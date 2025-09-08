
export const TZ = process.env.TIMEZONE || 'Europe/Rome';

export function toIsoDate(d: Date, tz = TZ): string {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz });
  return fmt.format(d);
}

export function parseRelativeDateToken(
  token: string,
  now = new Date(),
  tz = TZ,
): string | null {
  const t = token.toLowerCase();
  const base = new Date(now);
  switch (t) {
    case 'oggi':
    case 'stasera':
      return toIsoDate(base, tz);
    case 'domani':
      base.setDate(base.getDate() + 1);
      return toIsoDate(base, tz);
    case 'dopodomani':
      base.setDate(base.getDate() + 2);
      return toIsoDate(base, tz);
    default:
      break;
  }

  const dayMap: Record<string, number> = {
    lun: 1,
    mar: 2,
    mer: 3,
    gio: 4,
    ven: 5,
    sab: 6,
    dom: 0,
  };

  const match = t.match(/^(lun|mar|mer|gio|ven|sab|dom)(?:\w+)?(?:\s+prossimo)?$/);
  if (match) {
    const target = dayMap[match[1]];
    const isNext = t.includes('prossim');
    let diff = (target - base.getDay() + 7) % 7;
    if (diff === 0 || isNext) diff += 7;
    base.setDate(base.getDate() + diff);
    return toIsoDate(base, tz);
  }

  return null;
}

export function alignToSlot(timeHHmm: string, slotMinutes: number): {
  ok: boolean;
  time: string;
} {
  const [h, m] = timeHHmm.split(':').map(Number);
  const total = h * 60 + m;
  const aligned = Math.floor(total / slotMinutes) * slotMinutes;
  const hh = String(Math.floor(aligned / 60)).padStart(2, '0');
  const mm = String(aligned % 60).padStart(2, '0');
  return { ok: total === aligned, time: `${hh}:${mm}` };
}

export function addMinutes(hhmm: string, mins: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + mins;
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function toDateTime(dateISO: string, timeHHmm: string): Date {
  return new Date(`${dateISO}T${timeHHmm}:00`);
}

export function formatHuman(dateISO: string, timeHHmm: string): string {
  const d = new Date(`${dateISO}T00:00:00`);
  const fmt = new Intl.DateTimeFormat('it-IT');
  return `${fmt.format(d)} alle ${timeHHmm}`;
}

