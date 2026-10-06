// Reading numbers as data and command output write them: with thousands separators or decimal
// commas, signs, currencies, percentages, sizes in bytes and durations.

import type { Cell } from "./data";

/**
 * What a column's numbers measure, as written in the data ("12%", "1.5G", "812ms") or its name
 * ("%CPU").
 */
export type Unit = "%" | "bytes" | "seconds";

/** A currency symbol, which comes before a number ("$5") or, in much of Europe, after it ("5 €"). */
const CURRENCY = "[$€£¥]";

/**
 * A percent sign, a multiplier ("K", "M", "B", "bn"), a unit of bytes ("B", "K", "kB", "KiB", "Ki"
 * and so on) or a currency.
 */
const SUFFIX = `%|bn|Bi?|[KMGTPEk](?:i?B|i)?|${CURRENCY}`;

/** Units that only sizes in bytes have: "KB", "KiB", "Ki", and "G", "P" and "E" without a "B". */
const BYTE_SUFFIX = /^(?:[KMGTPEk]i?B|[KMGTPEk]i|Bi|[GPE])$/;

/** The words of column names that hold sizes, as "Size", "MEMORY(bytes)" or df's "Avail". */
const SIZE_WORDS = new Set(
  "size bytes mem memory disk rss vsz used avail available free swap heap storage".split(" "),
);

/** The words of column names that hold durations, as "Duration", "Elapsed" or kubectl's "AGE". */
const DURATION_WORDS = new Set(
  "duration elapsed etime runtime took latency uptime age wall".split(" "),
);

/**
 * A duration as Go, kubectl and time print it, in units from days down to nanoseconds: "1h2m3.5s",
 * "3h12m", "0m1.234s", "812ms", "1.2µs".
 */
const DURATION = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?) ?(s|ms|[uµμ]s|ns))?$/;

/** A duration on a clock, as "1:02:03.5", "3:45" (minutes) or "1-02:03:04" (ps's days). */
const CLOCK = /^(?:(\d+)-)?(?:(\d+):)?(\d+):([0-5]\d(?:\.\d+)?)$/;

/** How many of each unit a second has. */
const PER_SECOND: Record<string, number> = { ms: 1e3, us: 1e6, µs: 1e6, μs: 1e6, ns: 1e9 };

/** The seconds of a {@link DURATION}, or a {@link CLOCK} in a column of `durations`. */
function parseDuration(text: string, durations = false): number | undefined {
  const [, d, h, m, s, unit = "s"] =
    DURATION.exec(text) ?? (durations ? CLOCK.exec(text) : null) ?? [];
  const parts = [d, h, m, s].filter((part) => part !== undefined).length;
  // Alone, "5m" may be millions or meters, and "3h" or "2d" other things, except in a column of
  // durations, as kubectl's AGE.
  if (parts === 0 || (parts === 1 && s === undefined && !durations)) return undefined;
  const minutes = (Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(m ?? 0);
  return minutes * 60 + Number(s ?? 0) / (PER_SECOND[unit] ?? 1);
}

/** A sign, which may be a typeset minus (−), and a currency symbol, as in "-$5". */
const PREFIX = `([-+\u2212]?)(${CURRENCY}?)`;

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
  /**
   * "1.2K" and "3M" are sizes in bytes, as du -h and ls -lh print them, rather than the thousands
   * and millions of counts such as "1.2K views".
   */
  sizes?: boolean;
  /** Sizes with a bare unit are in powers of 1000, as du --si prints "1.2M" beside "150k". */
  si?: boolean;
  /** Spaces or apostrophes group thousands, as in "1 234,5" (French) or "1'234.5" (Swiss). */
  groups?: boolean;
  /** Parentheses mark negative numbers, as in accounting: "(1,234)". */
  accounting?: boolean;
  /** "250m" is a quarter, as Kubernetes writes CPU cores in thousandths (millicores). */
  millicores?: boolean;
  /** "5m" and "3h" are durations, as are "1:02:03" and "3:45" (minutes) on a clock. */
  durations?: boolean;
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
 * "$9.99", "9.99 €", "12.5%" (as 12.5), thousands to trillions ("1.2K", "$3.4M", "1.5bn", "2T")
 * and sizes in bytes: "3GiB", "128Mi" (in units of 1024), "1.2kB", "187MB" (in units of 1000, as
 * docker prints them) or, in a column of `format.sizes`, "512B", "1.5K", "12M" (in units of 1024,
 * as du -h and ls -lh print them, or of 1000 with `format.si`), and durations in seconds
 * ("812ms", "1h2m3s"). The column's `format` also tells how to read "1,5", "1 234", "(5)", "250m"
 * and "3:45".
 */
export function parseNumber(
  text: string,
  format: NumberFormat = {},
): { value: number; unit?: Unit } | undefined {
  let trimmed = text.trim().replace(SINCE, "$1");
  if (format.millicores && /^\d+m$/.test(trimmed)) {
    return { value: Number(trimmed.slice(0, -1)) / 1000 };
  }
  const seconds = parseDuration(trimmed, format.durations);
  if (seconds !== undefined) {
    return { value: seconds, unit: "seconds" };
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
  const [, minus, currency, digits, suffix] = NUMBER.exec(trimmed) ?? [];
  if (digits === undefined) {
    return undefined;
  }
  const value =
    (minus === "" || minus === "+" ? sign : -sign) *
    Number(digits.includes(",") ? digits.replaceAll(",", "") : digits);
  if (!Number.isFinite(value)) {
    return undefined;
  }
  // A currency symbol, of those in CURRENCY, says nothing of the number.
  if (suffix === undefined || CURRENCY.includes(suffix)) {
    return { value };
  }
  if (suffix === "%") {
    return { value, unit: "%" };
  }
  // Counts and amounts of money abbreviate thousands, millions, billions and trillions: "1.2K
  // views", "$3.4M", "$1.2B", "1.5bn".
  const prefix = suffix.charAt(0).toUpperCase();
  if (!BYTE_SUFFIX.test(suffix) && (!format.sizes || currency !== "" || suffix === "bn")) {
    const scaled = value * 1000 ** ("KMBT".indexOf(prefix) + 1);
    return Number.isFinite(scaled) ? { value: scaled } : undefined;
  }
  // Explicit binary units ("KiB", "Mi") are in powers of 1024, and SI units in powers of 1000:
  // "kB", "MB" as docker prints them, and "k" as coreutils' --si option does.
  const base = suffix.includes("i")
    ? 1024
    : suffix === "k" || (suffix.length === 2 && suffix.endsWith("B")) || format.si
      ? 1000
      : 1024;
  const bytes = value * base ** "BKMGTPE".indexOf(prefix);
  return Number.isFinite(bytes) ? { value: bytes, unit: "bytes" } : undefined;
}

/**
 * How a column writes its numbers, from the cells below its header, if it has one, and from what
 * the data's source tells (`given`):
 * - in sizes, if some cell has a unit that only sizes have ("MB", "Ki", "G"), or the column's name
 *   is of sizes ("Size", "Used"), or it has no name, as du and sort -h print none, while counts
 *   are named, as "views" or "stars" are;
 * - with a decimal comma, if some cell can only be read that way ("1,5", "1234,5") and none only
 *   with thousands separators ("1,234.5", "1,234,567");
 * - in SI units, if some size has a bare "k" (only SI writes it in lowercase) and none a bare "K";
 * - with spaces or apostrophes between thousands, if some cell has them and no other cell has
 *   spaces or apostrophes between digits, as two numbers ("640 480") or text would;
 * - in accounting format, if some cell is a number in parentheses and none has a minus sign;
 * - in millicores, if the column may be named for CPU, as kubectl top's "CPU(cores)" is;
 * - in durations, if the column's name is of durations ("Elapsed", "AGE").
 */
export function numberFormat(
  records: Cell[][],
  column: number,
  header: boolean | undefined,
  given: NumberFormat,
): NumberFormat {
  const name = header === false ? undefined : records[0]?.[column];
  const words =
    typeof name === "string" && parseNumber(name) === undefined
      ? name.split(/[^a-zA-Z]+|(?<=[a-z])(?=[A-Z])/).map((word) => word.toLowerCase())
      : undefined;
  let sizes = given.sizes === true || words === undefined || words.some((w) => SIZE_WORDS.has(w));
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
    sizes ||= BYTE_SUFFIX.test(/[a-zA-Z]+$/.exec(text)?.[0] ?? "");
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
    sizes,
    si: given.si === true || (lowerK && !upperK),
    groups: grouped && !ungrouped,
    accounting: parenthesized && !minus,
    millicores: header !== false && /cpu/i.test(String(records[0]?.[column])),
    durations: words?.some((word) => DURATION_WORDS.has(word)) === true,
  };
}
