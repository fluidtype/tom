import type { Logger } from 'pino';
import { sendTextMessage } from '../whatsapp';
import { parseBookingIntent } from '../openai/nlu';
import { checkAvailability } from './availability';
import { tenantRules } from './rules.index';
import {
  parseRelativeDateToken,
  alignToSlot,
  formatHuman,
  addMinutes,
  toDateTime,
} from '../../utils/datetime';
import { prisma } from '../../db/client';
import {
  getSession,
  getPendingIfValid,
  setPending,
  clearSession,
  setLastOutboundNow,
} from '../session/store';

// Trova la prima prenotazione futura (o in corso) per questo numero
async function findActiveBookingByPhone(tenantId: string, phone: string) {
  return prisma.booking.findFirst({
    where: {
      tenantId,
      customerPhone: phone,
      status: { in: ['pending', 'confirmed'] },
      startAt: { gte: new Date() },
    },
    orderBy: { startAt: 'asc' },
  });
}

// Rileva sovrapposizione per lo stesso utente nello stesso slot
async function hasOverlapForSameUser(
  tenantId: string,
  phone: string,
  startAt: Date,
  endAt: Date,
) {
  const count = await prisma.booking.count({
    where: {
      tenantId,
      customerPhone: phone,
      status: { in: ['pending', 'confirmed'] },
      startAt: { lt: endAt },
      endAt: { gt: startAt },
    },
  });
  return count > 0;
}

function normalizeForIntent(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove accents
    .replace(/[!?.,]/g, '')
    .replace(/[\p{Emoji_Presentation}\p{Emoji}\p{Extended_Pictographic}]/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

async function reply(args: {
  tenant: { slug: string; whatsappPhoneId?: string | null; whatsappToken?: string | null; id: string };
  to: string;
  text: string;
  log?: Logger;
}) {
  const sess = getSession(args.tenant.id, args.to);
  const now = Date.now();
  if (sess.lastOutboundAt && now - sess.lastOutboundAt < 750) {
    args.log?.info({ to: args.to }, 'reply skipped by dedupe');
    return;
  }

  const phoneNumberId =
    args.tenant.whatsappPhoneId || process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = args.tenant.whatsappToken || process.env.WHATSAPP_TOKEN;

  if (!phoneNumberId || !token) {
    args.log?.warn({ tenant: args.tenant.slug }, 'missing WA credentials, skipping reply');
    return;
  }

  await sendTextMessage({
    to: args.to,
    body: args.text,
    phoneNumberId,
    token,
    log: args.log,
  });
  setLastOutboundNow(args.tenant.id, args.to);
}

function isTokenMatch(text: string, tokens: string[]): boolean {
  const words = text.split(' ').filter(Boolean);
  if (words.length <= 3) {
    return tokens.includes(text);
  }
  return tokens.some((t) => text.startsWith(t + ' '));
}

function isShortWhitelisted(text: string): boolean {
  if (/^\d+\s*(persone|persona)?$/.test(text)) return true;
  if (/per\s*\d+$/.test(text)) return true;
  if (/^alle?\s*\d{1,2}(:\d{2})?$/.test(text)) return true;
  if (/^\d{1,2}(:\d{2})?$/.test(text)) return true;
  return false;
}

export async function processInboundText(args: {
  tenant: {
    id: string;
    slug: string;
    name: string;
    whatsappPhoneId?: string | null;
    whatsappToken?: string | null;
  };
  from: string;
  body: string;
  messageId: string;
  log?: Logger;
}) {
  const { tenant, from, body, log } = args;
  const norm = normalizeForIntent(body);
  const words = norm.split(' ').filter(Boolean);

  const pending = getPendingIfValid(tenant.id, from);

  const CONFIRM_TOKENS = ['confermo', 'conferma', 'ok', 'va bene', 'si', 'perfetto', 'procedi'];
  const CANCEL_TOKENS = ['annulla', 'cancella', 'no', 'non va bene', 'stop', 'annullare', 'annullato'];

  if (isTokenMatch(norm, CONFIRM_TOKENS)) {
    if (!pending) {
      await reply({ tenant, to: from, text: 'Non ho una prenotazione in attesa. Vuoi crearne una?', log });
      return;
    }
    const { date, time, people, name, notes } = pending;
    const rules = tenantRules[tenant.slug] || { tableDuration: 120, slotMinutes: 15 };
    const startAt = toDateTime(date, time);
    const endAt = toDateTime(date, addMinutes(time, rules.tableDuration));

    const recheck = await checkAvailability(
      tenant.slug || 'demo',
      date,
      time,
      people,
      { tenantId: tenant.id },
    );
    if (!recheck.ok) {
      await reply({
        tenant,
        to: from,
        text: 'La proposta non è più disponibile. Ripartiamo: dimmi data e ora.',
        log,
      });
      clearSession(tenant.id, from);
      return;
    }

    if (await hasOverlapForSameUser(tenant.id, from, startAt, endAt)) {
      await reply({
        tenant,
        to: from,
        text: 'Hai già una prenotazione a quell’ora. Vuoi modificarla o annullarla?',
        log,
      });
      clearSession(tenant.id, from);
      return;
    }

    try {
      await prisma.booking.create({
        data: {
          tenantId: tenant.id,
          customerName: name,
          customerPhone: from,
          people,
          startAt,
          endAt,
          notes: notes || null,
          source: 'whatsapp',
          waMessageId: args.messageId,
          status: 'confirmed',
        },
      });
      await reply({
        tenant,
        to: from,
        text: `✅ Prenotazione confermata! Ti aspettiamo il ${formatHuman(date, time)}.`,
        log,
      });
    } catch (err) {
      log?.error({ err }, 'failed to create booking');
      await reply({ tenant, to: from, text: 'Si è verificato un errore, riprova tra poco.', log });
    }
    clearSession(tenant.id, from);
    return;
  }

  if (isTokenMatch(norm, CANCEL_TOKENS)) {
    if (pending) {
      clearSession(tenant.id, from);
      await reply({ tenant, to: from, text: '❌ Ok, prenotazione annullata. Vuoi provare un altro orario?', log });
      return;
    }
    const active = await findActiveBookingByPhone(tenant.id, from);
    if (!active) {
      await reply({
        tenant,
        to: from,
        text: 'Non trovo prenotazioni attive da annullare. Vuoi crearne una nuova?',
        log,
      });
      return;
    }
    await prisma.booking.update({ where: { id: active.id }, data: { status: 'cancelled' } });
    await reply({
      tenant,
      to: from,
      text: '❌ Ho annullato la tua prenotazione futura. Vuoi fissarne un’altra?',
      log,
    });
    return;
  }

  if (words.length <= 2 && !isShortWhitelisted(norm)) {
    if (pending) {
      await reply({ tenant, to: from, text: 'Vuoi confermare la prenotazione proposta? Scrivi "confermo" o "annulla".', log });
    } else {
      await reply({ tenant, to: from, text: 'Dimmi data, ora e persone (es. "domani alle 20 per 4 a nome Luca").', log });
    }
    return;
  }

  let nlu;
  try {
    nlu = await parseBookingIntent(body, {
      locale: process.env.LOCALE || 'it-IT',
      timezone: process.env.TIMEZONE || 'Europe/Rome',
    });
  } catch (err) {
    log?.warn({ err }, 'nlu failure');
    await reply({ tenant, to: from, text: 'Scusami, non ho capito. Dimmi data, ora e persone.', log });
    return;
  }

  if (nlu.intent !== 'booking.create') {
    const text = nlu.reply ?? 'Dimmi data, ora e persone (es. "domani alle 20 per 4 a nome Luca").';
    await reply({ tenant, to: from, text, log });
    return;
  }

  const { date, time, people, name, notes } = nlu.fields;
  if (!date || !time || !people || !name) {
    await reply({ tenant, to: from, text: 'Dimmi data, ora e persone (es. "domani alle 20 per 4 a nome Luca").', log });
    return;
  }

  const rules = tenantRules[tenant.slug] || { slotMinutes: 15, tableDuration: 120 };

  let normalizedDate = date;
  const rel = parseRelativeDateToken(date);
  if (rel) normalizedDate = rel;
  const aligned = alignToSlot(time, rules.slotMinutes);
  if (!aligned.ok) {
    await reply({ tenant, to: from, text: 'Accettiamo prenotazioni ogni 15 minuti. Vuoi provare 20:00 o 20:15?', log });
    return;
  }

  const startAtCandidate = toDateTime(normalizedDate, aligned.time);
  const endAtCandidate = toDateTime(
    normalizedDate,
    addMinutes(aligned.time, rules.tableDuration),
  );

  if (
    await hasOverlapForSameUser(
      tenant.id,
      from,
      startAtCandidate,
      endAtCandidate,
    )
  ) {
    await reply({
      tenant,
      to: from,
      text: 'Risulta già una tua prenotazione a quell’ora. Vuoi modificarla o annullarla?',
      log,
    });
    return;
  }

  const avail = await checkAvailability(tenant.slug || 'demo', normalizedDate, aligned.time, people, {
    tenantId: tenant.id,
  });

  if (!avail.ok) {
    let text = 'A quell’orario non c’è disponibilità. Vuoi provare un altro orario?';
    if (avail.reason === 'invalid_slot') {
      text = 'Accettiamo prenotazioni ogni 15 minuti. Vuoi provare 20:00 o 20:15?';
    } else if (avail.reason === 'outside_opening') {
      text = 'Siamo chiusi a quell’ora. Vuoi un altro orario?';
    } else if (avail.reason === 'capacity_exceeded') {
      text = 'Posti insufficienti per quel numero. Vuoi provare con meno persone o altro orario?';
      log?.info({ normalizedDate, time: aligned.time, people }, 'capacity exceeded');
    }
    await reply({ tenant, to: from, text, log });
    return;
  }

  const summary = `Perfetto! Tavolo per ${people} il ${formatHuman(normalizedDate, aligned.time)} a nome ${name}. Confermi?`;
  setPending(tenant.id, from, { date: normalizedDate, time: aligned.time, people, name, notes });
  await reply({ tenant, to: from, text: summary, log });
}
