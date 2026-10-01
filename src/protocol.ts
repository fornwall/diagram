// Messages exchanged between the extension host and the diagram webview.

export interface DiagramNode {
  /** The node id as written in the Mermaid source, when it can be determined. */
  id: string;
  /** The visible label of the node. */
  label: string;
}

export type ToWebview =
  | { type: "render"; requestId: number; source: string; title: string }
  | { type: "clearSelection" };

export type FromWebview =
  | { type: "ready" }
  | { type: "rendered"; requestId: number; diagramType: string }
  | { type: "renderError"; requestId: number; message: string }
  | { type: "selectionChanged"; nodes: DiagramNode[] }
  | { type: "sourceEdited"; source: string }
  | { type: "ask"; text: string; nodes: DiagramNode[] };
