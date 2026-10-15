// Lines of text as the splitters of each format read them: blank lines, rules, words and the
// most common number of fields of records.

import { checkRowWidth } from "./dataLimits";
import { parseNumber } from "./dataNumber";

export function isBlank(line: string): boolean {
  return line.trim() === "";
}

/**
 * A rule: a line of dashes, as under the header of Markdown ("|---|--:|"), psql ("----+----"),
 * pip list and PowerShell tables, of "=", as around tokei's, or of box-drawing characters, as
 * around those of DuckDB and sqlite3 -box ("├──┼──┤").
 */
export const RULE = /^[\s|+:]*[-=\u2500-\u257F][\s|+:=\u2500-\u257F-]*$/;

/** A line of single dashes, which may be missing values ("-  -") rather than a rule. */
const SINGLE_DASHES = /^\s*-(?:\s+-)*\s*$/;

/**
 * Whether `line` is a rule, given the `first` line if it is the second. Single dashes are one only
 * under a header of as many one-letter names in the same places, as under "a b"; otherwise they
 * are a row of missing values.
 */
export function isRule(line: string, first: string | undefined): boolean {
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

export interface Token {
  text: string;
  start: number;
  end: number;
}

const WORD = /\S+/g;

export function tokenize(line: string): Token[] {
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
 * The most common number of fields of `records`, preferring the smallest on ties, and how many
 * records have it.
 */
export function shape(records: unknown[][]): { width: number; matching: number } {
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
