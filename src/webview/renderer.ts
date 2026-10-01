import type { DiagramNode } from "../protocol";

/** A clickable part of a diagram: a Mermaid node or a chart data item. */
export interface Hit {
  /** Identifies the part within the current rendering; parts with the same key are one. */
  key: string;
  node: DiagramNode;
}

export interface RendererHost {
  /** The user clicked a part of the diagram, or empty space (`hit` undefined). */
  itemClicked(hit: Hit | undefined, modifier: boolean): void;
}

/** Renders one diagram language in the canvas area. */
export interface Renderer {
  /** What the panel calls a rendering, its clickable parts and its source. */
  readonly noun: string;
  readonly itemNoun: string;
  readonly sourceName: string;
  /**
   * Renders the source and shows it, returning the diagram type. Throws an error with an
   * actionable message when the source cannot be rendered.
   */
  render(source: string, title: string): Promise<string>;
  /** Hides the rendering and releases its resources (another renderer took over). */
  hide(): void;
  /** Highlights the parts with the given keys as selected. */
  showSelection(keys: ReadonlySet<string>): void;
  /** Renders the current diagram again with the current VS Code theme. */
  themeChanged(): Promise<void>;
  /** The source as shown in the source editor. */
  formatForEditing(source: string): string;
  /** Zooming, for renderers that do not fit the panel by themselves. */
  zoomBy?(factor: number): void;
  zoomReset?(): void;
}

/** Whether a click adds to the selection instead of replacing it. */
export const withModifier = (event: unknown) =>
  event instanceof MouseEvent && (event.ctrlKey || event.metaKey || event.shiftKey);
