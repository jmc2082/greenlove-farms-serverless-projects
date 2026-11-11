// Local delivery schedule. Keep in step with the website's `static-data/site.ts` → deliveryRules
// (still listed as unconfirmed in the frontend's open-decisions.md). Pickup happens on the same days.
export const DELIVERY_RULES = {
  timeZone: 'America/Chicago',
  slots: [
    { deliveryDow: 2, cutoffDow: 0, cutoffHour: 18 }, // Tuesday, order by Sunday 6 PM
    { deliveryDow: 4, cutoffDow: 2, cutoffHour: 18 }, // Thursday, order by Tuesday 6 PM
  ],
} as const;

const DAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const LOOKAHEAD_DAYS = 60;

// Wall-clock parts of `at` in `timeZone`.
function wallClock(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    dow: DAY_INDEX[get('weekday')] ?? 0,
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
  };
}

// The UTC instant of a wall-clock time in `timeZone` (handles daylight saving).
function zonedToUtc(year: number, month: number, day: number, hour: number, timeZone: string): Date {
  const target = Date.UTC(year, month - 1, day, hour);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const w = wallClock(new Date(guess), timeZone);
    const shownAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
    guess += target - shownAsUtc;
  }
  return new Date(guess);
}

export interface LocalDelivery {
  date: string;  // delivery or pickup day, YYYY-MM-DD in farm time
  orderBy: Date; // order cutoff for that day
}

/**
 * The next `count` delivery days whose cutoff hasn't passed and that are at least `minDays` calendar days
 * away (time to prepare the order), soonest first.
 */
export function upcomingLocalDeliveries(now: Date, minDays = 0, count = 1): LocalDelivery[] {
  const { timeZone, slots } = DELIVERY_RULES;
  const today = wallClock(now, timeZone);
  const found: LocalDelivery[] = [];

  for (let k = Math.max(0, minDays); k <= LOOKAHEAD_DAYS && found.length < count; k++) {
    const dow = (today.dow + k) % 7;
    for (const slot of slots) {
      if (slot.deliveryDow !== dow) continue;
      const cutoffOffset = k - ((slot.deliveryDow - slot.cutoffDow + 7) % 7);
      const orderBy = zonedToUtc(today.year, today.month, today.day + cutoffOffset, slot.cutoffHour, timeZone);
      if (orderBy.getTime() <= now.getTime()) continue;
      const date = new Date(Date.UTC(today.year, today.month - 1, today.day + k)).toISOString().slice(0, 10);
      found.push({ date, orderBy });
    }
  }
  return found;
}

// First upcoming delivery day (see upcomingLocalDeliveries). Null only if the schedule has no slots.
export const nextLocalDelivery = (now: Date, minDays = 0): LocalDelivery | null =>
  upcomingLocalDeliveries(now, minDays, 1)[0] ?? null;

// Calendar year in farm time (order numbers restart each year).
export const farmYear = (at: Date) => wallClock(at, DELIVERY_RULES.timeZone).year;
