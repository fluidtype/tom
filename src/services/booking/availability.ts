import { tenantRules } from './rules.index';
import { prisma } from '../../db/client';
import { addMinutes, toDateTime } from '../../utils/datetime';

function toMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

export async function checkAvailability(
  tenantSlug: string,
  date: string,
  time: string,
  people: number,
  opts?: { tenantId?: string },
) {
  const rules = tenantRules[tenantSlug];
  if (!rules) return { ok: false, reason: 'rules_not_found' };

  // day of week from date
  const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const dayKey = dayNames[new Date(date).getDay()];
  const ranges: string[] = rules.openingHours[dayKey] || [];
  if (!ranges.length) return { ok: false, reason: 'closed' };

  const timeMin = toMinutes(time);
  const duration = rules.tableDuration;

  // check slot alignment
  if (timeMin % rules.slotMinutes !== 0) {
    return { ok: false, reason: 'invalid_slot' };
  }

  // ensure time is within opening hours and duration fits
  const inRange = ranges.some((r) => {
    const [start, end] = r.split('-').map(toMinutes);
    return timeMin >= start && timeMin + duration <= end;
  });
  if (!inRange) return { ok: false, reason: 'outside_opening' };

  if (people > rules.capacity) {
    return { ok: false, reason: 'capacity_exceeded' };
  }

  if (opts?.tenantId) {
    const startAt = toDateTime(date, time);
    const endAt = toDateTime(date, addMinutes(time, duration));
    const bookings = await prisma.booking.findMany({
      where: {
        tenantId: opts.tenantId,
        status: { in: ['pending', 'confirmed'] },
        startAt: { lt: endAt },
        endAt: { gt: startAt },
      },
      select: { people: true },
    });
    const already = bookings.reduce(
      (sum: number, b: { people: number }) => sum + b.people,
      0,
    );
    if (already + people > rules.capacity) {
      return { ok: false, reason: 'capacity_exceeded' };
    }
  }

  return { ok: true, reason: 'available' };
}

export async function suggestAlternatives(
  tenantSlug: string,
  date: string,
  time: string,
  people: number,
  opts?: { tenantId?: string },
) {
  const rules = tenantRules[tenantSlug];
  if (!rules) return [] as string[];
  const candidates: string[] = [];
  const minutes = [ -rules.slotMinutes, rules.slotMinutes, rules.slotMinutes * 2, -rules.slotMinutes * 2 ];
  for (const diff of minutes) {
    const t = addMinutes(time, diff);
    const avail = await checkAvailability(tenantSlug, date, t, people, opts);
    if (avail.ok) candidates.push(t);
    if (candidates.length >= 3) break;
  }
  return candidates;
}

export async function listFreeSlots(
  tenantSlug: string,
  date: string,
  people: number,
  opts?: { tenantId?: string; limit?: number },
): Promise<string[]> {
  const rules = tenantRules[tenantSlug];
  if (!rules) return [];
  const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const dayKey = dayNames[new Date(date).getDay()];
  const ranges: string[] = rules.openingHours[dayKey] || [];
  const slots: string[] = [];
  const limit = opts?.limit ?? 5;

  for (const r of ranges) {
    const [start, end] = r.split('-').map(toMinutes);
    for (let m = start; m + rules.tableDuration <= end; m += rules.slotMinutes) {
      const hh = String(Math.floor(m / 60)).padStart(2, '0');
      const mm = String(m % 60).padStart(2, '0');
      const t = `${hh}:${mm}`;
      const avail = await checkAvailability(tenantSlug, date, t, people, opts);
      if (avail.ok) slots.push(t);
      if (slots.length >= limit) return slots;
    }
  }
  return slots;
}
