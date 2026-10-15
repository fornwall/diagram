// Splitting text into records in the format that fits it: CSV, TSV, a table drawn with pipes or
// box-drawing characters, or whitespace-separated command output, leaving out what is around the
// table and the rows and columns that the output left out.

import type { DataFormat } from "./chartSpec";
import type { Cell, Records } from "./data";
import { splitGoBenchmarks, splitLs, topSizes } from "./dataCommands";
import { QuoteError, splitCsv, splitDelimited, splitLeniently } from "./dataDelimited";
import { TableSizeError } from "./dataLimits";
import { isBlank, isRule, tokenize } from "./dataLines";
import { markdownTables, splitPipeTable } from "./dataPipes";
import { splitWhitespace, withoutLabelColons } from "./dataWhitespace";

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
  // Explicit delimited formats have literal fields, including "..." rows and columns.
  if (format === "csv" || format === "tsv") return splitShown(text, all, format);
  const tables = format === "auto" ? markdownTables(all) : [];
  const elidedRows = all.some((line) => ELIDED_ROWS.test(line));
  if (format === "auto" && text.includes('"') && (elidedRows || tables.length > 0)) {
    // A quoted CSV/TSV field may contain a whole Markdown table or literal ellipses.
    // Read it before interpreting those physical lines as display formatting.
    let table: Records | undefined;
    try {
      table = splitShown(text, all, format);
    } catch (error) {
      // Prose around a Markdown table need not be valid CSV or fit the table's size limits.
      if (!(error instanceof QuoteError || error instanceof TableSizeError)) throw error;
    }
    if (
      table !== undefined &&
      (table.csv || all.find((line) => !isBlank(line))?.includes("\t")) &&
      table.records.some((record) =>
        record.some((cell) => typeof cell === "string" && cell.includes("\n")),
      )
    ) {
      return table;
    }
  }
  if (format === "auto") {
    // A Markdown table in a document or a chat answer, with text or more tables around it.
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
  if (
    format === "tsv" ||
    (format === "auto" &&
      (tabs > lines.length / 2 || (text.includes('"') && lines[0]?.includes("\t"))))
  ) {
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
  if (format === "auto") {
    const piped = splitPipeTable(lines, ruled, underline);
    if (piped !== undefined) {
      return piped;
    }
  }
  if (format === "auto" || format === "csv") {
    const table = splitCsv(text, lines[0] ?? "", format === "csv");
    if (table !== undefined) {
      return { ...table, csv: true };
    }
  }
  return tabular ?? withoutLabelColons(splitWhitespace(lines, underline));
}
