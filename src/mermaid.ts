const MERMAID_FENCE = /```mermaid[^\S\n]*\n([\s\S]*?)\n?```/g;

/** Returns the contents of all ```mermaid code blocks in the given markdown, in order. */
export function extractMermaidBlocks(markdown: string): string[] {
  return Array.from(markdown.matchAll(MERMAID_FENCE), (match) => (match[1] ?? "").trim()).filter(
    (block) => block.length > 0,
  );
}

/** Wraps Mermaid source in a fenced code block that is safe to embed in markdown. */
export function mermaidFence(source: string): string {
  return `\`\`\`mermaid\n${source.trim()}\n\`\`\``;
}

/** Derives a short title from the first diagram line, e.g. "flowchart" or "sequenceDiagram". */
export function guessTitle(source: string): string {
  let inFrontmatter = false;
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "---") {
      inFrontmatter = !inFrontmatter;
      continue;
    }
    if (inFrontmatter) {
      const title = /^title:\s*(.+)$/.exec(trimmed)?.[1];
      if (title) {
        return title.replace(/^["']|["']$/g, "");
      }
      continue;
    }
    if (trimmed === "" || trimmed.startsWith("%%")) {
      continue;
    }
    return trimmed.split(/\s+/)[0] ?? "Diagram";
  }
  return "Diagram";
}

const MERMAID_OPENING_FENCE = "```mermaid";

/**
 * Removes ```mermaid code blocks from markdown that arrives in fragments, such as a streamed
 * language model reply. Text is passed through as soon as it cannot be the start of such a block.
 */
export class MermaidBlockFilter {
  /** The current, unfinished line. */
  private line = "";
  /** How much of the current line has already been passed through. */
  private passed = 0;
  private insideBlock = false;

  /** Adds a fragment, returning the text that can be shown. */
  push(fragment: string): string {
    this.line += fragment;
    let output = "";
    for (let newline = this.line.indexOf("\n"); newline !== -1; newline = this.line.indexOf("\n")) {
      output += this.completeLine(this.line.slice(0, newline + 1));
      this.line = this.line.slice(newline + 1);
      this.passed = 0;
    }
    if (!this.insideBlock && !this.mayOpenBlock(this.line)) {
      output += this.line.slice(this.passed);
      this.passed = this.line.length;
    }
    return output;
  }

  /** Returns the remaining text that can be shown, once all fragments have been pushed. */
  flush(): string {
    const output = this.insideBlock ? "" : this.line.slice(this.passed);
    this.line = "";
    this.passed = 0;
    return output;
  }

  private completeLine(line: string): string {
    const trimmed = line.trim();
    if (this.insideBlock) {
      this.insideBlock = !/^```\s*$/.test(trimmed);
      return "";
    }
    if (this.passed === 0 && /^```mermaid\s*$/.test(trimmed)) {
      this.insideBlock = true;
      return "";
    }
    return line.slice(this.passed);
  }

  /** Whether an unfinished line may still turn out to open a mermaid block. */
  private mayOpenBlock(partialLine: string): boolean {
    if (this.passed > 0) {
      return false;
    }
    const start = partialLine.trimStart();
    return MERMAID_OPENING_FENCE.startsWith(start) || start.startsWith(MERMAID_OPENING_FENCE);
  }
}
