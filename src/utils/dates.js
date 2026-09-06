/**
 * Dream date utilities.
 *
 * Dream dates are CALENDAR DATES. The user picks "May 12" and we display
 * "May 12" everywhere, regardless of timezone.
 *
 * Storage convention: noon UTC on the selected calendar date
 *   e.g. user picks "2025-05-12" → stored as "2025-05-12T12:00:00.000Z"
 *
 * Why noon UTC:
 *   - UTC midnight is ambiguous across timezones (UTC+1 reads May 11 as May 12)
 *   - Noon UTC is always the same calendar day in any timezone (UTC-11 to UTC+12)
 *
 * Display: always use UTC date components (getUTCFullYear/Month/Date) so the
 * calendar date in the DB is reproduced exactly, regardless of the viewer's
 * local timezone.
 *
 * Backwards compatibility: older dreams may be stored at UTC midnight or as
 * a non-noon timestamp. `getUtcCalendarDate` handles both by deriving the
 * calendar date from the UTC representation.
 */

import { format } from 'date-fns';

const DATE_INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const isValidDate = (value) => value instanceof Date && !Number.isNaN(value.getTime());

const pad = (n) => String(n).padStart(2, '0');

/**
 * Extract the calendar date stored in a Date as UTC components.
 * Returns a plain {year, month (0-indexed), day} object.
 */
const getUtcCalendarDate = (date) => ({
  year:  date.getUTCFullYear(),
  month: date.getUTCMonth(),   // 0-indexed, same as Date constructor
  day:   date.getUTCDate(),
});

/**
 * Parse a date-input value ("YYYY-MM-DD") into a Date object.
 * Stores as noon UTC of that calendar date so it reads back identically
 * in any timezone.
 */
export const parseDateInputValue = (value) => {
  if (typeof value !== 'string') return null;
  const match = DATE_INPUT_RE.exec(value.trim());
  if (!match) return null;

  const year  = Number(match[1]);
  const month = Number(match[2]);  // 1-indexed from the string
  const day   = Number(match[3]);

  // Store as noon UTC, a safe calendar-date anchor for all timezones
  const stored = new Date(`${match[1]}-${match[2]}-${match[3]}T12:00:00.000Z`);

  // Sanity check: UTC date components should match what we asked for
  if (
    stored.getUTCFullYear() !== year
    || stored.getUTCMonth() + 1 !== month
    || stored.getUTCDate() !== day
  ) {
    return null;
  }

  return stored;
};

/**
 * Format a dream's createdAt Date for display.
 * Always derives the calendar date from UTC components so the stored date
 * is reproduced exactly, regardless of the viewer's local timezone.
 * Handles legacy data (UTC midnight, non-noon timestamps) transparently.
 */
export const formatDreamDate = (value, pattern = 'MMM d, yyyy') => {
  if (!isValidDate(value)) return '';
  const { year, month, day } = getUtcCalendarDate(value);
  // Construct a LOCAL midnight date so date-fns format works without a locale
  const localDate = new Date(year, month, day, 0, 0, 0, 0);
  return format(localDate, pattern);
};

/**
 * Convert a Date to the YYYY-MM-DD string expected by <input type="date">.
 * Uses UTC components so the value shown in the picker matches the stored date.
 */
export const formatDateInputValue = (value) => {
  if (!isValidDate(value)) return '';
  const { year, month, day } = getUtcCalendarDate(value);
  return `${year}-${pad(month + 1)}-${pad(day)}`;
};

/**
 * Return today's date as a YYYY-MM-DD string for the date picker default.
 * Uses local date so "today" matches what the user sees on their device.
 */
export const getTodayDateInputValue = () => {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};
