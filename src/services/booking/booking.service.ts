import type { Logger } from 'pino';
import { sendTextMessage } from '../whatsapp';
import { parseBookingIntent } from '../openai/nlu';
import { generateReply } from '../openai/dialogue';
import { say } from '../nlg';
import { checkAvailability, suggestAlternatives } from './availability';
import { tenantRules } from './rules.index';
import { demoProfile } from '../../config/tenantProfile.demo';
import {
  parseRelativeDateToken,
  alignToSlot,
  formatHuman,
  addMinutes,
  toDateTime,
  toIsoDate,
} from '../../utils/datetime';
import { prisma } from '../../db/client';
import {
  getSession,
  getPendingIfValid,
  setPending,
  clearSession,
  setLastOutboundNow,
  setPendingCancel,
  getPendingCancelIfValid,
  clearPendingCancel,
  setPendingModify,
  getPendingModifyIfValid,
  clearPendingModify,
  setDraft,
  getDraft,
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

function formatAltSlots(slots: string[]): string {
  return slots.slice(0, 3).join(' o ');
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

function normalize(s: string) {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function isAffirmative(t: string) {
  t = normalize(t);
  const w = [
    'confermo',
    'conferma',
    'ok',
    'okay',
    'va bene',
    'si',
    'sì',
    'perfetto',
    'procedi',
    'vai',
    'va',
  ];
  return w.some(
    (x) =>
      t === x ||
      t.startsWith(x + ' ') ||
      t.includes(' ' + x + ' ') ||
      t.endsWith(' ' + x),
  );
}

function isNegative(t: string) {
  t = normalize(t);
  const w = [
    'annulla',
    'cancella',
    'no',
    'non va bene',
    'stop',
    'annullare',
    'annullato',
  ];
  return w.some((x) => t.includes(x));
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
  const pendingCancel = getPendingCancelIfValid(tenant.id, from);
  const pendingModify = getPendingModifyIfValid(tenant.id, from);

  if (isAffirmative(norm)) {
    if (pendingCancel) {
      await prisma.booking.update({
        where: { id: pendingCancel.bookingId },
        data: { status: 'cancelled' },
      });
      await reply({ tenant, to: from, text: '❌ Prenotazione annullata. Vuoi crearne una nuova?', log });
      clearPendingCancel(tenant.id, from);
      return;
    }
    if (pendingModify) {
      const { bookingId, date, time, people, notes } = pendingModify;
      const rules = tenantRules[tenant.slug] || { tableDuration: 120, slotMinutes: 15 };
      const startAt = toDateTime(date!, time!);
      const endAt = toDateTime(date!, addMinutes(time!, rules.tableDuration));
      const recheck = await checkAvailability(tenant.slug, date!, time!, people!, {
        tenantId: tenant.id,
      });
      if (!recheck.ok) {
        await reply({ tenant, to: from, text: 'Non è più disponibile. Riproviamo?', log });
        clearPendingModify(tenant.id, from);
        return;
      }
      await prisma.booking.update({
        where: { id: bookingId },
        data: {
          startAt,
          endAt,
          people: people!,
          notes: notes || null,
        },
      });
      await reply({ tenant, to: from, text: `✅ Modifica confermata per ${formatHuman(date!, time!)}.`, log });
      clearPendingModify(tenant.id, from);
      clearSession(tenant.id, from);
      return;
    }
    if (!pending) {
      await reply({ tenant, to: from, text: 'Non ho una prenotazione in attesa. Vuoi crearne una?', log });
      return;
    }
    const { date, time, people, name, notes } = pending;
    const rules = tenantRules[tenant.slug] || { tableDuration: 120, slotMinutes: 15 };
    const startAt = toDateTime(date, time);
    const endAt = toDateTime(date, addMinutes(time, rules.tableDuration));
    const recheck = await checkAvailability(tenant.slug, date, time, people, {
      tenantId: tenant.id,
    });
    if (!recheck.ok) {
      await reply({ tenant, to: from, text: 'La proposta non è più disponibile. Ripartiamo: dimmi data e ora.', log });
      clearSession(tenant.id, from);
      return;
    }
    if (await hasOverlapForSameUser(tenant.id, from, startAt, endAt)) {
      await reply({ tenant, to: from, text: 'Hai già una prenotazione a quell’ora. Vuoi modificarla o annullarla?', log });
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
      await reply({ tenant, to: from, text: `✅ Prenotazione confermata! Ti aspettiamo il ${formatHuman(date, time)}.`, log });
    } catch (err) {
      log?.error({ err }, 'failed to create booking');
      await reply({ tenant, to: from, text: 'Si è verificato un errore, riprova tra poco.', log });
    }
    clearSession(tenant.id, from);
    return;
  }

  if (isNegative(norm)) {
    if (pending) {
      clearSession(tenant.id, from);
      await reply({ tenant, to: from, text: '❌ Ok, prenotazione annullata. Vuoi provare un altro orario?', log });
      return;
    }
    if (pendingCancel) {
      clearPendingCancel(tenant.id, from);
      await reply({ tenant, to: from, text: 'Ok, annullamento cancellato. Vuoi altro?', log });
      return;
    }
    if (pendingModify) {
      clearPendingModify(tenant.id, from);
      await reply({ tenant, to: from, text: 'Ok, modifica annullata.', log });
      return;
    }
    const active = await findActiveBookingByPhone(tenant.id, from);
    if (!active) {
      await reply({ tenant, to: from, text: 'Non vedo prenotazioni attive da annullare. Vuoi crearne una?', log });
      return;
    }
    setPendingCancel(tenant.id, from, active.id);
    await reply({ tenant, to: from, text: `Vuoi annullare la prenotazione del ${formatHuman(toIsoDate(active.startAt), active.startAt.toISOString().slice(11,16))}? Scrivi confermo per procedere.`, log });
    return;
  }

  if (/^(per\s*)?\d+$/.test(norm)) {
    const num = parseInt(norm.replace(/per\s*/g, ''), 10);
    setDraft(tenant.id, from, { people: num });
    const d = getDraft(tenant.id, from);
    if (!d.date) {
      await reply({ tenant, to: from, text: say('ask_date'), log });
      return;
    }
    if (!d.time) {
      await reply({ tenant, to: from, text: say('ask_time'), log });
      return;
    }
    if (!d.name) {
      await reply({ tenant, to: from, text: say('ask_name'), log });
      return;
    }
  }

  if (/^\d{1,2}(:\d{2})?$/.test(norm)) {
    let t = norm;
    if (/^\d{1,2}$/.test(t)) t = t.padStart(2, '0') + ':00';
    setDraft(tenant.id, from, { time: t });
    const d = getDraft(tenant.id, from);
    if (!d.people) {
      await reply({ tenant, to: from, text: say('ask_people'), log });
      return;
    }
    if (!d.date) {
      await reply({ tenant, to: from, text: say('ask_date'), log });
      return;
    }
    if (!d.name) {
      await reply({ tenant, to: from, text: say('ask_name'), log });
      return;
    }
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

  if (nlu.intent === 'greeting' || nlu.intent === 'smalltalk.info' || nlu.intent === 'general.chat' || nlu.intent === 'unknown') {
    const text = await generateReply({
      history: [],
      intent: nlu.intent,
      fields: nlu.fields,
      restaurantProfile: demoProfile,
    });
    await reply({ tenant, to: from, text, log });
    return;
  }

  if (nlu.intent === 'booking.cancel') {
    const active = await findActiveBookingByPhone(tenant.id, from);
    if (!active) {
      await reply({ tenant, to: from, text: 'Non vedo prenotazioni attive a tuo nome. Vuoi crearne una?', log });
      return;
    }
    setPendingCancel(tenant.id, from, active.id);
    await reply({ tenant, to: from, text: `Confermi l’annullamento della prenotazione del ${formatHuman(toIsoDate(active.startAt), active.startAt.toISOString().slice(11,16))}?`, log });
    return;
  }

  if (nlu.intent === 'booking.modify') {
    const active = await findActiveBookingByPhone(tenant.id, from);
    if (!active) {
      await reply({ tenant, to: from, text: 'Non vedo prenotazioni attive da modificare. Vuoi crearne una?', log });
      return;
    }
    const fields = { ...nlu.fields };
    if (!fields.people) {
      await reply({ tenant, to: from, text: 'Per quante persone?', log });
      return;
    }
    if (!fields.date) fields.date = toIsoDate(active.startAt);
    if (!fields.time) fields.time = active.startAt.toISOString().slice(11,16);
    const avail = await checkAvailability(tenant.slug, fields.date, fields.time, fields.people, { tenantId: tenant.id });
    if (!avail.ok) {
      const alts = await suggestAlternatives(tenant.slug, fields.date, fields.time, fields.people, { tenantId: tenant.id });
      const altText = alts.length ? `Non disponibile. Posso proporti ${formatAltSlots(alts)}?` : 'Non disponibile. Vuoi un altro orario?';
      await reply({ tenant, to: from, text: altText, log });
      return;
    }
    setPendingModify(tenant.id, from, { bookingId: active.id, ...fields });
    await reply({ tenant, to: from, text: `Aggiorno la prenotazione a ${formatHuman(fields.date, fields.time)} per ${fields.people} persone. Confermi?`, log });
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
