import { FenceScanner, fenceMarker, trimBlankLines } from "./fences";
import { DIRECTIVE } from "./mermaidSyntax";
import { DIAGRAM_LANGUAGES, type DiagramLanguage, isPlainObject } from "./protocol";
import { literalValue } from "./webview/optionSource";

/** A diagram written in a fenced code block: ```mermaid, or ```echarts with an ECharts option. */
export interface DiagramBlock {
  language: DiagramLanguage;
  source: string;
}

/** Wraps text in a fenced code block that is safe to embed in markdown, whatever the text. */
export function codeFence(text: string, language = ""): string {
  // The fence must be longer than any run of backticks in the text.
  const longestRun = Array.from(text.matchAll(/`+/g)).reduce(
    (most, [run]) => Math.max(most, run.length),
    0,
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

/** Derives a short title for a diagram. */
export function guessTitle({ language, source }: DiagramBlock): string {
  return language === "echarts" ? guessChartTitle(source) : guessMermaidTitle(source);
}

/**
 * Reads the title of JSON or a JavaScript object literal without evaluating it: model-written
 * JavaScript must never execute in the extension host.
 */
function guessChartTitle(source: string): string {
  // Not of an option with code, or invalid source that is reported when rendering.
  const option = literalValue(source);
  const title: unknown = isPlainObject(option) ? option.title : undefined;
  const first: unknown = Array.isArray(title) ? title[0] : title;
  const text = isPlainObject(first) ? first.text : undefined;
  return typeof text === "string" && text.trim() ? text.trim() : "Chart";
}

/** Types with title statements; in other types, a "title" line may be a node. */
const TITLED_TYPE =
  /^(?:architecture|C4|cynefin|eventmodeling|gantt|gitGraph|info|journey|packet|pie|quadrantChart|radar|railroad-(?:abnf-|ebnf-|peg-)?beta|requirement|sequenceDiagram|timeline|treemap|treeView|venn|wardley|xychart)/;
/** A title statement, up to a comment, after a pie's "showData" and with a sequence's colon. */
const TITLE_STATEMENT = /^(?:showData\s+)?title(?:\s+|:\s*)(.*?)\s*(?:%%.*)?$/i;

/** Prefer frontmatter or a title statement, then fall back to the diagram type. */
function guessMermaidTitle(source: string): string {
  let type: string | undefined;
  let inFrontmatter = false;
  // Directives, which may span lines, are read past as Mermaid does.
  for (const line of source.replace(DIRECTIVE, "").split("\n")) {
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

/** Whether an unfinished line may still turn out to open a diagram block. */
function mayOpenDiagramBlock(partialLine: string): boolean {
  // Block quote and list markers, such as "> " or "1. ", may come before the fence.
  const rest = partialLine.replace(/^(?:[ \t]*(?:>|(?:[-+*]|\d{1,9}[.)])(?=[ \t])))*[ \t]*/, "");
  if (/^(?:[-+*]|\d{1,9}[.)]?)?$/.test(rest)) {
    return true;
  }
  // A fence, maybe still short, whose info string has not started.
  if (/^(?:`+|~+|:+)$/.test(rest)) {
    return true;
  }
  const language = fenceMarker(rest)?.language;
  return (
    language !== undefined && DIAGRAM_LANGUAGES.some((diagram) => diagram.startsWith(language))
  );
}

/** The length up to which an unfinished line that may open a diagram block is held back. */
const MAX_UNDECIDED_LINE = 1000;

/**
 * Removes ```mermaid and ```echarts code blocks from markdown that arrives in fragments, such as a
 * streamed language model reply, and collects them. Text is passed through as soon as it cannot be
 * the start of such a block. Fences inside other code blocks are left alone. Blocks are found as
 * in Markdown documents, also in block quotes and list items.
 */
export class DiagramBlockFilter {
  /** The complete, non-empty diagram blocks seen so far. */
  readonly diagrams: DiagramBlock[] = [];
  /** The current, unfinished line. */
  private line = "";
  /** How much of the current line has already been passed through. */
  private passed = 0;
  private readonly scanner = new FenceScanner();
  /** The diagram block the text is in, with its content lines so far. */
  private diagram: { language: DiagramLanguage; lines: string[] } | undefined;

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
    // A line that ends another code block, by leaving its block quote or list item, may open one.
    // Rescanning a long line on each fragment would be quadratic, and no fence is that far in.
    const undecided = this.passed === 0 && this.line.length <= MAX_UNDECIDED_LINE;
    const hidden = this.scanner.inCode
      ? this.diagram !== undefined || (undecided && !this.scanner.continuesCode(this.line))
      : undecided && mayOpenDiagramBlock(this.line);
    if (!hidden) {
      // Once a line is visible, only inspect new text; rescanning a long streamed line is quadratic.
      output += this.passed === 0 ? this.line : fragment.slice(start);
      this.passed = this.line.length;
    }
    return output;
  }

  /** Returns the remaining text that can be shown, once all fragments have been pushed. */
  flush(): string {
    const output = this.line ? this.completeLine(this.line) : "";
    this.line = "";
    this.passed = 0;
    return output;
  }

  /** Whether the text ended inside a diagram block, e.g. because the reply was cut off. */
  get unterminated(): boolean {
    return this.diagram !== undefined;
  }

  private completeLine(line: string): string {
    const shown = line.slice(this.passed);
    const scanned = this.scanner.next(line.endsWith("\n") ? line.slice(0, -1) : line);
    if (scanned.kind === "content") {
      this.diagram?.lines.push(scanned.text);
      return this.diagram ? "" : shown;
    }
    if (this.diagram) {
      // Closed by its fence or, as in Markdown, by the end of its block quote or list item.
      const { language, lines } = this.diagram;
      const source = trimBlankLines(lines);
      if (source) {
        this.diagrams.push({ language, source });
      }
      this.diagram = undefined;
      if (scanned.kind === "closing") {
        return "";
      }
    }
    if (scanned.kind === "opening" && scanned.fence.language) {
      // A line that may open a diagram block is held back by push, so none of it was shown.
      this.diagram = { language: scanned.fence.language, lines: [] };
      return "";
    }
    return shown;
  }
}
