// Colors the items of a Mermaid diagram by editing its source: one `style <id> ...` line per item,
// replaced in place or appended to the diagram. Pure, so that it can be tested without a panel.

import { parseColor, readableTextColor } from "./cssColors";
import { DIRECTIVE, frontMatterEnd } from "./mermaidSyntax";
import { AUTO_TEXT, type StyleRequest } from "./styleInput";

/** The diagram types whose items Mermaid styles with `style <id> fill:...,stroke:...,color:...`. */
export type StyleableKind = "flowchart" | "class" | "state" | "er";

const KINDS: Record<string, StyleableKind> = {
  flowchart: "flowchart",
  "flowchart-elk": "flowchart",
  graph: "flowchart",
  classdiagram: "class",
  "classdiagram-v2": "class",
  statediagram: "state",
  "statediagram-v2": "state",
  erdiagram: "er",
};

/** What the items of a kind of diagram are called. */
export const ITEM_NOUNS: Record<StyleableKind, string> = {
  flowchart: "nodes or subgraphs",
  class: "classes",
  state: "states",
  er: "entities",
};

/** A line that Mermaid parses as a statement, by its index among the source's lines. */
interface Statement {
  index: number;
  text: string;
}

/**
 * The source's lines, and those that Mermaid parses as statements, the declaration first: not
 * front matter, directives, which may span lines, comments, blank lines, nor the text of notes and
 * accessible descriptions that go on for several lines. A statement with a quoted label that goes
 * on for several lines, such as a Markdown string, takes them all.
 */
function statements(source: string): { lines: string[]; statements: Statement[] } {
  const normalized = source.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const start = frontMatterEnd(normalized);
  // Directives become blanks, keeping the lines of those that span several.
  const body = normalized.slice(start).replace(DIRECTIVE, (match) => match.replace(/[^\n]/g, " "));
  const offset = normalized.slice(0, start).split("\n").length - 1;
  const found: Statement[] = [];
  const quotes = (text: string) => text.split('"').length - 1;
  /** What ends the text being skipped, if any. */
  let until: RegExp | undefined;
  /** The statement whose quoted label goes on in the next line. */
  let open: Statement | undefined;
  for (const [i, text] of body.split("\n").entries()) {
    const line = text.trim();
    if (open) {
      open.text += `\n${text}`;
      if (quotes(open.text) % 2 === 0) open = undefined;
    } else if (until) {
      if (until.test(line)) until = undefined;
    } else if (/^accDescr\s*\{/i.test(line) && !line.includes("}")) {
      until = /\}/;
    } else if (/^note\s+(?:left|right)\s+of\b/i.test(line) && !line.includes(":")) {
      // A state diagram's note without a colon goes on to `end note`.
      until = /^end\s+note\b/i;
    } else if (line && !line.startsWith("%%")) {
      const statement = { index: offset + i, text };
      found.push(statement);
      // Not the free text of notes and titles, whose quotes need not pair.
      if (quotes(text) % 2 === 1 && !/^(?:note|accTitle|accDescr|title)\b/i.test(line)) {
        open = statement;
      }
    }
  }
  return { lines, statements: found };
}

/**
 * The diagram's declaration keyword, e.g. "flowchart" or "sequenceDiagram", and the kind of
 * diagram, if its items can be styled.
 */
export function diagramKind(source: string): {
  keyword: string;
  kind: StyleableKind | undefined;
} {
  const [declaration] = statements(source).statements;
  const keyword = /^[^\s;:{]+/.exec(declaration?.text.trim() ?? "")?.[0] ?? "";
  const name = keyword.toLowerCase();
  return { keyword, kind: Object.hasOwn(KINDS, name) ? KINDS[name] : undefined };
}

/** The ids that a style line can name, as Mermaid's parser of each kind of diagram takes them. */
export const STYLEABLE_IDS: Record<StyleableKind, string> = {
  flowchart: "letters, digits and underscores, joined by dots or hyphens",
  class: "ASCII letters, digits and underscores",
  state: "ASCII letters, digits and underscores",
  er: "letters, digits and underscores, joined by hyphens",
};

/** Whether a style line can name the id; others, such as titles with spaces, would break it. */
export function isStyleableId(id: string, kind: StyleableKind): boolean {
  switch (kind) {
    // Class and state diagrams take ASCII word characters for the item a style names.
    case "class":
    case "state":
      return /^\w+$/.test(id);
    // The ER lexer takes no dots in the entity a style names.
    case "er":
      return /^[\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*$/u.test(id);
    default:
      return /^[\p{L}\p{N}_]+(?:[.-][\p{L}\p{N}_]+)*$/u.test(id);
  }
}

/** Statements that name items other than by their ids, or that declare none. */
const NOT_DECLARING =
  /^(?:style|classDef|linkStyle|click|callback|link|cssClass|note|accTitle|accDescr|direction)\b/i;

/** A word that may be an id, as {@link isStyleableId} takes them at most. */
const WORD = /[\p{L}\p{N}_]+(?:[.-][\p{L}\p{N}_]+)*/gu;

/**
 * The words of the statements other than notes, comments and directives, outside labels: the ids
 * that the source names. The panel names items that have no id in the source, such as notes, by
 * their labels, and a style line for such a name would add an item rather than color one.
 */
export function sourceIds(source: string, kind: StyleableKind): Set<string> {
  const ids = new Set<string>();
  let inBlock = false;
  for (const [index, { text }] of statements(source).statements.entries()) {
    // The declaration, which may go on with statements, as in `graph TD;A-->B;`.
    const line =
      index === 0
        ? text.replace(/^\s*[^\s;]+(?:\s+(?:TB|TD|BT|RL|LR)\b)?\s*;?/i, "").trim()
        : text.trim();
    // Class members and entity attributes, which are not items.
    if (inBlock) {
      inBlock = !line.startsWith("}");
      continue;
    }
    // A class diagram's namespace holds classes, not members.
    if (NOT_DECLARING.test(line) || (kind === "class" && /^namespace\b/.test(line))) {
      continue;
    }
    let bare = line.replace(/"[^"]*"/g, " ");
    // A class diagram's lollipop interfaces, which the panel names by their labels.
    if (kind === "class") {
      bare = bare.replace(/--\s*\(\)\s*\S+/g, " ").replace(/\S+\s*\(\)\s*--/g, " ");
    }
    for (let before = ""; before !== bare; ) {
      before = bare;
      bare = bare.replace(/\[[^[\]]*\]|\([^()]*\)|\{[^{}]*\}|\|[^|]*\|/g, " ");
    }
    // A flowchart's class names follow ":::"; state descriptions, relationship labels and class
    // members follow a colon.
    bare = kind === "flowchart" ? bare.replace(/:::[\w-]+/g, " ") : bare.replace(/:.*$/, "");
    if ((kind === "class" || kind === "er") && bare.trimEnd().endsWith("{")) {
      inBlock = true;
    }
    for (const [word] of bare.matchAll(WORD)) ids.add(word);
  }
  return ids;
}

/** The ids of flowchart subgraphs that have one, e.g. "pay" for `subgraph pay [Payment]`. */
export function subgraphIds(source: string): string[] {
  const ids = new Set<string>();
  for (const { text } of statements(source).statements) {
    // `subgraph Plain Title` has a title and no id; Mermaid makes one up.
    const id = /^\s*subgraph\s+([^\s["(]+)\s*(?:$|[[("])/.exec(text)?.[1];
    if (id && isStyleableId(id, "flowchart")) ids.add(id);
  }
  return [...ids];
}

/** States that hold others, which Mermaid draws without their style. */
export function compositeStateIds(source: string): string[] {
  const ids = new Set<string>();
  for (const { text } of statements(source).statements) {
    const id = /^\s*state\s+(?:"[^"]*"\s+as\s+)?(\w+)\s*\{/.exec(text)?.[1];
    if (id) ids.add(id);
  }
  return [...ids];
}

/** The colors that an item has after styling, or what became of its style otherwise. */
export interface AppliedStyle {
  id: string;
  fill?: string | undefined;
  stroke?: string | undefined;
  text?: string | undefined;
  /**
   * "contrast" when the text color was chosen for the fill; "theme" when the fill is translucent,
   * so that no text color is written and the panel picks one for the theme it shows the fill on.
   */
  autoText?: "contrast" | "theme";
  /** The style line was removed. */
  removed?: true;
  /** There was no style to remove. */
  unstyled?: true;
  /** Why the item was left as it was. */
  problem?: string;
}

/**
 * A style line for a single item, its properties as written, and any final semicolon. A line with
 * more statements after a semicolon is not one: replacing it would lose them.
 */
const STYLE_LINE = /^(\s*)style\s+(\S+)\s+([^;\n]*?)\s*;?\s*$/;
/** The items that style statements name, also among other statements of a line. */
const STYLE_STATEMENT = /(?:^|;)\s*style\s+([^\s;]+)/g;
/** A style property, whose value may have commas in parentheses, as in `fill:rgb(1,2,3)`. */
const PROPERTY = /(?:[^,(]|\([^)]*\))+/g;

/**
 * Sets the fill, stroke and text colors of items, keeping their other style properties. Each item's
 * `style` line is replaced in place, merging into the first the later lines for the item alone;
 * items without one get a line appended after the last line of the diagram, at the indentation of
 * its top-level statements. Keeps the source's line breaks.
 */
export function applyStyles(
  source: string,
  requests: readonly StyleRequest[],
): { source: string; applied: AppliedStyle[] } {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const { lines, statements: body } = statements(source);

  const styleLines = new Map<string, { index: number; indent: string; properties: string }[]>();
  /** Items styled among other statements of a line, which is left as it is. */
  const inline = new Set<string>();
  for (const { index, text } of body) {
    const [, indent = "", id = "", properties = ""] = STYLE_LINE.exec(text) ?? [];
    if (id) {
      styleLines.set(id, [...(styleLines.get(id) ?? []), { index, indent, properties }]);
    } else {
      for (const [, styled = ""] of text.matchAll(STYLE_STATEMENT)) inline.add(styled);
    }
  }

  /** The new text of replaced lines, undefined for those removed. */
  const replaced = new Map<number, string | undefined>();
  const appended: string[] = [];
  const applied: AppliedStyle[] = [];
  // The first statement after the declaration is at the top level.
  const indent = body[1] ? (/^\s*/.exec(body[1].text)?.[0] ?? "") : "  ";
  for (const request of requests) {
    // A line appended after it overrides colors, but cannot remove any.
    const removes =
      request.clear || request.fill === null || request.stroke === null || request.text === null;
    if (removes && inline.has(request.id)) {
      applied.push({
        id: request.id,
        problem:
          "Its style is in a line with other statements, which is left as it is: give the style a line of its own first.",
      });
      continue;
    }
    const existing = styleLines.get(request.id) ?? [];
    const colors = new Map<string, string>();
    const others: string[] = [];
    for (const { properties } of request.clear ? [] : existing) {
      for (const [property] of properties.matchAll(PROPERTY)) {
        const [, key = "", value = ""] = /^\s*([^:]*?)\s*:\s*(.*?)\s*$/.exec(property) ?? [];
        const name = key.toLowerCase();
        if (name === "fill" || name === "stroke" || name === "color") {
          colors.set(name, value);
        } else if (property.trim()) {
          others.push(property.trim());
        }
      }
    }
    const set = (name: string, value: string | null | undefined) => {
      if (value === null) colors.delete(name);
      else if (value !== undefined) colors.set(name, value);
    };
    set("fill", request.fill);
    set("stroke", request.stroke);
    let autoText: AppliedStyle["autoText"];
    if (request.text === AUTO_TEXT) {
      const fill = colors.get("fill");
      const color = fill === undefined ? undefined : parseColor(fill);
      if (!color) {
        applied.push({
          id: request.id,
          problem:
            fill === undefined
              ? 'It has no fill to choose a text color for: give "fill" or a "text" color.'
              : `Its fill, ${JSON.stringify(fill)}, is no color to choose a text color for: give "fill" or a "text" color.`,
        });
        continue;
      }
      // A translucent fill shows the theme through it, which the panel picks a text color for.
      autoText = color.a < 1 ? "theme" : "contrast";
      set("color", autoText === "theme" ? null : readableTextColor(color));
    } else {
      set("color", request.text);
    }

    const written = [
      ...["fill", "stroke", "color"].flatMap((name) => {
        const value = colors.get(name);
        return value === undefined ? [] : [`${name}:${value}`];
      }),
      ...others,
    ];
    const line = written.length > 0 ? `style ${request.id} ${written.join(",")}` : undefined;
    const [first, ...rest] = existing;
    if (first) {
      replaced.set(first.index, line && first.indent + line);
      for (const later of rest) replaced.set(later.index, undefined);
    } else if (line) {
      appended.push(indent + line);
    }
    applied.push(
      line
        ? {
            id: request.id,
            fill: colors.get("fill"),
            stroke: colors.get("stroke"),
            text: colors.get("color"),
            ...(autoText && { autoText }),
          }
        : first
          ? { id: request.id, removed: true }
          : { id: request.id, unstyled: true },
    );
  }

  const result = lines.flatMap((line, index) => {
    if (!replaced.has(index)) return [line];
    const replacement = replaced.get(index);
    return replacement === undefined ? [] : [replacement];
  });
  if (appended.length > 0) {
    // After the last line of the diagram, before any trailing blank lines.
    let end = result.length;
    while (end > 0 && !(result[end - 1] as string).trim()) end--;
    result.splice(end, 0, ...appended);
  }
  return { source: result.join(eol), applied };
}
