import OpenAI from 'openai';
import { z } from 'zod';
import logger from '../../config/logger';

// structured output type
const FieldsSchema = z.object({
  date: z.string().optional(),
  time: z.string().optional(),
  people: z.number().optional(),
  name: z.string().optional(),
  phone: z.string().optional(),
  notes: z.string().optional(),
});

const NluParsedSchema = z.object({
  intent: z.string(),
  confidence: z.number().min(0).max(1),
  fields: FieldsSchema,
  missing_fields: z.array(z.string()).optional(),
  reply: z.string().optional(),
  next_action: z.enum([
    'ask_clarification',
    'check_availability',
    'answer_info',
    'smalltalk',
    'handoff',
  ]),
});

export type NluParsed = z.infer<typeof NluParsedSchema>;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const toolSchema = {
  name: 'extract_booking_or_smalltalk',
  description:
    'Estrai intent e campi prenotazione o identifica small talk/FAQ. Rispondi in italiano amichevole.',
  parameters: {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        enum: [
          'booking.create',
          'booking.modify',
          'booking.cancel',
          'info.hours',
          'info.menu',
          'info.address',
          'greeting',
          'smalltalk',
          'unknown',
        ],
      },
      confidence: { type: 'number' },
      fields: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          time: { type: 'string' },
          people: { type: 'number' },
          name: { type: 'string' },
          phone: { type: 'string' },
          notes: { type: 'string' },
        },
      },
      missing_fields: {
        type: 'array',
        items: { type: 'string' },
      },
      reply: { type: 'string' },
      next_action: {
        type: 'string',
        enum: [
          'ask_clarification',
          'check_availability',
          'answer_info',
          'smalltalk',
          'handoff',
        ],
      },
    },
    required: ['intent', 'confidence', 'fields', 'next_action'],
  },
};

export async function parseBookingIntent(
  text: string,
  context?: {
    phone?: string;
    tenantName?: string;
    nowIso?: string;
    locale?: string;
    timezone?: string;
  },
): Promise<NluParsed> {
  const locale = context?.locale || process.env.LOCALE || 'it-IT';
  const timezone = context?.timezone || process.env.TIMEZONE || 'Europe/Rome';
  const system = `Sei l'assistente prenotazioni${
    context?.tenantName ? ` di ${context.tenantName}` : ''
  }. Interpreta date/ore in timezone ${timezone} e lingua ${locale}. Parla in modo amichevole e conciso. Se l'utente non prenota rispondi brevemente e chiedi se vuole prenotare.`;

  const messages = [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: text },
  ];

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await openai.chat.completions.create({
        model: MODEL,
        temperature: 0,
        max_tokens: 150,
        messages,
        functions: [toolSchema],
        function_call: 'auto',
      });
      const choice = res.choices[0];
      const fc = choice.message?.function_call;
      if (!fc?.arguments) throw new Error('no function call');
      let json: unknown;
        try {
          json = JSON.parse(fc.arguments);
        } catch {
          throw new Error('invalid json');
        }
      const parsed = NluParsedSchema.safeParse(json);
      if (!parsed.success) {
        throw new Error('validation failed');
      }
      const data = parsed.data;
      const fields = data.fields;
      const missing: string[] = data.missing_fields ? [...data.missing_fields] : [];
      if (fields.date && !/^\d{4}-\d{2}-\d{2}$/.test(fields.date)) {
        delete fields.date;
        missing.push('date');
      }
      if (fields.time && !/^\d{2}:\d{2}$/.test(fields.time)) {
        delete fields.time;
        missing.push('time');
      }
      if (fields.people && fields.people < 1) {
        delete fields.people;
        missing.push('people');
      }
      if (fields.name) fields.name = fields.name.trim();
      if (!fields.phone && context?.phone) fields.phone = context.phone;
      return { ...data, fields, missing_fields: missing };
      } catch (err: unknown) {
        const e = err as { status?: number };
        const status = e.status ?? 0;
        const isRetryable = status === 429 || (status >= 500 && status <= 599);
        logger.warn({ err: e, attempt }, 'openai nlu error');
      if (isRetryable && attempt < maxAttempts) {
        await sleep(500 * Math.pow(3, attempt - 1));
        continue;
      }
      break;
    }
  }

  return {
    intent: 'unknown',
    confidence: 0,
    fields: context?.phone ? { phone: context.phone } : {},
    missing_fields: [],
    reply: 'Posso aiutarti con le prenotazioni o info del locale 😄',
    next_action: 'smalltalk',
  };
}
