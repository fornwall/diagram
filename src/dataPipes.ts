// Splitting tables drawn with pipes or box-drawing characters: Markdown tables, and those that
// psql, mysql, sqlite3, DuckDB and Polars print, with cells over several lines.

import type { Records } from "./data";
import { splitDiffStat } from "./dataCommands";
import { checkRowWidth, MAX_CELLS } from "./dataLimits";
import { isBlank, RULE } from "./dataLines";
import { parseNumber } from "./dataNumber";

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
export function markdownTables(lines: string[]): { start: number; end: number }[] {
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

/**
 * Splits a table whose first line has pipes or box-drawing lines between its cells: the output of
 * git diff --stat, a table under a rule, as Markdown, psql, mysql, sqlite3, DuckDB and Polars draw
 * it, with its rows over several lines joined, or rows of as many cells without a rule. Returns
 * undefined unless the lines are such a table.
 */
export function splitPipeTable(
  lines: string[],
  ruled: boolean[],
  underline: string | undefined,
): Records | undefined {
  const box = BOX_LINE.test(lines[0] ?? "");
  if (!box && !PIPE.test(lines[0] ?? "")) return undefined;
  const diffStat = box ? undefined : splitDiffStat(lines);
  if (diffStat !== undefined) return diffStat;
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
  return width > 1 && records.every((record) => record.length === width) ? { records } : undefined;
}
