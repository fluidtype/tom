import OpenAI from 'openai';
import { z } from 'zod';
import logger from '../../config/logger';
import { demoProfile } from '../../config/tenantProfile.demo';
import { parseRelativeDateToken, toIsoDate } from '../../utils/datetime';

export type NluResult = {
  intent: 'booking.create' | 'smalltalk.info' | 'unknown';
  confidence: number;
  fields: {
    date?: string;
    time?: string;
    people?: number;
    name?: string;
    phone?: string;
    notes?: string;
  };
  missing_fields: string[];
  reply?: string;
  next_action: 'check_availability' | 'ask_missing' | 'answer_smalltalk' | 'none';
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const openai: any = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

function detectSmalltalk(text: string): NluResult | null {
  const t = text.toLowerCase();
  if (/(dove|indirizzo|vi trovate)/.test(t)) {
    return {
      intent: 'smalltalk.info',
      confidence: 0.7,
      fields: {},
      missing_fields: [],
      reply: `${demoProfile.address}. Vuoi prenotare? Dimmi quante persone.`,
      next_action: 'answer_smalltalk',
    };
  }
  if (/(orari|aperti|quando|chiusi)/.test(t)) {
    return {
      intent: 'smalltalk.info',
      confidence: 0.7,
      fields: {},
      missing_fields: [],
      reply: `${demoProfile.opening}. Vuoi prenotare? Dimmi quante persone.`,
      next_action: 'answer_smalltalk',
    };
  }
  if (/(men[uù]|piatti|cucina)/.test(t)) {
    return {
      intent: 'smalltalk.info',
      confidence: 0.7,
      fields: {},
      missing_fields: [],
      reply: `Puoi vedere il menu qui: ${demoProfile.menuUrl}. Vuoi prenotare? Dimmi quante persone.`,
      next_action: 'answer_smalltalk',
    };
  }
  if (/parchegg/.test(t)) {
    return {
      intent: 'smalltalk.info',
      confidence: 0.7,
      fields: {},
      missing_fields: [],
      reply: `${demoProfile.parking}. Vuoi prenotare? Dimmi quante persone.`,
      next_action: 'answer_smalltalk',
    };
  }
  if (/(ciao|buongiorno|buonasera)/.test(t)) {
    return {
      intent: 'smalltalk.info',
      confidence: 0.7,
      fields: {},
      missing_fields: [],
      reply: 'Ciao! Vuoi prenotare un tavolo? Dimmi quante persone.',
      next_action: 'answer_smalltalk',
    };
  }
  return null;
}

const strOpt = z
  .string()
  .transform((s) => (typeof s === 'string' && s.trim() !== '' ? s.trim() : undefined))
  .optional();

const extractBookingSchema = z.object({
  intent: z.literal('booking.create'),
  date: strOpt,
  time: strOpt,
  people: z.number().optional(),
  name: strOpt,
  phone: strOpt,
  notes: strOpt,
});

// ✅ Tool definition compatibile con openai@4.56.0 (schema chiuso)
const EXTRACT_BOOKING_TOOL = {
  type: 'function',
  name: 'extract_booking',
  description:
    'Estrai i dettagli della prenotazione da un messaggio naturale in italiano.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      intent: { type: 'string', enum: ['booking.create'] },
      date: { type: 'string', description: 'Data ISO (YYYY-MM-DD)' },
      time: { type: 'string', description: 'Ora HH:mm nel fuso del ristorante' },
      people: { type: 'number', minimum: 1 },
      name: { type: 'string' },
      phone: { type: 'string' },
      notes: { type: 'string' },
    },
    required: ['intent'],
  },
} as const;

export async function parseBookingIntent(
  text: string,
  _context?: { phone?: string; locale?: string; timezone?: string },
): Promise<NluResult> {
  const small = detectSmalltalk(text);
  if (small) return small;

  const wc = text.trim().split(/\s+/).filter(Boolean).length;
  if (wc <= 2) {
    return {
      intent: 'unknown',
      confidence: 0.4,
      fields: {},
      missing_fields: [],
      next_action: 'none',
    };
  }

  let systemPrompt =
    'Sei un NLU per prenotazioni ristorante. Usa SOLO la function extract_booking per estrarre i campi. NESSUN testo libero.';

  logger.debug({ text }, 'nlu input');

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await openai.responses.create({
        model: MODEL,
        input: [
          { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
          { role: 'user', content: [{ type: 'input_text', text }] },
        ],
        tools: [EXTRACT_BOOKING_TOOL],
        temperature: 0.2,
      });

      type RespItem = {
        type: string;
        arguments?: string;
        tool_call?: { function?: { arguments?: string }; arguments?: string };
        content?: Array<{ function_call?: { arguments?: string } }>;
      };

      const output = (res as unknown as { output?: RespItem[] }).output ?? [];

      let argsJson: string | undefined;
      const funcItem = output.find((c) => c.type === 'function_call');
      if (funcItem?.arguments) {
        argsJson = funcItem.arguments;
      }
      if (!argsJson) {
        const toolItem = output.find((c) => c.type === 'tool_call');
        argsJson =
          toolItem?.tool_call?.function?.arguments ??
          toolItem?.tool_call?.arguments ??
          toolItem?.content?.[0]?.function_call?.arguments;
      }

      if (!argsJson) throw new Error('no function call');

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(argsJson);
      } catch {
        throw new Error('invalid json');
      }

      const parsed = extractBookingSchema.safeParse(parsedJson);
      if (!parsed.success) throw new Error('invalid json');

      const fields = parsed.data;

      // Type guard: usa la data solo se è una stringa non vuota
      if (typeof fields.date === 'string' && fields.date.trim() !== '') {
        const rel = parseRelativeDateToken(fields.date);
        if (typeof rel === 'string' && rel.trim() !== '') {
          fields.date = rel;
        }

        const tz = _context?.timezone || 'Europe/Rome';
        const todayIso = toIsoDate(new Date(), tz);

        // new Date() accetta string: fields.date garantito string
        if (new Date(fields.date) < new Date(todayIso)) {
          const tomorrowIso = toIsoDate(
            new Date(Date.now() + 24 * 60 * 60 * 1000),
            tz,
          );
          fields.date = tomorrowIso;
        }
      }
      const missing = ['people', 'date', 'time', 'name'].filter(
        (k) => (fields as Record<string, unknown>)[k] == null,
      );

      logger.debug({ fields, missing }, 'nlu tool result');

      return {
        intent: 'booking.create',
        confidence: 0.9,
        fields,
        missing_fields: missing,
        next_action: missing.length ? 'ask_missing' : 'check_availability',
      };
    } catch (err) {
      logger.warn({ err, attempt }, 'openai nlu warn');
      systemPrompt =
        'Sei un NLU per prenotazioni. RISPOSTA SOLO CON FUNCTION CALL, NESSUN TESTO LIBERO.';
    }
  }

  // Fallback regex parser
  const fields: Record<string, unknown> = {};
  const wordToNumber: Record<string, number> = {
    uno: 1,
    due: 2,
    tre: 3,
    quattro: 4,
    cinque: 5,
    sei: 6,
    sette: 7,
    otto: 8,
    nove: 9,
    dieci: 10,
  };
  const peopleMatch = text.match(/(?:per|siamo in|siamo|x)\s*(\d{1,2}|\w+)/i);
  if (peopleMatch) {
    const raw = peopleMatch[1].toLowerCase();
    const num = wordToNumber[raw] ?? Number(raw);
    if (!Number.isNaN(num)) fields.people = num;
  }
  const dateMatch = text.match(/(\d{1,2}[\/\-]\d{1,2}|oggi|domani)/i);
  if (dateMatch) {
    const d = dateMatch[1].toLowerCase();
    fields.date = d;
  }
  const timeMatch = text.match(/alle\s*(\d{1,2})(?:[:.](\d{2}))?/i);
  if (timeMatch) {
    const hh = timeMatch[1].padStart(2, '0');
    const mm = (timeMatch[2] || '00').padStart(2, '0');
    fields.time = `${hh}:${mm}`;
  }
  const nameMatch = text.match(/a nome\s+(\w+)/i);
  if (nameMatch) fields.name = nameMatch[1];

  if (typeof fields.date === 'string' && fields.date.trim() !== '') {
    let dateStr = fields.date;
    const rel = parseRelativeDateToken(dateStr);
    if (typeof rel === 'string' && rel.trim() !== '') {
      dateStr = rel;
    }

    const tz = _context?.timezone || 'Europe/Rome';
    const todayIso = toIsoDate(new Date(), tz);

    if (new Date(dateStr) < new Date(todayIso)) {
      dateStr = toIsoDate(
        new Date(Date.now() + 24 * 60 * 60 * 1000),
        tz,
      );
    }

    fields.date = dateStr;
  }

  if (Object.keys(fields).length) {
    const missing = ['people', 'date', 'time', 'name'].filter(
      (k) => fields[k] == null,
    );
    logger.debug({ fields, missing }, 'nlu fallback result');
    return {
      intent: 'booking.create',
      confidence: 0.6,
      fields,
      missing_fields: missing,
      next_action: missing.length ? 'ask_missing' : 'check_availability',
    };
  }

  return {
    intent: 'unknown',
    confidence: 0,
    fields: {},
    missing_fields: [],
    next_action: 'none',
  };
}
