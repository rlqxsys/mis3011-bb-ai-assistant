export const MINUTE = 60_000;
export const DAY = 86_400_000;
export const ms = value => Date.parse(value);
export const iso = value => new Date(value).toISOString();
export const validTime = value => typeof value === 'string' && Number.isFinite(ms(value));
export const localDate = value => new Date(ms(value) + 8 * 60 * MINUTE).toISOString().slice(0, 10);
export const localClock = value => new Date(ms(value) + 8 * 60 * MINUTE).toISOString().slice(11, 16);
export const atLocal = (date, clock) => `${date}T${clock}:00+08:00`;
export const intersects = (a, b) => ms(a.start) < ms(b.end) && ms(b.start) < ms(a.end);
export const duration = block => (ms(block.end) - ms(block.start)) / MINUTE;
export const weekday = date => new Date(`${date}T12:00:00+08:00`).getUTCDay();
export const nextDate = (date, days = 1) => localDate(iso(ms(`${date}T12:00:00+08:00`) + days * DAY));

const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const monthWord = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';

// Dates without a clock remain dates, never invented 23:59 deadlines.
export function extractDeadline(text, year) {
  const lines = text.split(/\n|(?<=[.!])\s+(?=[A-Z])/).filter(line => /\bdue\b|deadline/i.test(line));
  for (const line of lines) {
    const forward = line.match(new RegExp(`${monthWord}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*\\([^)]*\\))?(?:\\s*,?\\s*(20\\d{2}))?`, 'i'));
    const reverse = line.match(new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s*${monthWord}\\.?(?:\\s*\\([^)]*\\))?(?:\\s*,?\\s*(20\\d{2}))?`, 'i'));
    const match = forward || reverse;
    if (!match) continue;
    const month = months[(forward ? match[1] : match[2]).slice(0, 3).toLowerCase()];
    const day = Number(forward ? match[2] : match[1]);
    const resolvedYear = Number(match[3] || year);
    const date = `${resolvedYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (!validTime(atLocal(date, '12:00')) || localDate(atLocal(date, '12:00')) !== date) continue;
    const clock = line.match(/\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/i);
    const clock24 = !clock && line.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    let time = null;
    if (clock && Number(clock[1]) >= 1 && Number(clock[1]) <= 12 && Number(clock[2] || 0) < 60) {
      const hour = Number(clock[1]) % 12 + (clock[3].toLowerCase() === 'pm' ? 12 : 0);
      time = `${String(hour).padStart(2, '0')}:${clock[2] || '00'}`;
    } else if (clock24) time = `${clock24[1].padStart(2, '0')}:${clock24[2]}`;
    return { date, at: time ? atLocal(date, time) : null, precision: time ? 'minute' : 'date', yearInferred: !match[3] };
  }
  return null;
}

// Blackboard source dates here use China Standard Time, not US Central Time.
export function parsePosted(raw) {
  const value = (raw || '').replace(/^Posted on:\s*/i, '').replace(/CST\s*$/, '+0800');
  return Number.isFinite(Date.parse(value)) ? iso(Date.parse(value)) : null;
}

export function quietUntil(value, quiet) {
  if (!quiet || quiet.start === quiet.end) return value;
  const clock = localClock(value), date = localDate(value);
  if (quiet.start > quiet.end) {
    if (clock >= quiet.start) return atLocal(nextDate(date), quiet.end);
    if (clock < quiet.end) return atLocal(date, quiet.end);
  } else if (clock >= quiet.start && clock < quiet.end) return atLocal(date, quiet.end);
  return value;
}
