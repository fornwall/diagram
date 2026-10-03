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

function isNumeric(rows: Cell[][], column: number): boolean {
  let numbers = 0;
  let others = 0;
  for (const row of rows) {
    const cell = row[column];
    if (typeof cell === "number") {
      numbers++;
    } else if (typeof cell === "string" && !MISSING.test(cell)) {
      others++;
    }
  }
  return numbers > 0 && numbers >= others;
}

export function isYear(cell: Cell | undefined): boolean {
  return typeof cell === "number" && Number.isInteger(cell) && cell >= 1000 && cell < 3000;
}

/**
 * Whether the first row names the columns: it has text, and no numbers other than a run of years
 * (as in "region,2024,2025"), but some column below it holds numbers.
 */
function hasHeader(rows: Cell[][]): boolean {
  const [first, ...rest] = rows;
  if (first === undefined || rest.length === 0 || !first.some((c) => typeof c === "string")) {
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
    if (first.some((cell, i) => typeof cell === "number" && rest.every((row) => isYear(row[i])))) {
      return false;
    }
  }
  return first.some((_, i) => isNumeric(rest, i));
}

/** Makes column names unique and non-empty, generating "Column N" for missing ones. */
function columnNames(header: Cell[], width: number): string[] {
  const seen = new Set<string>();
  // The next number to try for each name, so that many equal names take linear time.
  const next = new Map<string, number>();
  return Array.from({ length: width }, (_, column) => {
    const name = String(header[column] ?? "").trim() || `Column ${column + 1}`;
    let unique = name;
    let n = next.get(name) ?? 2;
    while (seen.has(unique)) {
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
  const values = header ? records.slice(1) : records;
  const decimalComma = Array.from({ length: width }, (_, column) =>
    hasDecimalCommas(values, column),
  );
  const units = Array.from({ length: width }, () => new Set<Unit>());
  const cells = records.map((record, row) =>
    Array.from({ length: width }, (_, column): Cell => {
      const field = record[column] ?? null;
      if (typeof field !== "string" || (header && row === 0)) {
        return field;
      }
      const number = parseNumber(field, decimalComma[column]);
      if (number?.unit !== undefined) {
        units[column]?.add(number.unit);
      }
      return number?.value ?? (field.trim() || null);
    }),
  );
  const named = header ?? hasHeader(cells);
  const rows = named ? cells.slice(1) : cells;
  const columns = columnNames(named ? (records[0] ?? []) : [], width).map((name, column) => {
    const numeric = isNumeric(rows, column);
    if (numeric) {
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
