// Splitting text into records: CSV, TSV, tables drawn with pipes or box-drawing characters, and
// whitespace-separated command output.

import type { DataFormat } from "./chartSpec";
import type { Cell, Records } from "./data";
import { splitDiffStat, splitGoBenchmarks, splitLs, topSizes } from "./dataCommands";
import {
  checkRowCount,
  checkRowWidth,
  checkTableSize,
  MAX_CELLS,
  TableSizeError,
} from "./dataLimits";
import { parseNumber } from "./dataNumber";
import { lineAndColumn, quote } from "./text";

function isBlank(line: string): boolean {
  return line.trim() === "";
}

/**
 * A rule: a line of dashes, as under the header of Markdown ("|---|--:|"), psql ("----+----"),
 * pip list and PowerShell tables, of "=", as around tokei's, or of box-drawing characters, as
 * around those of DuckDB and sqlite3 -box ("├──┼──┤").
 */
const RULE = /^[\s|+:]*[-=\u2500-\u257F][\s|+:=\u2500-\u257F-]*$/;

/** A line of single dashes, which may be missing values ("-  -") rather than a rule. */
const SINGLE_DASHES = /^\s*-(?:\s+-)*\s*$/;

/**
 * Whether `line` is a rule, given the `first` line if it is the second. Single dashes are one only
 * under a header of as many one-letter names in the same places, as under "a b"; otherwise they
 * are a row of missing values.
 */
function isRule(line: string, first: string | undefined): boolean {
  if (!RULE.test(line)) return false;
  if (!SINGLE_DASHES.test(line)) return true;
  const dashes = tokenize(line);
  const names = tokenize(first ?? "");
  return (
    names.length === dashes.length &&
    names.every(
      (name, i) =>
        name.start === dashes[i]?.start &&
        name.end === dashes[i]?.end &&
        parseNumber(name.text) === undefined,
    )
  );
}

/** The rule between the header and the body of a table drawn with box-drawing characters. */
const BOX_HEADER_RULE = /^\s*[\u251C\u255E]/;

/**
 * Leaves out rules, and gives the one under the first line, making it a header, if any. DuckDB and
 * Polars print the types of the columns ("varchar", "i64") below their names, above the rule
 * between header and body ("├──┼──┤", "╞══╪══╡"), and those are left out too. Also tells which
 * lines a rule is right above, as between rows that sqlite3 draws over several lines.
 */
function withoutRules(lines: string[]): { lines: string[]; ruled: boolean[]; underline?: string } {
  const kept: string[] = [];
  const ruled: boolean[] = [];
  let underline: string | undefined;
  let boxHeader = false;
  let rule = false;
  for (const line of lines) {
    if (isRule(line, kept.length === 1 ? kept[0] : undefined)) {
      if (!boxHeader && BOX_HEADER_RULE.test(line)) {
        boxHeader = true;
        kept.length = Math.min(kept.length, 1);
        ruled.length = kept.length;
      }
      if (kept.length === 1) underline ??= line;
      rule = true;
    } else {
      kept.push(line);
      ruled.push(rule);
      rule = false;
    }
  }
  return underline === undefined ? { lines: kept, ruled } : { lines: kept, ruled, underline };
}

/** A quote in delimited text that is not closed as CSV quotes are. */
class QuoteError extends Error {
  /** Where the record with the quote starts in the text. */
  constructor(
    message: string,
    readonly recordStart: number,
  ) {
    super(message);
  }
}

/**
 * Splits text into delimited records. With quoting, "quoted" fields may contain delimiters,
 * newlines and "" escapes.
 */
function splitDelimited(text: string, delimiter: string, quoting = true): Records {
  const records: string[][] = [];
  let width = 0;
  let underlined = false;
  let first: string | undefined;
  /** Adds a record unless it is empty or, as `line` without quotes, a rule. */
  const add = (record: string[], line: string | undefined): void => {
    // Spreadsheets save empty rows as ",,,".
    if (record.every(isBlank)) return;
    if (line !== undefined && isRule(line, records.length === 1 ? first : undefined)) {
      underlined ||= records.length === 1;
      return;
    }
    first ??= line;
    width = Math.max(width, record.length);
    checkTableSize(records.length + 1, width);
    records.push(record);
  };
  // Most exports have no quoted fields, and native splitting is much faster.
  if (!quoting || !text.includes('"')) {
    for (const line of text.split(/\r\n?|\n/)) {
      // Stop at the first excess cell, as the parser below does.
      const record = line.split(delimiter, MAX_CELLS + 1);
      checkRowWidth(record.length);
      add(record, line);
    }
    return { records, header: underlined || undefined };
  }
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  let fieldStart = true;
  let quoteStart = 0;
  let recordQuoted = false;
  let recordStart = 0;
  const finishRecord = (): void => {
    record.push(field);
    add(record, recordQuoted ? undefined : record.join(delimiter));
    record = [];
    field = "";
    fieldStart = true;
    closedQuote = false;
    recordQuoted = false;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      // Up to the next quote at once, as a string built a character at a time is slow to read.
      const close = text.indexOf('"', i);
      field += text.slice(i, close < 0 ? text.length : close);
      if (close < 0) break;
      i = close;
      if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = false;
        closedQuote = true;
      }
    } else if (char === '"' && fieldStart) {
      quoted = true;
      recordQuoted = true;
      quoteStart = i;
      field = "";
      fieldStart = false;
    } else if (char === delimiter) {
      record.push(field);
      checkRowWidth(record.length + 1);
      field = "";
      fieldStart = true;
      closedQuote = false;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") {
        i++;
      }
      finishRecord();
      recordStart = i + 1;
    } else {
      if (closedQuote && char !== " " && char !== "\t") {
        const { line, column } = lineAndColumn(text, i);
        throw new QuoteError(
          `Unexpected text after the quoted field ${quote(field)} on line ${line}, column ` +
            `${column}. Separate fields with the delimiter, or write a quote inside a quoted ` +
            `field twice, as in "say ""hi""".`,
          recordStart,
        );
      }
      if (closedQuote || char === " " || char === "\t") {
        field += char;
      } else {
        // Up to the end of the field at once, as a string built a character at a time is slow
        // to read. Quotes within it are text.
        let end = i + 1;
        while (end < text.length) {
          const next = text[end];
          if (next === delimiter || next === "\n" || next === "\r") break;
          end++;
        }
        field += text.slice(i, end);
        i = end - 1;
        fieldStart = false;
      }
    }
  }
  if (quoted) {
    const { line, column } = lineAndColumn(text, quoteStart);
    throw new QuoteError(
      `The quoted field that starts on line ${line}, column ${column}, is not closed. A quote ` +
        `in a quoted field is written twice, as in "say ""hi""".`,
      recordStart,
    );
  }
  finishRecord();
  return { records, header: underlined || undefined };
}

/** Splits delimited text, ignoring quotes if they are not closed as CSV quotes are. */
function splitLeniently(
  text: string,
  delimiter: string,
): { table: Records; quoteError?: QuoteError } {
  try {
    return { table: splitDelimited(text, delimiter) };
  } catch (error) {
    if (!(error instanceof QuoteError)) {
      throw error;
    }
    return { table: splitDelimited(text, delimiter, false), quoteError: error };
  }
}

/**
 * The most common number of fields of `records`, preferring the smallest on ties, and how many
 * records have it.
 */
function shape(records: unknown[][]): { width: number; matching: number } {
  const counts = new Map<number, number>();
  for (const { length } of records) counts.set(length, (counts.get(length) ?? 0) + 1);
  let width = 0;
  let matching = 0;
  for (const [length, count] of counts) {
    if (count > matching || (count === matching && length < width)) {
      width = length;
      matching = count;
    }
  }
  return { width, matching };
}

/**
 * Whether records split into several fields consistently: most into as many, or each into at least
 * two, as lines may have fewer or more fields than the header, as with cloc --csv.
 */
function fits(records: Cell[][], { width, matching } = shape(records)): boolean {
  return width >= 2 && (matching >= records.length * 0.8 || records.every((r) => r.length >= 2));
}

/** A number with thousands separators within text, as in "apples 1,234". */
const THOUSANDS_IN_TEXT = /(?<![\d.,])\d{1,3}(?:,\d{3})+(?![\d,])/g;

/**
 * Splits comma- or semicolon-separated values with the delimiter that splits the lines more
 * consistently. Unless `strict`, returns undefined when neither splits every line, or 80% of them
 * into as many fields, or when the first line has no delimiter (as in docker ps output, with
 * commas in a column) or commas only separate thousands (as in "apples 1,234"). A quoted first
 * field also permits single-column CSV.
 */
function splitCsv(text: string, firstLine: string, strict: boolean): Records | undefined {
  let best: { table: Records; uniform: boolean; width: number } | undefined;
  let quoteError: QuoteError | undefined;
  let sizeError: TableSizeError | undefined;
  const quotedColumn = firstLine.trimStart().startsWith('"');
  for (const delimiter of [",", ";"]) {
    const candidate =
      quotedColumn ||
      (strict
        ? text.includes(delimiter)
        : firstLine.includes(delimiter) &&
          (delimiter !== "," || text.replace(THOUSANDS_IN_TEXT, "").includes(",")));
    if (!candidate) {
      continue;
    }
    let split: ReturnType<typeof splitLeniently>;
    try {
      split = splitLeniently(text, delimiter);
    } catch (error) {
      if (!(error instanceof TableSizeError)) {
        throw error;
      }
      sizeError ??= error;
      continue;
    }
    const { table, quoteError: candidateError } = split;
    const { records } = table;
    if (candidateError !== undefined) {
      // In auto mode, literal quotes in command output are not CSV errors unless the unquoted
      // rows also fit this delimiter, or the rows above the error do, as when a quoted field
      // over several lines splits the unquoted rows apart.
      const { records: above } = splitDelimited(
        text.slice(0, candidateError.recordStart),
        delimiter,
      );
      if (strict || fits(records) || (above.length > 1 && fits(above))) {
        quoteError ??= candidateError;
      }
      continue;
    }
    const { width, matching } = shape(records);
    const uniform = matching === records.length;
    const singleColumn = quotedColumn && width === 1 && uniform;
    if (!singleColumn && !fits(records, { width, matching })) {
      continue;
    }
    // Semicolons, tried last, win ties, as for "a;1,5": a comma is more likely a decimal comma than
    // a semicolon is part of a field. They also win over more columns split at commas when every
    // field is a number with a decimal comma, as in "1,5;2,5".
    if (
      best === undefined ||
      (uniform && !best.uniform) ||
      (uniform === best.uniform &&
        (width >= best.width ||
          records.every((row) =>
            row.every((field) => parseNumber(String(field), { decimalComma: true }) !== undefined),
          )))
    ) {
      best = { table, uniform, width };
    }
  }
  if (best === undefined && quoteError !== undefined) {
    throw quoteError;
  }
  if (best === undefined && sizeError !== undefined) {
    throw sizeError;
  }
  return best?.table ?? (strict ? splitDelimited(text, ",") : undefined);
}

/**
 * A line that tells the size of a table rather than holding data, as psql ("(2 rows)"), mysql
 * ("2 rows in set (0.00 sec)"), pandas ("[1000 rows x 3 columns]") and DuckDB ("│ 1000 rows (40
 * shown)  3 columns │") print below it, and Polars ("shape: (1_000, 3)") above it.
 */
const TABLE_SIZE =
  /^\s*(?:\(\d+ rows?\)|\d+ rows? in set\b.*|Empty set\b.*|\[\d+ rows x \d+ columns\]|shape: \([\d_]+, [\d_]+\)|│(?:\s*(?:[\d,]+ (?:rows?|columns?)|\([^()]*shown\)))+\s*│)$/;

/** What DuckDB ("·"), Polars ("…") and pandas ("...") print for the rows or columns they left out. */
const ELISION_MARK = String.raw`(?:[·…]|\.{2,})`;
const ELISION = new RegExp(`^${ELISION_MARK}$`);

/** A line that stands for the rows that the output left out of a long table, in each column. */
const ELIDED_ROWS = new RegExp(String.raw`^[\s|│┆]*(?:${ELISION_MARK}(?:[\s|│┆]+|$))+$`);

/**
 * The columns that stand for those the output left out of a wide table: under a mark in the
 * header, they have marks or nothing.
 */
function elidedColumns(records: Cell[][]): Set<number> {
  const mark = (cell: Cell | undefined) => typeof cell === "string" && ELISION.test(cell.trim());
  const elided = new Set<number>();
  for (const [column, name] of (records[0] ?? []).entries()) {
    if (
      mark(name) &&
      records.every((record) => {
        const cell = record[column] ?? null;
        return cell === null || String(cell).trim() === "" || mark(cell);
      })
    ) {
      elided.add(column);
    }
  }
  return elided;
}

/**
 * Says that only the rows or columns that the output shows were read, with how many it has in all
 * if a line of {@link TABLE_SIZE} among `lines` tells.
 */
function elisionNote(lines: string[], rows: boolean, columns: boolean): string {
  // Polars writes "1_000" for a thousand.
  const size = (lines.find((line) => TABLE_SIZE.test(line)) ?? "").replaceAll("_", ",");
  const [, shapeRows, shapeColumns] = /\(([\d,]+), ([\d,]+)\)/.exec(size) ?? [];
  const rowCount = shapeRows ?? /([\d,]+) rows/.exec(size)?.[1];
  const columnCount = shapeColumns ?? /([\d,]+) columns/.exec(size)?.[1];
  const totals = [
    rows && rowCount !== undefined && `${rowCount} rows`,
    columns && columnCount !== undefined && `${columnCount} columns`,
  ].filter(Boolean);
  const left = [rows && "rows", columns && "columns"].filter(Boolean).join(" and ");
  return (
    `Only the ${left} that the output shows were read, not those it left out` +
    (totals.length === 0 ? "." : ` of its ${totals.join(" and ")}.`)
  );
}

/** A pipe that is not escaped by a backslash, which itself may be escaped ("\\|"), as in GFM. */
const PIPE = /(?<=(?:^|[^\\])(?:\\\\)*)\|/;

/** A vertical line drawn with box-drawing characters: "│", or "┆" between the columns of Polars. */
const BOX_LINE = /[\u2502\u2503\u2506\u2551]/;

/** Markdown emphasis or code around a whole cell, as in "**Total**" or "`12`". */
const MARKDOWN_SPAN = /^\s*(\*\*|\*|`)(?=\S)((?:(?!\1).)*\S)\1\s*$/;

/**
 * Splits a row of a table with "|" between cells, as in Markdown, printed by psql, mysql and
 * sqlite3, or by sqlite3 and psql -A without spaces, or with the `box` lines that sqlite3, DuckDB
 * and Polars draw, between which a "|" is text. A leading and trailing separator are optional.
 */
function pipeCells(line: string, box = false): string[] {
  // Two more than a row may have, as a leading and a trailing pipe leave empty cells.
  const cells = line.trim().split(box ? BOX_LINE : PIPE, MAX_CELLS + 3);
  if (cells.length > 1 && cells[0] === "") cells.shift();
  if (cells.length > 1 && cells.at(-1) === "") cells.pop();
  checkRowWidth(cells.length);
  return box
    ? cells
    : cells.map((cell) => cell.replaceAll("\\|", "|").replace(MARKDOWN_SPAN, "$2"));
}

/**
 * Escapes the pipes of `line` that are not at a "|" or "+" of the `rule` under the header, as a
 * pipe in a cell of a table that psql, mysql or sqlite3 align is not.
 */
function escapeUnaligned(line: string, rule: string): string {
  return line.replace(/\|/g, (pipe, i: number) => (/[|+]/.test(rule[i] ?? "") ? pipe : "\\|"));
}

/** How a cell's text goes on in the line below: after a newline in it, or wrapped. */
type Continuation = "newline" | "wrap" | undefined;

/**
 * How the cells of a line go on in the line below, and the text of each between the spaces around
 * it, with the spaces in it, as wrapped text may have some at either end.
 */
interface MarkedLine {
  marks: Continuation[];
  texts: string[];
}

/** A horizontal line of a rule, as between the junctions of "+----+" or "├────┼". */
const HORIZONTAL = /[-=\u2500\u2501\u2550]/;

/** The marks after the text of a cell that goes on in the line below. */
const NEWLINE_MARK = /[+\u21B5]/;
const WRAP_MARK = /[.\u2026]/;

/**
 * Leaves out the marks that psql writes in the space after the text of a cell that goes on in the
 * line below, "+" or "↵" for a newline in it and "." or "…" where it wraps, and those it writes in
 * the space before the rest of wrapped text, and tells how the cells of each line go on. Only in
 * tables aligned under a `rule` with "+" or box-drawing junctions, as psql, mysql and sqlite3 draw
 * them with a space on each side of the text of a cell, blank but for the marks, as the header
 * shows, and not in Markdown tables, which need not be aligned.
 */
function continuationMarks(
  lines: string[],
  rule: string,
  box: boolean,
): { lines: string[]; marked: (MarkedLine | undefined)[] } {
  const columns = [...rule.matchAll(new RegExp(`${HORIZONTAL.source}+`, "g"))].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  if (/[|:]/.test(rule) || columns.length === 0) {
    return { lines, marked: [] };
  }
  const junctions = [...rule.trimEnd()].flatMap((char, i) =>
    char === " " || HORIZONTAL.test(char) ? [] : [i],
  );
  const blankAt = (line: string, i: number) => i >= line.length || line[i] === " ";
  const header = lines[0] ?? "";
  if (
    junctions.length === 0 ||
    !columns.every(({ start, end }) => blankAt(header, start) && blankAt(header, end - 1))
  ) {
    return { lines, marked: [] };
  }
  const separator = box ? BOX_LINE : /\|/;
  const marked: (MarkedLine | undefined)[] = [];
  let above: Continuation[] = [];
  const unmarked = lines.map((line) => {
    // Lines with wide characters, or not drawn by such a tool, are not aligned with the rule.
    if (
      !junctions.every((i) => i >= line.length || separator.test(line[i] ?? "")) ||
      !columns.every(
        ({ start }, column) =>
          blankAt(line, start) || (above[column] === "wrap" && WRAP_MARK.test(line[start] ?? "")),
      )
    ) {
      above = [];
      marked.push(undefined);
      return line;
    }
    const chars = line.split("");
    const marks = columns.map(({ start, end }, column): Continuation => {
      if (end - start < 3) return undefined;
      if (above[column] === "wrap" && WRAP_MARK.test(chars[start] ?? "")) chars[start] = " ";
      const mark = chars[end - 1] ?? "";
      const continuation = NEWLINE_MARK.test(mark)
        ? "newline"
        : WRAP_MARK.test(mark)
          ? "wrap"
          : undefined;
      if (continuation !== undefined) chars[end - 1] = " ";
      return continuation;
    });
    above = marks;
    marked.push({ marks, texts: columns.map(({ start, end }) => line.slice(start + 1, end - 1)) });
    return chars.join("");
  });
  return { lines: unmarked, marked };
}

/**
 * Joins the lines of rows over several lines into the rows: those below a line that psql marks
 * as {@link continuationMarks} tells, and, in a table with rules between rows, as sqlite3 -box
 * and -table draw one with text over several lines, the lines between two rules that go on the
 * first: each has some cells empty, as the cells of other columns have fewer lines, and no
 * numbers in the others below a number or nothing, as a number has no newlines, though text may
 * go on with one, as an address with its postal code.
 *
 * Rules may also be between groups of rows, as in a report, where a row may lack values. Unless
 * rules are surely between each row and the next, as rows of one line between them outnumber
 * those of several, a line goes on only with an empty first cell, so that a row named in the
 * first column is a row of its own: in sqlite3 tables of only a few rows, a first cell over several
 * lines is not joined. Lines above a rule that sets off only the last line, as a total, are rows.
 */
function joinLines(
  records: string[][],
  marked: (MarkedLine | undefined)[],
  ruled: boolean[],
): string[][] {
  const blank = (cell: string | undefined) => (cell ?? "").trim() === "";
  const continues = records.map(() => false);
  // The first line of the body, after the header, has the rule below the header above it.
  const inner = ruled.flatMap((rule, i) => (rule && i > 1 ? [i] : []));
  if (inner.length > 1 || (inner.length === 1 && inner[0] !== records.length - 1)) {
    // The lines between each two rules, from the first line of the body.
    const blocks = [1, ...inner].map((start, i) => ({ start, end: inner[i] ?? records.length }));
    const single = blocks.filter(({ start, end }) => end - start === 1).length;
    const perRow = single >= 3 && single > blocks.length - single;
    const isNumber = (cell: string | undefined) =>
      !blank(cell) && parseNumber((cell ?? "").trim()) !== undefined;
    const goesOn = (record: string[], first: string[]) =>
      (perRow ? record.some(blank) : blank(record[0])) &&
      !record.every(blank) &&
      record.every(
        (cell, column) => !isNumber(cell) || (!blank(first[column]) && !isNumber(first[column])),
      );
    for (const { start, end } of blocks) {
      const first = records[start] ?? [];
      if (records.slice(start + 1, end).every((record) => goesOn(record, first))) {
        continues.fill(true, start + 1, end);
      }
    }
  }
  const rows: string[][] = [];
  /** The line where the last row starts. */
  let rowStart = 0;
  for (const [i, record] of records.entries()) {
    const above = marked[i - 1];
    const last = rows.at(-1);
    if (
      last !== undefined &&
      (above?.marks.some((mark) => mark !== undefined) === true || continues[i])
    ) {
      rows[rows.length - 1] = Array.from(
        { length: Math.max(last.length, record.length) },
        (_, column) => {
          const top = last[column] ?? "";
          const below = record[column] ?? "";
          if (above?.marks[column] === "wrap") {
            // Text wraps at any character, so the spaces at the ends of its parts are kept, from
            // the line above unless it went on from an earlier line already joined.
            const first = rowStart === i - 1 ? above.texts[column] : top;
            return (first ?? top) + (marked[i]?.texts[column] ?? below);
          }
          if (blank(below)) return top;
          if (blank(top)) return below;
          return `${top.trim()}\n${below.trim()}`;
        },
      );
    } else {
      rows.push(record);
      rowStart = i;
    }
  }
  return rows;
}

/**
 * A GFM delimiter row, as under the header of a Markdown table, trimmed: "|---|:--:|" or "--|--".
 * Spaces are matched only beside pipes: two places for spaces next to each other would take
 * quadratic time to match against a long line of spaces.
 */
const DELIMITER_ROW = /^\|?(?:[ \t]*:?-+:?[ \t]*\|)*[ \t]*:?-+:?[ \t]*\|?$/;

/**
 * A line that starts a block other than a paragraph, and so ends a table, in GFM: a block quote, a
 * heading, a code fence, a list item, HTML or a thematic break. Unambiguous, so that a long line
 * cannot take long to match.
 */
const BLOCK_START =
  /^ {0,3}(?:>|#{1,6}(?:[ \t]|$)|`{3}|~{3}|[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|<[a-zA-Z/!?]|(?:\*[ \t]*){3,}$|(?:-[ \t]*){3,}$|(?:_[ \t]*){3,}$)/;

/**
 * Finds Markdown tables among `lines`: a header row above a delimiter row with as many cells, and
 * the rows below them up to a blank line or the start of another block, as in GFM, where a line
 * without a pipe below a table is a row of one cell, unless it is below the last row.
 */
function markdownTables(lines: string[]): { start: number; end: number }[] {
  const tables: { start: number; end: number }[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const header = lines[i] ?? "";
    const delimiter = lines[i + 1] ?? "";
    if (
      PIPE.test(header) &&
      delimiter.includes("|") &&
      DELIMITER_ROW.test(delimiter.trim()) &&
      !RULE.test(header) &&
      pipeCells(header).length === pipeCells(delimiter).length
    ) {
      let end = i + 2;
      while (
        end < lines.length &&
        !isBlank(lines[end] ?? "") &&
        !BLOCK_START.test(lines[end] ?? "")
      ) {
        end++;
      }
      // GFM reads lines without a pipe as rows of one cell, but those at the end below a table
      // of several columns are more likely its caption or a footer, as "Total rows: 2".
      if (pipeCells(header).length > 1) {
        while (end > i + 2 && !PIPE.test(lines[end - 1] ?? "")) end--;
      }
      tables.push({ start: i, end });
      i = end - 1;
    }
  }
  return tables;
}

interface Token {
  text: string;
  start: number;
  end: number;
}

const WORD = /\S+/g;

function tokenize(line: string): Token[] {
  // A loop of exec, which takes a quarter of the time of matchAll on long command output.
  const tokens: Token[] = [];
  WORD.lastIndex = 0;
  for (let match = WORD.exec(line); match !== null; match = WORD.exec(line)) {
    tokens.push({ text: match[0], start: match.index, end: WORD.lastIndex });
    // No row has more cells, so a longer line is refused before it is read further.
    checkRowWidth(tokens.length);
  }
  return tokens;
}

/**
 * Joins the tokens of a duration that systemd writes with spaces between its parts, as
 * "1min 2.345s" in systemd-analyze blame, or "1h 2min". Only with its "min", as durations in
 * columns of their own ("2h 30s") are as likely.
 */
function joinDurations(line: string, tokens: Token[]): Token[] {
  const joined: Token[] = [];
  for (const token of tokens) {
    const last = joined.at(-1);
    if (last !== undefined && token.start === last.end + 1 && /\d(?:d|h|min)$/.test(last.text)) {
      const text = line.slice(last.start, token.end);
      if (text.includes("min") && parseNumber(text)?.unit === "seconds") {
        joined[joined.length - 1] = { text, start: last.start, end: token.end };
        continue;
      }
    }
    joined.push(token);
  }
  return joined;
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
    // Each word is compared with each column, which would take long for very wide output.
    header.length * count > MAX_CELLS ||
    rest.some((line) => line.length !== count)
  ) {
    return undefined;
  }
  const spans = columnSpans(rest, count);
  const names: string[][] = spans.map(() => []);
  for (const word of header) {
    names[nearestColumn(word, spans)]?.push(word.text);
  }
  return [names.map((words) => words.join(" ")), ...rest.map((line) => line.map((t) => t.text))];
}

/** Where each of `count` columns is, from the first to the last character in it of `lines`. */
function columnSpans(lines: Token[][], count: number): { start: number; end: number }[] {
  return Array.from({ length: count }, (_, column) => {
    let start = Number.POSITIVE_INFINITY;
    let end = 0;
    for (const line of lines) {
      start = Math.min(start, line[column]?.start ?? 0);
      end = Math.max(end, line[column]?.end ?? 0);
    }
    return { start, end };
  });
}

/** The column of `spans` that `word` overlaps most, or else is nearest to. */
function nearestColumn(word: Token, spans: { start: number; end: number }[]): number {
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
  return best;
}

/**
 * The cells of a line with more words than the columns of `spans`, if all its extra words are under
 * one column other than the last, as a name with a space is in the first column of df on macOS
 * ("map auto_home"), and each other column has one. Otherwise, as in ps aux, the last column keeps
 * them.
 */
function alignedFields(
  line: string,
  tokens: Token[],
  spans: { start: number; end: number }[],
): string[] | undefined {
  // Each word is compared with each column, which would take long for very wide output.
  if (tokens.length * spans.length > 10_000) return undefined;
  const columns: Token[][] = spans.map(() => []);
  let last = 0;
  let wide: number | undefined;
  for (const token of tokens) {
    const column = nearestColumn(token, spans);
    if (column < last) return undefined;
    if (columns[column]?.push(token) === 2) {
      if (wide !== undefined || column === spans.length - 1) return undefined;
      wide = column;
    }
    last = column;
  }
  if (wide === undefined || columns.some((words) => words.length === 0)) return undefined;
  return columns.map((words) => line.slice(words[0]?.start, words.at(-1)?.end));
}

/**
 * Splits aligned columns at the positions where they `start`, so that cells may be empty or have
 * spaces. Returns undefined unless there are several and each line has a space before each.
 */
function splitAtStarts(lines: string[], starts: number[]): string[][] | undefined {
  if (
    starts.length < 2 ||
    !lines.every(
      (line) =>
        !line.includes("\t") &&
        line.slice(0, starts[0]).trim() === "" &&
        starts.every((start, i) => i === 0 || line.length <= start || line[start - 1] === " "),
    )
  ) {
    return undefined;
  }
  checkTableSize(lines.length, starts.length);
  return lines.map((line) =>
    starts.map((start, i) => line.slice(start, starts[i + 1] ?? line.length).trim()),
  );
}

/**
 * Splits aligned columns (as printed by docker ps) at the positions where the header's columns
 * start, which are separated by at least two spaces. Returns undefined when the lines are not
 * aligned that way.
 */
function splitAtHeaderGaps(lines: string[]): string[][] | undefined {
  // Not with a regular expression such as /(?:^|\s{2,})\S/g, which takes quadratic time.
  const starts = tokenize(lines[0] ?? "")
    .filter((token, i, tokens) => token.start === 0 || token.start - (tokens[i - 1]?.end ?? 0) >= 2)
    .map((token) => token.start);
  const records = splitAtStarts(lines, starts);
  // A cell with a wide gap inside spans several columns: the header is not aligned with the data.
  return records?.some((record) => record.some((cell) => /\s{2,}/.test(cell)))
    ? undefined
    : records;
}

/**
 * Whether `line` names groups of the columns of the `header` below it, as vmstat prints them:
 * "procs -----------memory---------- ---swap--", with fewer words than the header has names.
 */
function isColumnGroups(line: string, header: string): boolean {
  const groups = tokenize(line);
  if (!groups.some((group) => /^-{2,}[^-].*-{2,}$/.test(group.text))) return false;
  const names = tokenize(header);
  return (
    names.length > groups.length && names.every((name) => parseNumber(name.text) === undefined)
  );
}

/**
 * Splits whitespace-separated lines into as many fields as most lines have; the last field keeps
 * any remaining spaces, so "12 src/a b.ts" gives ["12", "src/a b.ts"]. Multi-word column names,
 * as printed by df or docker ps, are matched to the data columns by position. The first line is a
 * header if it has an `underline`, a rule, whose parts tell where the columns are, as tasklist,
 * PowerShell, sqlite3 -column and pip list draw it, so that "Image Name" and "6,532 K" are cells.
 */
function splitWhitespace(lines: string[], underline: string | undefined): Records {
  // ls -l prints "total 16" above the files, also with the inodes or blocks before them (-i, -s).
  if (/^total\s+\S+$/.test(lines[0] ?? "") && tokenize(lines[1] ?? "").length > 2) {
    return splitWhitespace(lines.slice(1), underline);
  }
  if (isColumnGroups(lines[0] ?? "", lines[1] ?? "")) {
    return splitWhitespace(lines.slice(1), underline);
  }
  // Each line is a record, so too many lines need not be split to be refused.
  checkRowCount(lines.length);
  const ruled =
    underline === undefined
      ? undefined
      : splitAtStarts(
          lines,
          tokenize(underline).map((part) => part.start),
        );
  if (ruled !== undefined) {
    return { records: ruled, header: true };
  }
  const tokens = lines.map((line) => joinDurations(line, tokenize(line)));
  const [header = [], ...data] = tokens;
  const textHeader = header.every((token) => parseNumber(token.text) === undefined);
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
  if (textHeader && data.some((line) => line.length !== header.length)) {
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
      : shape(tokens).width;
  const full = (textHeader ? data : tokens).filter((line) => line.length === count);
  const spans = full.length > 0 ? columnSpans(full, count) : undefined;
  return {
    records: lines.map((line, i) => {
      const words = tokens[i] ?? [];
      const aligned =
        spans && words.length > count && (i > 0 || !textHeader)
          ? alignedFields(line, words, spans)
          : undefined;
      return aligned ?? fields(line, words, count);
    }),
    header: underline === undefined ? undefined : true,
  };
}

/**
 * Whether `line` may be above a table rather than in it, as exports from spreadsheets, banks and
 * Google Analytics have them: a comment ("# exported 2024-01-01"), or a title ("Sales by region")
 * of words without a delimiter, a leading digit or quote, or the wide gaps of aligned columns.
 */
function isPreamble(line: string): boolean {
  const text = line.trim();
  return /^#(?: |$)/.test(text) || (/^[^\d"].* /.test(text) && !/[,;\t|]| {2}/.test(text));
}

/**
 * The number of lines above a table of delimited values that are not part of it, being blank or
 * {@link isPreamble}, or 0 if there are none.
 */
function preambleLength(lines: string[]): number {
  let length = 0;
  let text = false;
  for (const line of lines) {
    if (!isBlank(line)) {
      if (!isPreamble(line)) break;
      text = true;
    }
    length++;
  }
  // A header and a row of the table share a delimiter, which a line of text, such as a commit
  // subject, may have too.
  const [header = "", row = ""] = filledLines(lines, length).map((i) => lines[i]);
  return text && [",", ";", "\t"].some((d) => header.includes(d) && row.includes(d)) ? length : 0;
}

/** The indexes of the first two lines from `start` that are not blank. */
function filledLines(lines: string[], start: number): number[] {
  const filled: number[] = [];
  for (let i = start; i < lines.length && filled.length < 2; i++) {
    if (!isBlank(lines[i] ?? "")) filled.push(i);
  }
  return filled;
}

/** The first line of top's summary of the system above its processes, on Linux or macOS. */
const TOP_SUMMARY = /^(?:top - |Processes: \d+ total)/;

/**
 * The number of lines that a command prints above its table, or 0 if there are none: the summary
 * that top prints above its header ("PID USER …"), or text above a header between two rules, as
 * cloc prints its version and speed, which has other numbers of words than the header.
 */
function outputAbove(lines: string[]): number {
  if (TOP_SUMMARY.test(lines[0] ?? "")) {
    return Math.max(
      lines.findIndex((line) => /^\s*PID\s/.test(line)),
      0,
    );
  }
  let rule = 0;
  while (rule < lines.length && !isRule(lines[rule] ?? "", undefined)) rule++;
  const [header, below] = filledLines(lines, rule + 1).map((i) => lines[i] ?? "");
  if (header === undefined || below === undefined || !isRule(below, undefined)) return 0;
  const words = tokenize(header).length;
  const above = lines.slice(0, rule).filter((line) => !isBlank(line) && !TABLE_SIZE.test(line));
  return above.length > 0 && above.every((line) => tokenize(line).length !== words) ? rule : 0;
}

/**
 * Splits text into records in the given format, or in auto format as the first that fits of
 * those that parseTable (in data.ts) lists.
 */
export function splitText(text: string, format: Exclude<DataFormat, "json">): Records {
  // Excel writes and reads a first line such as "sep=;" that names the delimiter. It is left as an
  // empty line, which is skipped, so that errors count lines as an editor does.
  const declared = /^sep=([^\r\n])(?=\r|\n|$)/.exec(text);
  if (declared?.[1] !== undefined) {
    return { ...splitDelimited(text.slice(declared[0].length), declared[1]), csv: true };
  }
  const all = text.split(/\r\n?|\n/);
  if (format === "auto") {
    // A Markdown table in a document or a chat answer, with text or more tables around it.
    const tables = markdownTables(all);
    const [table] = tables;
    if (
      table !== undefined &&
      (tables.length > 1 ||
        all.some((line, i) => (i < table.start || i >= table.end) && !isBlank(line)))
    ) {
      const lines = `lines ${table.start + 1}\u2013${table.end}`;
      const note =
        tables.length > 1
          ? `The data has ${tables.length} Markdown tables; only the first (${lines}) was read.`
          : `Only the Markdown table (${lines}) was read, not the text around it.`;
      const inner = splitText(all.slice(table.start, table.end).join("\n"), format);
      // What the table itself left out, as rows of "...", is noted after it.
      return { ...inner, note: inner.note === undefined ? note : `${note} ${inner.note}` };
    }
  }
  const elidedRows = all.some((line) => ELIDED_ROWS.test(line));
  // Left as empty lines, which are skipped, as errors count lines.
  const shown = elidedRows ? all.map((line) => (ELIDED_ROWS.test(line) ? "" : line)) : all;
  const table = splitShown(elidedRows ? shown.join("\n") : text, shown, format);
  const elided = elidedColumns(table.records);
  if (!elidedRows && elided.size === 0) {
    return table;
  }
  const kept = (_: unknown, column: number) => !elided.has(column);
  return {
    ...table,
    records: table.records.map((record) => record.filter(kept)),
    ...(table.units === undefined ? {} : { units: table.units.filter(kept) }),
    note: [table.note, elisionNote(all, elidedRows, elided.size > 0)].filter(Boolean).join(" "),
  };
}

/**
 * Splits text without the rows that the output left out, given as `all` its lines. Text above a
 * table of delimited values, such as a title, is left out, as is what top and cloc print above
 * theirs, unless the text is the output of a command that has its own lines around the table, such
 * as go test -bench.
 */
function splitShown(text: string, all: string[], format: Exclude<DataFormat, "json">): Records {
  const { lines, ruled, underline } = withoutRules(
    all.filter((line) => !isBlank(line) && !TABLE_SIZE.test(line)),
  );
  if (format === "auto") {
    const output = splitLs(lines) ?? splitGoBenchmarks(lines);
    if (output !== undefined) {
      return output;
    }
  }
  const preamble = outputAbove(all) || (format === "whitespace" ? 0 : preambleLength(all));
  if (preamble > 0) {
    // Left as empty lines, which are skipped, as errors count lines.
    const kept = all.map((line, i) => (i < preamble ? "" : line));
    const table = splitShown(kept.join("\n"), kept, format);
    if ((table.records[0]?.length ?? 0) > 1) {
      const note = `Only the table from line ${preamble + 1} was read, not the text above it.`;
      return { ...(TOP_SUMMARY.test(all[0] ?? "") ? topSizes(table) : table), note };
    }
  }
  const tabs = lines.filter((line) => line.includes("\t")).length;
  let tabular: Records | undefined;
  if (format === "tsv" || (format === "auto" && tabs > lines.length / 2)) {
    // Tab-separated output, e.g. from du, is rarely quoted but may contain quotes in file names.
    const { table, quoteError } = splitLeniently(text, "\t");
    tabular = table;
    const first = table.records[0] ?? [];
    if (
      format === "tsv" ||
      (first.length > 1 && (quoteError === undefined || !String(first[0]).includes('"')))
    ) {
      return table;
    }
  }
  const box = BOX_LINE.test(lines[0] ?? "");
  if (format === "auto" && (box || PIPE.test(lines[0] ?? ""))) {
    const diffStat = box ? undefined : splitDiffStat(lines);
    if (diffStat !== undefined) {
      return diffStat;
    }
    const width = pipeCells(lines[0] ?? "", box).length;
    if (underline !== undefined) {
      const { lines: unmarked, marked } = continuationMarks(lines, underline, box);
      // As in GFM, the header of a pipe table sets its width: shorter rows are padded, and the
      // cells beyond it are left out, unless pipes in cells of an aligned table split them off.
      // Without a line at the left, as psql draws tables with "+" or "┼" between the columns of
      // the rule, a line that starts with one has an empty first cell.
      const separator = box ? BOX_LINE : PIPE;
      const unbordered =
        !/[|:]/.test(underline) &&
        HORIZONTAL.test(underline.trim()[0] ?? "") &&
        [...underline.trim()].some((char) => char !== " " && !HORIZONTAL.test(char)) &&
        !separator.test((lines[0] ?? "").trim()[0] ?? "");
      const cells = (line: string): string[] => {
        const split = pipeCells(line, box);
        return unbordered && separator.test(line.trim()[0] ?? "") ? ["", ...split] : split;
      };
      const fit = (line: string): string[] => {
        const record = cells(line);
        if (record.length <= width) return record;
        const aligned = box ? record : cells(escapeUnaligned(line, underline));
        return aligned.length === width ? aligned : record.slice(0, width);
      };
      return { records: joinLines(unmarked.map(fit), marked, ruled), header: true };
    }
    const records = lines.map((line) => pipeCells(line, box));
    if (width > 1 && records.every((record) => record.length === width)) {
      return { records };
    }
  }
  if (format === "auto" || format === "csv") {
    const table = splitCsv(text, lines[0] ?? "", format === "csv");
    if (table !== undefined) {
      return { ...table, csv: true };
    }
  }
  return tabular ?? splitWhitespace(lines, underline);
}
