import type { DiagramLanguage, DiagramNode } from "../protocol";

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

export interface RenderContext {
  /** The title shown in the panel header. */
  title: string;
}

/** Renders one diagram language in the canvas area. */
export interface Renderer {
  readonly language: DiagramLanguage;
  /** Whether the zoom buttons and Ctrl/Cmd+wheel zoom apply. */
  readonly zoomable: boolean;
  /** Noun for the clickable parts, for hints: "node" or "item". */
  readonly itemNoun: string;
  /**
   * Renders the source and shows it, returning the diagram type. Throws an error with an
   * actionable message when the source cannot be rendered.
   */
  render(source: string, context: RenderContext): Promise<string>;
  /** Hides the rendering and releases its resources (another renderer took over). */
  hide(): void;
  /** Highlights the parts with the given keys as selected. */
  showSelection(keys: ReadonlySet<string>): void;
  /** Renders the current diagram again with the current VS Code theme. */
  themeChanged(): Promise<void>;
  /** The source as shown in the source editor. */
  formatForEditing(source: string): string;
  zoomBy?(factor: number): void;
  zoomReset?(): void;
}
