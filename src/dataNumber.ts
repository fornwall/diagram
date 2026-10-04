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
  String.raw`^${PREFIX}((?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)(?:[^\S\r\n]*(${SUFFIX}))?$`,
);

/**
 * A number with a decimal comma and dots between thousands, as "1,5", "1.234,56" or "1.234" (and
 * "1,234", which may have a thousands separator instead).
 */
const COMMA_NUMBER = new RegExp(
  String.raw`^${PREFIX}(?:\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+,\d+)(?:[eE][-+]?\d+)?(?:[^\S\r\n]*(?:${SUFFIX}))?$`,
);

/** How a column writes its numbers, as told by {@link numberFormat}. */
interface NumberFormat {
  /** "1,5" and "1.234,5" have a decimal comma. */
  decimalComma?: boolean;
  /** Sizes with a bare unit are in powers of 1000, as du --si prints "1.2M" beside "150k". */
  si?: boolean;
  /** Spaces or apostrophes group thousands, as in "1 234,5" (French) or "1'234.5" (Swiss). */
  groups?: boolean;
  /** Parentheses mark negative numbers, as in accounting: "(1,234)". */
  accounting?: boolean;
  /** "250m" is a quarter, as Kubernetes writes CPU cores in thousandths (millicores). */
  millicores?: boolean;
}

/** Leading digits grouped by thousands with spaces, including no-break and thin ones, or apostrophes. */
const GROUPS =
  /^([-+\u2212]?[$€£¥]?)(\d{1,3}([ \u00A0\u2009\u202F'\u2019])\d{3}(?:\3\d{3})*)(?!\d)/;

/** Leaves out the spaces or apostrophes that group the leading digits of `text` by thousands. */
function ungroup(text: string): string {
  return text.replace(
    GROUPS,
    (_, prefix: string, digits: string, separator: string) =>
      prefix + digits.replaceAll(separator, ""),
  );
}

/** A number in parentheses, perhaps after a currency symbol, as accounting writes negatives. */
const ACCOUNTING = /^([$€£¥]?)\(([$€£¥]?[\d.].*)\)$/;

/** kubectl's restart counts: "2 (3h ago)". */
const SINCE = /^(\d+) \([^()]+ ago\)$/;

/**
 * Parses a number as written in data or command output: "1234", "1,234", "-3", "12.5", "1e3",
 * "$9.99", "12.5%" (as 12.5) and sizes in bytes: "512B", "1.5K", "12M" (in units of 1024, as du -h
 * and ls -lh print them), "3GiB", "128Mi" (1024 too) or "1.2kB", "187MB", "150k" (in units of
 * 1000, as docker and du --si print them). The column's `format` tells how to read "1,5",
 * "1 234", "(5)", "1.2M" beside "150k" and "250m".
 */
export function parseNumber(
  text: string,
  format: NumberFormat = {},
): { value: number; unit?: Unit } | undefined {
  let trimmed = text.trim().replace(SINCE, "$1");
  if (format.millicores && /^\d+m$/.test(trimmed)) {
    return { value: Number(trimmed.slice(0, -1)) / 1000 };
  }
  let sign = 1;
  const accounting = format.accounting ? ACCOUNTING.exec(trimmed) : null;
  if (accounting) {
    trimmed = `${accounting[1]}${accounting[2]}`;
    sign = -1;
  }
  if (format.groups) {
    trimmed = ungroup(trimmed);
  }
  if (format.decimalComma && COMMA_NUMBER.test(trimmed)) {
    trimmed = trimmed.replaceAll(".", "").replace(",", ".");
  }
  const [, prefix, digits, suffix] = NUMBER.exec(trimmed) ?? [];
  if (digits === undefined) {
    return undefined;
  }
  const value =
    (prefix === "" || prefix === "+" ? sign : -sign) *
    Number(digits.includes(",") ? digits.replaceAll(",", "") : digits);
  if (!Number.isFinite(value)) {
    return undefined;
  }
  if (suffix === undefined) {
    return { value };
  }
  if (suffix === "%") {
    return { value, unit: "%" };
  }
  // Explicit binary units ("KiB", "Mi") are in powers of 1024, and SI units in powers of 1000:
  // "kB", "MB" as docker prints them, and "k" as coreutils' --si option does.
  const base = suffix.includes("i")
    ? 1024
    : suffix === "k" || (suffix.length === 2 && suffix.endsWith("B")) || format.si
      ? 1000
      : 1024;
  const bytes = value * base ** "BKMGTPE".indexOf(suffix.charAt(0).toUpperCase());
  return Number.isFinite(bytes) ? { value: bytes, unit: "bytes" } : undefined;
}

/**
 * How a column writes its numbers, from the cells below its header, if it has one:
 * - with a decimal comma, if some cell can only be read that way ("1,5", "1234,5") and none only
 *   with thousands separators ("1,234.5", "1,234,567");
 * - in SI units, if some size has a bare "k" (only SI writes it in lowercase) and none a bare "K";
 * - with spaces or apostrophes between thousands, if some cell has them and no other cell has
 *   spaces or apostrophes between digits, as two numbers ("640 480") or text would;
 * - in accounting format, if some cell is a number in parentheses and none has a minus sign;
 * - in millicores, if the column may be named for CPU, as kubectl top's "CPU(cores)" is.
 */
export function numberFormat(records: Cell[][], column: number, header?: boolean): NumberFormat {
  let comma = false;
  let point = false;
  let lowerK = false;
  let upperK = false;
  let grouped = false;
  let ungrouped = false;
  let parenthesized = false;
  let minus = false;
  for (let row = header ? 1 : 0; row < records.length; row++) {
    const cell = records[row]?.[column];
    if (typeof cell !== "string") continue;
    let text = cell.trim();
    const accounting = ACCOUNTING.exec(text);
    if (accounting) {
      text = `${accounting[1]}${accounting[2]}`;
    }
    const grouping = GROUPS.test(text);
    if (grouping) {
      text = ungroup(text);
    }
    const number = NUMBER.test(text);
    const commaNumber = COMMA_NUMBER.test(text);
    if (grouping && (number || commaNumber)) grouped = true;
    else if (/\d[\s'\u2019]+\d/.test(cell)) ungrouped = true;
    if (!number && !commaNumber) continue;
    if (accounting) parenthesized = true;
    else if (/^[-\u2212]/.test(text)) minus = true;
    if (text.includes(",")) {
      point ||= number && !commaNumber;
      comma ||= commaNumber && !number;
    }
    const unit = /\d\s*([kK])$/.exec(text)?.[1];
    if (unit === "k") lowerK = true;
    else if (unit === "K") upperK = true;
  }
  return {
    decimalComma: comma && !point,
    si: lowerK && !upperK,
    groups: grouped && !ungrouped,
    accounting: parenthesized && !minus,
    millicores: header !== false && /cpu/i.test(String(records[0]?.[column])),
  };
}
