// Messages and types shared by the extension host and webview.

import type { ChartOptionsState } from "./chartOptions";
import type { ThemeColors } from "./webview/colors";

export const RENDER_TOOL = "diagram_render";
export const EDIT_TOOL = "diagram_edit";
export const CHART_TOOL = "diagram_chart";
export const GET_STATE_TOOL = "diagram_getState";
export const GET_IMAGE_TOOL = "diagram_getImage";
export const EXPORT_HTML_TOOL = "diagram_exportHtml";
export const GUIDE_TOOL = "diagram_guide";
export const PICK_NODES_TOOL = "diagram_pickNodes";
export const ANNOTATE_TOOL = "diagram_annotate";
export const FIND_FILES_TOOL = "diagram_findFiles";
export const SEARCH_TEXT_TOOL = "diagram_searchText";
export const READ_FILE_TOOL = "diagram_readFile";
export const INSPECT_DATA_TOOL = "diagram_inspectData";
export const UPDATE_CHART_TOOL = "diagram_updateChart";
export const STYLE_TOOL = "diagram_style";

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

/** The objects of an ECharts component, which an option may give as one object or an array. */
export function asArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(isPlainObject);
  }
  return isPlainObject(value) ? [value] : [];
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The error's message without a final period, to go on with more text. */
export function errorClause(error: unknown): string {
  return errorMessage(error).replace(/\.$/, "");
}

export interface DiagramNode {
  /**
   * Mermaid node id, or chart item id: the item's own id or else its name (its path in a tree, or
   * what places an unnamed item: its categories, as "Mon, 10" for a heatmap's cell, or its time),
   * prefixed with "Series/" when the chart has several series, and told apart by its index when
   * that repeats.
   */
  id: string;
  /** The visible label of the node, or the name of the chart data item. */
  label: string;
  /** Raw chart position, returned only for source-row inspection. */
  chart?: { seriesIndex: number; dataIndex: number; dataType?: string | undefined } | undefined;
  /** Only edges and sequence messages have relationship metadata. */
  relationship?: {
    kind: "edge" | "message";
    source: string;
    target: string;
    direction: "forward" | "both" | "undirected";
    /**
     * A flowchart edge's number in linkStyle lines, which count the links as Mermaid reads them,
     * when that tells it.
     */
    linkStyle?: number;
    /**
     * Its own label, "" for none, which the label of the whole joins to its ends' labels: as these
     * may hold colons too, the tools take this to tell it from others between the same ends.
     */
    text?: string | undefined;
  };
}

/** A name that several items of a chart series go by, which marks need the ids of instead. */
export interface RepeatedName {
  name: string;
  /** The ids of the first items, up to a limit. */
  ids: string[];
  /** How many items go by the name. */
  count: number;
}

export interface ItemQuery {
  includeData?: boolean | undefined;
  itemIds?: readonly string[] | undefined;
  query?: string | undefined;
  startItem: number;
  maxItems: number;
}

export interface ItemPage {
  totalItems: number;
  matchedItems: number;
  startItem: number;
  items: DiagramNode[];
  nextItem?: number;
}

/** Mark colors: focus, red, green and purple, respectively. */
export const MARK_KINDS = ["current", "problem", "good", "info"] as const;

type MarkKind = (typeof MARK_KINDS)[number];

export function isMarkKind(value: unknown): value is MarkKind {
  return MARK_KINDS.includes(value as MarkKind);
}

/** A node or chart item an agent marked, named by the id the panel knows it under. */
export interface DiagramMark {
  id: string;
  kind: MarkKind;
  /** Plain text beside the item, also listed in the explanation panel. */
  text?: string;
}

export interface AnnotationStep {
  text: string;
  marks: DiagramMark[];
  dim: boolean;
  focus?: boolean;
}

/** Replaces the previous marks without redrawing. Cleared when the diagram is replaced. */
export interface Annotation {
  marks: DiagramMark[];
  /** Whether what is not marked is faded, so that the marked nodes stand out. */
  dim: boolean;
  /** Scroll marked items into view without changing the user's selection. */
  focus?: boolean;
  steps?: AnnotationStep[];
  /** Current walkthrough step, counted from zero. */
  step?: number;
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

/** What an image for a model shows, in CSS pixels of the drawing at 100%. */
export interface ImageView {
  /** The size of the whole drawing, which a chart is laid out at. */
  width: number;
  height: number;
  /** The size of the part around the items asked for, which the image shows, unless all of it. */
  area?: { width: number; height: number } | undefined;
  /** How many pixels of the image show a pixel of the drawing. */
  scale: number;
  /** The font size of most of its text, if it has any. */
  textSize?: number | undefined;
  /** The room the panel shows the drawing in, and its zoom, unless the drawing is out of sight. */
  panel?: { width: number; height: number; zoom: number } | undefined;
  /** The ids asked for that name nothing drawn. */
  missing?: string[] | undefined;
}

export type ExportResult = Extract<
  FromWebview,
  { type: "exportImage" | "exportTheme" | "exportError" }
>;

export interface SourceRepair {
  source: string;
  description: string;
}

export type ToWebview =
  | {
      type: "validateDraft";
      requestId: number;
      source: string;
      language: DiagramLanguage;
      title: string;
      image: boolean;
    }
  | ({ type: "getItems"; requestId: number; renderRequestId: number } & ItemQuery)
  | {
      type: "export";
      requestId: number;
      renderRequestId: number;
      format: ExportFormat;
      /**
       * Whether a model asks, for a PNG of the drawing as the panel shows it, and what it shows.
       * It cannot export the drawing as SVG instead when a PNG fails.
       */
      forModel: boolean;
      /** The most pixels a PNG may have on either side, by default the most it can have. */
      maxSide?: number | undefined;
      /** The most pixels a PNG may have in all. */
      maxPixels?: number | undefined;
      /** The items whose part of the drawing a model asks to see, by id, rather than all of it. */
      ids?: string[] | undefined;
    }
  /** Whether the tab is hidden behind another, where the page has no size of its own. */
  | { type: "tabVisibility"; hidden: boolean }
  /** Shows the Chart Options form with the state, or without one hides it. */
  | { type: "chartOptions"; state?: ChartOptionsState }
  | { type: "chartOptionsError"; message: string }
  | {
      type: "render";
      requestId: number;
      language: DiagramLanguage;
      source: string;
      title: string;
      /** Try one diagnostic-based Mermaid label correction for diagram_render. */
      repairMermaid?: boolean | undefined;
      /** When set, a plain click on a node asks this in chat instead of selecting the node. */
      clickPrompt?: string | undefined;
      /** Tooltip text by node id. The host holds the actual locations and opens them. */
      links?: Record<string, string> | undefined;
      /** Where the chart's data can be reloaded from, e.g. "file sales.csv" or "command `du -s *`". */
      refreshFrom?: string | undefined;
      /** Bound document's display name, shown on the write-back action. */
      writeTo?: string | undefined;
      /** Tells diagrams apart, which revisions of one, by follow-ups or edits, share. */
      diagram: number;
      /** Why the page shows this error rather than draw the source, which may hang it. */
      notDrawn?: string | undefined;
      /** The ids of the items to select again once drawn, by a revision that keeps its items. */
      selection?: string[] | undefined;
    }
  /** The saved chart omitted its large source; ask the user to refresh its data. */
  | { type: "needsRefresh"; title: string; refreshFrom?: string | undefined }
  /** The bound document's display name, as the document was renamed. */
  | { type: "writeTo"; writeTo: string }
  | { type: "clearSelection" }
  | { type: "highlightPath" }
  /** Replace marks without redrawing; empty marks clear them. */
  | ({ type: "annotate"; annotationId?: number } & Annotation)
  /** Asks the user to click nodes until the pick is answered or ended. */
  | { type: "startPick"; pickId: number; prompt: string; multiple: boolean }
  | { type: "endPick"; pickId: number };

export type FromWebview =
  | {
      type: "draftResult";
      requestId: number;
      diagramType?: string;
      items?: DiagramNode[];
      warnings?: string[];
      image?: string;
      error?: string;
    }
  | { type: "annotationStep"; requestId: number; annotationId: number; step: number }
  | { type: "items"; requestId: number; page: ItemPage }
  | { type: "itemsError"; requestId: number; message: string }
  | { type: "closeChartOptions" }
  /** Rebuilds the chart with the controls, or without them resets its styling. */
  | {
      type: "applyChartOptions";
      revision: number;
      controls?: Record<string, unknown> | undefined;
      replaceSource: boolean;
    }
  | { type: "ready" }
  /** diagramType is a Mermaid type ("flowchart-v2") or ECharts series types ("bar, line"). */
  | {
      type: "rendered";
      requestId: number;
      diagramType: string;
      repair?: SourceRepair | undefined;
      /** Omitted when the renderer cannot enumerate nodes, such as chart data items. */
      nodeIds?: string[] | undefined;
      /** Complete node labels when enumeration fits the metadata limit. */
      nodes?: DiagramNode[] | undefined;
      /** Selectable edges or sequence messages, with their endpoints as drawn. */
      relationships?: DiagramNode[] | undefined;
      repeatedNames?: RepeatedName[] | undefined;
      /** Parts of the source that the rendering leaves out. */
      warnings?: string[] | undefined;
    }
  /**
   * The warnings of the drawing that answered the render, after the panel's new size changed them,
   * as by laying the drawing out again or measuring it against the panel's width.
   */
  | { type: "warningsChanged"; requestId: number; warnings: string[] }
  | {
      type: "renderError";
      requestId: number;
      message: string;
      /** The page could not render at all, e.g. as the code of its renderer did not load. */
      unavailable?: boolean | undefined;
    }
  | { type: "selectionChanged"; requestId: number; nodes: DiagramNode[] }
  | { type: "sourceEdited"; requestId: number; source: string }
  /**
   * What the user typed, about the nodes selected in the drawing of the render, if the page shows
   * one.
   */
  | { type: "ask"; requestId?: number | undefined; text: string; nodes: DiagramNode[] }
  /**
   * A plain click on a node that links to code or has the diagram's clickPrompt to ask, which the
   * host resolves: the webview cannot choose a path. Clicks name the render whose drawing was
   * clicked, as a click on a drawing sent just before the page drew its replacement is on a diagram
   * that is gone.
   */
  | { type: "clickNode"; requestId: number; node: DiagramNode }
  /**
   * A link that the Mermaid source drew, or the HTML of a chart, such as its tooltip's, which the
   * host checks: a model may have written it.
   */
  | { type: "openUrl"; requestId: number; url: string }
  | { type: "picked"; pickId: number; nodes: DiagramNode[] }
  | { type: "pickCancelled"; pickId: number }
  /** The user asked to reload the chart's data from its file or command. */
  | { type: "refresh" }
  | {
      type: "exportImage";
      requestId: number;
      format: "png" | "svg";
      data: string;
      /** What the image shows, for a model that asked for it. */
      view?: ImageView | undefined;
    }
  | { type: "exportTheme"; requestId: number; colors: ThemeColors }
  | { type: "exportError"; requestId: number; message: string }
  /** Write the shown diagram to its bound code block without requiring a source edit. */
  | { type: "writeToDocument"; requestId: number };

type Check = (value: unknown) => boolean;
const isString: Check = (value) => typeof value === "string";
const isBoolean: Check = (value) => typeof value === "boolean";
const isNumber: Check = (value) => typeof value === "number" && Number.isFinite(value);
const isId: Check = (value) => Number.isSafeInteger(value);
const isNode: Check = (value) =>
  isPlainObject(value) &&
  isString(value.id) &&
  isString(value.label) &&
  (value.chart === undefined ||
    (isPlainObject(value.chart) &&
      isId(value.chart.seriesIndex) &&
      Number(value.chart.seriesIndex) >= 0 &&
      isId(value.chart.dataIndex) &&
      Number(value.chart.dataIndex) >= 0 &&
      (value.chart.dataType === undefined || isString(value.chart.dataType)))) &&
  (value.relationship === undefined ||
    (isPlainObject(value.relationship) &&
      (value.relationship.kind === "edge" || value.relationship.kind === "message") &&
      isString(value.relationship.source) &&
      isString(value.relationship.target) &&
      ["forward", "both", "undirected"].includes(value.relationship.direction as string) &&
      (value.relationship.linkStyle === undefined || isId(value.relationship.linkStyle)) &&
      (value.relationship.text === undefined || isString(value.relationship.text))));
const isNodes: Check = (value) => Array.isArray(value) && value.every(isNode);
const isStrings: Check = (value) => Array.isArray(value) && value.every(isString);
const isRepeatedNames: Check = (value) =>
  Array.isArray(value) &&
  value.every(
    (item) => isPlainObject(item) && isString(item.name) && isStrings(item.ids) && isId(item.count),
  );
const optional =
  (check: Check): Check =>
  (value) =>
    value === undefined || check(value);
const isSize: Check = (value) =>
  isPlainObject(value) && isNumber(value.width) && isNumber(value.height);
const isImageView: Check = (value) =>
  isSize(value) &&
  isPlainObject(value) &&
  isNumber(value.scale) &&
  optional(isSize)(value.area) &&
  optional(isNumber)(value.textSize) &&
  optional((panel) => isSize(panel) && isPlainObject(panel) && isNumber(panel.zoom))(value.panel) &&
  optional(isStrings)(value.missing);
const isRgba: Check = (value) =>
  isPlainObject(value) && [value.r, value.g, value.b, value.a].every(isNumber);

const THEME_COLOR_FIELDS: { [K in keyof ThemeColors]-?: Check } = {
  dark: isBoolean,
  highContrast: isBoolean,
  background: isRgba,
  foreground: isRgba,
  muted: isRgba,
  gridLine: isRgba,
  axisLine: isRgba,
  focus: isRgba,
  contrastBorder: isRgba,
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
  draftResult: {
    requestId: isId,
    diagramType: optional(isString),
    items: optional((value) => isNodes(value) && Array.isArray(value) && value.length <= 5000),
    warnings: optional(isStrings),
    image: optional(isString),
    error: optional(isString),
  },
  items: {
    requestId: isId,
    page: (value) =>
      isPlainObject(value) &&
      isId(value.totalItems) &&
      Number(value.totalItems) >= 0 &&
      isId(value.matchedItems) &&
      Number(value.matchedItems) >= 0 &&
      Number(value.matchedItems) <= Number(value.totalItems) &&
      isId(value.startItem) &&
      Number(value.startItem) >= 1 &&
      isNodes(value.items) &&
      Array.isArray(value.items) &&
      value.items.length <= 100 &&
      value.items.length <= Math.max(0, Number(value.matchedItems) - Number(value.startItem) + 1) &&
      (value.nextItem === undefined ||
        (isId(value.nextItem) &&
          value.nextItem === Number(value.startItem) + value.items.length &&
          Number(value.nextItem) <= Number(value.matchedItems))),
  },
  itemsError: { requestId: isId, message: isString },
  ready: {},
  closeChartOptions: {},
  applyChartOptions: {
    revision: isId,
    controls: optional(isPlainObject),
    replaceSource: isBoolean,
  },
  rendered: {
    requestId: isId,
    diagramType: isString,
    repair: optional(
      (value) => isPlainObject(value) && isString(value.source) && isString(value.description),
    ),
    nodeIds: optional(isStrings),
    nodes: optional(isNodes),
    relationships: optional(isNodes),
    repeatedNames: optional(isRepeatedNames),
    warnings: optional(isStrings),
  },
  warningsChanged: { requestId: isId, warnings: isStrings },
  annotationStep: {
    requestId: isId,
    annotationId: isId,
    step: (value) => Number.isInteger(value) && Number(value) >= 0 && Number(value) < 20,
  },
  renderError: { requestId: isId, message: isString, unavailable: optional(isBoolean) },
  selectionChanged: { requestId: isId, nodes: isNodes },
  sourceEdited: { requestId: isId, source: isString },
  ask: { requestId: optional(isId), text: isString, nodes: isNodes },
  clickNode: { requestId: isId, node: isNode },
  openUrl: { requestId: isId, url: isString },
  picked: { pickId: isId, nodes: isNodes },
  pickCancelled: { pickId: isId },
  refresh: {},
  exportImage: {
    requestId: isId,
    format: (value) => value === "png" || value === "svg",
    data: isString,
    view: optional(isImageView),
  },
  exportTheme: { requestId: isId, colors: isThemeColors },
  exportError: { requestId: isId, message: isString },
  writeToDocument: { requestId: isId },
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
