import OpenAI from 'openai';
import { z } from 'zod';
import logger from '../../config/logger';
import { demoProfile } from '../../config/tenantProfile.demo';
import { parseRelativeDateToken, toIsoDate } from '../../utils/datetime';
import { getBookingsList } from '../booking/booking.service';

export type NluResult = {
  intent: 'booking.create' | 'booking.modify' | 'booking.cancel' | 'booking.list' | 'availability.query' | 'info.menu' | 'info.address' | 'info.opening' | 'info.parking' | 'greeting' | 'unknown' | 'general.chat';
  confidence: number;
  fields: { date?: string; time?: string; people?: number; name?: string; phone?: string; notes?: string; booking_id?: string };
  missing_fields: string[];
  reply?: string;
  next_action: 'check_availability' | 'ask_missing' | 'ask_clarification' | 'answer_smalltalk' | 'list_show' | 'send_info' | 'cancel_confirm' | 'modify_propose' | 'none';
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

export async function parseBookingIntent(
  text: string,
  context: {
    tenantId: string;
    from: string;
    history: Array<{ role: 'user' | 'assistant'; text: string; ts: number }>;
    list_bookings: Array<{
      id: string;
      date: string;
      time: string;
      people: number;
      name: string;
      status: string;
    }>;
    locale?: string;
    timezone?: string;
  },
): Promise<NluResult> {
  const { tenantId, from, history, list_bookings, timezone = 'Europe/Rome' } = context;
  const systemPrompt = `Tu sei Tom, assistente del ristorante Demo Ristorante. Stai parlando con ${from} (telefono: ${from}). History recente: ${JSON.stringify(
    history.slice(-20),
  )}. Prenotazioni attive: ${JSON.stringify(
    list_bookings,
  )}. Regole: Orari ${demoProfile.opening}, capienza 8. Analizza "${text}": Output SOLO JSON {intent: 'booking.create' | 'booking.modify' | 'booking.cancel' | 'booking.list' | 'availability.query' | 'info.menu' | 'info.address' | 'info.opening' | 'info.parking' | 'greeting' | 'unknown' | 'general.chat', entities: {date?: string, time?: string, people?: number, name?: string, booking_id?: string}, missing_fields: string[], action: 'check_availability' | 'ask_missing' | 'answer_smalltalk' | 'list_show' | 'send_info' | 'cancel_confirm' | 'modify_propose' | 'none', response_suggestion: string | undefined}.`;
  logger.debug({ text }, 'nlu input');
  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        ...history.slice(-20).map((h) => ({ role: h.role, content: h.text })),
        { role: 'user', content: text },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    });
    const parsedJson = JSON.parse(completion.choices[0].message.content || '{}');
    const parsed = z
      .object({
        intent: z.enum([
          'booking.create',
          'booking.modify',
          'booking.cancel',
          'booking.list',
          'availability.query',
          'info.menu',
          'info.address',
          'info.opening',
          'info.parking',
          'greeting',
          'unknown',
          'general.chat',
        ]),
        entities: z.object({
          date: z.string().optional(),
          time: z.string().optional(),
          people: z.number().optional(),
          name: z.string().optional(),
          booking_id: z.string().optional(),
        }),
        missing_fields: z.array(z.string()),
        action: z.enum([
          'check_availability',
          'ask_missing',
          'ask_clarification',
          'answer_smalltalk',
          'list_show',
          'send_info',
          'cancel_confirm',
          'modify_propose',
          'none',
        ]),
        response_suggestion: z.string().optional(),
      })
      .safeParse(parsedJson);
    if (!parsed.success) throw new Error('invalid json');
    let fields = parsed.data.entities;
    if (fields.date && typeof fields.date === 'string') {
      const rel = parseRelativeDateToken(fields.date);
      if (rel) fields.date = rel;
      const todayIso = toIsoDate(new Date(), timezone);
      if (new Date(fields.date) < new Date(todayIso))
        fields.date = toIsoDate(new Date(Date.now() + 86400000), timezone);
    }
    if (!fields.booking_id && list_bookings.length > 0) {
      const tomorrow = toIsoDate(new Date(Date.now() + 86400000));
      const match = list_bookings.find((b) => b.date === tomorrow);
      if (match) fields.booking_id = match.id;
    }
    const confidence = 0.9;
    return {
      intent: parsed.data.intent,
      confidence,
      fields,
      missing_fields: parsed.data.missing_fields,
      next_action: parsed.data.action,
      reply: parsed.data.response_suggestion,
    };
  } catch (err) {
    logger.warn({ err }, 'openai nlu error');
    return {
      intent: 'unknown',
      confidence: 0.4,
      fields: {},
      missing_fields: [],
      next_action: 'none',
      reply: 'Non capito, vuoi prenotare?',
    };
  }
}
