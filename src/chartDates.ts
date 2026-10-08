// Recognizing unambiguous calendar dates for chart time axes, and other labels in an order of their
// own.

const MONTH = "(?:0[1-9]|1[0-2])";
const DAY = String.raw`(?:0[1-9]|[12]\d|3[01])`;
const DATE = String.raw`\d{4}-${MONTH}-${DAY}`;
const SLASHED_DATE = String.raw`\d{4}/${MONTH}/${DAY}`;
const TIME = String.raw`(?:[01]\d|2[0-3]):[0-5]\d`;

/**
 * An ISO date and time, perhaps with a fraction of a second and a time zone, which git log
 * --date=iso writes after a space ("2025-10-04 14:02:33 +0200"), and Go programs, as docker ps
 * --format json, also with its name ("2025-10-04 14:02:33 +0200 CEST").
 */
const DATE_TIME = new RegExp(
  String.raw`^(${DATE})[T ](${TIME}(?::[0-5]\d(?:\.\d{1,9})?)?)(?: ?(Z|[+-](?:[01]\d|2[0-3])(?::?[0-5]\d)?)(?: [A-Z]{3,5})?)?$`,
);

/**
 * The date shapes that a column of labels is read as times in, with the name reported for each.
 * Only shapes that cannot be read any other way are here: "01/02/2026" is the second of January in
 * one country and the first of February in another, and a column of years is in practice a set of
 * categories, so both stay labels. The parts are bounded, so "2026-13-01" is no date either.
 */
const DATE_FORMATS: { name: string; pattern: RegExp }[] = [
  { name: "ISO date-times", pattern: DATE_TIME },
  { name: "ISO dates", pattern: new RegExp(`^${DATE}$`) },
  { name: "ISO months", pattern: new RegExp(String.raw`^\d{4}-${MONTH}$`) },
  {
    name: "date-times written YYYY/MM/DD hh:mm",
    pattern: new RegExp(String.raw`^${SLASHED_DATE} ${TIME}(?::[0-5]\d)?$`),
  },
  { name: "dates written YYYY/MM/DD", pattern: new RegExp(`^${SLASHED_DATE}$`) },
];

/**
 * The shape of the dates in a column of labels, which ECharts reads itself on a time axis, or
 * undefined unless every label is a date written the same way.
 */
export function dateFormat(labels: string[]): string | undefined {
  const dates = labels.filter((label) => label !== "");
  if (dates.length === 0) {
    return undefined;
  }
  return DATE_FORMATS.find(({ pattern }) =>
    dates.every((date) => {
      if (!pattern.test(date)) {
        return false;
      }
      if (date.length === 7) {
        return true;
      }
      const year = Number(date.slice(0, 4));
      const month = Number(date.slice(5, 7));
      const day = Number(date.slice(8, 10));
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
      return day <= days;
    }),
  )?.name;
}

/**
 * A date as ECharts reads it on a time axis. ECharts ignores offset minutes and reads short
 * fractions as milliseconds, so zoned times become milliseconds since the epoch, and unzoned ones
 * keep three digits of fraction.
 */
export function timeValue(date: string): string | number {
  const [, day, time, zone] = DATE_TIME.exec(date) ?? [];
  if (zone !== undefined) {
    // Date.parse reads "+02:00" and "+0200", but neither "+02" nor a space before the zone.
    return Date.parse(`${day}T${time}${zone.length === 3 ? `${zone}:00` : zone}`);
  }
  // Keep unzoned times local to the chart viewer and express their fraction in milliseconds.
  return date.replace(
    /\.(\d+)$/,
    (_, fraction: string) => `.${fraction.padEnd(3, "0").slice(0, 3)}`,
  );
}

/**
 * The milliseconds that order a date as `timeValue` gives it. Unzoned times are local to the
 * viewer; the host's time zone orders them alike.
 */
export function timeOrder(time: string | number): number {
  return typeof time === "number" ? time : Date.parse(time.replace(" ", "T").replace(/\//g, "-"));
}

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/** The weekday of a name such as "Mon" or "monday", from 0 for Monday, or -1 for another label. */
function weekday(label: string): number {
  const name = label.toLowerCase();
  return WEEKDAYS.findIndex((day) => name === day || name === day.slice(0, 3));
}

/**
 * What orders categories that are all numbers, all dates written alike or all weekdays, as hours
 * and days of a heatmap of when commits were made, or undefined for other labels.
 */
export function labelOrder(labels: string[]): ((label: string) => number) | undefined {
  if (labels.every((label) => label.trim() !== "" && Number.isFinite(Number(label)))) {
    return Number;
  }
  if (!labels.includes("") && dateFormat(labels) !== undefined) {
    return (label) => timeOrder(timeValue(label));
  }
  return labels.every((label) => weekday(label) >= 0) ? weekday : undefined;
}
