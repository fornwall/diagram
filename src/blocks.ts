import { DIAGRAM_LANGUAGES, type DiagramLanguage, isDiagramLanguage } from "./protocol";

/** A diagram written in a fenced code block: ```mermaid, or ```echarts with an ECharts option. */
export interface DiagramBlock {
  language: DiagramLanguage;
  source: string;
}

/** Wraps text in a fenced code block that is safe to embed in markdown, whatever the text. */
export function codeFence(text: string, language = ""): string {
  // The fence must be longer than any run of backticks in the text.
  let longestRun = 0;
  for (const [run] of text.matchAll(/`+/g)) {
    longestRun = Math.max(longestRun, run.length);
  }
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

/** Derives a short title for a diagram. */
export function guessTitle({ language, source }: DiagramBlock): string {
  return language === "echarts" ? guessChartTitle(source) : guessMermaidTitle(source);
}

/** Read JSON titles only: model-written JavaScript must never execute in the extension host. */
function guessChartTitle(source: string): string {
  try {
    const { title } = JSON.parse(source) ?? {};
    const text: unknown = (Array.isArray(title) ? title[0] : title)?.text;
    if (typeof text === "string" && text.trim()) {
      return text.trim();
    }
  } catch {
    // A JavaScript option, or invalid source that is reported when rendering.
  }
  return "Chart";
}

/** Types with title statements; in other types, a "title" line may be a node. */
const TITLED_TYPE =
  /^(?:architecture|C4|cynefin|gantt|gitGraph|info|journey|packet|pie|quadrantChart|radar|railroad-(?:ebnf-|peg-)?beta|requirement|sequenceDiagram|timeline|treemap|treeView|venn|wardley|xychart)/;
/** A title statement, up to a comment, after a pie's "showData" and with a sequence's colon. */
const TITLE_STATEMENT = /^(?:showData\s+)?title(?:\s+|:\s*)(.*?)\s*(?:%%.*)?$/i;

/** Prefer frontmatter or a title statement, then fall back to the diagram type. */
function guessMermaidTitle(source: string): string {
  let type: string | undefined;
  let inFrontmatter = false;
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (type === undefined && trimmed === "---") {
      inFrontmatter = !inFrontmatter;
      continue;
    }
    if (inFrontmatter) {
      const title = /^title:\s*(.+)$/.exec(trimmed)?.[1];
      if (title) {
        return title.replace(/^(["'])(.*)\1$/, "$2");
      }
      continue;
    }
    if (trimmed === "" || trimmed.startsWith("%%")) {
      continue;
    }
    let statement = trimmed;
    if (type === undefined) {
      type = trimmed.split(/\s+/)[0] ?? "Diagram";
      if (!TITLED_TYPE.test(type)) {
        return type;
      }
      // As in "pie title Pets".
      statement = trimmed.slice(type.length).trim();
    }
    // An xychart's title may be quoted.
    const title = TITLE_STATEMENT.exec(statement)?.[1]?.replace(/^"(.*)"$/, "$1");
    if (title) {
      return title;
    }
  }
  return type ?? "Diagram";
}

/** An opening code fence: its indentation, its marker and the first word of its info string. */
export interface OpeningFence {
  indent: string;
  fence: string;
  language: string;
}

/**
 * Parses an opening code fence. Unlike CommonMark, which allows up to 3 spaces, any indentation
 * is accepted, as a fence may sit in a list item.
 */
export function openingFence(line: string): OpeningFence | undefined {
  const match = /^([ \t]*)(`{3,}|~{3,})(.*)$/.exec(line.trimEnd());
  if (!match) {
    return undefined;
  }
  const [, indent = "", fence = "", info = ""] = match;
  // The info string of a backtick fence may not contain backticks, e.g. ```mermaid``` inline.
  if (fence.startsWith("`") && info.includes("`")) {
    return undefined;
  }
  return { indent, fence, language: info.trim().split(/\s/, 1)[0] ?? "" };
}

/**
 * Whether the line closes the block that the opening fence opened: the same character, at least as
 * many, followed only by spaces or tabs. As in CommonMark, it may be indented by at most 3 columns,
 * here counted from the opening fence, which may be in a list item.
 */
export function isClosingFence(line: string, { indent, fence }: OpeningFence): boolean {
  const maxIndent = indentWidth(indent) + 3;
  let column = 0;
  let index = 0;
  for (; line[index] === " " || line[index] === "\t"; index++) {
    column = line[index] === "\t" ? column + 4 - (column % 4) : column + 1;
    if (column > maxIndent) return false;
  }
  // Most lines are source, sometimes megabytes of chart data: stop at the first other character.
  const start = index;
  while (line[index] === fence[0]) index++;
  return index - start >= fence.length && /^[ \t]*\r?\n?$/.test(line.slice(index));
}

/** The columns that indentation spans, with tab stops every 4 columns as in CommonMark. */
function indentWidth(indent: string): number {
  let column = 0;
  for (const char of indent) column = char === "\t" ? column + 4 - (column % 4) : column + 1;
  return column;
}

/** Whether an unfinished line may still turn out to open a diagram block. */
function mayOpenDiagramBlock(partialLine: string): boolean {
  const [, fence = "", rest = ""] = /^[ \t]*(`+|~+)?(.*)$/s.exec(partialLine) ?? [];
  if (rest === "") {
    return true;
  }
  const language = fence.length >= 3 ? openingFence(partialLine)?.language : undefined;
  return (
    language !== undefined && DIAGRAM_LANGUAGES.some((diagram) => diagram.startsWith(language))
  );
}

/**
 * Removes ```mermaid and ```echarts code blocks from markdown that arrives in fragments, such as a
 * streamed language model reply, and collects them. Text is passed through as soon as it cannot be
 * the start of such a block. Fences inside other code blocks are left alone.
 */
export class DiagramBlockFilter {
  /** The complete, non-empty diagram blocks seen so far. */
  readonly diagrams: DiagramBlock[] = [];
  /** The current, unfinished line. */
  private line = "";
  /** How much of the current line has already been passed through. */
  private passed = 0;
  /** The code block the text is in, and the diagram it holds if it is a diagram block. */
  private block: { opening: OpeningFence; diagram?: DiagramBlock } | undefined;

  /** Adds a fragment, returning the text that can be shown. */
  push(fragment: string): string {
    let output = "";
    let start = 0;
    // Scan only new text: a chart option may be one long line arriving in tiny fragments.
    for (
      let newline = fragment.indexOf("\n");
      newline !== -1;
      newline = fragment.indexOf("\n", start)
    ) {
      output += this.completeLine(this.line + fragment.slice(start, newline + 1));
      this.line = "";
      this.passed = 0;
      start = newline + 1;
    }
    this.line += fragment.slice(start);
    const hidden = this.block
      ? this.block.diagram !== undefined
      : this.passed === 0 && mayOpenDiagramBlock(this.line);
    if (!hidden) {
      // Once a line is visible, only inspect new text; rescanning a long streamed line is quadratic.
      output += this.passed === 0 ? this.line : fragment.slice(start);
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
    return this.block?.diagram !== undefined;
  }

  private completeLine(line: string): string {
    const shown = line.slice(this.passed);
    if (!this.block) {
      const opening = openingFence(line);
      if (opening) {
        // A line that may open a diagram block is held back by push, so none of it was shown.
        const { language } = opening;
        this.block = isDiagramLanguage(language)
          ? { opening, diagram: { language, source: "" } }
          : { opening };
      }
      return this.block?.diagram ? "" : shown;
    }
    const { opening, diagram } = this.block;
    if (isClosingFence(line, opening)) {
      this.block = undefined;
      const source = diagram?.source.trim();
      if (diagram && source) {
        this.diagrams.push({ language: diagram.language, source });
      }
    } else if (diagram) {
      diagram.source += line;
    }
    return diagram ? "" : shown;
  }
}
