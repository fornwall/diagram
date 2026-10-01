// Shared by the extension host and the diagram webview, mainly the messages exchanged between them.

export const RENDER_TOOL = "diagram_render";
export const CHART_TOOL = "diagram_chart";
export const GET_STATE_TOOL = "diagram_getState";
export const PICK_NODES_TOOL = "diagram_pickNodes";

/**
 * How a diagram's source is written: Mermaid syntax, or an Apache ECharts option object as JSON.
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

export type ToWebview =
  | {
      type: "render";
      requestId: number;
      language: DiagramLanguage;
      source: string;
      title: string;
      /** When set, a plain click on a node asks this in chat instead of selecting the node. */
      clickPrompt?: string;
      /** Where the chart's data can be reloaded from, e.g. "file sales.csv" or "command `du -s *`". */
      refreshFrom?: string;
    }
  /**
   * Sent instead of render to a webview that just loaded, for a chart that was too large to keep
   * when VS Code closed: shows its title and asks the user to press Refresh.
   */
  | { type: "needsRefresh"; title: string; refreshFrom?: string }
  | { type: "clearSelection" }
  /** Asks the user to click nodes until the pick is answered or ended. */
  | { type: "startPick"; pickId: number; prompt: string; multiple: boolean }
  | { type: "endPick"; pickId: number };

export type FromWebview =
  | { type: "ready" }
  /**
   * For Mermaid, diagramType is Mermaid's diagram type, e.g. "flowchart-v2". For ECharts, it is
   * the series types of the chart, e.g. "pie" or "bar, line".
   */
  | { type: "rendered"; requestId: number; diagramType: string }
  | { type: "renderError"; requestId: number; message: string }
  | { type: "selectionChanged"; nodes: DiagramNode[] }
  | { type: "sourceEdited"; source: string }
  | { type: "ask"; text: string; nodes: DiagramNode[] }
  | { type: "clickToAsk"; node: DiagramNode }
  | { type: "picked"; pickId: number; nodes: DiagramNode[] }
  | { type: "pickCancelled"; pickId: number }
  /** The user asked to reload the chart's data from its file or command. */
  | { type: "refresh" };

type Check = (value: unknown) => boolean;
const isString: Check = (value) => typeof value === "string";
const isId: Check = (value) => Number.isSafeInteger(value);
const isNode: Check = (value) =>
  isPlainObject(value) && isString(value.id) && isString(value.label);
const isNodes: Check = (value) => Array.isArray(value) && value.every(isNode);

/** How to check each field of each message from the webview. */
const FROM_WEBVIEW_FIELDS: {
  [M in FromWebview as M["type"]]: { [K in Exclude<keyof M, "type">]-?: Check };
} = {
  ready: {},
  rendered: { requestId: isId, diagramType: isString },
  renderError: { requestId: isId, message: isString },
  selectionChanged: { nodes: isNodes },
  sourceEdited: { source: isString },
  ask: { text: isString, nodes: isNodes },
  clickToAsk: { node: isNode },
  picked: { pickId: isId, nodes: isNodes },
  pickCancelled: { pickId: isId },
  refresh: {},
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
