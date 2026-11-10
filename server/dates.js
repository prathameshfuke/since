// Resolves date phrases ("Monday", "last Tuesday", "3 November", "two weeks ago") against
// today's date in the user's timezone. Deterministic on purpose: a model guessing which
// Tuesday "last Tuesday" means is a bug we can remove with ~100 lines of arithmetic.

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };

const pad = (n) => String(n).padStart(2, '0');
const toYmd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const fromYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };

export const addDays = (s, n) => { const d = fromYmd(s); d.setUTCDate(d.getUTCDate() + n); return toYmd(d); };
export const weekdayOf = (s) => fromYmd(s).getUTCDay();
const isReal = (s) => toYmd(fromYmd(s)) === s; // rejects 30 February

/** Calendar day (YYYY-MM-DD) of an instant in a timezone. Falls back to UTC on a bad zone. */
export function dayKey(when, tz = 'UTC') {
  const d = when instanceof Date ? when : new Date(when);
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch {
    return toYmd(d);
  }
}

export const prettyDay = (s) =>
  new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(fromYmd(s));

/** Most recent given weekday strictly before `today` (never today itself). */
function lastWeekday(today, wd) {
  let back = (weekdayOf(today) - wd + 7) % 7;
  if (back === 0) back = 7;
  return addDays(today, -back);
}

/** Month/day with optional year. No year means the most recent such date on or before today. */
function monthDay(today, month, day, year) {
  const y = year ? Number(year) : Number(today.slice(0, 4));
  let c = `${y}-${pad(month)}-${pad(day)}`;
  if (!isReal(c)) return null;
  if (!year && c > today) c = `${y - 1}-${pad(month)}-${pad(day)}`;
  return isReal(c) ? c : null;
}

const monthIndex = (m) => MONTHS.indexOf(m.slice(0, 3)) + 1;

/** Does this ref (a range, plus an optional second candidate day) cover the given day? */
export const refMatches = (r, day) => (day >= r.start && day <= r.end) || day === r.alt;

/**
 * @returns {{ today: string, weekday: string, refs: {phrase: string, start: string, end: string}[] }}
 * Each ref is an inclusive YYYY-MM-DD range (start === end for a single day).
 */
export function resolveDates(text, now = new Date(), tz = 'UTC') {
  const today = dayKey(now, tz);
  const refs = [];
  let rest = ` ${text.toLowerCase()} `;

  // Replaces each match with spaces so later patterns cannot re-read the same words.
  const take = (re, fn) => {
    rest = rest.replace(re, (...m) => {
      const r = fn(m);
      if (!r) return m[0];
      refs.push({ phrase: m[0].trim(), start: r[0], end: r[1] ?? r[0], ...(r[2] ? { alt: r[2] } : {}) });
      return ' '.repeat(m[0].length);
    });
  };

  take(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => {
    const s = `${m[1]}-${m[2]}-${m[3]}`;
    return isReal(s) ? [s] : null;
  });
  take(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b(?:,?\\s+(\\d{4}))?`, 'g'), (m) => {
    const d = monthDay(today, monthIndex(m[2]), Number(m[1]), m[3]);
    return d ? [d] : null;
  });
  take(new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, 'g'), (m) => {
    const d = monthDay(today, monthIndex(m[1]), Number(m[2]), m[3]);
    return d ? [d] : null;
  });

  take(/\bday before yesterday\b/g, () => [addDays(today, -2)]);
  take(/\byesterday\b/g, () => [addDays(today, -1)]);
  take(/\b(?:earlier )?today\b/g, () => [today]);

  take(/\b(\d+|an?|one|two|three|four|five|six|seven)\s+(day|week|month)s?\s+ago\b/g, (m) => {
    const n = NUM_WORDS[m[1]] ?? Number(m[1]);
    if (m[2] === 'day') return [addDays(today, -n)];
    if (m[2] === 'week') return [addDays(today, -7 * n - 1), addDays(today, -7 * n + 1)];
    const d = fromYmd(today);
    d.setUTCMonth(d.getUTCMonth() - n);
    const c = toYmd(d);
    return [addDays(c, -3), addDays(c, 3)];
  });

  take(/\b(?:last|past|previous)\s+(\d+|an?|one|two|three|four|five|six|seven)\s+(day|week)s?\b/g, (m) => {
    const n = (NUM_WORDS[m[1]] ?? Number(m[1])) * (m[2] === 'week' ? 7 : 1);
    return n >= 1 && n <= 366 ? [addDays(today, -(n - 1)), today] : null;
  });

  const thisMonday = addDays(today, -((weekdayOf(today) + 6) % 7));
  take(/\blast week\b/g, () => [addDays(thisMonday, -7), addDays(thisMonday, -1)]);
  take(/\bthis week\b/g, () => [thisMonday, today]);
  take(/\blast month\b/g, () => {
    const first = `${today.slice(0, 7)}-01`;
    const end = addDays(first, -1);
    return [`${end.slice(0, 7)}-01`, end];
  });

  take(new RegExp(`\\b(?:(last|this|on|since|from)\\s+)?(${WEEKDAYS.join('|')})\\b`, 'g'), (m) => {
    const wd = WEEKDAYS.indexOf(m[2]);
    if (m[1] === 'this' && wd === weekdayOf(today)) return [today];
    const day = lastWeekday(today, wd);
    // "last Tuesday" said on a Wednesday is genuinely ambiguous: yesterday, or the Tuesday a week
    // earlier. Keep both days; recall tries both and the model sees the dates.
    return m[1] === 'last' && day >= thisMonday ? [day, day, addDays(day, -7)] : [day];
  });

  const wdName = WEEKDAYS[weekdayOf(today)];
  return { today, weekday: wdName[0].toUpperCase() + wdName.slice(1), refs };
}
