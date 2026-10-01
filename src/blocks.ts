import { DIAGRAM_LANGUAGES, type DiagramLanguage, isDiagramLanguage } from "./protocol";

/** A diagram written in a fenced code block: ```mermaid, or ```echarts with an ECharts option. */
export interface DiagramBlock {
  language: DiagramLanguage;
  source: string;
}

/** Returns the last complete, non-empty ```mermaid or ```echarts block in the given markdown. */
export function lastDiagramBlock(markdown: string): DiagramBlock | undefined {
  const filter = new DiagramBlockFilter();
  filter.push(markdown);
  filter.flush();
  return filter.diagrams.at(-1);
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

/**
 * Diagram types whose grammar has a title statement, as in "pie title Pets" or a gantt's
 * "title Plan", by the start of their keyword. In other types, a "title" line may be a node.
 */
const TITLED_TYPE =
  /^(?:architecture|C4|cynefin|gantt|gitGraph|info|journey|packet|pie|quadrantChart|radar|railroad-(?:ebnf-|peg-)?beta|requirement|sequenceDiagram|timeline|treemap|treeView|venn|wardley|xychart)/;
/** A title statement, up to a comment, after a pie's "showData" and with a sequence's colon. */
const TITLE_STATEMENT = /^(?:showData\s+)?title(?:\s+|:\s*)(.*?)\s*(?:%%.*)?$/i;

/**
 * Derives a short title from the frontmatter or a title statement, or else the diagram type, e.g.
 * "flowchart" or "sequenceDiagram".
 */
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
        return title.replace(/^["']|["']$/g, "");
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

/**
 * Parses an opening code fence: three or more backticks or tildes, followed by an info string whose
 * first word is the language. Unlike CommonMark, any indentation is accepted, as fences in list
 * items may be indented further.
 */
function openingFence(line: string): { fence: string; language: string } | undefined {
  const match = /^\s*(`{3,}|~{3,})(.*)$/.exec(line.trimEnd());
  if (!match) {
    return undefined;
  }
  const [, fence = "", info = ""] = match;
  // The info string of a backtick fence may not contain backticks, e.g. ```mermaid``` inline.
  if (fence.startsWith("`") && info.includes("`")) {
    return undefined;
  }
  return { fence, language: info.trim().split(/\s/, 1)[0] ?? "" };
}

/** Whether the line closes a block opened by the given fence: the same character, at least as many. */
function isClosingFence(line: string, fence: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= fence.length && trimmed === fence.charAt(0).repeat(trimmed.length);
}

/** Whether an unfinished line may still turn out to open a diagram block. */
function mayOpenDiagramBlock(partialLine: string): boolean {
  const [, fence = "", rest = ""] = /^\s*(`+|~+)?(.*)$/s.exec(partialLine) ?? [];
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
  private block: { fence: string; diagram?: DiagramBlock } | undefined;

  /** Adds a fragment, returning the text that can be shown. */
  push(fragment: string): string {
    this.line += fragment;
    let output = "";
    for (let newline = this.line.indexOf("\n"); newline !== -1; newline = this.line.indexOf("\n")) {
      output += this.completeLine(this.line.slice(0, newline + 1));
      this.line = this.line.slice(newline + 1);
      this.passed = 0;
    }
    const hidden = this.block ? this.block.diagram !== undefined : mayOpenDiagramBlock(this.line);
    if (!hidden) {
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
    return this.block?.diagram !== undefined;
  }

  private completeLine(line: string): string {
    const shown = line.slice(this.passed);
    if (!this.block) {
      const opening = openingFence(line);
      if (opening) {
        // A line that may open a diagram block is held back by push, so none of it was shown.
        const { fence, language } = opening;
        this.block = isDiagramLanguage(language)
          ? { fence, diagram: { language, source: "" } }
          : { fence };
      }
      return this.block?.diagram ? "" : shown;
    }
    const { fence, diagram } = this.block;
    if (isClosingFence(line, fence)) {
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
