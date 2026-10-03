import type { Annotation, DiagramNode } from "../protocol";
import type { DiagramImage } from "./images";

/** A clickable part of a diagram: a Mermaid node or a chart data item. */
export interface Hit {
  /** Identifies the part within the current rendering; parts with the same key are one. */
  key: string;
  node: DiagramNode;
}

/** A click on a diagram item, or empty space when `hit` is undefined. */
export type ItemClickHandler = (hit: Hit | undefined, modifier: boolean) => void;

/** Renders one diagram language in the canvas area. */
export interface Renderer {
  /** What the panel calls a rendering, its clickable parts and its source. */
  readonly noun: string;
  readonly itemNoun: string;
  readonly sourceName: string;
  /** Shows the source and returns its diagram type, or throws an actionable render error. */
  render(source: string, title: string): Promise<string>;
  /** Hides the rendering and releases its resources (another renderer took over). */
  hide(): void;
  /** Highlights the parts with the given keys as selected. */
  showSelection(keys: ReadonlySet<string>): void;
  /** Replaces annotations, including whether to dim unmarked items. */
  showMarks(annotation: Annotation): void;
  /** Enumerable nodes and relationships; charts do not enumerate their data items. */
  drawnNodes?(): DiagramNode[];
  /** Whether the current drawing supports path selection between its nodes. */
  readonly supportsPaths?: boolean;
  findPath?(from: string, to: string): DiagramNode[] | undefined;
  /** Adds code links and location tooltips to Mermaid nodes, keyed by node id. */
  showLinks?(locations: ReadonlyMap<string, string>): void;
  /** Exports a self-contained image on the given background. */
  toImage?(background: string): Promise<DiagramImage>;
  /** Renders the current diagram again with the current VS Code theme. */
  themeChanged(): Promise<void>;
  /** The source as shown in the source editor. */
  formatForEditing(source: string): string;
  /** Zooming, for renderers that do not fit the panel by themselves. */
  zoomBy?(factor: number): void;
  zoomReset?(): void;
}

/** Initial or cleared annotations. */
export const UNMARKED: Annotation = { marks: [], dim: false };

/** Whether a click, or a key press on a node, adds to the selection instead of replacing it. */
export const withModifier = (event: unknown) =>
  (event instanceof MouseEvent || event instanceof KeyboardEvent) &&
  (event.ctrlKey || event.metaKey || event.shiftKey);
