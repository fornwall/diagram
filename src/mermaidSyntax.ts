// Mermaid syntax that both the extension and the webview read past: front matter and directives.

/**
 * A directive, such as `%%{init: {"theme": "dark"}}%%`, which may span lines, as Mermaid's
 * directiveRegex finds it.
 */
export const DIRECTIVE =
  /%{2}{\s*(?:(\w+)\s*:|(\w+))\s*(?:(\w+)|((?:(?!}%{2}).|\r?\n)*))?\s*(?:}%{2})?/gi;

/**
 * Blank lines and comments directly after these diagram types confuse their indentation parsers.
 * The panel and exported HTML render the same normalization of the original source.
 */
export const BLANK_LINES_AFTER_TYPE =
  /^((?:[^\S\n]*(?:%%[^\n]*)?\n)*?[^\S\n]*(?:mindmap|kanban|ishikawa(?:-beta)?)\b[^\n]*\n)(?:[^\S\n]*(?:%%(?!\{)[^\n]*)?\n)+/gi;

/** Removes from text after the front matter what Mermaid would parse but fail on. */
export function withoutBlankLinesAfterType(text: string): string {
  return text.replace(BLANK_LINES_AFTER_TYPE, "$1");
}

/** The source as Mermaid can parse it, while retaining the original source for editing. */
export function parsableSource(source: string): string {
  const normalized = source.replace(/\r\n?/g, "\n");
  const start = frontMatterEnd(normalized);
  return normalized.slice(0, start) + withoutBlankLinesAfterType(normalized.slice(start));
}

/** Where the front matter ends, as Mermaid's matchFrontMatter finds it, or 0 without front matter. */
export function frontMatterEnd(text: string): number {
  const indent = /^[^\S\n]*/.exec(text)?.[0] ?? "";
  // The line breaks in the run of whitespace from the offset.
  const breaks = (from: number) => {
    const found: number[] = [];
    for (let i = from; i < text.length && /\s/.test(text[i] as string); i++) {
      if (text[i] === "\n") found.push(i);
    }
    return found;
  };
  const openings = breaks(indent.length + 3);
  if (!text.startsWith("---", indent.length) || openings.length === 0) {
    return 0;
  }
  const fence = `\n${indent}---`;
  /** The end of the closing fence that starts at the offset, with the blank lines after it. */
  const closingEnd = (i: number) =>
    text.startsWith(fence, i) ? (breaks(i + fence.length).at(-1) ?? -1) : -1;
  let lastClosing = -1;
  for (
    let i = text.indexOf(fence, (openings[0] as number) + 1);
    i >= 0;
    i = text.indexOf(fence, i + 1)
  ) {
    if (closingEnd(i) >= 0) lastClosing = i;
  }
  if (lastClosing < 0) {
    return 0;
  }
  const body = (openings.findLast((opening) => opening < lastClosing) as number) + 1;
  for (
    let i = text.indexOf(fence, body);
    i >= 0 && i <= lastClosing;
    i = text.indexOf(fence, i + 1)
  ) {
    const end = closingEnd(i);
    if (end >= 0) return end + 1;
  }
  return 0;
}
