// Splitting comma-, semicolon- or tab-separated values into records, with CSV quoting.

import type { Cell, Records } from "./data";
import { checkRowWidth, checkTableSize, MAX_CELLS, TableSizeError } from "./dataLimits";
import { isBlank, isRule, shape } from "./dataLines";
import { parseNumber } from "./dataNumber";
import { lineAndColumn, quote } from "./text";

/** A quote in delimited text that is not closed as CSV quotes are. */
export class QuoteError extends Error {
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
export function splitDelimited(text: string, delimiter: string, quoting = true): Records {
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
      const part = text.slice(i, close < 0 ? text.length : close);
      // Newlines in it as "\n", as Windows line endings would leave a "\r" in labels.
      field += part.includes("\r") ? part.replace(/\r\n?/g, "\n") : part;
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
export function splitLeniently(
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
 * Whether records split into several fields consistently: most into as many, or each into at least
 * two, as lines may have fewer or more fields than the header, as with cloc --csv, or more than
 * half into as many as a first record of names, as "x,y" above "1,2" and a short row, which would
 * otherwise be read as numbers with a decimal comma.
 */
function fits(records: Cell[][], { width, matching } = shape(records)): boolean {
  const [first = []] = records;
  const named =
    first.length === width &&
    matching > records.length / 2 &&
    first.every((cell) => {
      const name = String(cell ?? "").trim();
      return name !== "" && parseNumber(name) === undefined;
    });
  return (
    width >= 2 && (matching >= records.length * 0.8 || records.every((r) => r.length >= 2) || named)
  );
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
export function splitCsv(text: string, firstLine: string, strict: boolean): Records | undefined {
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
