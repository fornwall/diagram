// Parsing tabular data (JSON, CSV, TSV or whitespace-separated command output) for charts.

import type { DataFormat } from "./chartSpec";
import { errorMessage, isPlainObject } from "./protocol";

/** A table cell: text, a number, or null when empty. */
export type Cell = string | number | null;

/** What a column's numbers measure, as written in the data ("12%", "1.5G") or its name ("%CPU"). */
export type Unit = "%" | "bytes";

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

/** Records of fields, the first of which is the header if `header`, or may be if undefined. */
interface Records {
  records: Cell[][];
  header?: boolean;
}

const SUFFIX = "%|Bi?|[KMGTPEk](?:i?B|i)?";

/** A sign, which may be a typeset minus (−), and a currency symbol, as in "-$5". */
const PREFIX = "([-+\u2212]?)[$€£¥]?";

/** A number with optional thousands separators, as "1,234.5", and prefix and suffix. */
const NUMBER = new RegExp(
  String.raw`^${PREFIX}((?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)(${SUFFIX})?$`,
);

/** A number with a decimal comma, as "1,5" or "1.234,56" (or "1,234" with a thousands separator). */
const COMMA_NUMBER = new RegExp(
  String.raw`^${PREFIX}(?:\d{1,3}(?:\.\d{3})+|\d+),\d+(?:${SUFFIX})?$`,
);

/** A number with thousands separators within text, as in "apples 1,234". */
const THOUSANDS_IN_TEXT = /(?<![\d.,])\d{1,3}(?:,\d{3})+(?![\d,])/g;

/**
 * Parses a number as written in data or command output: "1234", "1,234", "-3", "12.5", "1e3",
 * "$9.99", "12.5%" (as 12.5) and sizes in bytes: "512B", "1.5K", "12M" (in units of 1024, as du -h prints
 * them), "3GiB", "128Mi" (1024 too) or "1.2kB", "187MB" (in units of 1000, as docker prints them).
 */
export function parseNumber(text: string): { value: number; unit?: Unit } | undefined {
  const [, sign, digits, suffix] = NUMBER.exec(text.trim()) ?? [];
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

function isNumber(text: string | undefined): boolean {
  return text !== undefined && parseNumber(text) !== undefined;
}

/**
 * Whether a column writes numbers with a decimal comma: some field can only be read that way
 * ("1,5", "1234,5"), and none only with thousands separators ("1,234.5", "1,234,567").
 */
function hasDecimalCommas(records: Cell[][], column: number): boolean {
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

function isNumeric(rows: Cell[][], column: number): boolean {
  let numbers = 0;
  let others = 0;
  for (const row of rows) {
    const cell = row[column];
    if (typeof cell === "number") {
      numbers++;
    } else if (cell !== null && cell !== undefined) {
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
  return Array.from({ length: width }, (_, column) => {
    const name = String(header[column] ?? "").trim() || `Column ${column + 1}`;
    let unique = name;
    for (let n = 2; seen.has(unique); n++) {
      unique = `${name} (${n})`;
    }
    seen.add(unique);
    return unique;
  });
}

/** Builds a table from records, converting text to numbers where it is one. */
function tableFromRecords({ records, header }: Records): DataTable {
  // Not Math.max(...lengths), which overflows the stack for many records.
  const width = records.reduce((max, record) => Math.max(max, record.length), 0);
  const decimalComma = Array.from({ length: width }, (_, column) =>
    hasDecimalCommas(records, column),
  );
  const units = Array.from({ length: width }, () => new Set<Unit>());
  const cells = records.map((record) =>
    Array.from({ length: width }, (_, column): Cell => {
      const field = record[column] ?? null;
      if (typeof field !== "string") {
        return field;
      }
      const text = field.trim();
      const number = parseNumber(
        decimalComma[column] && COMMA_NUMBER.test(text)
          ? text.replaceAll(".", "").replace(",", ".")
          : text,
      );
      if (number?.unit !== undefined) {
        units[column]?.add(number.unit);
      }
      return number?.value ?? (text === "" ? null : text);
    }),
  );
  const named = header ?? hasHeader(cells);
  const rows = named ? cells.slice(1) : cells;
  const columns = columnNames(named ? (records[0] ?? []) : [], width).map((name, column) => {
    const numeric = isNumeric(rows, column);
    const found = [...(units[column] ?? [])];
    const unit =
      found.length === 0 && name.includes("%") ? "%" : found.length === 1 ? found[0] : undefined;
    return numeric && unit !== undefined ? { name, numeric, unit } : { name, numeric };
  });
  return { columns, rows, header: named };
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
  let line = 1;
  let quoteLine = 0;
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
        if (char === "\n") {
          line++;
        }
      }
    } else if (quoting && char === '"' && fieldStart) {
      quoted = true;
      quoteLine = line;
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
      line++;
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
    throw new Error(
      `The quoted field that starts on line ${quoteLine} is not closed. A quote in a ` +
        `quoted field is written twice, as in "say ""hi""".`,
    );
  }
  record.push(field);
  records.push(record);
  return records.filter((r) => r.length > 1 || !isBlank(r[0] ?? ""));
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

/**
 * Splits comma- or semicolon-separated values with the delimiter that splits the lines more
 * consistently. Unless `strict`, returns undefined when neither splits every line, or 80% of them
 * into as many fields, or when the first line has no delimiter (as in docker ps output, with
 * commas in a column) or commas only separate thousands (as in "apples 1,234").
 */
function splitCsv(text: string, firstLine: string, strict: boolean): string[][] | undefined {
  let best: { records: string[][]; uniform: number; width: number } | undefined;
  for (const delimiter of [",", ";"]) {
    if (
      !strict &&
      (!firstLine.includes(delimiter) ||
        (delimiter === "," && !text.replace(THOUSANDS_IN_TEXT, "").includes(",")))
    ) {
      continue;
    }
    let records: string[][];
    try {
      records = splitDelimited(text, delimiter);
    } catch {
      continue;
    }
    const width = mode(records.map((record) => record.length));
    const matching = records.filter((record) => record.length === width).length;
    // Lines may have fewer or more fields than the header, as with cloc --csv.
    if (width < 2 || (matching < records.length * 0.8 && records.some((r) => r.length < 2))) {
      continue;
    }
    // On ties, as for "a;1,5", prefer semicolons: a comma is more likely a decimal comma than a
    // semicolon is part of a field.
    const uniform = matching === records.length ? 1 : 0;
    if (
      best === undefined ||
      uniform > best.uniform ||
      (uniform === best.uniform && width >= best.width)
    ) {
      best = { records, uniform, width };
    }
  }
  return best?.records ?? (strict ? splitDelimited(text, ",") : undefined);
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

/** The texts of a line's tokens, at most `count`: the last keeps the rest of the line. */
function fields(line: string, tokens: Token[], count: number): string[] {
  const last = tokens[count - 1];
  if (tokens.length <= count || last === undefined) {
    return tokens.map((token) => token.text);
  }
  return [...tokens.slice(0, count - 1).map((t) => t.text), line.slice(last.start).trimEnd()];
}

/**
 * Splits output whose data lines all have the same number of fields, but whose header has more
 * words because some column names have several words (as printed by df: "Mounted on"). Each
 * header word goes to the column of data it overlaps most, or else is nearest to.
 */
function splitMultiWordHeader(tokens: Token[][]): string[][] | undefined {
  const [header, ...rest] = tokens;
  const count = rest[0]?.length ?? 0;
  if (
    header === undefined ||
    count < 2 ||
    header.length <= count ||
    rest.some((line) => line.length !== count)
  ) {
    return undefined;
  }
  const spans = Array.from({ length: count }, (_, column) => {
    let start = Number.POSITIVE_INFINITY;
    let end = 0;
    for (const line of rest) {
      start = Math.min(start, line[column]?.start ?? 0);
      end = Math.max(end, line[column]?.end ?? 0);
    }
    return { start, end };
  });
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
  return [names.map((words) => words.join(" ")), ...rest.map((line) => line.map((t) => t.text))];
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

/**
 * Splits whitespace-separated lines into as many fields as most lines have; the last field keeps
 * any remaining spaces, so "12 src/a b.ts" gives ["12", "src/a b.ts"]. Multi-word column names,
 * as printed by df or docker ps, are matched to the data columns by position. The first line is a
 * header if `underlined`.
 */
function splitWhitespace(lines: string[], underlined: boolean): Records {
  const tokens = lines.map(tokenize);
  // ls -l starts with "total 16".
  if (tokens[0]?.length === 2 && tokens[0][0]?.text === "total" && (tokens[1]?.length ?? 0) > 2) {
    lines.shift();
    tokens.shift();
  }
  const [header = [], ...data] = tokens;
  const textHeader = !header.some((token) => isNumber(token.text));
  // Rows that start with a name, under a header that starts after it, as printed by free and R.
  const named = header.length + 1;
  const indent = header[0]?.start ?? 0;
  if (
    textHeader &&
    data.some((line) => line.length === named) &&
    data.every((line) => line.length <= named && (line[0]?.end ?? 0) <= indent)
  ) {
    return {
      records: [
        ["", ...header.map((token) => token.text)],
        ...data.map((line, i) => fields(lines[i + 1] ?? "", line, named)),
      ],
      header: true,
    };
  }
  const counts = tokens.map((line) => line.length);
  if (textHeader && counts.some((c) => c !== counts[0])) {
    // Gaps in the header are the surest column boundaries, but df has single spaces between some.
    const aligned = splitAtHeaderGaps(lines) ?? splitMultiWordHeader(tokens);
    if (aligned !== undefined) {
      return { records: aligned, header: true };
    }
  }
  // Under a header, as from ps aux, longer lines have spaces in the last column.
  const count =
    textHeader && data.length > 0 && data.every((line) => line.length >= header.length)
      ? header.length
      : mode(counts);
  return {
    records: lines.map((line, i) => fields(line, tokens[i] ?? [], count)),
    header: underlined || undefined,
  };
}

/**
 * A rule: a line of dashes, as under the header of Markdown ("|---|--:|"), psql ("----+----"),
 * pip list and PowerShell tables, or of "=", as around tokei's.
 */
const RULE = /^[\s|+:=-]*[-=][\s|+:=-]*$/;

/** Leaves out rules, and tells whether one is under the first line, making it a header. */
function withoutRules(lines: string[]): { lines: string[]; underlined: boolean } {
  const kept: string[] = [];
  let underlined = false;
  for (const line of lines) {
    if (RULE.test(line)) {
      underlined ||= kept.length === 1;
    } else {
      kept.push(line);
    }
  }
  return { lines: kept, underlined };
}

/**
 * Splits a table with "|" between cells, as in Markdown or printed by psql and mysql. Returns
 * undefined unless all lines have as many cells.
 */
function splitPipes(lines: string[]): string[][] | undefined {
  // psql prints the number of rows below the table.
  const rows = lines.filter((line) => !/^\(\d+ rows?\)$/.test(line.trim()));
  const records = rows.map((line) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split(/(?<!\\)\|/)
      .map((cell) => cell.replaceAll("\\|", "|")),
  );
  const width = records[0]?.length ?? 0;
  return width >= 2 && records.every((record) => record.length === width) ? records : undefined;
}

function jsonCell(value: unknown): Cell {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function isScalar(value: unknown): boolean {
  return !isPlainObject(value) && !Array.isArray(value);
}

function recordsFromJsonArray(array: unknown[]): Records {
  if (array.length === 0) {
    throw new Error("The JSON array is empty.");
  }
  if (array.every(isPlainObject)) {
    const keys = [...new Set(array.flatMap((item) => Object.keys(item)))];
    return {
      records: [keys, ...array.map((item) => keys.map((key) => jsonCell(item[key])))],
      header: true,
    };
  }
  if (array.every(Array.isArray)) {
    return { records: array.map((row) => row.map(jsonCell)) };
  }
  if (array.every(isScalar)) {
    return { records: [["value"], ...array.map((item) => [jsonCell(item)])], header: true };
  }
  throw new Error("The JSON array mixes objects, arrays and plain values.");
}

function recordsFromJson(value: unknown): Records {
  if (Array.isArray(value)) {
    return recordsFromJsonArray(value);
  }
  if (!isPlainObject(value)) {
    throw new Error("The JSON is neither an array nor an object.");
  }
  const names = Object.keys(value);
  const columns = Object.values(value);
  if (names.length === 0) {
    throw new Error("The JSON object is empty.");
  }
  const length = Array.isArray(columns[0]) ? columns[0].length : 0;
  if (
    length > 0 &&
    columns.every(
      (item): item is unknown[] =>
        Array.isArray(item) && item.length === length && item.every(isScalar),
    )
  ) {
    // Columns: {"label": ["a", "b"], "count": [1, 2]}.
    return {
      records: [
        names,
        ...Array.from({ length }, (_, row) => columns.map((column) => jsonCell(column[row]))),
      ],
      header: true,
    };
  }
  // Rows wrapped in an object: {"items": [...], "errors": [], "count": 2}.
  const arrays = columns.filter(Array.isArray);
  const nonEmpty = arrays.filter((array) => array.length > 0);
  const rows = arrays.length === 1 ? arrays[0] : nonEmpty.length === 1 ? nonEmpty[0] : undefined;
  if (rows !== undefined) {
    return recordsFromJsonArray(rows);
  }
  if (columns.every(isScalar)) {
    return {
      records: [["name", "value"], ...names.map((name, i) => [name, jsonCell(columns[i])])],
      header: true,
    };
  }
  if (columns.every(isPlainObject)) {
    const [keys = [], ...rows] = recordsFromJsonArray(columns).records;
    return {
      records: [
        [keys.includes("name") ? "key" : "name", ...keys],
        ...rows.map((row, i) => [names[i] ?? null, ...row]),
      ],
      header: true,
    };
  }
  throw new Error(
    "The JSON object must map names to numbers, map names to objects, map column names to " +
      "equally long arrays, or hold one array of rows.",
  );
}

/**
 * Parses newline-delimited JSON, as printed by jq -c or docker ps --format json, or returns
 * undefined unless the first of several lines is a JSON value.
 */
function parseJsonLines(text: string): unknown[] | undefined {
  const lines = text.split(/\r?\n/).filter((line) => !isBlank(line));
  if (lines.length < 2) {
    return undefined;
  }
  const values: unknown[] = [];
  for (const [i, line] of lines.entries()) {
    try {
      values.push(JSON.parse(line));
    } catch (error) {
      if (i === 0) {
        return undefined;
      }
      // Leaves out V8's "(line 1 column 8)", which counts lines from this one.
      const message = errorMessage(error).replace(/ \(line \d+ column \d+\)/, "");
      throw new Error(`Line ${i + 1} of the JSON Lines is not valid JSON: ${message}.`);
    }
  }
  return values;
}

function parseJson(text: string): Records {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    value = parseJsonLines(text);
    if (value === undefined) {
      throw new Error(`The data is not valid JSON: ${errorMessage(error)}.`);
    }
  }
  return recordsFromJson(value);
}

function readRecords(text: string, format: DataFormat): Records {
  const trimmed = text.trim();
  if (
    format === "json" ||
    (format === "auto" &&
      (trimmed.startsWith("{") || (trimmed.startsWith("[") && trimmed.endsWith("]"))))
  ) {
    return parseJson(trimmed);
  }
  const { lines, underlined } = withoutRules(text.split(/\r?\n/).filter((line) => !isBlank(line)));
  const tabs = lines.filter((line) => line.includes("\t")).length;
  if (format === "tsv" || (format === "auto" && tabs > lines.length / 2)) {
    try {
      return { records: splitDelimited(text, "\t") };
    } catch {
      // Tab-separated output, e.g. from du, is rarely quoted but may contain quotes in file names.
      return { records: splitDelimited(text, "\t", false) };
    }
  }
  if (format === "auto" && underlined) {
    const records = splitPipes(lines);
    if (records !== undefined) {
      return { records, header: true };
    }
  }
  if (format === "auto" || format === "csv") {
    const records = splitCsv(text, lines[0] ?? "", format === "csv");
    if (records !== undefined) {
      return { records };
    }
  }
  return splitWhitespace(lines, underlined);
}

/**
 * Parses tabular data, detecting the format (unless given) and whether the first row is a header.
 * Numbers such as "1,234", "1,5" (in a column with decimal commas), "12%" and "1.5K" (see
 * {@link parseNumber}) become numbers, and empty cells null.
 *
 * @throws Error when the text is empty or cannot be parsed in the given format.
 */
export function parseTable(text: string, format: DataFormat = "auto"): DataTable {
  const content = text.replace(/^\uFEFF/, "");
  if (isBlank(content)) {
    throw new Error(
      "The data is empty. Give JSON, CSV, TSV or whitespace-separated columns such as the " +
        "output of du, wc or df.",
    );
  }
  const table = tableFromRecords(readRecords(content, format));
  if (table.rows.length === 0 || table.columns.length === 0) {
    throw new Error("The data holds no values.");
  }
  return table;
}
