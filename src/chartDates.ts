// Recognizing unambiguous calendar dates for chart time axes.

/**
 * The date shapes that a column of labels is read as times in, with the name reported for each.
 * Only shapes that cannot be read any other way are here: "01/02/2026" is the second of January in
 * one country and the first of February in another, and a column of years is in practice a set of
 * categories, so both stay labels. The parts are bounded, so "2026-13-01" is no date either.
 */
const DATE_FORMATS: { name: string; pattern: RegExp }[] = [
  {
    name: "ISO date-times",
    pattern:
      /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?$/,
  },
  { name: "ISO dates", pattern: /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/ },
  { name: "ISO months", pattern: /^\d{4}-(?:0[1-9]|1[0-2])$/ },
  {
    name: "dates written YYYY/MM/DD",
    pattern: /^\d{4}\/(?:0[1-9]|1[0-2])\/(?:0[1-9]|[12]\d|3[01])$/,
  },
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
