import type { DiagramLanguage } from "./protocol";

/** A diagram written in a fenced code block: ```mermaid, or ```echarts with an ECharts option. */
export interface DiagramBlock {
  language: DiagramLanguage;
  source: string;
}

/**
 * A ```mermaid or ```echarts block. Like {@link DiagramBlockFilter}, it only takes fences on lines of
 * their own, so that a ``` inside a label does not end the block.
 */
const DIAGRAM_BLOCK =
  /(?<![^\n])[^\S\n]*```(mermaid|echarts)[^\S\n]*\n((?:[^\n]*\n)*?)[^\S\n]*```[^\S\n]*(?![^\n])/g;

/** Returns the last non-empty ```mermaid or ```echarts block in the given markdown. */
export function lastDiagramBlock(markdown: string): DiagramBlock | undefined {
  return Array.from(markdown.matchAll(DIAGRAM_BLOCK), (match) => ({
    language: match[1] as DiagramLanguage,
    source: (match[2] ?? "").trim(),
  }))
    .filter((block) => block.source.length > 0)
    .at(-1);
}

/** Wraps text in a fenced code block that is safe to embed in markdown, whatever the text. */
export function codeFence(text: string, language = ""): string {
  // The fence must be longer than any run of backticks in the text.
  const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), (run) => run[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${text.trim()}\n${fence}`;
}

/** Derives a short title for a diagram. */
export function guessTitle({ language, source }: DiagramBlock): string {
  return language === "echarts" ? guessChartTitle(source) : guessMermaidTitle(source);
}

/** Uses the title of an ECharts option, if any. */
function guessChartTitle(source: string): string {
  try {
    const { title } = JSON.parse(source) ?? {};
    const text: unknown = (Array.isArray(title) ? title[0] : title)?.text;
    if (typeof text === "string" && text.trim()) {
      return text.trim();
    }
  } catch {
    // Invalid JSON is reported when rendering.
  }
  return "Chart";
}

/** Derives a short title from the first diagram line, e.g. "flowchart" or "sequenceDiagram". */
function guessMermaidTitle(source: string): string {
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

const OPENING_FENCES = ["```mermaid", "```echarts"];

/**
 * Removes ```mermaid and ```echarts code blocks from markdown that arrives in fragments, such as a
 * streamed language model reply. Text is passed through as soon as it cannot be the start of such
 * a block.
 */
export class DiagramBlockFilter {
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
    const output = this.completeLine(this.line);
    this.line = "";
    this.passed = 0;
    return output;
  }

  /** Whether the text ended inside a diagram block, e.g. because the reply was cut off. */
  get unterminated(): boolean {
    return this.insideBlock;
  }

  private completeLine(line: string): string {
    const trimmed = line.trim();
    if (this.insideBlock) {
      this.insideBlock = !/^```\s*$/.test(trimmed);
      return "";
    }
    if (this.passed === 0 && /^```(?:mermaid|echarts)\s*$/.test(trimmed)) {
      this.insideBlock = true;
      return "";
    }
    return line.slice(this.passed);
  }

  /** Whether an unfinished line may still turn out to open a diagram block. */
  private mayOpenBlock(partialLine: string): boolean {
    if (this.passed > 0) {
      return false;
    }
    const start = partialLine.trimStart();
    return OPENING_FENCES.some((fence) => fence.startsWith(start) || start.startsWith(fence));
  }
}
