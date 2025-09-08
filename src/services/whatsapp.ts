// src/services/whatsapp.ts
// Lightweight helper to send outbound WhatsApp messages using fetch.
// Retries on 429 and 5xx responses with exponential backoff.

type LoggerLike = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

type SendTextInput = {
  to: string; // E.164 sender (e.g. "15551234567")
  body: string; // text to send
  phoneNumberId: string; // WhatsApp Phone Number ID
  token: string; // Graph API token
  log?: LoggerLike; // optional logger (req.log or global logger)
};

const GRAPH_BASE = 'https://graph.facebook.com/v20.0';

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function sendTextMessage(input: SendTextInput) {
  const { to, body, phoneNumberId, token, log } = input;

  const url = `${GRAPH_BASE}/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body },
  };

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  const maxAttempts = 3; // initial try + 2 retries
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      const isRetryable = res.status === 429 || (res.status >= 500 && res.status <= 599);

      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        // ignore JSON parse errors
      }

      if (!res.ok) {
        (log || console).warn({ status: res.status, json, attempt }, 'wa outbound not ok');
        if (isRetryable && attempt < maxAttempts) {
          const wait = 500 * Math.pow(3, attempt - 1);
          await sleep(wait);
          continue;
        }
        return { ok: false, status: res.status, data: json ?? null };
      }

      (log || console).info({ attempt, json }, 'wa outbound ok');
      return { ok: true, status: res.status, data: json ?? null };
    } catch (err: unknown) {
      (log || console).error({ err, attempt }, 'wa outbound error thrown');
      if (attempt < maxAttempts) {
        const wait = 500 * Math.pow(3, attempt - 1);
        await sleep(wait);
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 0, data: null, error: message };
    }
  }

  return { ok: false, status: 0, data: null };
}
