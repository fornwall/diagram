// Parsing tabular data (JSON, CSV, TSV, Markdown tables or whitespace-separated command output)
// for charts: telling the format, whether the first row is a header, and which cells are numbers.

import { type DataFormat, quoteAll } from "./chartSpec";
import { parseJson } from "./dataJson";
import { checkTableSize } from "./dataLimits";
import { hasDecimalCommas, parseNumber, type Unit } from "./dataNumber";
import { splitText } from "./dataText";

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
}

/** Finds a column by its exact name, then ignoring case and surrounding spaces. */
export function findColumn(table: DataTable, name: string, role: string): number {
  let index = table.columns.findIndex((column) => column.name === name);
  if (index < 0) {
    const wanted = name.trim().toLowerCase();
    index = table.columns.findIndex((column) => column.name.trim().toLowerCase() === wanted);
  }
  if (index < 0) {
    throw new Error(
      `Unknown ${role} column ${JSON.stringify(name)}. Available columns: ${quoteAll(table.columns.map((column) => column.name))}.`,
    );
  }
  return index;
}

/** Records of fields, the first of which is the header if `header`, or may be if undefined. */
export interface Records {
  records: Cell[][];
  header?: boolean;
}

/**
 * Text that marks a missing value, as spreadsheets ("#N/A"), databases ("NULL"), pandas ("NaN",
 * "None", "<NA>") and command output ("-", "--") write it. Like an empty cell it neither makes a
 * column numeric nor keeps it from being so, but outside numeric columns it stays, as a label.
 */
const MISSING = /^(?:-+|[\u2013\u2014]|#?n\/a|na|<na>|nan|null|none)$/i;

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
 * Whether the first row names the columns: it has text, and no numbers other than a run of years
 * (as in "region,2024,2025"), but some column below it holds numbers.
 */
function hasHeader(rows: Cell[][], counts: ColumnCounts[]): boolean {
  const first = rows[0];
  if (first === undefined || rows.length < 2 || !first.some((c) => typeof c === "string")) {
    return false;
  }
  const numbers = first.filter((cell) => typeof cell === "number");
  if (numbers.length > 0) {
    // Years as column names come in order, unlike data such as "apples,1500" or "Alice,1990".
    const ascending = numbers.every((year, i) => i === 0 || year > (numbers[i - 1] ?? year));
    const descending = numbers.every((year, i) => i === 0 || year < (numbers[i - 1] ?? year));
    if (numbers.length < 2 || !numbers.every(isYear) || !(ascending || descending)) {
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
  return counts.some(isNumeric);
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

/** Builds a table from records, converting text to numbers where it is one. */
function tableFromRecords({ records, header }: Records): DataTable {
  // Not Math.max(...lengths), which overflows the stack for many records.
  const width = records.reduce((max, record) => Math.max(max, record.length), 0);
  checkTableSize(records.length, width);
  const decimalComma = Array.from({ length: width }, (_, column) =>
    hasDecimalCommas(records, column, header ? 1 : 0),
  );
  const units = Array.from({ length: width }, () => new Set<Unit>());
  // Count while normalizing, in row order, instead of revisiting every cell for each column.
  // Keep the first row out until header inference has decided whether it is data.
  const counts: ColumnCounts[] = Array.from({ length: width }, () => ({
    numbers: 0,
    others: 0,
    missing: false,
  }));
  // Parsers give us fresh records: normalize those rows in place instead of retaining a
  // second rectangular table and allocating a callback for every row.
  const first = records[0]?.slice() ?? [];
  for (let row = 0; row < records.length; row++) {
    const record = records[row];
    if (!record) continue;
    for (let column = 0; column < width; column++) {
      const field = record[column] ?? null;
      let cell = field;
      if (typeof field === "string" && !(header && row === 0)) {
        const number = parseNumber(field, decimalComma[column]);
        if (number?.unit !== undefined) units[column]?.add(number.unit);
        cell = number?.value ?? (field.trim() || null);
      }
      record[column] = cell;
      const count = counts[column];
      if (row > 0 && count !== undefined) countCell(count, cell);
    }
  }
  const cells = records;
  const named = header ?? hasHeader(cells, counts);
  const rows = named ? cells.slice(1) : cells;
  const columns = columnNames(named ? first : [], width).map((name, column) => {
    const count = counts[column] ?? { numbers: 0, others: 0, missing: false };
    if (!named) countCell(count, cells[0]?.[column] ?? null);
    const numeric = isNumeric(count);
    if (numeric && count.missing) {
      for (const row of rows) {
        const cell = row[column];
        if (typeof cell === "string" && MISSING.test(cell)) {
          row[column] = null;
        }
      }
    }
    const found = [...(units[column] ?? [])];
    const unit =
      found.length === 0 && name.includes("%") ? "%" : found.length === 1 ? found[0] : undefined;
    return numeric && unit !== undefined ? { name, numeric, unit } : { name, numeric };
  });
  return { columns, rows, header: named };
}

/**
 * Parses tabular data, detecting the format (unless given) and whether the first row is a header.
 * Numbers such as "1,234", "1,5" (in a column with decimal commas), "12%" and "1.5K" (see
 * {@link parseNumber}) become numbers, and empty cells null, as do markers of missing values such
 * as "N/A" and "-" in numeric columns.
 *
 * @throws Error when the text is empty or cannot be parsed in the given format.
 */
export function parseTable(text: string, format: DataFormat = "auto"): DataTable {
  const content = text.replace(/^﻿/, "");
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
  const table = tableFromRecords(json ? parseJson(content) : splitText(content, format));
  if (table.rows.length === 0 || table.columns.length === 0) {
    throw new Error("The data holds no values.");
  }
  return table;
}
