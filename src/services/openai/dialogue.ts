import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

export async function generateReply(input: {
  history: Array<{ role: 'user' | 'assistant'; text: string }>;
  intent: 'booking.create' | 'booking.modify' | 'booking.cancel' | 'availability.query' | 'greeting' | 'smalltalk.info' | 'unknown' | 'general.chat';
  fields?: { date?: string; time?: string; people?: number; name?: string; notes?: string };
  toolsResult?: Record<string, unknown>;
  restaurantProfile: { name: string; address?: string; opening?: string; menuUrl?: string; parking?: string };
}): Promise<string> {
  const { history, intent, fields, toolsResult, restaurantProfile } = input;
  const system = `Sei Tom, assistente virtuale del ristorante ${restaurantProfile.name}.
Rispondi come un cameriere umano su WhatsApp: cortese, colloquiale, frasi brevi, emoji minime.
Compito: prenotazioni, disponibilità, modifiche, cancellazioni, info base (indirizzo, orari, menu).
Non inventare servizi. Non dire mai che sei un bot.
Usa i dati forniti in input (history, fields, toolsResult). Non inventare dati mancanti.
Se il messaggio non riguarda il ristorante (es. Bitcoin, meteo, politica), rispondi con gentilezza e reindirizza:
- riconosci la richiesta
- spiega che ti occupi solo del ristorante
- proponi cosa puoi fare ora (es. mostrare orari liberi, iniziare prenotazione).
Non usare tool esterni. Non fornire numeri/quote di mercato o meteo.`;

  const userPayload = {
    history: history.slice(-5),
    intent,
    fields: fields || {},
    toolsResult: toolsResult || {},
    restaurantProfile,
  };

  const res = await openai.responses.create({
    model: MODEL,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: system }] },
      { role: 'user', content: [{ type: 'input_text', text: JSON.stringify(userPayload) }] },
    ],
    temperature: 0.5,
  });

  const out = (res as unknown as { output?: Array<{ content?: Array<{ text?: string }> }> })
    .output?.[0]?.content?.[0]?.text;
  return (out || '').trim() ||
    'Certo! Posso aiutarti con prenotazioni, orari e disponibilità. Da dove partiamo?';
}

export default { generateReply };
