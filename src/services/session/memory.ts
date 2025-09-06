// src/services/session/memory.ts
export type BookingSession = {
  name?: string;
  phone?: string;
  people?: number;
  date?: string; // YYYY-MM-DD
  time?: string; // HH:mm
  notes?: string;
  lastUpdate: number;
};

const TTL_MS = 30 * 60 * 1000; // 30 minuti
const store = new Map<string, BookingSession>();

export function getSession(key: string): BookingSession {
  const now = Date.now();
  const existing = store.get(key);
  if (existing && now - existing.lastUpdate < TTL_MS) return existing;
  const fresh: BookingSession = { lastUpdate: now };
  store.set(key, fresh);
  return fresh;
}

export function saveSession(key: string, partial: Partial<BookingSession>) {
  const now = Date.now();
  const current = getSession(key);
  const next: BookingSession = { ...current, ...partial, lastUpdate: now };
  store.set(key, next);
  return next;
}

export function clearSession(key: string) {
  store.delete(key);
}
