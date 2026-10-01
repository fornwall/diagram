// Reading numbers as data and command output write them: with thousands separators or decimal
// commas, signs, currencies, percentages and sizes in bytes.

import type { Cell } from "./data";

/** What a column's numbers measure, as written in the data ("12%", "1.5G") or its name ("%CPU"). */
export type Unit = "%" | "bytes";

/** A percent sign, or a unit of bytes: "B", "K", "kB", "KiB", "Ki" and so on. */
const SUFFIX = "%|Bi?|[KMGTPEk](?:i?B|i)?";

/** A sign, which may be a typeset minus (−), and a currency symbol, as in "-$5". */
const PREFIX = "([-+\u2212]?)[$€£¥]?";

/** A number with optional thousands separators, as "1,234.5", and prefix and suffix. */
const NUMBER = new RegExp(
  String.raw`^${PREFIX}((?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)(${SUFFIX})?$`,
);

/**
 * A number with a decimal comma and dots between thousands, as "1,5", "1.234,56" or "1.234" (and
 * "1,234", which may have a thousands separator instead).
 */
const COMMA_NUMBER = new RegExp(
  String.raw`^${PREFIX}(?:\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+,\d+)(?:${SUFFIX})?$`,
);

/**
 * Parses a number as written in data or command output: "1234", "1,234", "-3", "12.5", "1e3",
 * "$9.99", "12.5%" (as 12.5) and sizes in bytes: "512B", "1.5K", "12M" (in units of 1024, as du -h
 * prints them), "3GiB", "128Mi" (1024 too) or "1.2kB", "187MB" (in units of 1000, as docker prints
 * them). With `decimalComma`, "1,5" and "1.234,5" are read with a decimal comma.
 */
export function parseNumber(
  text: string,
  decimalComma = false,
): { value: number; unit?: Unit } | undefined {
  let trimmed = text.trim();
  if (decimalComma && COMMA_NUMBER.test(trimmed)) {
    trimmed = trimmed.replaceAll(".", "").replace(",", ".");
  }
  const [, sign, digits, suffix] = NUMBER.exec(trimmed) ?? [];
  if (digits === undefined) {
    return undefined;
  }
  const value = (sign === "" || sign === "+" ? 1 : -1) * Number(digits.replaceAll(",", ""));
  if (!Number.isFinite(value)) {
    return undefined;
  }
  if (suffix === undefined) {
    return { value };
  }
  if (suffix === "%") {
    return { value, unit: "%" };
  }
  const base = suffix.length === 2 && suffix.endsWith("B") ? 1000 : 1024;
  return {
    value: value * base ** "BKMGTPE".indexOf(suffix.charAt(0).toUpperCase()),
    unit: "bytes",
  };
}

/**
 * Whether a column writes numbers with a decimal comma: some field can only be read that way
 * ("1,5", "1234,5"), and none only with thousands separators ("1,234.5", "1,234,567").
 */
export function hasDecimalCommas(records: Cell[][], column: number): boolean {
  let decimal = false;
  for (const record of records) {
    const text = record[column];
    if (typeof text === "string" && text.includes(",")) {
      const comma = COMMA_NUMBER.test(text.trim());
      const point = NUMBER.test(text.trim());
      if (point && !comma) {
        return false;
      }
      decimal ||= comma && !point;
    }
  }
  return decimal;
}
