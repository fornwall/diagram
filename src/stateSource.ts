// Bounded, exact source reads for diagram_getState, without repeating the panel's metadata.

import { codeFence } from "./blocks";
import type { DiagramLanguage } from "./protocol";
import { formatCount, toolInput } from "./text";

export interface StateInput {
  detail?: "full" | "summary" | "source" | "search";
  startLine?: number;
  endLine?: number;
  query?: string;
  startMatch?: number;
  maxMatches?: number;
  contextLines?: number;
}

const DEFAULT_LINES = 200;
const MAX_LINES = 500;

export function parseStateInput(value: unknown): StateInput {
  const input = toolInput(value ?? {}, [
    "detail",
    "startLine",
    "endLine",
    "query",
    "startMatch",
    "maxMatches",
    "contextLines",
  ]);
  if (
    input.detail !== undefined &&
    (typeof input.detail !== "string" ||
      !["full", "summary", "source", "search"].includes(input.detail))
  ) {
    throw new Error('"detail" must be "full", "summary", "source" or "search".');
  }
  const search =
    input.detail === "search" ||
    ["query", "startMatch", "maxMatches", "contextLines"].some((key) => input[key] !== undefined);
  if (search) {
    if (input.detail !== undefined && input.detail !== "search") {
      throw new Error('Use search parameters with "detail": "search", or omit "detail".');
    }
    if (input.startLine !== undefined || input.endLine !== undefined) {
      throw new Error('Search cannot be combined with "startLine" or "endLine".');
    }
    if (
      typeof input.query !== "string" ||
      input.query.length === 0 ||
      input.query.length > 1000 ||
      /[\r\n]/.test(input.query)
    ) {
      throw new Error('Give "query" as 1–1,000 characters of literal text on one line.');
    }
    for (const [key, min, max] of [
      ["startMatch", 1, Number.MAX_SAFE_INTEGER],
      ["maxMatches", 1, 50],
      ["contextLines", 0, 10],
    ] as const) {
      const value = input[key];
      if (
        value !== undefined &&
        (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
      ) {
        throw new Error(`"${key}" must be an integer from ${min} to ${max}.`);
      }
    }
    return { ...(input as StateInput), detail: "search" };
  }
  for (const key of ["startLine", "endLine"] as const) {
    if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || Number(input[key]) < 1)) {
      throw new Error(`"${key}" must be a positive integer, starting at 1.`);
    }
  }
  const range = input.startLine !== undefined || input.endLine !== undefined;
  if (range && input.detail !== undefined && input.detail !== "source") {
    throw new Error('Use line ranges with "detail": "source", or omit "detail".');
  }
  const parsed = input as StateInput;
  if (parsed.endLine !== undefined && parsed.endLine < (parsed.startLine ?? 1)) {
    throw new Error('"endLine" must be at least "startLine".');
  }
  return range ? { ...parsed, detail: "source" } : parsed;
}

/**
 * Reads whole source lines, retaining their actual line endings and indentation for exact edits.
 * Shrinks the range to fit the caller's budget, and tells it exactly where to continue.
 */
export async function sourcePage(
  source: string,
  language: DiagramLanguage,
  revision: number,
  input: StateInput,
  fits: (text: string) => Promise<boolean>,
): Promise<string> {
  const starts = [0];
  for (const match of source.matchAll(/\r\n?|\n/g)) starts.push(match.index + match[0].length);
  const total = starts.length;
  const start = input.startLine ?? 1;
  const heading = `Revision: ${revision}. ${language} source: ${formatCount(total)} lines, ${formatCount(source.length)} characters.`;
  if (start > total) {
    return `${heading}\n\nLine ${start} is past the end. Give "startLine" between 1 and ${total}.`;
  }
  const end = Math.min(total, input.endLine ?? start + DEFAULT_LINES - 1, start + MAX_LINES - 1);
  const response = (last: number) => {
    const excerpt = source.slice(starts[start - 1], starts[last] ?? source.length);
    const next =
      last < total
        ? `\n\nTo continue, call diagram_getState with {"startLine": ${last + 1}}. Read each page's revision; if it changes, reread the relevant lines before editing.`
        : "\n\nEnd of source.";
    return `${heading}\n\nSource lines ${start}-${last} (exact text, without line numbers; copy from the block for diagram_edit):\n${codeFence(excerpt, language)}${next}`;
  };
  const complete = response(end);
  if (await fits(complete)) return complete;
  // Binary search keeps tokenizer calls bounded for a 500-line request. Never return half a line
  // as if it were complete source that an agent can copy into an exact replacement.
  let low = start;
  let high = end - 1;
  let fitting: string | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const text = response(middle);
    if (await fits(text)) {
      fitting = text;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return (
    fitting ??
    `${heading}\n\nSource line ${start} does not fit the available result budget; no source was returned. Use a larger tool result budget or a new chat. A smaller line range cannot make this line fit.`
  );
}
