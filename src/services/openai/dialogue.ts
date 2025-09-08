import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

export async function generateReply(input: {
  history: Array<{ role: 'user' | 'assistant'; text: string }>;
  intent:
    | 'booking.create'
    | 'booking.modify'
    | 'booking.cancel'
    | 'booking.list'
    | 'availability.query'
    | 'info.menu'
    | 'info.address'
    | 'info.opening'
    | 'info.parking'
    | 'greeting'
    | 'smalltalk.info'
    | 'unknown'
    | 'general.chat';
  fields?: { date?: string; time?: string; people?: number; name?: string; notes?: string; booking_id?: string };
  list_bookings?: Array<{ id: string; date: string; time: string; people: number; name: string; status: string }>;
  user_id?: string;
  toolsResult?: Record<string, unknown>;
  restaurantProfile: { name: string; address?: string; opening?: string; menuUrl?: string; parking?: string };
}): Promise<string> {
  const { history, intent, fields, list_bookings = [], user_id = '', toolsResult, restaurantProfile } = input;
  const system = `Tu sei Tom, assistente del ristorante ${restaurantProfile.name}. Stai parlando con ${user_id}. History: ${JSON.stringify(history.slice(-20))}. Prenotazioni: ${JSON.stringify(list_bookings)}. Info: Address ${restaurantProfile.address || 'Via Roma 1, Milano'}; Opening ${restaurantProfile.opening || '12-15 e 19-23'}; Menu ${restaurantProfile.menuUrl || 'bit.ly/menu-demo'}; Parking ${restaurantProfile.parking || 'Disponibile vicino'}. Basato su intent ${intent}, fields ${JSON.stringify(fields)}, genera response_text naturale, breve, italiano, amichevole. Per 'info.menu' usa menuUrl. Per 'booking.list' elenca da list_bookings. Reindirizza unknown a prenotazioni.`;
  const userPayload = { history, intent, fields: fields || {}, list_bookings, user_id, toolsResult: toolsResult || {}, restaurantProfile };
  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(userPayload) },
      ],
      temperature: 0.5,
      response_format: { type: 'json_object' },
    });
    const parsed = JSON.parse(completion.choices[0].message.content || '{}');
    return parsed.response_text || 'Posso aiutarti con prenotazioni?';
  } catch (err) {
    return 'Grazie! Come posso aiutarti oggi?';
  }
}

export default { generateReply };
