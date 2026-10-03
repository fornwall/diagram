// Messages and types shared by the extension host and webview.

import type { ChartOptionsState } from "./chartOptions";
import type { ThemeColors } from "./webview/colors";

export const RENDER_TOOL = "diagram_render";
export const CHART_TOOL = "diagram_chart";
export const GET_STATE_TOOL = "diagram_getState";
export const PICK_NODES_TOOL = "diagram_pickNodes";
export const ANNOTATE_TOOL = "diagram_annotate";
export const FIND_FILES_TOOL = "diagram_findFiles";
export const SEARCH_TEXT_TOOL = "diagram_searchText";
export const READ_FILE_TOOL = "diagram_readFile";
export const INSPECT_DATA_TOOL = "diagram_inspectData";
export const UPDATE_CHART_TOOL = "diagram_updateChart";

/** Mermaid source or an ECharts option written as JSON or JavaScript. */
export const DIAGRAM_LANGUAGES = ["mermaid", "echarts"] as const;

export type DiagramLanguage = (typeof DIAGRAM_LANGUAGES)[number];

export function isDiagramLanguage(value: unknown): value is DiagramLanguage {
  return DIAGRAM_LANGUAGES.includes(value as DiagramLanguage);
}

export function diagramNoun(language: DiagramLanguage): "diagram" | "chart" {
  return language === "echarts" ? "chart" : "diagram";
}

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
  /** Mermaid node id, or chart item name ("Series/Name" for multiple series). */
  id: string;
  /** The visible label of the node, or the name of the chart data item. */
  label: string;
  /** Only flowchart edges and sequence messages have relationship metadata. */
  relationship?: {
    kind: "edge" | "message";
    source: string;
    target: string;
    direction: "forward" | "both" | "undirected";
  };
}

/** Mark colors: focus, red, green and blue, respectively. */
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

/** Replaces the previous marks without redrawing. Cleared when the diagram is replaced. */
export interface Annotation {
  marks: DiagramMark[];
  /** One line shown above the drawing, e.g. "Step 2 of 3: the request is retried here". */
  caption?: string;
  /** Whether what is not marked is faded, so that the marked nodes stand out. */
  dim: boolean;
}

/** Embedded by savedChart.ts and read from {@link SAVED_CHART} by webview/standalone.ts. */
export interface SavedChart {
  /** The title of the chart, shown above it as the page has no panel header. */
  title: string;
  /** The ECharts option, as JSON or JavaScript, as the panel rendered it. */
  source: string;
  /** The VS Code theme colors the chart was drawn in when it was saved. */
  colors: ThemeColors;
}

export const SAVED_CHART = "__diagramSavedChart";

/** Filename without an extension; use the fallback if sanitizing leaves it empty. */
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

export type ExportFormat = "png" | "svg" | "html";

export type ExportResult = Extract<
  FromWebview,
  { type: "exportImage" | "exportTheme" | "exportError" }
>;

export type ToWebview =
  | { type: "export"; requestId: number; renderRequestId: number; format: ExportFormat }
  | { type: "chartOptions"; state?: ChartOptionsState; visible: boolean }
  | { type: "chartOptionsError"; message: string }
  | {
      type: "render";
      requestId: number;
      language: DiagramLanguage;
      source: string;
      title: string;
      /** When set, a plain click on a node asks this in chat instead of selecting the node. */
      clickPrompt?: string;
      /** Tooltip text by node id. The host holds the actual locations and opens them. */
      links?: Record<string, string>;
      /** Where the chart's data can be reloaded from, e.g. "file sales.csv" or "command `du -s *`". */
      refreshFrom?: string;
      /** Bound document's display name, shown on the write-back action. */
      writeTo?: string;
    }
  /** The saved chart omitted its large source; ask the user to refresh its data. */
  | { type: "needsRefresh"; title: string; refreshFrom?: string }
  | { type: "clearSelection" }
  /** Replace marks without redrawing; empty marks and no caption clears them. */
  | ({ type: "annotate" } & Annotation)
  /** Asks the user to click nodes until the pick is answered or ended. */
  | { type: "startPick"; pickId: number; prompt: string; multiple: boolean }
  | { type: "endPick"; pickId: number };

export type FromWebview =
  | { type: "closeChartOptions" }
  | { type: "resetChartStyling"; revision: number; replaceSource: boolean }
  | {
      type: "applyChartOptions";
      revision: number;
      controls: Record<string, unknown>;
      replaceSource: boolean;
    }
  | { type: "ready" }
  /** diagramType is a Mermaid type ("flowchart-v2") or ECharts series types ("bar, line"). */
  | {
      type: "rendered";
      requestId: number;
      diagramType: string;
      /** Omitted when the renderer cannot enumerate nodes, such as chart data items. */
      nodeIds?: string[];
      /** Selectable flowchart edges or sequence messages, with authoritative endpoints. */
      relationships?: DiagramNode[];
    }
  | { type: "renderError"; requestId: number; message: string }
  | { type: "selectionChanged"; nodes: DiagramNode[] }
  | { type: "sourceEdited"; source: string }
  | { type: "ask"; text: string; nodes: DiagramNode[] }
  | { type: "clickToAsk"; node: DiagramNode }
  /** The host resolves this node's link; the webview cannot choose a path. */
  | { type: "clickToOpen"; node: DiagramNode }
  | { type: "picked"; pickId: number; nodes: DiagramNode[] }
  | { type: "pickCancelled"; pickId: number }
  /** The user asked to reload the chart's data from its file or command. */
  | { type: "refresh" }
  | { type: "exportImage"; requestId: number; format: "png" | "svg"; data: string }
  | { type: "exportTheme"; requestId: number; colors: ThemeColors }
  | { type: "exportError"; requestId: number; message: string }
  /** Write the shown diagram to its bound code block without requiring a source edit. */
  | { type: "writeToDocument" };

type Check = (value: unknown) => boolean;
const isString: Check = (value) => typeof value === "string";
const isBoolean: Check = (value) => typeof value === "boolean";
const isNumber: Check = (value) => typeof value === "number" && Number.isFinite(value);
const isId: Check = (value) => Number.isSafeInteger(value);
const isNode: Check = (value) =>
  isPlainObject(value) &&
  isString(value.id) &&
  isString(value.label) &&
  (value.relationship === undefined ||
    (isPlainObject(value.relationship) &&
      (value.relationship.kind === "edge" || value.relationship.kind === "message") &&
      isString(value.relationship.source) &&
      isString(value.relationship.target) &&
      ["forward", "both", "undirected"].includes(value.relationship.direction as string)));
const isNodes: Check = (value) => Array.isArray(value) && value.every(isNode);
const isStrings: Check = (value) => Array.isArray(value) && value.every(isString);
const optional =
  (check: Check): Check =>
  (value) =>
    value === undefined || check(value);
const isRgba: Check = (value) =>
  isPlainObject(value) && [value.r, value.g, value.b, value.a].every(isNumber);

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

const FROM_WEBVIEW_FIELDS: {
  [M in FromWebview as M["type"]]: { [K in Exclude<keyof M, "type">]-?: Check };
} = {
  ready: {},
  closeChartOptions: {},
  resetChartStyling: { revision: isId, replaceSource: isBoolean },
  applyChartOptions: { revision: isId, controls: isPlainObject, replaceSource: isBoolean },
  rendered: {
    requestId: isId,
    diagramType: isString,
    nodeIds: optional(isStrings),
    relationships: optional(isNodes),
  },
  renderError: { requestId: isId, message: isString },
  selectionChanged: { nodes: isNodes },
  sourceEdited: { source: isString },
  ask: { text: isString, nodes: isNodes },
  clickToAsk: { node: isNode },
  clickToOpen: { node: isNode },
  picked: { pickId: isId, nodes: isNodes },
  pickCancelled: { pickId: isId },
  refresh: {},
  exportImage: {
    requestId: isId,
    format: (value) => value === "png" || value === "svg",
    data: isString,
  },
  exportTheme: { requestId: isId, colors: isThemeColors },
  exportError: { requestId: isId, message: isString },
  writeToDocument: {},
};

/** Validate untrusted messages before the host handles them. */
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
