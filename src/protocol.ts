// Messages exchanged between the extension host and the diagram webview.

/**
 * How a diagram's source is written: Mermaid syntax, or an Apache ECharts option object as JSON.
 */
export const DIAGRAM_LANGUAGES: readonly string[] = ["mermaid", "echarts"];

export type DiagramLanguage = "mermaid" | "echarts";

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
      /** Whether the chart's data comes from a file or command, so that it can be reloaded. */
      refreshable: boolean;
    }
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
