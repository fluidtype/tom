import OpenAI from 'openai';
import { z } from 'zod';
import logger from '../../config/logger';
import { demoProfile } from '../../config/tenantProfile.demo';

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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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

const extractBookingSchema = z.object({
  intent: z.literal('booking.create'),
  date: z.string().optional(),
  time: z.string().optional(),
  people: z.number().optional(),
  name: z.string().optional(),
  phone: z.string().optional(),
  notes: z.string().optional(),
});

export async function parseBookingIntent(
  text: string,
  _context?: { phone?: string; locale?: string; timezone?: string },
): Promise<NluResult> {
  const small = detectSmalltalk(text);
  if (small) return small;

  const systemPrompt =
    'Sei un NLU per prenotazioni ristorante. Usa SOLO la function extract_booking per estrarre i campi. NESSUN testo libero.';
  const messages = [
    { role: 'system', content: [{ type: 'text', text: systemPrompt }] },
    { role: 'user', content: [{ type: 'text', text }] },
  ];

  const tool = {
    type: 'function',
    function: {
      name: 'extract_booking',
      description: 'Estrai i dettagli della prenotazione',
      parameters: {
        type: 'object',
        properties: {
          intent: { type: 'string', enum: ['booking.create'] },
          date: { type: 'string' },
          time: { type: 'string' },
          people: { type: 'number' },
          name: { type: 'string' },
          phone: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['intent'],
      },
      strict: true,
    },
  } as const;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await openai.responses.create({
          model: MODEL,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          input: messages as any,
          temperature: 0.2,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tools: [tool] as any,
          tool_choice: 'required',
        });
      const output = (res as unknown as { output?: Array<{ type: string; tool_call?: { function?: { arguments?: string } } }> }).output || [];
      const call = output.find((c) => c.type === 'tool_call');
      const args = call?.tool_call?.function?.arguments;
      if (!args) throw new Error('no function call');
      const parsed = extractBookingSchema.safeParse(JSON.parse(args));
      if (!parsed.success) throw new Error('invalid json');
      const fields = parsed.data;
      const missing = ['people', 'date', 'time', 'name'].filter(
        (k) => (fields as Record<string, unknown>)[k] == null,
      );
      return {
        intent: 'booking.create',
        confidence: 0.9,
        fields,
        missing_fields: missing,
        next_action: missing.length ? 'ask_missing' : 'check_availability',
      };
    } catch (err) {
      logger.warn({ err, attempt }, 'openai nlu warn');
      messages[0].content = [
        {
          type: 'text',
          text: 'Sei un NLU per prenotazioni. RISPOSTA SOLO CON FUNCTION CALL, NESSUN TESTO LIBERO.',
        },
      ];
    }
  }

  // Fallback regex parser
  const fields: Record<string, unknown> = {};
  const peopleMatch = text.match(/(?:per|siamo in|siamo|x)\s*(\d{1,2})/i);
  if (peopleMatch) fields.people = Number(peopleMatch[1]);
  const dateMatch = text.match(/(\d{1,2}[\/\-]\d{1,2}|oggi|domani)/i);
  if (dateMatch) fields.date = dateMatch[1];
  const timeMatch = text.match(/alle\s*(\d{1,2})(?:[:.](\d{2}))?/i);
  if (timeMatch) {
    const hh = timeMatch[1].padStart(2, '0');
    const mm = (timeMatch[2] || '00').padStart(2, '0');
    fields.time = `${hh}:${mm}`;
  }
  const nameMatch = text.match(/a nome\s+(\w+)/i);
  if (nameMatch) fields.name = nameMatch[1];

  if (Object.keys(fields).length) {
    const missing = ['people', 'date', 'time', 'name'].filter(
      (k) => fields[k] == null,
    );
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
