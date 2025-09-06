import type { Logger } from 'pino';
import { sendTextMessage } from '../whatsapp';
import { parseBookingIntent } from '../openai/nlu';
import { checkAvailability } from './availability';

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
};

const SESSIONS = new Map<string, Session>();
const TTL_MS = 30 * 60 * 1000;

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

function saveSession(key: string, patch: SessionFields): Session {
  const cur = getSession(key);
  cur.fields = { ...cur.fields, ...patch };
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

  if (body.trim().toLowerCase().includes('annulla')) {
    clearSession(key);
    await reply({ tenant, to: from, text: 'Ok, annullato. Se vuoi riprendiamo quando vuoi 😊', log });
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
    if (nlu.reply) await reply({ tenant, to: from, text: nlu.reply, log });
    await reply({ tenant, to: from, text: 'Vuoi prenotare? Dimmi solo quante persone.', log });
    return;
  }

  if (nlu.intent !== 'booking.create') {
    await reply({ tenant, to: from, text: 'Posso aiutarti con una prenotazione. Quante persone siete?', log });
    return;
  }

  const s = saveSession(key, nlu.fields);

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

  const { date, time, people, name } = s.fields as Required<Pick<SessionFields, 'date' | 'time' | 'people' | 'name'>>;
  const avail = checkAvailability(tenant.slug || 'demo', date, time, people);

  if (!avail.ok) {
    let text = 'A quell\u2019orario non c\u2019\u00e8 disponibilit\u00e0. Vuoi provare un altro orario?';
    if (avail.reason === 'invalid_slot') {
      text = 'Accettiamo prenotazioni ogni 15 minuti. Vuoi provare 20:00 o 20:15?';
    } else if (avail.reason === 'outside_opening') {
      text = 'Siamo chiusi a quell\u2019ora. Vuoi un altro orario?';
    } else if (avail.reason === 'capacity_exceeded') {
      text = 'Posti insufficienti per quel numero. Vuoi provare con meno persone o altro orario?';
    }
    await reply({ tenant, to: from, text, log });
    return;
  }

  await reply({
    tenant,
    to: from,
    text: `Perfetto! Tavolo per ${people} il ${date} alle ${time} a nome ${name}. Confermi?`,
    log,
  });
}
