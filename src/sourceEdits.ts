// Exact text replacements in a diagram's source, as diagram_edit makes them, and the numbered lines
// that tell a model where an edit or an error is, to make the next edit with.

import { formatCount, joinWords, lineAndColumn, plural, shorten } from "./text";

/** Replaces oldText, which must occur once in the source unless every occurrence is to go. */
export interface SourceEdit {
  oldText: string;
  newText: string;
  replaceAll: boolean;
}

/**
 * The source with the edits made in turn, each to the source the edits before it left, with the
 * number of occurrences that each replaced; or why some did not apply, in which case none is made.
 */
export type EditedSource =
  | { ok: true; source: string; replaced: number[] }
  | { ok: false; problems: string[] };

/** The most lines quoted around a place, and the most characters of each. */
const CONTEXT_LINES = 3;
const MAX_LINE_LENGTH = 200;
/** The most occurrences of an ambiguous oldText listed. */
const MAX_LISTED = 5;
/** How many characters of lines times lines of oldText the search for the closest lines compares. */
const MAX_COMPARED = 2_000_000;
/**
 * The line that stands for a run of lines of values left out of a long chart option shown to a
 * model, as describe.ts's withoutValueRuns writes it.
 */
const LEFT_OUT_VALUES = /^\s*… [\d,]+ more lines? of values …\s*$/;

export function applySourceEdits(source: string, edits: readonly SourceEdit[]): EditedSource {
  let text = source;
  const problems: string[] = [];
  const replaced: number[] = [];
  let changed = false;
  for (const [index, { oldText, newText, replaceAll }] of edits.entries()) {
    const which = `Edit ${index + 1}`;
    const found = occurrences(text, oldText);
    if (found.length === 0) {
      const after = changed ? `, as the edits before it left it` : "";
      problems.push(`${which}: oldText is not in the source${after}. ${notFound(text, oldText)}`);
      continue;
    }
    if (found.length > 1 && !replaceAll) {
      const lines = linesOf(text, found);
      const listed = lines.slice(0, MAX_LISTED);
      problems.push(
        `${which}: oldText occurs ${formatCount(found.length)} times, on ${lines.length === 1 ? "line" : "lines"} ${joinWords(listed.map(String), "and")}${lines.length > listed.length ? ` and ${formatCount(lines.length - listed.length)} more` : ""}. Include more of the text around the one to change, or set "replaceAll": true to change every one:\n${listed.map((line) => numberedLines(text, line, line)).join("\n")}`,
      );
      continue;
    }
    text =
      found.length === 1
        ? `${text.slice(0, found[0])}${newText}${text.slice((found[0] as number) + oldText.length)}`
        : text.replaceAll(oldText, () => newText);
    changed ||= oldText !== newText;
    replaced.push(found.length);
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, source: text, replaced };
}

/** Where the text occurs in the source, without overlaps, as replaceAll replaces it. */
function occurrences(source: string, text: string): number[] {
  const found: number[] = [];
  for (let at = source.indexOf(text); at >= 0; at = source.indexOf(text, at + text.length)) {
    found.push(at);
  }
  return found;
}

/**
 * The lines, counted from 1, that the offsets, in ascending order, are on, each once, in one pass
 * over the text: text that a large chart has thousands of, such as a quote, is on many.
 */
function linesOf(text: string, offsets: readonly number[]): number[] {
  const lines: number[] = [];
  let line = 1;
  let at = 0;
  for (const offset of offsets) {
    for (; at < offset; at++) {
      const char = text[at];
      // As lineAndColumn counts them: "\r\n", "\r" or "\n".
      if (char === "\n" || (char === "\r" && text[at + 1] !== "\n")) line++;
    }
    if (lines.at(-1) !== line) lines.push(line);
  }
  return lines;
}

/**
 * Lines `from` to `to` of the text, counted from 1, as "12: text", cutting long lines short, which
 * an edit's oldText can still quote the start of.
 */
export function numberedLines(text: string, from: number, to: number): string {
  const lines = text.split(/\r\n?|\n/);
  const first = Math.max(1, from);
  const last = Math.min(lines.length, to);
  const numbered: string[] = [];
  for (let line = first; line <= last; line++) {
    numbered.push(`${line}: ${shorten(lines[line - 1] ?? "", MAX_LINE_LENGTH)}`);
  }
  return numbered.join("\n");
}

/** What the source has instead of text that is not in it, for the model to copy. */
function notFound(source: string, text: string): string {
  const lines = text.split(/\r\n?|\n/);
  // A model may copy the numbers of the lines that a result quotes.
  if (lines.every((line) => /^\d+: /.test(line))) {
    const unnumbered = lines.map((line) => line.replace(/^\d+: /, "")).join("\n");
    if (source.includes(unnumbered)) {
      return 'Leave out the line numbers, such as "12: ", that the lines are quoted with.';
    }
  }
  // Or copy the line that stands for the values left out of the source as it was shown.
  const leftOut = lines.find((line) => LEFT_OUT_VALUES.test(line) && !source.includes(line));
  if (leftOut !== undefined) {
    return `Its line ${JSON.stringify(leftOut.trim())} stands for lines left out of the source as it was shown to you: make the edit without that line, with text before or after it.`;
  }
  // Or write the line breaks of a JSON string as "\n" once too often.
  if (text.includes("\\n") && source.includes(text.replaceAll("\\n", "\n"))) {
    return 'Its line breaks are written as "\\n" in the text, rather than as line breaks.';
  }
  const loose = looseMatch(source, text);
  if (loose) {
    const { line: from } = lineAndColumn(source, loose.start);
    const { line: to } = lineAndColumn(source, loose.end);
    return `It differs from ${from === to ? `line ${from}` : `lines ${from}-${to}`} only in whitespace, such as indentation or line breaks, which must match exactly:\n${numberedLines(source, from, to)}`;
  }
  const closest = closestLines(source, lines);
  return closest === undefined
    ? ""
    : `The closest lines are:\n${numberedLines(source, closest.from, closest.to)}`;
}

/** Where the text occurs in the source with other whitespace between its words, if it does. */
function looseMatch(source: string, text: string): { start: number; end: number } | undefined {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;
  const pattern = new RegExp(
    words.map((word) => word.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&")).join("\\s+"),
  );
  const match = pattern.exec(source);
  return match ? { start: match.index, end: match.index + match[0].length } : undefined;
}

/**
 * The lines of the source most like the lines of text, by how many pairs of adjacent characters
 * they share, with a line before and after them.
 */
function closestLines(
  source: string,
  lines: readonly string[],
): { from: number; to: number } | undefined {
  const sourceLines = source.split(/\r\n?|\n/).map(pairsOf);
  // The lines of the text that tell most, unless comparing them all takes too long.
  const compared = lines.map(pairsOf);
  const budget = Math.max(1, Math.floor(MAX_COMPARED / Math.max(1, source.length)));
  const kept = compared.slice(0, budget);
  let best: { line: number; score: number } | undefined;
  for (let start = 0; start < sourceLines.length; start++) {
    let score = 0;
    for (const [offset, pairs] of kept.entries()) {
      const line = sourceLines[start + offset];
      if (line) score += similarity(pairs, line);
    }
    if (!best || score > best.score) best = { line: start + 1, score };
  }
  if (!best || best.score === 0) return undefined;
  return { from: best.line - 1, to: best.line + Math.min(kept.length, 2 * CONTEXT_LINES) };
}

/** The pairs of adjacent characters in the line without its indentation, by how often each occurs. */
function pairsOf(line: string): Map<string, number> {
  const trimmed = line.trim();
  const pairs = new Map<string, number>();
  for (let i = 0; i + 1 < trimmed.length; i++) {
    const pair = trimmed.slice(i, i + 2);
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
  }
  return pairs;
}

/** The Sørensen–Dice coefficient of the pairs: 1 for the same ones, 0 for none in common. */
function similarity(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
  let size = 0;
  let common = 0;
  for (const [pair, count] of a) {
    size += count;
    common += Math.min(count, b.get(pair) ?? 0);
  }
  for (const count of b.values()) size += count;
  return size === 0 ? 0 : (2 * common) / size;
}

/**
 * The lines of the source around the place that a render error names, as "(line 3, column 5)" or
 * "on line 3" does, or else around the part that differs from the previous source, if given; for a
 * model to make the edit that fixes it.
 */
export function errorContext(source: string, error: string, previous?: string): string {
  const place = /\(line (\d+), column \d+\)/.exec(error) ?? /\bon line (\d+)\b/.exec(error);
  if (place) {
    return linesAround(source, Number(place[1]));
  }
  if (previous === undefined || previous === source) {
    return "";
  }
  const { from, to } = changedLines(previous, source);
  return quotedLines(
    source,
    from - 1,
    Math.min(to + 1, from + 4 * CONTEXT_LINES),
    "source, where it changed",
  );
}

/** E.g. "Lines 3-9 of the source:" and those lines, numbered, around the given one. */
export function linesAround(source: string, line: number, what = "source"): string {
  return quotedLines(source, line - CONTEXT_LINES, line + CONTEXT_LINES, what);
}

function quotedLines(source: string, from: number, to: number, what: string): string {
  const first = Math.max(1, from);
  const last = Math.min(lineAndColumn(source, source.length).line, to);
  if (first > last) return "";
  const lines = first === last ? `Line ${first}` : `Lines ${first}-${last}`;
  return `${lines} of the ${what}:\n${numberedLines(source, first, last)}`;
}

/** The lines of `after` that differ from `before`, from the first to the last. */
export function changedLines(before: string, after: string): { from: number; to: number } {
  const shortest = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < shortest && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  const from = lineAndColumn(after, prefix).line;
  // A change that only removes text is on the line where it was.
  const to = Math.max(from, lineAndColumn(after, Math.max(prefix, after.length - suffix)).line);
  return { from, to };
}

/** E.g. "2 edits" or "2 edits, 7 replacements in all", for edits that replaced several each. */
export function editCount(replaced: readonly number[]): string {
  const total = replaced.reduce((sum, count) => sum + count, 0);
  const edits = plural(replaced.length, "edit");
  return total > replaced.length ? `${edits}, ${plural(total, "replacement")} in all` : edits;
}
