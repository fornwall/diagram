// Parsing tabular data (JSON, CSV, TSV or whitespace-separated command output) for charts.

import type { DataFormat } from "./chartSpec";

/** A table cell: text, a number, or null when empty. */
export type Cell = string | number | null;

/** Parsed tabular data. Every row has one cell per column. */
export interface DataTable {
  columns: string[];
  rows: Cell[][];
}

const ACCEPTED_FORMATS =
  "Accepted formats: JSON (an array of objects or arrays, or an object mapping names to numbers), " +
  "CSV, semicolon-separated, TSV, or whitespace-separated columns such as the output of du, " +
  "wc or ls -l.";

const NUMBER =
  /^([-+]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)(%|([KMGTPEk])(?:i?B)?)?$/;

/** A size with a decimal comma, as printed by du -h in some locales: "1,5M". */
const SIZE_WITH_DECIMAL_COMMA = /^([-+]?\d+),(\d{1,2})([KMGTPEk](?:i?B)?)$/;

/** A number with a decimal comma (or a thousands separator): "1,5", "-12,25%" or "1,234". */
const COMMA_NUMBER = /^[-+]?\d+,\d+(?:%|[KMGTPEk](?:i?B)?)?$/;

/** A number that can only have thousands separators: "1,234.5" or "1,234,567". */
const THOUSANDS = /^[-+]?\d{1,3}(?:(?:,\d{3})+\.\d*|(?:,\d{3}){2,})(?:%|[KMGTPEk](?:i?B)?)?$/;

/** A number that may have a thousands separator: "1,234" (but not "1,5" or "1234,5"). */
const MAYBE_THOUSANDS = /^[-+]?\d{1,3}(?:,\d{3})+(?:%|[KMGTPEk](?:i?B)?)?$/;

const SIZE_POWERS: Record<string, number> = { K: 1, M: 2, G: 3, T: 4, P: 5, E: 6 };

/**
 * Parses a number as written in data or command output: "1234", "1,234", "-3", "12.5", "1e3",
 * "12.5%" (as 12.5) and sizes like "1.5K", "12M", "3G" or "4TiB" (powers of 1024, as by du -h).
 * A size may have a decimal comma, as du -h prints in some locales: "1,5M". Returns undefined
 * when the text is not such a number.
 */
export function parseNumber(text: string): number | undefined {
  const trimmed = text.trim();
  const size = SIZE_WITH_DECIMAL_COMMA.exec(trimmed);
  const match = NUMBER.exec(size === null ? trimmed : `${size[1]}.${size[2]}${size[3]}`);
  const digits = match?.[1];
  if (match === null || digits === undefined) {
    return undefined;
  }
  const value = Number(digits.replaceAll(",", ""));
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const unit = match[3];
  return unit === undefined ? value : value * 1024 ** (SIZE_POWERS[unit.toUpperCase()] ?? 0);
}

/** Converts a raw field to a cell: empty → null, a number → number, otherwise trimmed text. */
function toCell(raw: string): Cell {
  const text = raw.trim();
  if (text === "") {
    return null;
  }
  return parseNumber(text) ?? text;
}

/**
 * Whether a column of raw fields writes numbers with a decimal comma: some field is like "1,5" or
 * "1234,5" (which cannot be a thousands separator), and none is like "1,234.5" or "1,234,567"
 * (which can only be).
 */
function hasDecimalCommas(fields: string[]): boolean {
  let decimal = false;
  for (const field of fields) {
    const text = field.trim();
    if (THOUSANDS.test(text)) {
      return false;
    }
    if (COMMA_NUMBER.test(text) && !MAYBE_THOUSANDS.test(text)) {
      decimal = true;
    }
  }
  return decimal;
}

/**
 * Converts records of raw fields to rows of cells. In a column that writes numbers with a decimal
 * comma (see {@link hasDecimalCommas}), "1,5" is 1.5 and "1,234" is 1.234; elsewhere "1,234" is
 * 1234.
 */
function toRows(records: string[][]): Cell[][] {
  const width = Math.max(0, ...records.map((record) => record.length));
  const decimalComma = Array.from({ length: width }, (_, column) =>
    hasDecimalCommas(records.map((record) => record[column] ?? "")),
  );
  return records.map((record) =>
    record.map((field, column) => {
      const text = field.trim();
      if (decimalComma[column] && COMMA_NUMBER.test(text)) {
        return parseNumber(text.replace(",", ".")) ?? text;
      }
      return toCell(text);
    }),
  );
}

/** Converts a JSON value to a cell. */
function jsonToCell(value: unknown): Cell {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    return toCell(value);
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a column holds numbers: at least one cell is a number, and most non-empty cells are.
 */
export function isNumericColumn(table: DataTable, column: number): boolean {
  return isNumeric(table.rows.map((row) => row[column] ?? null));
}

function isNumeric(cells: Cell[]): boolean {
  let numbers = 0;
  let others = 0;
  for (const cell of cells) {
    if (typeof cell === "number") {
      numbers++;
    } else if (cell !== null) {
      others++;
    }
  }
  return numbers > 0 && numbers >= others;
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
  const width = Math.max(...rows.map((row) => row.length));
  const column = (index: number) => rest.map((row) => row[index] ?? null);
  const numbers = first.filter((cell) => typeof cell === "number");
  if (numbers.length > 0) {
    // Years as column names come in order, as in "region,2024,2025", unlike data such as
    // "apples,1500" or "Alice,1990".
    const ascending = numbers.every((year, i) => i === 0 || year > (numbers[i - 1] ?? year));
    const descending = numbers.every((year, i) => i === 0 || year < (numbers[i - 1] ?? year));
    if (numbers.length < 2 || !numbers.every(isYear) || !(ascending || descending)) {
      return false;
    }
    for (let index = 0; index < width; index++) {
      // A year above more years is data.
      if (typeof first[index] === "number" && column(index).every(isYear)) {
        return false;
      }
    }
  }
  for (let index = 0; index < width; index++) {
    if (isNumeric(column(index))) {
      return true;
    }
  }
  return false;
}

function isYear(cell: Cell): boolean {
  return typeof cell === "number" && Number.isInteger(cell) && cell >= 1000 && cell < 3000;
}

/** Makes column names unique and non-empty, generating "Column N" for missing ones. */
function columnNames(header: Cell[], width: number): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (let column = 0; column < width; column++) {
    const cell = header[column];
    let name = cell === null || cell === undefined ? "" : String(cell).trim();
    if (name === "") {
      name = `Column ${column + 1}`;
    }
    let unique = name;
    for (let n = 2; seen.has(unique); n++) {
      unique = `${name} (${n})`;
    }
    seen.add(unique);
    names.push(unique);
  }
  return names;
}

/** Builds a table from rows of cells, taking the column names from the first row if it has them. */
function tableFromRows(rows: Cell[][], forceHeader = false): DataTable {
  const width = Math.max(0, ...rows.map((row) => row.length));
  const header = forceHeader || hasHeader(rows);
  const columns = columnNames(header ? (rows[0] ?? []) : [], width);
  const body = header ? rows.slice(1) : rows;
  return {
    columns,
    rows: body.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? null)),
  };
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

/**
 * Splits text into delimited records. With quoting, "quoted" fields may contain delimiters,
 * newlines and "" escapes.
 */
function splitDelimited(text: string, delimiter: string, quoting = true): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStart = true;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (quoting && char === '"' && fieldStart && field.trim() === "") {
      quoted = true;
      field = "";
      fieldStart = false;
    } else if (char === delimiter) {
      record.push(field);
      field = "";
      fieldStart = true;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") {
        i++;
      }
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      fieldStart = true;
    } else {
      field += char;
      if (char !== " " && char !== "\t") {
        fieldStart = false;
      }
    }
  }
  if (quoted) {
    throw new Error('A quoted field is not closed: a field starts with " but has no closing ".');
  }
  record.push(field);
  records.push(record);
  return records.filter((r) => !(r.length === 1 && isBlank(r[0] ?? "")));
}

/** The most common value, preferring the smallest on ties. */
function mode(values: number[]): number {
  const counts = new Map<number, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && value < best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/** Whether records consistently have the same number (at least two) of fields. */
function isConsistent(records: string[][]): boolean {
  if (records.length === 0) {
    return false;
  }
  const lengths = records.map((record) => record.length);
  const common = mode(lengths);
  const matching = lengths.filter((length) => length === common).length;
  return common >= 2 && matching >= Math.max(1, records.length * 0.8);
}

function parseDelimited(text: string, delimiter: string): DataTable {
  let records: string[][];
  try {
    records = splitDelimited(text, delimiter);
  } catch (error) {
    if (delimiter !== "\t") {
      throw error;
    }
    // Tab-separated output, e.g. from du, is rarely quoted but may contain quotes in file names.
    records = splitDelimited(text, delimiter, false);
  }
  return tableFromRows(toRows(records));
}

/** Splits a line on runs of whitespace into at most `count` fields; the last keeps its spaces. */
function splitWhitespace(line: string, count: number): string[] {
  const tokens = Array.from(line.matchAll(/\S+/g));
  if (tokens.length <= count) {
    return tokens.map((token) => token[0]);
  }
  const last = tokens[count - 1];
  return [
    ...tokens.slice(0, count - 1).map((token) => token[0]),
    line.slice(last?.index ?? 0).trimEnd(),
  ];
}

interface Token {
  text: string;
  start: number;
  end: number;
}

function tokenize(line: string): Token[] {
  return Array.from(line.matchAll(/\S+/g), (m) => ({
    text: m[0],
    start: m.index,
    end: m.index + m[0].length,
  }));
}

/**
 * Splits output whose data lines all have the same number of fields, but whose header has more
 * words because some column names have several words (as printed by df: "Mounted on"). Each
 * header word goes to the column of data it overlaps most, or else is nearest to.
 */
function splitMultiWordHeader(lines: string[]): string[][] | undefined {
  const [header, ...rest] = lines.map(tokenize);
  const count = rest[0]?.length ?? 0;
  if (
    header === undefined ||
    count < 2 ||
    header.length <= count ||
    header.some((token) => parseNumber(token.text) !== undefined) ||
    rest.some((tokens) => tokens.length !== count)
  ) {
    return undefined;
  }
  const spans = Array.from({ length: count }, (_, column) => ({
    start: Math.min(...rest.map((tokens) => tokens[column]?.start ?? 0)),
    end: Math.max(...rest.map((tokens) => tokens[column]?.end ?? 0)),
  }));
  const names: string[][] = spans.map(() => []);
  for (const word of header) {
    let best = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    spans.forEach((span, column) => {
      // The overlap when positive, otherwise minus the distance.
      const score = Math.min(word.end, span.end) - Math.max(word.start, span.start);
      if (score > bestScore) {
        best = column;
        bestScore = score;
      }
    });
    names[best]?.push(word.text);
  }
  return [
    names.map((words) => words.join(" ")),
    ...rest.map((tokens) => tokens.map((t) => t.text)),
  ];
}

/**
 * Splits aligned columns (as printed by docker ps) at the positions where the header's columns
 * start, which are separated by at least two spaces, so that cells may be empty or have spaces.
 * Returns undefined when the lines are not aligned that way.
 */
function splitAtHeaderGaps(lines: string[]): string[][] | undefined {
  const [header, ...rest] = lines;
  if (header === undefined || rest.length === 0 || header.includes("\t")) {
    return undefined;
  }
  const starts = Array.from(header.matchAll(/(?:^|\s{2,})(\S)/g), (m) => m.index + m[0].length - 1);
  if (starts.length < 2) {
    return undefined;
  }
  for (const line of lines) {
    if (line.includes("\t") || line.slice(0, starts[0]).trim() !== "") {
      return undefined;
    }
    for (const start of starts.slice(1)) {
      if (line.length > start && line[start - 1] !== " ") {
        return undefined;
      }
    }
  }
  const records = lines.map((line) =>
    starts.map((start, i) => line.slice(start, starts[i + 1] ?? line.length).trim()),
  );
  // A cell with a wide gap inside spans several columns: the header is not aligned with the data.
  return records.some((record) => record.some((cell) => /\s{2,}/.test(cell))) ? undefined : records;
}

function parseWhitespace(text: string): DataTable {
  const lines = text.split(/\r?\n/).filter((line) => !isBlank(line));
  const counts = lines.map((line) => line.trim().split(/\s+/).length);
  const count = mode(counts);
  if (counts.some((c) => c !== count)) {
    const aligned = splitMultiWordHeader(lines) ?? splitAtHeaderGaps(lines);
    if (aligned !== undefined) {
      const rows = toRows(aligned);
      const first = rows[0] ?? [];
      return tableFromRows(
        rows,
        first.every((cell) => typeof cell === "string"),
      );
    }
  }
  return tableFromRows(toRows(lines.map((line) => splitWhitespace(line, count))));
}

function tableFromJsonArray(array: unknown[]): DataTable {
  if (array.length === 0) {
    throw new Error("The JSON array is empty.");
  }
  if (array.every(isPlainObject)) {
    const columns: string[] = [];
    const known = new Set<string>();
    for (const item of array) {
      for (const key of Object.keys(item)) {
        if (!known.has(key)) {
          known.add(key);
          columns.push(key);
        }
      }
    }
    return {
      columns,
      rows: array.map((item) => columns.map((column) => jsonToCell(item[column]))),
    };
  }
  if (array.every(Array.isArray)) {
    return tableFromRows(array.map((row) => row.map(jsonToCell)));
  }
  if (array.every((item) => !isPlainObject(item) && !Array.isArray(item))) {
    return { columns: ["value"], rows: array.map((item) => [jsonToCell(item)]) };
  }
  throw new Error("The JSON array mixes objects, arrays and plain values.");
}

function tableFromJson(value: unknown): DataTable {
  if (Array.isArray(value)) {
    return tableFromJsonArray(value);
  }
  if (!isPlainObject(value)) {
    throw new Error("The JSON is neither an array nor an object.");
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    throw new Error("The JSON object is empty.");
  }
  const columns = entries.map(([, item]) => item);
  const length = Array.isArray(columns[0]) ? columns[0].length : -1;
  if (
    length > 0 &&
    columns.every(
      (column) =>
        Array.isArray(column) &&
        column.length === length &&
        column.every((item) => !isPlainObject(item) && !Array.isArray(item)),
    )
  ) {
    // Columns: {"label": ["a", "b"], "count": [1, 2]}.
    return {
      columns: entries.map(([name]) => name),
      rows: Array.from({ length }, (_, row) =>
        columns.map((column) => jsonToCell((column as unknown[])[row])),
      ),
    };
  }
  const arrays = entries.filter(([, item]) => Array.isArray(item));
  if (arrays.length === 1 && arrays[0] !== undefined) {
    return tableFromJsonArray(arrays[0][1] as unknown[]);
  }
  if (entries.every(([, item]) => !isPlainObject(item) && !Array.isArray(item))) {
    return {
      columns: ["name", "value"],
      rows: entries.map(([name, item]) => [name, jsonToCell(item)]),
    };
  }
  if (entries.every(([, item]) => isPlainObject(item))) {
    const inner = tableFromJsonArray(entries.map(([, item]) => item));
    const nameColumn = inner.columns.includes("name") ? "key" : "name";
    return {
      columns: [nameColumn, ...inner.columns],
      rows: inner.rows.map((row, i) => [entries[i]?.[0] ?? null, ...row]),
    };
  }
  throw new Error(
    "The JSON object must map names to numbers, map names to objects, map column names to " +
      "equally long arrays, or hold one array of rows.",
  );
}

function parseJson(text: string): DataTable {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return tableFromJson(value);
}

type ActualFormat = Exclude<DataFormat, "auto"> | "semicolon";

const FORMAT_NAMES: Record<ActualFormat, string> = {
  json: "JSON",
  csv: "CSV",
  semicolon: "semicolon-separated values",
  tsv: "TSV",
  whitespace: "whitespace-separated columns",
};

function detectFormat(text: string): ActualFormat {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return "json";
  }
  const lines = trimmed.split(/\r?\n/).filter((line) => !isBlank(line));
  if (lines.filter((line) => line.includes("\t")).length > lines.length / 2) {
    return "tsv";
  }
  // When both fit, as for "a;1,5" with decimal commas, prefer the one that splits every line
  // into the same number of fields, then the one giving more fields, then semicolons (a comma is
  // more likely a decimal comma than a semicolon is part of a CSV field).
  let best: { format: ActualFormat; score: [number, number] } | undefined;
  for (const [delimiter, format] of [
    [",", "csv"],
    [";", "semicolon"],
  ] as const) {
    if (trimmed.includes(delimiter)) {
      let records: string[][];
      try {
        records = splitDelimited(trimmed, delimiter);
      } catch {
        // An unclosed quote: not this format.
        continue;
      }
      if (isConsistent(records)) {
        const width = records[0]?.length ?? 0;
        const score: [number, number] = [
          records.every((record) => record.length === width) ? 1 : 0,
          mode(records.map((record) => record.length)),
        ];
        if (
          best === undefined ||
          score[0] > best.score[0] ||
          (score[0] === best.score[0] && score[1] >= best.score[1])
        ) {
          best = { format, score };
        }
      }
    }
  }
  if (best !== undefined) {
    return best.format;
  }
  return "whitespace";
}

/**
 * Parses tabular data. With format "auto", the format is detected: JSON when the text starts with
 * { or is enclosed in [ and ], TSV when most lines contain tabs, CSV or semicolon-separated values when
 * the lines consistently have that many fields, and whitespace-separated columns otherwise.
 *
 * JSON can be an array of objects (columns are the keys in first-seen order), an array of arrays,
 * an array of plain values, an object mapping names to values (columns "name" and "value") or to
 * objects, an object mapping column names to equally long arrays of values, or an object holding
 * one array of rows (e.g. {"data": [...]}).
 *
 * Whitespace-separated lines are split on runs of whitespace into as many columns as most lines
 * have; the last column keeps any remaining spaces, so "12 src/a b.ts" gives [12, "src/a b.ts"].
 * When the header has multi-word column names, as printed by df or docker ps, the header words
 * are matched to the data columns by position.
 *
 * The first row is a header when none of its cells are numbers but some column below it holds
 * numbers; otherwise the columns are named "Column 1", "Column 2" and so on. Numbers such as
 * "1,234", "12.5%" and "1.5K" (see {@link parseNumber}) become numbers, and empty cells null. In
 * a column with numbers like "1,5" or "1234,5", the comma is a decimal comma.
 * Blank lines are skipped, but other rows (such as a "total" line) are kept; charts leave out a
 * last row that totals the others (see {@link hasTotalsRow}).
 *
 * @throws Error when the text is empty or cannot be parsed in the given format.
 */
export function parseTable(text: string, format: DataFormat = "auto"): DataTable {
  if (isBlank(text)) {
    throw new Error(`The data is empty. ${ACCEPTED_FORMATS}`);
  }
  const actual = format === "auto" ? detectFormat(text) : format;
  let table: DataTable;
  try {
    switch (actual) {
      case "json":
        table = parseJson(text.trim());
        break;
      case "csv":
        table = parseDelimited(text, ",");
        break;
      case "semicolon":
        table = parseDelimited(text, ";");
        break;
      case "tsv":
        table = parseDelimited(text, "\t");
        break;
      default:
        table = parseWhitespace(text);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not parse the data as ${FORMAT_NAMES[actual]}: ${message} ${ACCEPTED_FORMATS}`,
    );
  }
  if (table.rows.length === 0 || table.columns.length === 0) {
    throw new Error(`The data has no rows, only a header. ${ACCEPTED_FORMATS}`);
  }
  return table;
}

const TOTAL_LABEL = /^(?:total|totals|sum|grand total)\s*:?$/i;

/** How far a totals row's value may be from the sum of the other rows, relative to the value. */
const TOTAL_TOLERANCE = 0.01;

/**
 * Whether the last row sums up the others, as the "total" row of wc -l or du -c and the "SUM:" row
 * of cloc do: its label is "total", "totals" or "sum" (ignoring case and a trailing colon), and in
 * every value column where it has a number, that number is within 1% of the sum of the other rows.
 * At least two other rows are needed.
 */
export function hasTotalsRow(
  table: DataTable,
  labelColumn: number,
  valueColumns: number[],
): boolean {
  const last = table.rows.at(-1);
  const others = table.rows.slice(0, -1);
  const label = last?.[labelColumn];
  if (last === undefined || others.length < 2 || typeof label !== "string") {
    return false;
  }
  if (!TOTAL_LABEL.test(label.trim())) {
    return false;
  }
  let checked = 0;
  for (const column of valueColumns) {
    const total = last[column];
    if (typeof total !== "number") {
      continue;
    }
    const sum = others.reduce<number>((acc, row) => {
      const cell = row[column];
      return typeof cell === "number" ? acc + cell : acc;
    }, 0);
    if (Math.abs(total - sum) > Math.abs(total) * TOTAL_TOLERANCE) {
      return false;
    }
    checked++;
  }
  return checked > 0;
}

/** The label of the last row if it sums up the others in the numeric columns, as charts assume. */
function totalsLabel(table: DataTable): string | undefined {
  const last = table.rows.at(-1) ?? [];
  const numeric = table.columns.map((_, i) => isNumericColumn(table, i));
  for (let column = 0; column < last.length; column++) {
    const cell = last[column];
    if (typeof cell === "string" && !numeric[column]) {
      const values = table.columns.flatMap((_, i) => (numeric[i] ? [i] : []));
      return hasTotalsRow(table, column, values) ? cell : undefined;
    }
  }
  return undefined;
}

const PREVIEW_ROWS = 5;
const TEXT_EXAMPLES = 3;

function describeColumn(table: DataTable, column: number): string {
  const cells = table.rows.map((row) => row[column] ?? null);
  if (cells.every((cell) => cell === null)) {
    return "empty";
  }
  if (!isNumericColumn(table, column)) {
    return "text";
  }
  const texts = cells.filter((cell): cell is string => typeof cell === "string");
  if (texts.length === 0) {
    return "number";
  }
  const examples = texts.slice(0, TEXT_EXAMPLES).map((text) => JSON.stringify(text));
  if (texts.length > TEXT_EXAMPLES) {
    examples.push("…");
  }
  const count = `${texts.length} text ${texts.length === 1 ? "cell" : "cells"}`;
  return `number, ${count}: ${examples.join(", ")}`;
}

/**
 * Summarizes a table for a language model, e.g.
 * `42 rows; columns: "dir" (text), "size" (number)` followed by the first rows as JSON arrays.
 * Text cells in numeric columns (which charts leave out) are pointed out, as is a totals row (see
 * {@link hasTotalsRow}).
 */
export function describeTable(table: DataTable): string {
  const columns = table.columns.map(
    (name, i) => `${JSON.stringify(name)} (${describeColumn(table, i)})`,
  );
  const count = table.rows.length;
  const lines = [`${count} ${count === 1 ? "row" : "rows"}; columns: ${columns.join(", ")}`];
  const total = totalsLabel(table);
  if (total !== undefined) {
    lines.push(
      `The last row (${JSON.stringify(total)}) is a total of the others; charts leave it out.`,
    );
  }
  const preview = table.rows.slice(0, PREVIEW_ROWS);
  lines.push(count > PREVIEW_ROWS ? `First ${PREVIEW_ROWS} rows:` : "Rows:");
  for (const row of preview) {
    lines.push(JSON.stringify(row));
  }
  return lines.join("\n");
}
