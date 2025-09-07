import { randomInt } from 'node:crypto';

// Simple NLG helper returning one of multiple variants for a key.
// Allows optional parameters replacement using {{key}} syntax.

const RESPONSES: Record<string, string[]> = {
  hello: [
    'Ciao! Sono Tom, come posso aiutarti?',
    'Ehi! Qui Tom, pronto a prendere una prenotazione? 😊',
    'Ciao! Tutto bene? Dimmi pure se vuoi prenotare.'
  ],
  ask_missing_generic: ['Mi servono ancora alcune informazioni.', 'Per completare ho bisogno di qualche dettaglio in più.'],
  ask_people: ['Quante persone siete?', 'Per quante persone?'],
  ask_date: ['Che giorno ti interessa?', 'Per quale data?'],
  ask_time: ['A che ora vorresti venire?', 'Quale orario preferisci?'],
  ask_name: ['A nome di chi faccio la prenotazione?', 'Come ti chiami?'],
  propose_summary: ['Perfetto! Tavolo per {{people}} il {{date}} alle {{time}} a nome {{name}}.'],
  confirm_hint: ['Scrivi "confermo" per fissare, oppure dimmi un altro orario.'],
  no_availability_with_alts: ['A quell\'ora siamo al completo, posso proporti degli orari alternativi.'],
  availability_list_intro: ['Ecco alcuni orari liberi:'],
  modify_diff_prompt: ['Aggiorno così: {{diff}}. Confermi?'],
  cancel_confirm: ['Sei sicuro di voler annullare la prenotazione? Scrivi "confermo" per procedere.'],
  cancel_done: ['Prenotazione annullata. Se vuoi rifissare sono qui.'],
  error_retry: ['Ops, qualcosa è andato storto. Riproviamo?']
};

export function say(key: string, params: Record<string, string | number> = {}): string {
  const variants = RESPONSES[key] || [''];
  const variant = variants[randomInt(variants.length)];
  return variant.replace(/{{(\w+)}}/g, (_, p) => String(params[p] ?? ''));
}

export default { say };
