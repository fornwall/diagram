// Splitting text into records: CSV, TSV, tables drawn with pipes, and whitespace-separated
// command output.

import type { DataFormat } from "./chartSpec";
import type { Records } from "./data";
import { checkTableSize, TableSizeError } from "./dataLimits";
import { parseNumber } from "./dataNumber";

function isBlank(line: string): boolean {
  return line.trim() === "";
}

/**
 * A rule: a line of dashes, as under the header of Markdown ("|---|--:|"), psql ("----+----"),
 * pip list and PowerShell tables, or of "=", as around tokei's.
 */
const RULE = /^(?=[^-=]*[-=])[\s|+:=-]+$/;

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
 * Splits text into delimited records. With quoting, "quoted" fields may contain delimiters,
 * newlines and "" escapes.
 */
function splitDelimited(text: string, delimiter: string, quoting = true): Records {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  let fieldStart = true;
  let line = 1;
  let quoteLine = 0;
  let recordQuoted = false;
  let underlined = false;
  let width = 0;
  const finishRecord = (): void => {
    record.push(field);
    // Spreadsheets save empty rows as ",,,".
    if (!record.every(isBlank)) {
      if (!recordQuoted && RULE.test(record.join(delimiter))) {
        underlined ||= records.length === 1;
      } else {
        width = Math.max(width, record.length);
        checkTableSize(records.length + 1, width);
        records.push(record);
      }
    }
    record = [];
    field = "";
    fieldStart = true;
    closedQuote = false;
    recordQuoted = false;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        field += char;
        if (char === "\n") {
          line++;
        }
      }
    } else if (quoting && char === '"' && fieldStart) {
      quoted = true;
      recordQuoted = true;
      quoteLine = line;
      field = "";
      fieldStart = false;
    } else if (char === delimiter) {
      record.push(field);
      checkTableSize(1, record.length + 1);
      field = "";
      fieldStart = true;
      closedQuote = false;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") {
        i++;
      }
      line++;
      finishRecord();
    } else {
      if (closedQuote && char !== " " && char !== "\t") {
        throw new Error(
          `Unexpected text after a closing quote on line ${line}. Separate fields with ` +
            `the delimiter, or write a quote inside a quoted field twice, as in "say ""hi""".`,
        );
      }
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
  finishRecord();
  return { records, header: underlined || undefined };
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

/** A number with thousands separators within text, as in "apples 1,234". */
const THOUSANDS_IN_TEXT = /(?<![\d.,])\d{1,3}(?:,\d{3})+(?![\d,])/g;

/**
 * Splits comma- or semicolon-separated values with the delimiter that splits the lines more
 * consistently. Unless `strict`, returns undefined when neither splits every line, or 80% of them
 * into as many fields, or when the first line has no delimiter (as in docker ps output, with
 * commas in a column) or commas only separate thousands (as in "apples 1,234").
 */
function splitCsv(text: string, firstLine: string, strict: boolean): Records | undefined {
  let best: { table: Records; uniform: number; width: number } | undefined;
  let quoteError: unknown;
  let sizeError: TableSizeError | undefined;
  for (const delimiter of [",", ";"]) {
    if (
      !text.includes(delimiter) ||
      (!strict &&
        (!firstLine.includes(delimiter) ||
          (delimiter === "," && !text.replace(THOUSANDS_IN_TEXT, "").includes(","))))
    ) {
      continue;
    }
    let table: Records;
    let candidateError: unknown;
    try {
      try {
        table = splitDelimited(text, delimiter);
      } catch (error) {
        if (error instanceof TableSizeError) {
          throw error;
        }
        if (strict) {
          quoteError ??= error;
        }
        candidateError = error;
        table = splitDelimited(text, delimiter, false);
      }
    } catch (error) {
      if (!(error instanceof TableSizeError)) {
        throw error;
      }
      sizeError ??= error;
      continue;
    }
    const { records } = table;
    const width = mode(records.map((record) => record.length));
    const matching = records.reduce((count, row) => count + (row.length === width ? 1 : 0), 0);
    // Lines may have fewer or more fields than the header, as with cloc --csv.
    if (width < 2 || (matching < records.length * 0.8 && records.some((r) => r.length < 2))) {
      continue;
    }
    if (candidateError !== undefined) {
      // In auto mode, literal quotes in command output are not CSV errors unless the
      // unquoted rows also fit this delimiter.
      quoteError ??= candidateError;
      continue;
    }
    // On ties, as for "a;1,5", prefer semicolons: a comma is more likely a decimal comma than a
    // semicolon is part of a field.
    const uniform = matching === records.length ? 1 : 0;
    // A numeric table such as "1,5;2,5" has more commas than semicolons. Splitting at those commas
    // would turn its decimal numbers into separate columns, including text like "5;2".
    if (
      best === undefined ||
      uniform > best.uniform ||
      (uniform === best.uniform &&
        (width >= best.width ||
          records.every((row) =>
            row.every((field) => parseNumber(String(field), true) !== undefined),
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

/** Splits a table with "|" between cells, as in Markdown or printed by psql and mysql. */
function splitPipes(lines: string[]): string[][] {
  // psql prints the number of rows below the table.
  const rows = lines.filter((line) => !/^\(\d+ rows?\)$/.test(line.trim()));
  return rows.map((line) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/(?<!\\)\|$/, "")
      .split(/(?<!\\)\|/)
      .map((cell) => cell.replaceAll("\\|", "|")),
  );
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
  // Not with a regular expression such as /(?:^|\s{2,})\S/g, which takes quadratic time.
  const starts = tokenize(lines[0] ?? "")
    .filter((token, i, tokens) => token.start === 0 || token.start - (tokens[i - 1]?.end ?? 0) >= 2)
    .map((token) => token.start);
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
  // ls -l prints "total 16" above the files.
  if (/^total\s+\S+$/.test(lines[0] ?? "") && tokenize(lines[1] ?? "").length > 2) {
    return splitWhitespace(lines.slice(1), underlined);
  }
  const tokens = lines.map(tokenize);
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

/** Splits text in the given format, or else in the one that fits it best, into records. */
export function splitText(text: string, format: Exclude<DataFormat, "json">): Records {
  const { lines, underlined } = withoutRules(
    text.split(/\r\n?|\n/).filter((line) => !isBlank(line)),
  );
  const tabs = lines.filter((line) => line.includes("\t")).length;
  let tabular: Records | undefined;
  if (format === "tsv" || (format === "auto" && tabs > lines.length / 2)) {
    try {
      tabular = splitDelimited(text, "\t");
      if (format === "tsv" || (tabular.records[0]?.length ?? 0) > 1) {
        return tabular;
      }
    } catch (error) {
      if (error instanceof TableSizeError) {
        throw error;
      }
      // Tab-separated output, e.g. from du, is rarely quoted but may contain quotes in file names.
      tabular = splitDelimited(text, "\t", false);
      const first = tabular.records[0] ?? [];
      if (format === "tsv" || (first.length > 1 && !String(first[0]).includes('"'))) {
        return tabular;
      }
    }
  }
  // Rows of a Markdown table may have fewer or more cells than its header.
  if (format === "auto" && underlined && lines[0]?.includes("|")) {
    return { records: splitPipes(lines), header: true };
  }
  if (format === "auto" || format === "csv") {
    const table = splitCsv(text, lines[0] ?? "", format === "csv");
    if (table !== undefined) {
      return table;
    }
  }
  return tabular ?? splitWhitespace(lines, underlined);
}
