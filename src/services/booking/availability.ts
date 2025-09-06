import { tenantRules } from './rules.index';

function toMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

export function checkAvailability(
  tenantSlug: string,
  date: string,
  time: string,
  people: number,
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

  // TODO: consider existing bookings from DB to adjust capacity

  return { ok: true, reason: 'available' };
}
