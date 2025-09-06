import { prisma } from '../../db/client';
import type { Logger } from 'pino';
import { sendTextMessage } from '../whatsapp';
import { parseBookingIntent } from '../openai/nlu';
import { checkAvailability } from './availability';
import { tenantRules } from './rules.index';
import { getSession, saveSession, clearSession, type BookingSession } from '../session/memory';

function combineDateTimeToISO(date: string, time: string, _tz: string): string {
  // Basic combination assuming Europe/Rome; for production, use a real TZ library.
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const local = new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
  return local.toISOString();
}

function addMinutesISO(iso: string, minutes: number): string {
  const dt = new Date(iso);
  dt.setMinutes(dt.getMinutes() + minutes);
  return dt.toISOString();
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
  const { tenant, from, body, messageId, log } = args;

  // ===== Session handling
  const sessionKey = `${tenant.id}:${from}`;
  let s = getSession(sessionKey);
  if (!s.phone) s.phone = from;

  // ===== NLU parsing
  let nlu;
  try {
    nlu = await parseBookingIntent(body, { locale: process.env.LOCALE || 'it-IT' });
  } catch (err: unknown) {
    log?.error({ err }, 'nlu error');
    return;
  }

  const upd: Partial<BookingSession> = {};
  if (nlu?.fields?.name) upd.name = nlu.fields.name;
  if (nlu?.fields?.people) upd.people = nlu.fields.people;
  if (nlu?.fields?.date) upd.date = nlu.fields.date;
  if (nlu?.fields?.time) upd.time = nlu.fields.time;
  if (nlu?.fields?.phone) upd.phone = nlu.fields.phone;
  if (nlu?.fields?.notes) upd.notes = nlu.fields.notes;

  s = saveSession(sessionKey, upd);

  // ===== Ask for missing fields one at a time
  const missingOrder: Array<keyof BookingSession> = ['people', 'date', 'time', 'name'];
  const firstMissing = missingOrder.find((k) => !s[k]);
  if (firstMissing) {
    const prompts: Record<string, string> = {
      people: 'Quante persone siete?',
      date: 'Per che giorno? (es. 2025-09-06)',
      time: 'A che ora? (es. 20:00)',
      name: 'A nome di chi facciamo la prenotazione?',
    };
    await replyWhatsApp({ tenant, to: from, text: prompts[firstMissing], log });
    return;
  }

  // ===== Availability check
  const avail = checkAvailability(tenant.slug || 'demo', s.date!, s.time!, s.people!);
  if (!avail.ok) {
    await replyWhatsApp({
      tenant,
      to: from,
      text: 'A quell\u2019orario non c\u2019\u00e8 disponibilit\u00e0. Vuoi provare un altro orario?',
      log,
    });
    return;
  }

  // ===== Create booking
  const tz = process.env.TIMEZONE || 'Europe/Rome';
  const startAtISO = combineDateTimeToISO(s.date!, s.time!, tz);
  const duration = tenantRules[tenant.slug || 'demo']?.tableDuration ?? 120;
  const endAtISO = addMinutesISO(startAtISO, duration);

  try {
    await prisma.booking.create({
      data: {
        tenantId: tenant.id,
        customerName: s.name!,
        customerPhone: s.phone || from,
        people: s.people!,
        startAt: new Date(startAtISO),
        endAt: new Date(endAtISO),
        notes: s.notes || null,
        source: 'whatsapp',
        waMessageId: messageId,
        status: 'confirmed',
      },
    });
  } catch (err: unknown) {
    log?.error({ err }, 'failed to create booking');
    await replyWhatsApp({
      tenant,
      to: from,
      text: 'C\u2019\u00e8 stato un problema a salvare la prenotazione. Puoi riprovare tra poco?',
      log,
    });
    return;
  }

  // ===== Confirmation and cleanup
  await replyWhatsApp({
    tenant,
    to: from,
    text:
      `Prenotazione confermata \u2705\n` +
      `Nome: ${s.name}\n` +
      `Persone: ${s.people}\n` +
      `Quando: ${s.date} alle ${s.time}\n` +
      `A presto da ${tenant.name}!`,
    log,
  });

  clearSession(sessionKey);
}

async function replyWhatsApp(args: {
  tenant: { slug: string; whatsappPhoneId?: string | null; whatsappToken?: string | null };
  to: string;
  text: string;
  log?: Logger;
}) {
  const phoneNumberId = args.tenant.whatsappPhoneId || process.env.WHATSAPP_PHONE_NUMBER_ID;
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
