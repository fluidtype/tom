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

export type SessionFields = {
  date?: string;
  time?: string;
  people?: number;
  name?: string;
  phone?: string;
  notes?: string;
};

type Session = {
  fields: SessionFields;
  last: number;
  awaitingConfirm?: boolean;
  lastSummary?: string;
};

const SESSIONS = new Map<string, Session>();
const TTL_MS = 30 * 60 * 1000;

const LAST_SEND = new Map<string, { text: string; at: number }>();
const DEBOUNCE_MS = 2000;

function shouldSkipSend(key: string, text: string): boolean {
  const now = Date.now();
  const prev = LAST_SEND.get(key);
  if (prev && prev.text === text && now - prev.at < DEBOUNCE_MS) {
    return true;
  }
  LAST_SEND.set(key, { text, at: now });
  return false;
}

function getSession(key: string): Session {
  const now = Date.now();
  const s = SESSIONS.get(key);
  if (!s || now - s.last > TTL_MS) {
    const fresh: Session = { fields: {}, last: now };
    SESSIONS.set(key, fresh);
    return fresh;
  }
  s.last = now;
  return s;
}

function saveSession(
  key: string,
  patch: SessionFields & { awaitingConfirm?: boolean; lastSummary?: string },
): Session {
  const cur = getSession(key);
  const { awaitingConfirm, lastSummary, ...fieldPatch } = patch;
  cur.fields = { ...cur.fields, ...fieldPatch };
  if (awaitingConfirm !== undefined) cur.awaitingConfirm = awaitingConfirm;
  if (lastSummary !== undefined) cur.lastSummary = lastSummary;
  cur.last = Date.now();
  SESSIONS.set(key, cur);
  return cur;
}

function clearSession(key: string) {
  SESSIONS.delete(key);
}

async function reply(args: {
  tenant: { slug: string; whatsappPhoneId?: string | null; whatsappToken?: string | null };
  to: string;
  text: string;
  log?: Logger;
}) {
  const phoneNumberId =
    args.tenant.whatsappPhoneId || process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = args.tenant.whatsappToken || process.env.WHATSAPP_TOKEN;

  const debKey = `${args.tenant.slug}:${args.to}`;
  if (shouldSkipSend(debKey, args.text)) {
    args.log?.info({ debKey }, 'reply skipped by debounce');
    return;
  }

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
}

export async function processInboundText(args: {
  tenant: { id: string; slug: string; name: string; whatsappPhoneId?: string | null; whatsappToken?: string | null };
  from: string;
  body: string;
  messageId: string;
  log?: Logger;
}) {
  const { tenant, from, body, log } = args;
  const key = from;
  let s = getSession(key);
  const msg = body.trim().toLowerCase();

  if (['annulla', 'stop', 'no'].includes(msg)) {
    clearSession(key);
    await reply({ tenant, to: from, text: 'Ok, annullato. Se vuoi riprendiamo quando vuoi 😊', log });
    return;
  }
  if (['confermo', 'ok', 'si', 'sì'].includes(msg)) {
    if (!s.awaitingConfirm) {
      await reply({ tenant, to: from, text: 'Mi mancano ancora alcuni dati. Quante persone e a che ora?', log });
      return;
    }
    const { date, time, people, name } = s.fields;
    if (!date || !time || !people || !name) {
      await reply({ tenant, to: from, text: 'Mi mancano ancora alcuni dati. Quante persone e a che ora?', log });
      return;
    }
    const rules = tenantRules[tenant.slug] || { tableDuration: 120 };
    const startAt = toDateTime(date, time);
    const endAt = toDateTime(date, addMinutes(time, rules.tableDuration));
    try {
      const booking = await prisma.booking.create({
        data: {
          tenantId: tenant.id,
          customerName: name,
          customerPhone: from,
          people,
          startAt,
          endAt,
          notes: s.fields.notes || null,
          source: 'whatsapp',
          waMessageId: args.messageId,
          status: 'confirmed',
        },
      });
      log?.info({ bookingId: booking.id }, 'booking confirmed');
      await reply({ tenant, to: from, text: `✅ Prenotazione confermata! Ti aspettiamo ${formatHuman(date, time)}.`, log });
    } catch (err) {
      log?.error({ err }, 'failed to create booking');
      await reply({ tenant, to: from, text: 'C’è stato un problema a salvare la prenotazione. Puoi riprovare tra poco?', log });
    }
    clearSession(key);
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
    await reply({ tenant, to: from, text: 'Scusami, non ho capito. Quante persone siete?', log });
    return;
  }

  if (nlu.intent === 'smalltalk.info') {
    const text = nlu.reply ?? 'Vuoi prenotare? Dimmi solo quante persone.';
    await reply({ tenant, to: from, text, log });
    return;
  }

  if (nlu.intent !== 'booking.create') {
    await reply({ tenant, to: from, text: 'Posso aiutarti con una prenotazione. Quante persone siete?', log });
    return;
  }

  s = saveSession(key, nlu.fields);

  const required: Array<keyof SessionFields> = ['people', 'date', 'time', 'name'];
  const missing = required.filter((k) => s.fields[k] == null);

  if (missing.length) {
    const prompts: Record<string, string> = {
      people: 'Per quante persone?',
      date: 'Che giorno?',
      time: 'A che ora?',
      name: 'A nome di chi?',
    };
    await reply({ tenant, to: from, text: prompts[missing[0]], log });
    return;
  }

  let { date, time, people, name } = s.fields as Required<
    Pick<SessionFields, 'date' | 'time' | 'people' | 'name'>
  >;

  const rules = tenantRules[tenant.slug] || { slotMinutes: 15, tableDuration: 120 };
  const rel = parseRelativeDateToken(date);
  if (rel) {
    date = rel;
    s = saveSession(key, { date });
  }
  const aligned = alignToSlot(time, rules.slotMinutes);
  if (!aligned.ok) {
    s = saveSession(key, { time: aligned.time });
    await reply({
      tenant,
      to: from,
      text: 'Accettiamo prenotazioni ogni 15 minuti. Vuoi provare 20:00 o 20:15?',
      log,
    });
    return;
  }
  time = aligned.time;
  s = saveSession(key, { time });

  const avail = await checkAvailability(tenant.slug || 'demo', date, time, people, {
    tenantId: tenant.id,
  });

  if (!avail.ok) {
    let text = 'A quell\u2019orario non c\u2019\u00e8 disponibilit\u00e0. Vuoi provare un altro orario?';
    if (avail.reason === 'invalid_slot') {
      text = 'Accettiamo prenotazioni ogni 15 minuti. Vuoi provare 20:00 o 20:15?';
    } else if (avail.reason === 'outside_opening') {
      text = 'Siamo chiusi a quell\u2019ora. Vuoi un altro orario?';
    } else if (avail.reason === 'capacity_exceeded') {
      text = 'Posti insufficienti per quel numero. Vuoi provare con meno persone o altro orario?';
      log?.info({ date, time, people }, 'capacity exceeded');
    }
    await reply({ tenant, to: from, text, log });
    return;
  }

  const summary = `Perfetto! Tavolo per ${people} il ${formatHuman(date, time)} a nome ${name}. Confermi?`;
  s = saveSession(key, {
    awaitingConfirm: true,
    lastSummary: summary,
    date,
    time,
    people,
    name,
  });
  log?.info({ summary }, 'awaiting confirm');
  await reply({ tenant, to: from, text: summary, log });
}
