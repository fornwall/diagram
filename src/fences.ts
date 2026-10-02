// The diagrams written as fenced code blocks in a Markdown document, and where their source sits in
// it, so that the panel can open one and write the user's edits back into the same block. This is
// free of VS Code so that it can be unit-tested, and it applies the fence rules of src/blocks.ts,
// which reads the same blocks out of the markdown a model streams.

import { type DiagramBlock, isClosingFence, openingFence } from "./blocks";
import { isDiagramLanguage, isPlainObject } from "./protocol";

/**
 * A ```mermaid or ```echarts block in a document. Lines are counted from 0, as VS Code counts them,
 * and name the content alone: writing a diagram back replaces those lines and leaves the fence
 * markers, their length and their indentation as they are.
 */
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
}

/**
 * Finds the diagrams written as fenced code blocks in a document, in the order they appear. A block
 * in another language is skipped along with the diagram fences inside it, which are code and not
 * diagrams of their own, and so is an empty block, which holds no diagram to open.
 */
export function findDiagramFences(text: string): DiagramFence[] {
  const lines = text.split(/\r?\n/);
  // A trailing newline ends the last line rather than starting a line of content of its own.
  const lineCount = text.endsWith("\n") ? lines.length - 1 : lines.length;
  const fences: DiagramFence[] = [];
  const add = (open: OpenFence, lastLine: number): void => {
    const { language, indent, openingLine } = open;
    if (!isDiagramLanguage(language)) {
      return;
    }
    const source = fenceSource(lines.slice(openingLine + 1, lastLine + 1), indent);
    if (source) {
      fences.push({ language, source, openingLine, lastLine, indent });
    }
  };

  let open: OpenFence | undefined;
  for (const [index, line] of lines.entries()) {
    if (!open) {
      const opening = openingFence(line);
      if (opening) {
        open = { ...opening, openingLine: index };
      }
    } else if (isClosingFence(line, open.fence)) {
      add(open, index - 1);
      open = undefined;
    }
  }
  // Like CommonMark, a block that is never closed holds the rest of the document.
  if (open) {
    add(open, lineCount - 1);
  }
  return fences;
}

/**
 * The diagram in a fence's content lines: the opening fence's indentation removed from each of them,
 * as CommonMark removes it, and no blank lines around it, as a diagram source needs none. What the
 * lines are indented by beyond the fence is kept, so that writing a source back unchanged leaves
 * the document exactly as it was.
 */
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

/**
 * Removes up to the given number of leading spaces or tabs from a content line, and no more, so
 * that deeper indentation is kept. A tab counts as one character rather than as the columns it
 * spans, which keeps reading a fence and writing it back consistent.
 */
function stripIndent(line: string, width: number): string {
  let start = 0;
  while (start < width && (line[start] === " " || line[start] === "\t")) {
    start++;
  }
  return line.slice(start);
}

/**
 * The fence to open for a cursor on the given line: the one it is in, else the next one below it,
 * else the last one above it, so that the command finds a diagram wherever the cursor is in a
 * document that holds one.
 */
export function fenceAt(fences: readonly DiagramFence[], line: number): DiagramFence | undefined {
  const inside = fences.find((fence) => line >= fence.openingLine && line <= fence.lastLine + 1);
  return inside ?? fences.find((fence) => fence.openingLine > line) ?? fences.at(-1);
}

/**
 * Finds a fence again in a document that may have changed since it was read: the nearest block in
 * the same language that still holds the very same source. Returns nothing when it is gone or holds
 * something else, in which case a diagram must not be written over it.
 */
export function relocateFence(
  fences: readonly DiagramFence[],
  read: DiagramFence,
): DiagramFence | undefined {
  const moved = (fence: DiagramFence) => Math.abs(fence.openingLine - read.openingLine);
  let found: DiagramFence | undefined;
  for (const fence of fences) {
    if (fence.language === read.language && fence.source === read.source) {
      found = found && moved(found) <= moved(fence) ? found : fence;
    }
  }
  return found;
}

/**
 * Whether a value is a fence as {@link findDiagramFences} found it. The CodeLens hands its fence to
 * a command, so it comes back through VS Code, and another extension may call that command with
 * anything at all.
 */
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
