// In-memory session store. NOT suitable for multi-process or cluster setups.
// Provides pending booking storage with TTL and outbound deduplication timestamps.

export type PendingBooking = {
  date: string; // ISO YYYY-MM-DD
  time: string; // HH:mm
  people: number;
  name: string;
  notes?: string;
  expiresAt: number; // epoch ms
};

export type SessionData = {
  pendingBooking?: PendingBooking;
  lastOutboundAt?: number;
};

export const DEFAULT_TTL_MS = Number(process.env.SESSION_PENDING_TTL_MS || 600_000);

const store = new Map<string, SessionData>();

function key(tenantId: string, phone: string): string {
  return `${tenantId}:${phone}`;
}

export function getSession(tenantId: string, phone: string): SessionData {
  const k = key(tenantId, phone);
  const s = store.get(k);
  if (!s) {
    const fresh: SessionData = {};
    store.set(k, fresh);
    return fresh;
  }
  return s;
}

export function setPending(
  tenantId: string,
  phone: string,
  payload: Omit<PendingBooking, 'expiresAt'>,
  ttlMs: number = DEFAULT_TTL_MS,
): void {
  const expiresAt = Date.now() + ttlMs;
  const s = getSession(tenantId, phone);
  s.pendingBooking = { ...payload, expiresAt };
  store.set(key(tenantId, phone), s);
}

export function clearSession(tenantId: string, phone: string): void {
  store.delete(key(tenantId, phone));
}

export function getPendingIfValid(tenantId: string, phone: string): PendingBooking | undefined {
  const s = getSession(tenantId, phone);
  const pending = s.pendingBooking;
  if (!pending) return undefined;
  if (pending.expiresAt < Date.now()) {
    store.delete(key(tenantId, phone));
    return undefined;
  }
  return pending;
}

export function setLastOutboundNow(tenantId: string, phone: string): void {
  const s = getSession(tenantId, phone);
  s.lastOutboundAt = Date.now();
  store.set(key(tenantId, phone), s);
}

export default {
  getSession,
  setPending,
  clearSession,
  getPendingIfValid,
  setLastOutboundNow,
};
