// Messages exchanged between the extension host and the diagram webview.

export interface DiagramNode {
  /** The node id as written in the Mermaid source, when it can be determined. */
  id: string;
  /** The visible label of the node. */
  label: string;
}

export type ToWebview =
  | {
      type: "render";
      requestId: number;
      source: string;
      title: string;
      /** When set, a plain click on a node asks this in chat instead of selecting the node. */
      clickPrompt?: string;
    }
  | { type: "clearSelection" }
  /** Asks the user to click nodes until the pick is answered or ended. */
  | { type: "startPick"; pickId: number; prompt: string; multiple: boolean }
  | { type: "endPick"; pickId: number };

export type FromWebview =
  | { type: "ready" }
  | { type: "rendered"; requestId: number; diagramType: string }
  | { type: "renderError"; requestId: number; message: string }
  | { type: "selectionChanged"; nodes: DiagramNode[] }
  | { type: "sourceEdited"; source: string }
  | { type: "ask"; text: string; nodes: DiagramNode[] }
  | { type: "clickToAsk"; node: DiagramNode }
  | { type: "picked"; pickId: number; nodes: DiagramNode[] }
  | { type: "pickCancelled"; pickId: number };
