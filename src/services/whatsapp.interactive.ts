
import type { Logger } from 'pino';

type SendOpts = {
  to: string;
  phoneNumberId: string;
  token: string;
  title?: string;
  options: string[];
  log?: Logger;
};

export async function sendTimeOptions({
  to,
  phoneNumberId,
  token,
  title = 'Scegli un orario',
  options,
  log,
}: SendOpts) {
  const rows = options.map((o) => ({ id: `slot_${o}`, title: o }));
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: title },
      action: {
        button: 'Orari',
        sections: [{ title: 'Orari liberi', rows }],
      },
    },
  };
  return sendRaw({ phoneNumberId, token, payload, log });
}

type ConfirmOpts = {
  to: string;
  phoneNumberId: string;
  token: string;
  text: string;
  log?: Logger;
};

export async function sendConfirmButtons({
  to,
  phoneNumberId,
  token,
  text,
  log,
}: ConfirmOpts) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'confirm', title: 'Confermo' } },
          { type: 'reply', reply: { id: 'cancel', title: 'Annulla' } },
        ],
      },
    },
  };
  return sendRaw({ phoneNumberId, token, payload, log });
}

type SendBookingListOpts = {
  to: string;
  phoneNumberId: string;
  token: string;
  title?: string;
  bookings: Array<{ id: string; date: string; time: string; people: number; name: string }>;
  log?: Logger;
};

export async function sendBookingList({
  to,
  phoneNumberId,
  token,
  title = 'Scegli prenotazione',
  bookings,
  log,
}: SendBookingListOpts) {
  const rows = bookings.map((b) => ({
    id: `booking_${b.id}`,
    title: `${b.date} ${b.time} (${b.people} persone)`,
  }));
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: title },
      action: {
        button: 'Prenotazioni',
        sections: [{ title: 'Le tue prenotazioni', rows }],
      },
    },
  };
  return sendRaw({ phoneNumberId, token, payload, log });
}

type RawArgs = { phoneNumberId: string; token: string; payload: unknown; log?: Logger };
async function sendRaw({ phoneNumberId, token, payload, log }: RawArgs): Promise<boolean> {
  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    log?.warn({ status: res.status }, 'wa interactive not ok');
    return false;
  }
  log?.info({ status: res.status }, 'wa interactive ok');
  return true;
}
