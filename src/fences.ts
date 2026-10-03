// Locate Markdown diagrams for opening and write-back, using the same fence rules as chat.

import type { TextDocument } from "vscode";
import { type DiagramBlock, isClosingFence, openingFence } from "./blocks";
import { isDiagramLanguage, isPlainObject } from "./protocol";

/** A Markdown diagram with zero-based line positions for write-back. */
export interface DiagramFence extends DiagramBlock {
  /** The line the opening fence marker is on; the content starts on the line after it. */
  openingLine: number;
  /** The last line of the content, which runs to the end of the text in a block that is never closed. */
  lastLine: number;
  /** The whitespace the opening fence is indented by, e.g. inside a list item. */
  indent: string;
}

/** A block being scanned, before its content and its end are known. */
interface OpenFence {
  /** The opening marker, which the closing fence must match. */
  fence: string;
  language: string;
  indent: string;
  openingLine: number;
  /** Offset immediately after the opening line's newline. */
  contentStart: number;
}

const documentFences = new WeakMap<
  Pick<TextDocument, "version" | "getText">,
  { version: number; fences: readonly DiagramFence[] }
>();

/** Share a scan between CodeLens, opening and write-back; edits invalidate it immediately. */
export function findDocumentDiagramFences(
  document: Pick<TextDocument, "version" | "getText">,
): readonly DiagramFence[] {
  const cached = documentFences.get(document);
  if (cached?.version === document.version) return cached.fences;
  const fences = findDiagramFences(document.getText());
  // Weak keys let closed documents and their potentially large diagram sources be collected.
  documentFences.set(document, { version: document.version, fences });
  return fences;
}

/** Find nonempty diagram blocks in document order, skipping fences inside other code blocks. */
export function findDiagramFences(text: string): DiagramFence[] {
  const fences: DiagramFence[] = [];
  const add = (open: OpenFence, end: number, lastLine: number): void => {
    const { language, indent, openingLine } = open;
    if (!isDiagramLanguage(language)) {
      return;
    }
    const source = fenceSource(text.slice(open.contentStart, end).split(/\r?\n/), indent);
    if (source) {
      fences.push({ language, source, openingLine, lastLine, indent });
    }
  };

  // Most Markdown lines cannot be fences. Scan those without allocating a string per line;
  // only split the contents of diagram blocks that will actually be returned to the caller.
  // Match LF explicitly: multiline ^ also treats CR and Unicode separators as new lines.
  const candidates = /(?:^|\n)([^\S\n]*(?:`{3,}|~{3,})[^\n]*)/g;
  let line = 0;
  let nextNewline = text.indexOf("\n");
  const lineAt = (offset: number): number => {
    while (nextNewline !== -1 && nextNewline < offset) {
      line++;
      nextNewline = text.indexOf("\n", nextNewline + 1);
    }
    return line;
  };
  let open: OpenFence | undefined;
  for (const candidate of text.matchAll(candidates)) {
    const candidateLine = candidate[1] ?? "";
    const offset = candidate.index + candidate[0].length - candidateLine.length;
    const index = lineAt(offset);
    if (!open) {
      const opening = openingFence(candidateLine);
      if (opening) {
        open = {
          ...opening,
          openingLine: index,
          contentStart: Math.min(text.length, offset + candidateLine.length + 1),
        };
      }
    } else if (isClosingFence(candidateLine, open.fence)) {
      add(open, offset, index - 1);
      open = undefined;
    }
  }
  // Like CommonMark, a block that is never closed holds the rest of the document.
  if (open) {
    // A trailing newline ends the last content line rather than adding another one.
    add(open, text.length, lineAt(text.length) - (text.endsWith("\n") ? 1 : 0));
  }
  return fences;
}

/** Remove fence indentation and surrounding blank lines, preserving indentation within the source. */
export function fenceSource(lines: readonly string[], indent: string): string {
  const content = lines.map((line) => stripIndent(line, indent.length));
  let first = 0;
  let last = content.length - 1;
  while (first <= last && !content[first]?.trim()) {
    first++;
  }
  while (last >= first && !content[last]?.trim()) {
    last--;
  }
  return content.slice(first, last + 1).join("\n");
}

/** Strip up to `width` spaces or tabs, counting tabs as one character for consistent write-back. */
function stripIndent(line: string, width: number): string {
  let start = 0;
  while (start < width && (line[start] === " " || line[start] === "\t")) {
    start++;
  }
  return line.slice(start);
}

/** Open the enclosing fence, the next below the cursor, or the last in the document. */
export function fenceAt(fences: readonly DiagramFence[], line: number): DiagramFence | undefined {
  const inside = fences.find((fence) => line >= fence.openingLine && line <= fence.lastLine + 1);
  return inside ?? fences.find((fence) => fence.openingLine > line) ?? fences.at(-1);
}

/**
 * Finds an unchanged block at its original line, or a unique matching block that moved.
 * An edited block or ambiguous copies must be reopened before writing to avoid replacing another
 * diagram that happens to have the same source.
 */
export function relocateFence(
  fences: readonly DiagramFence[],
  read: DiagramFence,
): DiagramFence | undefined {
  const matches = (fence: DiagramFence) =>
    fence.language === read.language && fence.source === read.source;
  const original = fences.find((fence) => fence.openingLine === read.openingLine);
  if (original) {
    return matches(original) ? original : undefined;
  }
  let found: DiagramFence | undefined;
  for (const fence of fences) {
    if (matches(fence)) {
      if (found) {
        return undefined;
      }
      found = fence;
    }
  }
  return found;
}

/** Validate command arguments, which can also come from other extensions. */
export function isDiagramFence(value: unknown): value is DiagramFence {
  return (
    isPlainObject(value) &&
    isDiagramLanguage(value.language) &&
    typeof value.source === "string" &&
    typeof value.indent === "string" &&
    isLine(value.openingLine) &&
    isLine(value.lastLine) &&
    value.lastLine > value.openingLine
  );
}

function isLine(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
