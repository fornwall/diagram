// Splitting whitespace-separated command output into columns, aligned under a header (df, docker
// ps, free) or not (du, wc).

import type { Records } from "./data";
import { checkRowCount, checkTableSize, MAX_CELLS } from "./dataLimits";
import { shape, type Token, tokenize } from "./dataLines";
import { parseNumber } from "./dataNumber";

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
export function splitWhitespace(lines: string[], underline: string | undefined): Records {
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
 * Leaves out the colon after each label in the first column, as free ("Mem:"), /proc/meminfo
 * ("MemTotal:") and other listings of "name: value" write them, when every label has one.
 */
export function withoutLabelColons(table: Records): Records {
  const labels = table.records.slice(table.header ? 1 : 0).map((record) => record[0]);
  if (
    labels.length === 0 ||
    !labels.every((label) => typeof label === "string" && /^[^\s:].*:$/.test(label))
  ) {
    return table;
  }
  for (const record of table.records.slice(table.header ? 1 : 0)) {
    record[0] = String(record[0]).slice(0, -1);
  }
  return table;
}
