// Literal source search with complete, copyable excerpts and stable continuation positions.

import { codeFence } from "./blocks";
import type { DiagramLanguage } from "./protocol";
import type { StateInput } from "./stateSource";
import { formatCount } from "./text";

/**
 * Search one snapshot. A match is a line containing the query, even when it occurs several times
 * there. Keep only the requested page while counting matches, so dense chart data stays bounded.
 */
export async function searchSource(
  source: string,
  language: DiagramLanguage,
  revision: number,
  input: StateInput,
  fits: (text: string) => Promise<boolean>,
): Promise<string> {
  const query = input.query ?? "";
  const start = input.startMatch ?? 1;
  const limit = input.maxMatches ?? 20;
  const context = input.contextLines ?? 2;
  const starts = [0];
  for (const match of source.matchAll(/\r\n?|\n/g)) starts.push(match.index + match[0].length);
  const matches: number[] = [];
  let total = 0;
  for (let line = 0; line < starts.length; line++) {
    if (!source.slice(starts[line], starts[line + 1] ?? source.length).includes(query)) continue;
    total++;
    if (total >= start && matches.length < limit) matches.push(line + 1);
  }
  const heading =
    `Revision: ${revision}. ${language} source search: ${formatCount(total)} matching lines ` +
    `for ${JSON.stringify(query)} (literal, case-sensitive).`;
  const diagnostic = async (message: string, compact: string) => {
    const full = `${heading}\n\n${message}`;
    if (await fits(full)) return full;
    const short = `Revision: ${revision}. ${compact}`;
    return (await fits(short)) ? short : "Source search needs a larger tool result budget.";
  };
  if (total === 0) {
    return diagnostic("No matches. Try a shorter query or check its case.", "No matches.");
  }
  if (start > total) {
    return diagnostic(
      `Match ${start} is past the end. Give "startMatch" between 1 and ${total}.`,
      `Match ${start} is past the end (${total} matches).`,
    );
  }
  const response = (count: number) => {
    // Merge overlapping context before copying any source. Nearby matches must not duplicate a
    // megabyte-long chart-data line in every excerpt, even for a candidate that will not fit.
    const blocks: { from: number; to: number; first: number; lines: number[] }[] = [];
    for (const [index, line] of matches.slice(0, count).entries()) {
      const from = Math.max(1, line - context);
      const to = Math.min(starts.length, line + context);
      const last = blocks.at(-1);
      if (last && from <= last.to + 1) {
        last.to = to;
        last.lines.push(line);
      } else {
        blocks.push({ from, to, first: start + index, lines: [line] });
      }
    }
    const excerpts = blocks.map(({ from, to, first, lines }) => {
      const matched =
        lines.length === 1
          ? `Match ${first} at line ${lines[0]}`
          : `Matches ${first}-${first + lines.length - 1} at lines ${lines.join(", ")}`;
      const excerpt = source.slice(starts[from - 1], starts[to] ?? source.length);
      return `${matched}; source lines ${from}-${to} (exact text, without line numbers):\n${codeFence(excerpt, language)}`;
    });
    const next = start + count;
    const continuation =
      next <= total
        ? `To continue, call diagram_getState with ${JSON.stringify({
            detail: "search",
            query,
            startMatch: next,
            maxMatches: limit,
            contextLines: context,
          })}.`
        : "End of matches.";
    return `${heading}\n\n${excerpts.join("\n\n")}\n\n${continuation} If the revision changes, restart the search before editing. Copy exact text from a block for diagram_edit.`;
  };
  const complete = response(matches.length);
  if (await fits(complete)) return complete;
  let low = 1;
  let high = matches.length - 1;
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
    (await diagnostic(
      `Match ${start} at line ${matches[0]} does not fit the available result budget; no source was returned. ${context > 0 ? 'Retry with "contextLines": 0, or ' : "Use "}a larger tool result budget. Read a specific range with detail:"source" and startLine/endLine.`,
      `Match ${start} at line ${matches[0]} needs a larger result budget.`,
    ))
  );
}
