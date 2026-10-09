// Parsing tabular data (JSON, CSV, TSV, Markdown tables or whitespace-separated command output)
// for charts: telling the format, whether the first row is a header, and which cells are numbers.

import type { DataFormat } from "./chartSpec";
import { parseJson } from "./dataJson";
import { checkTableSize } from "./dataLimits";
import { numberFormat, parseNumber, scale, statedUnit, type Unit } from "./dataNumber";
import { splitText } from "./dataText";
import { formatCount, quote } from "./text";

/** A table cell: text, a number, or null when empty. */
export type Cell = string | number | null;

export interface Column {
  name: string;
  /** Whether it holds numbers: some cells are numbers, and at least as many as other text. */
  numeric: boolean;
  unit?: Unit;
}

/** Parsed tabular data. Every row has one cell per column. */
export interface DataTable {
  columns: Column[];
  rows: Cell[][];
  /** Whether the column names come from the data, rather than being generated ("Column 1"). */
  header: boolean;
  /** What of the data was left out, such as the text around a Markdown table. */
  note?: string;
}

/** Records of fields, the first of which is the header if `header`, or may be if undefined. */
export interface Records {
  records: Cell[][];
  header?: boolean | undefined;
  /** Whether they are CSV, which usually has a header even when all its columns hold text. */
  csv?: boolean;
  /** The units of columns that the format tells, as ls -l prints sizes in bytes. */
  units?: (Unit | undefined)[];
  note?: string;
}

/**
 * Text that marks a missing value, as spreadsheets ("#N/A", or errors such as "#DIV/0!"),
 * databases ("NULL"), pandas ("NaN", "None", "<NA>"), kubectl ("<none>", "<unknown>") and command
 * output ("-", "--") write it, or an infinity, which no chart can place, as pandas ("inf"), R
 * ("-Inf") and JavaScript ("Infinity") write it. Like an empty cell it neither makes a column
 * numeric nor keeps it from being so, but outside numeric columns it stays, as a label.
 */
const MISSING =
  /^(?:-+|[\u2013\u2014]|n\/a|na|<(?:na|none|unknown)>|nan|[-+\u2212]?inf(?:inity)?|null|none|#(?:n\/a|div\/0!|value!|ref!|name\?|num!|null!))$/i;

interface ColumnCounts {
  numbers: number;
  others: number;
  missing: boolean;
}

function countCell(counts: ColumnCounts, cell: Cell): void {
  if (typeof cell === "number") {
    counts.numbers++;
  } else if (typeof cell === "string") {
    if (MISSING.test(cell)) counts.missing = true;
    else counts.others++;
  }
}

function isNumeric({ numbers, others }: ColumnCounts): boolean {
  return numbers > 0 && numbers >= others;
}

export function isYear(cell: Cell | undefined): boolean {
  return typeof cell === "number" && Number.isInteger(cell) && cell >= 1000 && cell < 3000;
}

/**
 * Whether the first row names columns of text: none of its cells is empty or recurs in its column,
 * in which some text does recur, as categories do ("city" above "Paris", "Rome" and "Paris").
 */
function namesCategories(rows: Cell[][]): boolean {
  const [first = [], ...rest] = rows;
  let recurs = false;
  for (const [column, name] of first.entries()) {
    if (name === null) return false;
    const seen = new Set<Cell>();
    for (const row of rest) {
      const cell = row[column] ?? null;
      if (cell === name) return false;
      if (cell !== null) {
        recurs ||= seen.has(cell);
        seen.add(cell);
      }
    }
  }
  return recurs;
}

/**
 * Whether the first row names the columns: it has text or years in order, and no other numbers
 * (as in "region,2024,2025", or ",2024,2025" as pandas writes a pivot table), and some column
 * below it holds numbers. CSV of text only has a header if it {@link namesCategories}.
 */
function hasHeader(rows: Cell[][], counts: ColumnCounts[], csv: boolean): boolean {
  const first = rows[0];
  if (first === undefined || rows.length < 2) {
    return false;
  }
  const numbers = first.filter((cell) => typeof cell === "number");
  if (first.every((cell) => cell === null || (typeof cell === "string" && MISSING.test(cell)))) {
    return false;
  }
  if (numbers.length > 0) {
    // Years as column names come in order. A single one is of recent times, above numbers of
    // another order of magnitude, as in "region,2024" above "North,10", unlike data such as
    // "apples,1500", or "Jan,2034" above "Feb,1840".
    const ascending = numbers.every((year, i) => i === 0 || year > (numbers[i - 1] ?? year));
    const descending = numbers.every((year, i) => i === 0 || year < (numbers[i - 1] ?? year));
    const column = first.findIndex((cell) => typeof cell === "number");
    const year = numbers[0] ?? 0;
    const apart = (cell: Cell | undefined) =>
      typeof cell !== "number" || Math.abs(cell) * 10 < year || Math.abs(cell) > year * 10;
    if (
      !numbers.every(isYear) ||
      !(ascending || descending) ||
      (numbers.length === 1 &&
        (Math.abs(year - 2000) > 100 || !rows.every((row, i) => i === 0 || apart(row[column]))))
    ) {
      return false;
    }
    // A year above more years is data.
    if (
      first.some(
        (cell, i) =>
          typeof cell === "number" && rows.every((row, index) => index === 0 || isYear(row[i])),
      )
    ) {
      return false;
    }
  }
  return counts.some(isNumeric) || (csv && numbers.length === 0 && namesCategories(rows));
}

/** Makes column names unique and non-empty, generating "Column N" for missing ones. */
function columnNames(header: Cell[], width: number): string[] {
  const seen = new Set<string>();
  const reserved = new Set(header.map((cell) => String(cell ?? "").trim()).filter(Boolean));
  // The next number to try for each name, so that many equal names take linear time.
  const next = new Map<string, number>();
  return Array.from({ length: width }, (_, column) => {
    const given = String(header[column] ?? "").trim();
    const name = given || `Column ${column + 1}`;
    let unique = name;
    let n = next.get(name) ?? 2;
    while (seen.has(unique) || ((unique !== name || !given) && reserved.has(unique))) {
      unique = `${name} (${n++})`;
    }
    next.set(name, n);
    seen.add(unique);
    return unique;
  });
}

/**
 * Builds a table from records, converting text to numbers where it is one, and sizes with a bare
 * unit in powers of 1000 if `si`.
 */
function tableFromRecords(
  { records, header, csv = false, units, note }: Records,
  si: boolean,
): DataTable {
  // Not Math.max(...lengths), which overflows the stack for many records.
  const width = records.reduce((max, record) => Math.max(max, record.length), 0);
  checkTableSize(records.length, width);
  const formats = Array.from({ length: width }, (_, column) =>
    numberFormat(records, column, header, { sizes: si || units?.[column] === "bytes", si }),
  );
  const cellUnits = Array.from({ length: width }, () => new Set<Unit>());
  // The cells below the first row, which is counted once it is known not to be the header.
  const counts: ColumnCounts[] = Array.from({ length: width }, () => ({
    numbers: 0,
    others: 0,
    missing: false,
  }));
  // The records are the parser's own, so they are converted in place.
  const first = records[0]?.slice() ?? [];
  for (const [row, record] of records.entries()) {
    for (let column = 0; column < width; column++) {
      const field = record[column] ?? null;
      let cell = field;
      if (typeof field === "string" && !(header && row === 0)) {
        const number = parseNumber(field, formats[column]);
        if (number?.unit !== undefined) cellUnits[column]?.add(number.unit);
        cell = number?.value ?? (field.trim() || null);
      }
      record[column] = cell;
      const count = counts[column];
      if (row > 0 && count !== undefined) countCell(count, cell);
    }
  }
  const named = header ?? hasHeader(records, counts, csv);
  const rows = named ? records.slice(1) : records;
  const columns = columnNames(named ? first : [], width).map((name, column) => {
    const count = counts[column] ?? { numbers: 0, others: 0, missing: false };
    if (!named) countCell(count, records[0]?.[column] ?? null);
    const numeric = isNumeric(count);
    if (numeric && count.missing) {
      for (const row of rows) {
        const cell = row[column];
        if (typeof cell === "string" && MISSING.test(cell)) {
          row[column] = null;
        }
      }
    }
    const found = [...(cellUnits[column] ?? [])];
    // Plain numbers under a name that states their unit, as "Latency (ms)", are converted as if
    // each had it, so that they are shown in the multiple that suits them.
    const stated =
      numeric && found.length === 0 && units?.[column] === undefined
        ? statedUnit(name, formats[column] ?? {})
        : undefined;
    if (stated !== undefined) {
      for (const row of rows) {
        const cell = row[column];
        if (typeof cell === "number") row[column] = scale(cell, stated.size);
      }
    }
    const unit =
      found.length === 0
        ? (units?.[column] ?? stated?.unit ?? (name.includes("%") ? "%" : undefined))
        : found.length === 1
          ? found[0]
          : undefined;
    return numeric && unit !== undefined ? { name, numeric, unit } : { name, numeric };
  });
  return { columns, rows, header: named, ...(note === undefined ? {} : { note }) };
}

/**
 * A terminal's escape sequence: a control sequence, as for colors ("\x1b[32m"), or an operating
 * system command, as for links ("\x1b]8;;https://…\x1b\\"). Commands print them when forced to,
 * as with FORCE_COLOR or --color=always.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences start with ESC.
const TERMINAL_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?)/g;

/**
 * Parses tabular data, detecting the format (unless given) and whether the first row is a header.
 * The format is the first of these that fits, from the most specific to the most general:
 * 1. JSON, or a stream of JSON values, if the text starts with "{", or with "[" and ends with "]";
 * 2. the first Markdown table, if there is text or another table around it;
 * 3. ls -l or go test -bench output;
 * 4. TSV, if most lines have tabs, unless the first has none or an unclosed quote and CSV fits;
 * 5. git diff --stat output, or a table drawn with pipes (Markdown, psql, mysql, sqlite3);
 * 6. CSV, with commas or semicolons;
 * 7. whitespace-separated columns, aligned under a header (docker ps, df, free) or not (du, wc).
 * A first line such as "sep=;", as Excel writes, makes it CSV with the delimiter that it names.
 *
 * Numbers such as "1,234", "1,5" (in a column with decimal commas), "12%" and "1.5K" (see
 * {@link parseNumber} and {@link numberFormat}) become numbers, and empty cells null, as do
 * markers of missing values such as "N/A" and "-" in numeric columns.
 *
 * @param si Whether sizes with a bare unit ("1.2M") are in powers of 1000, as the command that
 *   printed them says (du --si, df -H). Otherwise only a lowercase "k" beside them tells.
 * @throws Error when the text is empty or cannot be parsed in the given format.
 */
export function parseTable(text: string, format: DataFormat = "auto", si = false): DataTable {
  const content = text.replace(/^\uFEFF/, "").replace(TERMINAL_ESCAPE, "");
  const trimmed = content.trim();
  if (trimmed === "") {
    throw new Error(
      "The data is empty. Give JSON, CSV, TSV or whitespace-separated columns such as the " +
        "output of du, wc or df.",
    );
  }
  const json =
    format === "json" ||
    (format === "auto" &&
      (trimmed.startsWith("{") || (trimmed.startsWith("[") && trimmed.endsWith("]"))));
  // Not trimmed, as leading spaces align the columns of command output.
  const table = tableFromRecords(json ? parseJson(content) : splitText(content, format), si);
  if (table.columns.length === 0) {
    throw new Error("The data holds no values.");
  }
  if (table.rows.length === 0) {
    const names = table.columns.slice(0, 5).map((column) => quote(column.name));
    const more = table.columns.length - names.length;
    if (more > 0) names.push(`${formatCount(more)} more`);
    throw new Error(`The data has a header (${names.join(", ")}) but no rows below it.`);
  }
  return table;
}
