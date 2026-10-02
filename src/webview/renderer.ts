import type { Annotation, DiagramNode } from "../protocol";
import type { DiagramImage } from "./images";

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
  /**
   * Makes an agent's marks stand out on the rendering as it is, replacing the marks shown before,
   * and fades the rest while the annotation dims. Called again after a re-render, as a theme change
   * draws the rendering anew.
   */
  showMarks(annotation: Annotation): void;
  /**
   * The nodes drawn, by the ids the extension host knows them under, for renderings whose parts
   * the panel can name: a Mermaid diagram's nodes come from its source, while a chart's items are
   * its data, which the panel does not enumerate.
   */
  drawnNodes?(): DiagramNode[];
  /**
   * Marks the nodes that link to a place in the code, given by node id, as clickable and shows the
   * location as their tooltip. Only Mermaid nodes can link; chart items are data points.
   */
  showLinks?(locations: ReadonlyMap<string, string>): void;
  /**
   * The rendering as a standalone image, to drag out of the panel or save. Drawn on `background`,
   * as an image dropped into another application has no theme behind it.
   */
  toImage?(background: string): Promise<DiagramImage>;
  /** Renders the current diagram again with the current VS Code theme. */
  themeChanged(): Promise<void>;
  /** The source as shown in the source editor. */
  formatForEditing(source: string): string;
  /** Zooming, for renderers that do not fit the panel by themselves. */
  zoomBy?(factor: number): void;
  zoomReset?(): void;
}

/** An annotation with nothing in it: how a rendering starts out, and what clearing the marks leaves. */
export const UNMARKED: Annotation = { marks: [], dim: false };

/** Whether a click, or a key press on a node, adds to the selection instead of replacing it. */
export const withModifier = (event: unknown) =>
  (event instanceof MouseEvent || event instanceof KeyboardEvent) &&
  (event.ctrlKey || event.metaKey || event.shiftKey);
