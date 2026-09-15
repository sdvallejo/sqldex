/**
 * Reading a date literal the one way this rule set trusts, and judging what it reads.
 *
 * `schema/invalid-date-default` and `query/write-value-invalid-for-type` both ask the same three
 * questions of a date-shaped string — does it have a zero month or day, is it impossible on the
 * calendar, is its time of day impossible — against a live server's own answers
 * (`robust-seeking-octopus.md`, "Resultado del paso 0"). A second reading of the calendar would
 * drift from the first, and the drift would show up as one rule accepting a default the other
 * refuses as a write.
 */

export interface ParsedDate {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
}

/** MySQL's canonical spelling, single digits allowed: `YYYY-M-D[ H:M:S[.f]]`. */
const DATE_SHAPE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?: (\d{1,2}):(\d{1,2}):(\d{1,2})(?:\.\d+)?)?$/;

/**
 * Reads `text` as `YYYY-M-D[ H:M:S[.f]]`, or `undefined` for any other shape — `'20200515'`,
 * `'2020/05/15'`, free text. Recognising only this one spelling is deliberate: guessing at every
 * format MySQL's own parser tolerates would be arguing with strings neither rule can read with
 * confidence, which is why both stand down on the rest rather than risk a false positive.
 */
export function parseDateShape(text: string): ParsedDate | undefined {
  const m = DATE_SHAPE.exec(text);
  if (!m) return undefined;
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: m[4] !== undefined ? Number(m[4]) : undefined,
    minute: m[5] !== undefined ? Number(m[5]) : undefined,
    second: m[6] !== undefined ? Number(m[6]) : undefined,
  };
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/**
 * Is the month or the day zero? The one shape `NO_ZERO_IN_DATE`/`NO_ZERO_DATE` refuse and MariaDB,
 * or a server with `sql_mode=''`, accepts outright — a whole zero date (`'0000-00-00'`) included,
 * since that is a zero month and a zero day at once. A year alone at zero is not this: MySQL
 * accepts `'0000-05-15'` regardless of mode, so it is not read as a defect here.
 */
export function hasZeroField(date: ParsedDate): boolean {
  return date.month === 0 || date.day === 0;
}

/**
 * Is the date impossible on the calendar — a month outside 1-12, or a day past the end of its
 * month? Both engines refuse this one outright, in every mode: a zero field is a separate
 * question, `hasZeroField`'s, and is not read as impossible here.
 */
export function isImpossibleDate(date: ParsedDate): boolean {
  if (date.month === 0 || date.day === 0) return false;
  if (date.month < 1 || date.month > 12) return true;
  const days = date.month === 2 && isLeapYear(date.year) ? 29 : DAYS_IN_MONTH[date.month - 1]!;
  return date.day > days;
}

/**
 * Is the time of day impossible — an hour past 23, or a minute or second past 59? MySQL has no
 * leap seconds, so `:60` is refused exactly like any other out-of-range field.
 */
export function isImpossibleTime(date: ParsedDate): boolean {
  if (date.hour === undefined) return false;
  return date.hour > 23 || date.minute! > 59 || date.second! > 59;
}
