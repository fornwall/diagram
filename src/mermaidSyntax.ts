// Mermaid syntax that both the extension and the webview read past: front matter and directives.

/**
 * A directive, such as `%%{init: {"theme": "dark"}}%%`, which may span lines, as Mermaid's
 * directiveRegex finds it.
 */
export const DIRECTIVE =
  /%{2}{\s*(?:(\w+)\s*:|(\w+))\s*(?:(\w+)|((?:(?!}%{2}).|\r?\n)*))?\s*(?:}%{2})?/gi;

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
