// Unified diffs, which models read well, of what the user changed in a diagram.

const CONTEXT = 1;
// Pairs of changed lines; more are slow to compare, and a rewrite rather than an edit.
const MAX_COMPARED = 1_000_000;

type Line = { kind: " " | "-" | "+"; text: string };

// Hunks without file headers; undefined if too many lines to compare.
export function lineDiff(before: string, after: string): string | undefined {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  ) {
    end++;
  }
  const removed = a.slice(start, a.length - end);
  const added = b.slice(start, b.length - end);
  if (removed.length * added.length > MAX_COMPARED) return undefined;
  const offset = Math.max(0, start - CONTEXT);
  const lines: Line[] = [
    ...a.slice(offset, start).map((text): Line => ({ kind: " ", text })),
    ...changes(removed, added),
    ...a.slice(a.length - end, a.length - end + CONTEXT).map((text): Line => ({ kind: " ", text })),
  ];
  return hunks(lines, offset).join("\n");
}

function changes(a: readonly string[], b: readonly string[]): Line[] {
  const width = b.length + 1;
  // LCS length of a[i..] and b[j..] at i * width + j.
  const common = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i * width + j] =
        a[i] === b[j]
          ? (common[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(common[(i + 1) * width + j] ?? 0, common[i * width + j + 1] ?? 0);
    }
  }
  const lines: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ kind: " ", text: a[i++] ?? "" });
      j++;
    } else if (
      j >= b.length ||
      (i < a.length && (common[(i + 1) * width + j] ?? 0) >= (common[i * width + j + 1] ?? 0))
    ) {
      // Removed lines first, as a diff shows a replacement.
      lines.push({ kind: "-", text: a[i++] ?? "" });
    } else {
      lines.push({ kind: "+", text: b[j++] ?? "" });
    }
  }
  return lines;
}

function hunks(lines: readonly Line[], offset: number): string[] {
  const changed: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.kind !== " ") changed.push(index);
  }
  const result: string[] = [];
  // Counted on from the previous hunk, to stay linear.
  let counted = 0;
  let oldBefore = offset;
  let newBefore = offset;
  let next = 0;
  while (next < changed.length) {
    const first = changed[next] ?? 0;
    let last = first;
    // Changes whose context would meet or overlap go in one hunk.
    while (next < changed.length && (changed[next] ?? 0) <= last + 2 * CONTEXT + 1) {
      last = changed[next++] ?? last;
    }
    const from = Math.max(0, first - CONTEXT);
    const to = Math.min(lines.length, last + CONTEXT + 1);
    for (; counted < from; counted++) {
      const kind = lines[counted]?.kind;
      if (kind !== "+") oldBefore++;
      if (kind !== "-") newBefore++;
    }
    const shown = lines.slice(from, to);
    let oldCount = 0;
    let newCount = 0;
    for (const { kind } of shown) {
      if (kind !== "+") oldCount++;
      if (kind !== "-") newCount++;
    }
    // As in unified diffs, an empty range starts at the line before it.
    const oldStart = oldBefore + (oldCount > 0 ? 1 : 0);
    const newStart = newBefore + (newCount > 0 ? 1 : 0);
    result.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const { kind, text } of shown) result.push(`${kind}${text}`);
  }
  return result;
}
