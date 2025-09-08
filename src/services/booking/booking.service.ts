import type { Logger } from 'pino';
import { sendTextMessage } from '../whatsapp';
import {
  sendConfirmButtons,
  sendTimeOptions,
  sendBookingList,
} from '../whatsapp.interactive';
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
  appendHistory,
  getHistory,
} from '../session/store';

// Trova la prima prenotazione futura (o in corso) per questo numero
// (legacy function removed)

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
  if (/(👍|👌|✌️|🙂)/u.test(t)) return true;
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
  if (/(👎|🙅|🚫)/u.test(t)) return true;
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
  appendHistory(args.tenant.id, args.to, { role: 'assistant', text: args.text, ts: Date.now() });
}

function isShortWhitelisted(text: string): boolean {
  if (/^\d+\s*(persone|persona)?$/.test(text)) return true;
  if (/per\s*\d+$/.test(text)) return true;
  if (/^alle?\s*\d{1,2}(:\d{2})?$/.test(text)) return true;
  if (/^\d{1,2}(:\d{2})?$/.test(text)) return true;
  return false;
}

function toTwoDigits(n: number) {
  return String(n).padStart(2, '0');
}

function guessShortTokenKind(
  raw: string,
  draft: { date?: string; time?: string; people?: number; name?: string },
  capacity: number,
): { kind: 'time' | 'people' | 'ambiguous'; value?: string | number } {
  const token = raw.trim();
  if (!/^\d{1,2}$/.test(token)) return { kind: 'ambiguous' };
  const n = parseInt(token, 10);
  const timeMissing = !draft.time;
  const peopleMissing = draft.people == null;
  if (n > capacity) return { kind: 'time', value: `${toTwoDigits(n)}:00` };
  if (timeMissing && peopleMissing) {
    if (n <= 23) return { kind: 'ambiguous' };
    return { kind: 'people', value: n };
  }
  if (timeMissing && !peopleMissing && n <= 23) {
    return { kind: 'time', value: `${toTwoDigits(n)}:00` };
  }
  if (peopleMissing && !timeMissing) {
    if (n >= 1 && n <= capacity) return { kind: 'people', value: n };
    return { kind: 'ambiguous' };
  }
  return { kind: 'ambiguous' };
}

export async function getBookingsList(tenantId: string, phone: string) {
  const bookings = await prisma.booking.findMany({
    where: { tenantId, customerPhone: phone, status: 'confirmed', startAt: { gte: new Date() } },
    orderBy: { startAt: 'asc' },
    select: { id: true, startAt: true, people: true, customerName: true, status: true },
  });
  return bookings.map((b) => ({
    id: b.id,
    date: toIsoDate(b.startAt),
    time: b.startAt.toISOString().slice(11, 16),
    people: b.people,
    name: b.customerName,
    status: b.status,
  }));
}


export async function processInboundText(args: { tenant: { id: string; slug: string; name: string; whatsappPhoneId?: string | null; whatsappToken?: string | null; }; from: string; body: string; messageId: string; log?: Logger; }) {
  const { tenant, from, body, log } = args;
  appendHistory(tenant.id, from, { role: 'user', text: body, ts: Date.now() });
  const norm = normalizeForIntent(body);
  const pending = getPendingIfValid(tenant.id, from);
  const pendingCancel = getPendingCancelIfValid(tenant.id, from);
  const pendingModify = getPendingModifyIfValid(tenant.id, from);
  const history = getHistory(tenant.id, from);
  const list_bookings = await getBookingsList(tenant.id, from);
  let nlu;
  try {
    nlu = await parseBookingIntent(body, { tenantId: tenant.id, from, history, list_bookings, locale: process.env.LOCALE || 'it-IT', timezone: process.env.TIMEZONE || 'Europe/Rome' });
  } catch (err) {
    log?.warn({ err }, 'nlu failure');
    await reply({ tenant, to: from, text: nlu?.reply || 'Scusami, non ho capito. Dimmi data, ora e persone.', log });
    return;
  }
  if (isAffirmative(norm)) {
    if (pendingCancel) {
      await prisma.booking.update({ where: { id: pendingCancel.bookingId }, data: { status: 'cancelled' } });
      await reply({ tenant, to: from, text: 'Cancellata. Vuoi nuova?', log });
      clearPendingCancel(tenant.id, from);
      return;
    }
    if (pendingModify) {
      const { bookingId, date, time, people, notes } = pendingModify;
      const rules = tenantRules[tenant.slug] || { tableDuration: 120, slotMinutes: 15 };
      const startAt = toDateTime(date!, time!);
      const endAt = toDateTime(date!, addMinutes(time!, rules.tableDuration));
      const recheck = await checkAvailability(tenant.slug, date!, time!, people!, { tenantId: tenant.id });
      if (!recheck.ok) {
        await reply({ tenant, to: from, text: 'Non disponibile. Riproviamo?', log });
        clearPendingModify(tenant.id, from);
        return;
      }
      await prisma.booking.update({ where: { id: bookingId }, data: { startAt, endAt, people: people!, notes: notes || null } });
      await reply({ tenant, to: from, text: `Modifica confermata per ${formatHuman(date!, time!)}.`, log });
      clearPendingModify(tenant.id, from);
      clearSession(tenant.id, from);
      return;
    }
    if (!pending) {
      await reply({ tenant, to: from, text: 'Non ho prenotazione in attesa. Vuoi crearne una?', log });
      return;
    }
    const { date, time, people, name, notes } = pending;
    const rules = tenantRules[tenant.slug] || { tableDuration: 120, slotMinutes: 15 };
    const startAt = toDateTime(date, time);
    const endAt = toDateTime(date, addMinutes(time, rules.tableDuration));
    const recheck = await checkAvailability(tenant.slug, date, time, people, { tenantId: tenant.id });
    if (!recheck.ok) {
      await reply({ tenant, to: from, text: 'Proposta non disponibile. Ripartiamo.', log });
      clearSession(tenant.id, from);
      return;
    }
    if (await hasOverlapForSameUser(tenant.id, from, startAt, endAt)) {
      await reply({ tenant, to: from, text: 'Hai già prenotazione a quell’ora. Modifica o annulla?', log });
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
      await reply({ tenant, to: from, text: `Confermata! Ti aspettiamo ${formatHuman(date, time)}.`, log });
    } catch (err) {
      log?.error({ err }, 'failed to create booking');
      await reply({ tenant, to: from, text: 'Errore, riprova.', log });
    }
    clearSession(tenant.id, from);
    return;
  }
  if (isNegative(norm)) {
    if (pending) {
      clearSession(tenant.id, from);
      await reply({ tenant, to: from, text: 'Annullata. Prova altro orario?', log });
      return;
    }
    if (pendingCancel) {
      clearPendingCancel(tenant.id, from);
      await reply({ tenant, to: from, text: 'Annullamento cancellato.', log });
      return;
    }
    if (pendingModify) {
      clearPendingModify(tenant.id, from);
      await reply({ tenant, to: from, text: 'Modifica annullata.', log });
      return;
    }
    const list_bookings = await getBookingsList(tenant.id, from);
    if (list_bookings.length === 0) {
      await reply({ tenant, to: from, text: 'Nessuna prenotazione da annullare.', log });
      return;
    }
    if (list_bookings.length === 1) {
      setPendingCancel(tenant.id, from, list_bookings[0].id);
      await reply({ tenant, to: from, text: `Annulla ${formatHuman(list_bookings[0].date, list_bookings[0].time)}? Confermo.`, log });
      return;
    }
    await sendBookingList({
      to: from,
      phoneNumberId: tenant.whatsappPhoneId || process.env.WHATSAPP_PHONE_NUMBER_ID!,
      token: tenant.whatsappToken || process.env.WHATSAPP_TOKEN!,
      title: 'Quale annullare?',
      bookings: list_bookings,
      log,
    });
    return;
  }
  switch (nlu.next_action as string) {
    case 'list_show':
      const listText = list_bookings.length
        ? list_bookings.map((b) => `${b.date} ${b.time} per ${b.people} (${b.name})`).join('\n')
        : 'Nessuna prenotazione.';
      const histForReply = history.map((h) => ({ role: h.role, text: h.text }));
      const replyText = await generateReply({
        history: histForReply,
        intent: 'booking.list',
        fields: {},
        list_bookings,
        user_id: from,
        restaurantProfile: demoProfile,
      });
      await reply({ tenant, to: from, text: `${replyText}\n\n${listText}\nVuoi modificare o cancellare?`, log });
      if (list_bookings.length > 1) {
        await sendBookingList({
          to: from,
          phoneNumberId: tenant.whatsappPhoneId || process.env.WHATSAPP_PHONE_NUMBER_ID!,
          token: tenant.whatsappToken || process.env.WHATSAPP_TOKEN!,
          title: 'Scegli',
          bookings: list_bookings,
          log,
        });
      }
      return;
    case 'ask_clarification':
      setDraft(tenant.id, from, { ...getDraft(tenant.id, from), ...nlu.fields });
      await reply({ tenant, to: from, text: nlu.reply || say(`ask_${nlu.missing_fields[0] || 'missing_generic'}`), log });
      return;
    case 'send_info':
      const histForInfo = history.map((h) => ({ role: h.role, text: h.text }));
      const infoReply = await generateReply({
        history: histForInfo,
        intent: nlu.intent,
        fields: nlu.fields,
        list_bookings,
        user_id: from,
        restaurantProfile: demoProfile,
      });
      await reply({ tenant, to: from, text: infoReply, log });
      return;
    case 'check_availability':
      const { date, time, people, name, notes, booking_id } = nlu.fields;
      if (nlu.intent === 'booking.modify' && booking_id) {
        const active = await prisma.booking.findUnique({
          where: { id: booking_id, tenantId: tenant.id, customerPhone: from },
        });
        if (!active) {
          await reply({ tenant, to: from, text: 'Non trovata.', log });
          return;
        }
        const fields = {
          date: date || toIsoDate(active.startAt),
          time: time || active.startAt.toISOString().slice(11, 16),
          people: people || active.people,
          notes,
        };
        if (!fields.date || !fields.time || !fields.people) {
          await reply({ tenant, to: from, text: 'Mancano data, ora o persone.', log });
          return;
        }
        const avail = await checkAvailability(
          tenant.slug,
          fields.date,
          fields.time,
          fields.people,
          { tenantId: tenant.id },
        );
        if (!avail.ok) {
          const alts = await suggestAlternatives(
            tenant.slug,
            fields.date,
            fields.time,
            fields.people,
            { tenantId: tenant.id },
          );
          await sendTimeOptions({
            to: from,
            phoneNumberId: tenant.whatsappPhoneId || process.env.WHATSAPP_PHONE_NUMBER_ID!,
            token: tenant.whatsappToken || process.env.WHATSAPP_TOKEN!,
            title: 'Alternativi',
            options: alts,
            log,
          });
          return;
        }
        setPendingModify(tenant.id, from, { bookingId: booking_id, ...fields });
        await reply({
          tenant,
          to: from,
          text: `Aggiorno ${booking_id} a ${formatHuman(fields.date, fields.time)} per ${fields.people}. Confermi?`,
          log,
        });
        return;
      }
      if (!date || !time || !people || !name) {
        await reply({ tenant, to: from, text: nlu.reply || 'Dimmi data, ora, persone e nome.', log });
        return;
      }
      const rules = tenantRules[tenant.slug] || { slotMinutes: 15, tableDuration: 120 };
      let normalizedDate = date;
      const rel = parseRelativeDateToken(date);
      if (rel) normalizedDate = rel;
      const aligned = alignToSlot(time, rules.slotMinutes);
      if (!aligned.ok) {
        await reply({ tenant, to: from, text: 'Orari ogni 15 min. Prova vicino?', log });
        return;
      }
      const startAtCandidate = toDateTime(normalizedDate, aligned.time);
      const endAtCandidate = toDateTime(normalizedDate, addMinutes(aligned.time, rules.tableDuration));
      if (await hasOverlapForSameUser(tenant.id, from, startAtCandidate, endAtCandidate)) {
        await reply({ tenant, to: from, text: 'Hai già prenotazione lì. Modifica o annulla?', log });
        return;
      }
      const avail = await checkAvailability(
        tenant.slug,
        normalizedDate,
        aligned.time,
        people,
        { tenantId: tenant.id },
      );
      if (!avail.ok) {
        let text = 'Non disponibile. Altro orario?';
        if (avail.reason === 'invalid_slot') text = 'Ogni 15 min. Prova 20:00 o 20:15?';
        if (avail.reason === 'outside_opening') text = 'Chiusi lì. Altro orario?';
        if (avail.reason === 'capacity_exceeded') text = 'Posti insufficienti. Meno persone o altro orario?';
        await reply({ tenant, to: from, text, log });
        return;
      }
      const hist = history.map((h) => ({ role: h.role, text: h.text }));
      const summary = await generateReply({
        history: hist,
        intent: 'booking.create',
        fields: { date: normalizedDate, time: aligned.time, people, name },
        list_bookings,
        user_id: from,
        restaurantProfile: demoProfile,
      });
      setPending(tenant.id, from, {
        date: normalizedDate,
        time: aligned.time,
        people,
        name,
        notes,
      });
      const phoneNumberId = tenant.whatsappPhoneId || process.env.WHATSAPP_PHONE_NUMBER_ID;
      const token = tenant.whatsappToken || process.env.WHATSAPP_TOKEN;
      if (phoneNumberId && token) {
        await sendConfirmButtons({ to: from, phoneNumberId, token, text: summary, log });
      } else {
        await reply({ tenant, to: from, text: summary, log });
      }
      return;
    case 'none':
    case 'unknown':
      const histForFallback = history.map((h) => ({ role: h.role, text: h.text }));
      const fallbackText = await generateReply({
        history: histForFallback,
        intent: nlu.intent || 'unknown',
        fields: nlu.fields,
        list_bookings,
        user_id: from,
        restaurantProfile: demoProfile,
      });
      await reply({ tenant, to: from, text: fallbackText, log });
      return;
  }
}
