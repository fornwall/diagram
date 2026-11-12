import { formatCount, joinWords, lineAndColumn, shorten } from "./text";

// oldText must occur once unless replaceAll.
export interface SourceEdit {
  oldText: string;
  newText: string;
  replaceAll: boolean;
}

type EditedSource =
  | { ok: true; source: string; replaced: number[] }
  | { ok: false; problems: string[] };

const CONTEXT_LINES = 3;
const MAX_LINE_LENGTH = 200;
const MAX_LISTED = 5;
// Source characters times oldText lines.
const MAX_COMPARED = 2_000_000;
// From describe.ts.
const LEFT_OUT_VALUES = /^\s*… [\d,]+ more lines? of values …\s*$/;

export function applySourceEdits(source: string, edits: readonly SourceEdit[]): EditedSource {
  let text = source;
  const problems: string[] = [];
  const replaced: number[] = [];
  let changed = false;
  for (const [index, { oldText, newText, replaceAll }] of edits.entries()) {
    const which = `Edit ${index + 1}`;
    if (!oldText) {
      problems.push(`${which}: oldText must not be empty.`);
      continue;
    }
    const first = text.indexOf(oldText);
    if (first < 0) {
      const after = changed ? `, as the edits before it left it` : "";
      problems.push(`${which}: oldText is not in the source${after}. ${notFound(text, oldText)}`);
      continue;
    }
    // Overlapping occurrences, as "5, 5" in "5, 5, 5", are as ambiguous as others.
    if (!replaceAll && text.indexOf(oldText, first + 1) >= 0) {
      const { count, lines, totalLines, overlapping } = matchingLines(text, oldText);
      const sourceLines = text.split(/\r\n?|\n/, lines.at(-1));
      // replaceAll replaces only occurrences that do not overlap.
      const advice = overlapping
        ? `, overlapping, so "replaceAll" would not change every one. Include more of the text around the one to change`
        : `. Include more of the text around the one to change, or set "replaceAll": true to change every one`;
      problems.push(
        `${which}: oldText occurs ${formatCount(count)} times, on ${totalLines === 1 ? "line" : "lines"} ${joinWords(lines.map(String), "and")}${totalLines > lines.length ? ` and ${formatCount(totalLines - lines.length)} more` : ""}${advice}:\n${lines.map((line) => numberedLines(sourceLines, line, line)).join("\n")}`,
      );
      continue;
    }
    let count = 1;
    if (replaceAll) {
      count = 0;
      text = text.replaceAll(oldText, () => {
        count++;
        return newText;
      });
    } else {
      text = `${text.slice(0, first)}${newText}${text.slice(first + oldText.length)}`;
    }
    changed ||= oldText !== newText;
    replaced.push(count);
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, source: text, replaced };
}

// Counts overlapping matches too, and keeps the first few distinct lines.
function matchingLines(text: string, needle: string) {
  const lines: number[] = [];
  let count = 0;
  let totalLines = 0;
  let line = 1;
  let lastLine = 0;
  let at = 0;
  let overlapping = false;
  let previous = -Infinity;
  for (let offset = text.indexOf(needle); offset >= 0; offset = text.indexOf(needle, offset + 1)) {
    count++;
    overlapping ||= offset < previous + needle.length;
    previous = offset;
    for (; at < offset; at++) {
      const char = text[at];
      // As lineAndColumn counts them: "\r\n", "\r" or "\n".
      if (char === "\n" || (char === "\r" && text[at + 1] !== "\n")) line++;
    }
    if (lastLine !== line) {
      totalLines++;
      if (lines.length < MAX_LISTED) lines.push(line);
      lastLine = line;
    }
  }
  return { count, lines, totalLines, overlapping };
}

// One-based, inclusive.
function numberedLines(lines: readonly string[], from: number, to: number): string {
  const first = Math.max(1, from);
  const last = Math.min(lines.length, to);
  const numbered: string[] = [];
  for (let line = first; line <= last; line++) {
    numbered.push(`${line}: ${shorten(lines[line - 1] ?? "", MAX_LINE_LENGTH)}`);
  }
  return numbered.join("\n");
}

function notFound(source: string, text: string): string {
  const lines = text.split(/\r\n?|\n/);
  // A model may copy the numbers of the lines that a result quotes.
  if (lines.every((line) => /^\d+: /.test(line))) {
    const unnumbered = lines.map((line) => line.replace(/^\d+: /, "")).join("\n");
    if (source.includes(unnumbered)) {
      return 'Leave out the line numbers, such as "12: ", that the lines are quoted with.';
    }
  }
  // Or copy the placeholder for left-out values.
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
    return `It differs from ${from === to ? `line ${from}` : `lines ${from}-${to}`} only in whitespace, such as indentation or line breaks, which must match exactly:\n${numberedLines(source.split(/\r\n?|\n/), from, to)}`;
  }
  const closest = closestLines(source, lines);
  return closest === undefined
    ? ""
    : `The closest lines are:\n${numberedLines(source.split(/\r\n?|\n/), closest.from, closest.to)}`;
}

// Ignoring whitespace differences.
function looseMatch(source: string, text: string): { start: number; end: number } | undefined {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) return undefined;
  let start = source.replace(/\s+/g, " ").indexOf(normalized);
  if (start < 0) return undefined;
  let end = start + normalized.length;
  // A regex of the words would backtrack for seconds on a large chart's data.
  for (const gap of source.matchAll(/\s+/g)) {
    if (gap.index >= end) break;
    const extra = gap[0].length - 1;
    if (gap.index < start) start += extra;
    end += extra;
  }
  return { start, end };
}

function closestLines(
  source: string,
  lines: readonly string[],
): { from: number; to: number } | undefined {
  const sourceLines = source.split(/\r\n?|\n/);
  const budget = Math.max(1, Math.floor(MAX_COMPARED / Math.max(1, source.length)));
  const kept = lines.slice(0, budget).map(pairsOf);
  // Only scores, not a pair map for every row of a large chart.
  const scores = new Float64Array(sourceLines.length);
  for (const [index, line] of sourceLines.entries()) {
    const pairs = pairsOf(line);
    for (let offset = 0; offset < kept.length && offset <= index; offset++) {
      const start = index - offset;
      scores[start] = (scores[start] as number) + similarity(kept[offset] as Pairs, pairs);
    }
  }
  let best: { line: number; score: number } | undefined;
  for (const [start, score] of scores.entries()) {
    if (!best || score > best.score) best = { line: start + 1, score };
  }
  if (!best || best.score === 0) return undefined;
  return { from: best.line - 1, to: best.line + Math.min(kept.length, 2 * CONTEXT_LINES) };
}

interface Pairs {
  counts: ReadonlyMap<string, number>;
  total: number;
}

function pairsOf(line: string): Pairs {
  const trimmed = line.trim();
  const pairs = new Map<string, number>();
  for (let i = 0; i + 1 < trimmed.length; i++) {
    const pair = trimmed.slice(i, i + 2);
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
  }
  return { counts: pairs, total: Math.max(0, trimmed.length - 1) };
}

// Sørensen–Dice.
function similarity(a: Pairs, b: Pairs): number {
  // Iterate the smaller one.
  if (a.counts.size > b.counts.size) [a, b] = [b, a];
  const size = a.total + b.total;
  let common = 0;
  for (const [pair, count] of a.counts) {
    common += Math.min(count, b.counts.get(pair) ?? 0);
  }
  return size === 0 ? 0 : (2 * common) / size;
}

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

// As "Lines 3-9 of the source:" and the lines.
function linesAround(source: string, line: number, what = "source"): string {
  return quotedLines(source, line - CONTEXT_LINES, line + CONTEXT_LINES, what);
}

function quotedLines(source: string, from: number, to: number, what: string): string {
  const first = Math.max(1, from);
  const last = Math.min(lineAndColumn(source, source.length).line, to);
  if (first > last) return "";
  const lines = first === last ? `Line ${first}` : `Lines ${first}-${last}`;
  return `${lines} of the ${what}:\n${numberedLines(source.split(/\r\n?|\n/), first, last)}`;
}

function changedLines(before: string, after: string): { from: number; to: number } {
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
