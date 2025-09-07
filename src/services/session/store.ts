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
  pendingCancel?: { bookingId: string; expiresAt: number };
  pendingModify?: {
    bookingId: string;
    date?: string;
    time?: string;
    people?: number;
    notes?: string;
    expiresAt: number;
  };
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

export function setPendingCancel(
  tenantId: string,
  phone: string,
  bookingId: string,
  ttlMs: number = DEFAULT_TTL_MS,
): void {
  const s = getSession(tenantId, phone);
  s.pendingCancel = { bookingId, expiresAt: Date.now() + ttlMs };
  store.set(key(tenantId, phone), s);
}

export function getPendingCancelIfValid(
  tenantId: string,
  phone: string,
): { bookingId: string } | undefined {
  const s = getSession(tenantId, phone);
  const p = s.pendingCancel;
  if (!p) return undefined;
  if (p.expiresAt < Date.now()) {
    delete s.pendingCancel;
    return undefined;
  }
  return { bookingId: p.bookingId };
}

export function clearPendingCancel(tenantId: string, phone: string): void {
  const s = getSession(tenantId, phone);
  delete s.pendingCancel;
}

export function setPendingModify(
  tenantId: string,
  phone: string,
  payload: { bookingId: string; date?: string; time?: string; people?: number; notes?: string },
  ttlMs: number = DEFAULT_TTL_MS,
): void {
  const s = getSession(tenantId, phone);
  s.pendingModify = { ...payload, expiresAt: Date.now() + ttlMs };
  store.set(key(tenantId, phone), s);
}

export function getPendingModifyIfValid(
  tenantId: string,
  phone: string,
): {
  bookingId: string;
  date?: string;
  time?: string;
  people?: number;
  notes?: string;
} | undefined {
  const s = getSession(tenantId, phone);
  const p = s.pendingModify;
  if (!p) return undefined;
  if (p.expiresAt < Date.now()) {
    delete s.pendingModify;
    return undefined;
  }
  return p;
}

export function clearPendingModify(tenantId: string, phone: string): void {
  const s = getSession(tenantId, phone);
  delete s.pendingModify;
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
  setPendingCancel,
  getPendingCancelIfValid,
  clearPendingCancel,
  setPendingModify,
  getPendingModifyIfValid,
  clearPendingModify,
  setLastOutboundNow,
};
