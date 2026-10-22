import { DIRECTIVE } from "./mermaidSyntax";
import { type DiagramLanguage, isPlainObject } from "./protocol";
import { literalValue } from "./webview/optionSource";

/** A diagram written in a fenced code block: ```mermaid, or ```echarts with an ECharts option. */
export interface DiagramBlock {
  language: DiagramLanguage;
  source: string;
}

/** Wraps text in a fenced code block that is safe to embed in markdown, whatever the text. */
export function codeFence(text: string, language = ""): string {
  // The fence must be longer than any run of backticks in the text.
  let longestRun = 0;
  for (const [run] of text.matchAll(/`+/g)) longestRun = Math.max(longestRun, run.length);
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
