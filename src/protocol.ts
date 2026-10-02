// Shared by the extension host and the diagram webview, mainly the messages exchanged between them.

import type { ThemeColors } from "./webview/colors";

export const RENDER_TOOL = "diagram_render";
export const CHART_TOOL = "diagram_chart";
export const GET_STATE_TOOL = "diagram_getState";
export const PICK_NODES_TOOL = "diagram_pickNodes";
export const ANNOTATE_TOOL = "diagram_annotate";

/**
 * How a diagram's source is written: Mermaid syntax, or an Apache ECharts option object, which
 * may be written as JSON or as a JavaScript object literal.
 */
export const DIAGRAM_LANGUAGES = ["mermaid", "echarts"] as const;

export type DiagramLanguage = (typeof DIAGRAM_LANGUAGES)[number];

export function isDiagramLanguage(value: unknown): value is DiagramLanguage {
  return DIAGRAM_LANGUAGES.includes(value as DiagramLanguage);
}

/** What to call a diagram in the given language when talking to the user or the model. */
export function diagramNoun(language: DiagramLanguage): "diagram" | "chart" {
  return language === "echarts" ? "chart" : "diagram";
}

/** What to call the parts of such a diagram: the things that are selected, picked and marked. */
export function nodeNoun(language: DiagramLanguage): "node" | "chart item" {
  return language === "echarts" ? "chart item" : "node";
}

/** Whether the value is an object other than an array or null, such as a parsed JSON object. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface DiagramNode {
  /**
   * The node id as written in the Mermaid source, when it can be determined. For charts, the data
   * item's name, prefixed by its series name when the chart has several series ("Series/Name").
   */
  id: string;
  /** The visible label of the node, or the name of the chart data item. */
  label: string;
}

/**
 * How a mark reads, which decides the theme color it is drawn in: the step being walked through
 * (the focus color), something wrong (red), something that works (green), or a plain pointer (blue).
 */
export const MARK_KINDS = ["current", "problem", "good", "info"] as const;

export type MarkKind = (typeof MARK_KINDS)[number];

export function isMarkKind(value: unknown): value is MarkKind {
  return MARK_KINDS.includes(value as MarkKind);
}

/** A node or chart item an agent marked, named by the id the panel knows it under. */
export interface DiagramMark {
  id: string;
  kind: MarkKind;
  /** A short note about this node, shown with the mark above the diagram. */
  note?: string;
}

/**
 * An agent's markup of the diagram shown, which leaves the drawing itself as it is: the nodes that
 * stand out and how, a line above the drawing, and whether what is not marked recedes. Each
 * annotation replaces the one before it, and a new diagram clears it.
 */
export interface Annotation {
  marks: DiagramMark[];
  /** One line shown above the drawing, e.g. "Step 2 of 3: the request is retried here". */
  caption?: string;
  /** Whether what is not marked is faded, so that the marked nodes stand out. */
  dim: boolean;
}

/**
 * A chart saved as a self-contained HTML file, as the page's script finds it in the global named
 * by {@link SAVED_CHART}. Built by src/savedChart.ts and read by src/webview/standalone.ts.
 */
export interface SavedChart {
  /** The title of the chart, shown above it as the page has no panel header. */
  title: string;
  /** The ECharts option, as JSON or JavaScript, as the panel rendered it. */
  source: string;
  /** The VS Code theme colors the chart was drawn in when it was saved. */
  colors: ThemeColors;
}

/** The global that a saved chart's page holds its {@link SavedChart} in. */
export const SAVED_CHART = "__diagramSavedChart";

/**
 * The name to offer a file of the diagram titled `title` under, without an extension and without
 * the characters that file systems and shells dislike, e.g. "Commits per author". Falls back to
 * `fallback` for a title that is empty or made of nothing else.
 */
export function safeFileName(title: string, fallback: string): string {
  let name = title
    // Control and format characters, and what Windows does not allow in a name.
    .replace(/[\p{C}\\/:*?"<>|]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Windows reserves device names even with an extension, such as CON.svg.
  if (/^(?:con|prn|aux|nul|(?:com|lpt)[1-9¹²³])(?:\s*\.|$)/i.test(name)) {
    name = `_${name}`;
  }
  // Truncation can split a surrogate pair or expose trailing dots and spaces.
  return name.slice(0, 80).replace(/[\s.\uD800-\uDBFF]+$/u, "") || fallback;
}

export type ToWebview =
  | {
      type: "render";
      requestId: number;
      language: DiagramLanguage;
      source: string;
      title: string;
      /** When set, a plain click on a node asks this in chat instead of selecting the node. */
      clickPrompt?: string;
      /**
       * The location each linked node opens, e.g. "src/panel.ts#L120", by node id. Only the
       * location's text, for the node's tooltip: opening it is up to the extension host.
       */
      links?: Record<string, string>;
      /** Where the chart's data can be reloaded from, e.g. "file sales.csv" or "command `du -s *`". */
      refreshFrom?: string;
      /**
       * The name of the document this diagram was opened from, when it came from a code block in
       * one, so that the panel can offer to write it back there.
       */
      writeTo?: string;
    }
  /**
   * Sent instead of render to a webview that just loaded, for a chart that was too large to keep
   * when VS Code closed: shows its title and asks the user to press Refresh.
   */
  | { type: "needsRefresh"; title: string; refreshFrom?: string }
  | { type: "clearSelection" }
  /**
   * Marks nodes of the diagram already shown, without rendering it again, replacing the marks from
   * before; an annotation without marks or caption clears them.
   */
  | ({ type: "annotate" } & Annotation)
  /** Asks the user to click nodes until the pick is answered or ended. */
  | { type: "startPick"; pickId: number; prompt: string; multiple: boolean }
  | { type: "endPick"; pickId: number };

export type FromWebview =
  | { type: "ready" }
  /**
   * For Mermaid, diagramType is Mermaid's diagram type, e.g. "flowchart-v2". For ECharts, it is
   * the series types of the chart, e.g. "pie" or "bar, line".
   */
  | {
      type: "rendered";
      requestId: number;
      diagramType: string;
      /**
       * The ids of the nodes drawn, so that the extension host can tell a model when it names one
       * the diagram does not have. Left out by a rendering whose parts the panel does not name,
       * such as a chart, whose items are its data; see drawnNodes in src/webview/renderer.ts.
       */
      nodeIds?: string[];
    }
  | { type: "renderError"; requestId: number; message: string }
  | { type: "selectionChanged"; nodes: DiagramNode[] }
  | { type: "sourceEdited"; source: string }
  | { type: "ask"; text: string; nodes: DiagramNode[] }
  | { type: "clickToAsk"; node: DiagramNode }
  /**
   * A plain click on a node that links to a place in the code. It names the node, not a path: the
   * extension host holds the links and decides what to open.
   */
  | { type: "clickToOpen"; node: DiagramNode }
  | { type: "picked"; pickId: number; nodes: DiagramNode[] }
  | { type: "pickCancelled"; pickId: number }
  /** The user asked to reload the chart's data from its file or command. */
  | { type: "refresh" }
  /**
   * The user asked to save the chart as an HTML file. The colors it is drawn in come along, as
   * only the webview can read them from the VS Code theme.
   */
  | { type: "save"; colors: ThemeColors }
  /**
   * The user asked to write the diagram as shown into the code block it was opened from, without
   * editing it first, which is how an agent's version reaches the document.
   */
  | { type: "writeToDocument" };

type Check = (value: unknown) => boolean;
const isString: Check = (value) => typeof value === "string";
const isBoolean: Check = (value) => typeof value === "boolean";
const isNumber: Check = (value) => typeof value === "number" && Number.isFinite(value);
const isId: Check = (value) => Number.isSafeInteger(value);
const isNode: Check = (value) =>
  isPlainObject(value) && isString(value.id) && isString(value.label);
const isNodes: Check = (value) => Array.isArray(value) && value.every(isNode);
const isStrings: Check = (value) => Array.isArray(value) && value.every(isString);
/** For a field a message may leave out, such as the ids of a rendering that names no parts. */
const optional =
  (check: Check): Check =>
  (value) =>
    value === undefined || check(value);
const isRgba: Check = (value) =>
  isPlainObject(value) && [value.r, value.g, value.b, value.a].every(isNumber);

/** How to check each color of a theme, so that a saved chart never draws in missing colors. */
const THEME_COLOR_FIELDS: { [K in keyof ThemeColors]-?: Check } = {
  dark: isBoolean,
  background: isRgba,
  foreground: isRgba,
  muted: isRgba,
  gridLine: isRgba,
  axisLine: isRgba,
  focus: isRgba,
  hoverBackground: isRgba,
  hoverBorder: isRgba,
  hoverForeground: isRgba,
  palette: (value) => Array.isArray(value) && value.length > 0 && value.every(isRgba),
  blue: isRgba,
  green: isRgba,
  red: isRgba,
  fontFamily: isString,
  fontSize: isNumber,
};
const isThemeColors: Check = (value) =>
  isPlainObject(value) &&
  Object.entries(THEME_COLOR_FIELDS).every(([key, check]) => check(value[key]));

/** How to check each field of each message from the webview. */
const FROM_WEBVIEW_FIELDS: {
  [M in FromWebview as M["type"]]: { [K in Exclude<keyof M, "type">]-?: Check };
} = {
  ready: {},
  rendered: { requestId: isId, diagramType: isString, nodeIds: optional(isStrings) },
  renderError: { requestId: isId, message: isString },
  selectionChanged: { nodes: isNodes },
  sourceEdited: { source: isString },
  ask: { text: isString, nodes: isNodes },
  clickToAsk: { node: isNode },
  clickToOpen: { node: isNode },
  picked: { pickId: isId, nodes: isNodes },
  pickCancelled: { pickId: isId },
  refresh: {},
  save: { colors: isThemeColors },
  writeToDocument: {},
};

/** Whether a message from the webview, whose content is not to be trusted, is well-formed. */
export function isFromWebview(message: unknown): message is FromWebview {
  if (
    !isPlainObject(message) ||
    typeof message.type !== "string" ||
    !Object.hasOwn(FROM_WEBVIEW_FIELDS, message.type)
  ) {
    return false;
  }
  const fields: Record<string, Check> = FROM_WEBVIEW_FIELDS[message.type as FromWebview["type"]];
  return Object.entries(fields).every(([key, check]) => check(message[key]));
}
