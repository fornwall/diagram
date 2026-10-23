import type { Annotation, DiagramNode, RepeatedName } from "../protocol";
import type { DiagramImage, ModelImage } from "./images";

/** A clickable part of a diagram: a Mermaid node or a chart data item. */
export interface Hit {
  /** Identifies the part within the current rendering; parts with the same key are one. */
  key: string;
  node: DiagramNode;
  /** The links in the Mermaid source from the part, and the element to show a menu of several at. */
  links?: { targets: readonly WebLink[]; anchor: Element } | undefined;
}

/** A link in the Mermaid source, unchecked: a model may have written it. */
export interface WebLink {
  /** What the source calls it: the URL itself unless an actor's menu names it. */
  name: string;
  url: string;
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
  /** The element that takes the keys for the drawing, if not the canvas, which scrolls. */
  readonly focusTarget?: HTMLElement;
  /** Hides the rendering and releases its resources (another renderer took over). */
  hide(): void;
  /** Highlights the parts with the given keys as selected. */
  showSelection(keys: ReadonlySet<string>): void;
  /** Replaces annotations, including whether to dim unmarked items. */
  showMarks(annotation: Annotation): void;
  /** Enumerable nodes and relationships; charts do not enumerate their data items. */
  drawnNodes?(): DiagramNode[];
  /** Enumerates chart identities on demand, including items hidden by legend or zoom. */
  eachItem?(visit: (node: DiagramNode) => void): void;
  /** Names that several chart items go by, which marks must replace with the items' ids. */
  repeatedNames?(): RepeatedName[];
  /** What a model should know about parts of the source that the rendering leaves out. */
  warnings?(): string[];
  /** Whether the current drawing supports path selection between its nodes. */
  readonly supportsPaths?: boolean;
  findPath?(from: string, to: string): DiagramNode[] | undefined;
  /** Adds code links and location tooltips to Mermaid nodes, keyed by node id. */
  showLinks?(locations: ReadonlyMap<string, string>): void;
  /** Whether links in the source lead from some nodes. */
  readonly hasWebLinks?: boolean;
  /** Lays the drawing out for the size of the tab, shown again after being hidden. */
  tabShown(): void;
  /** Exports a self-contained image on the given background. */
  toImage(background: string): Promise<DiagramImage>;
  /**
   * An image of the drawing as the panel shows it, for a model to check, on the given background:
   * all of it, or the area around the items with the ids, as far as they are drawn.
   */
  modelImage(background: string, ids: readonly string[]): Promise<ModelImage>;
  /** Whether the image can change while the source, theme and marks stay, as a chart's does. */
  readonly changesInPlace?: boolean;
  /** Renders the current diagram again with the current VS Code theme. */
  themeChanged(): Promise<void>;
  /** The source as shown in the source editor, if not as it is. */
  formatForEditing?(source: string): string;
  /** Zooming, for renderers that do not fit the panel by themselves. */
  zoomBy?(factor: number): void;
  zoomReset?(): void;
  /**
   * Fits the next drawing to the panel, dropping a zoom chosen for the previous diagram, and shows
   * it from the start rather than scrolled as far as the previous one was.
   */
  fitToPanel(): void;
}

/**
 * The event that a renderer dispatches on the canvas when its warnings may have changed with the
 * size of the panel, as when it lays the drawing out again for it.
 */
export const WARNINGS_CHANGED = "diagramwarningschanged";

/** Tells the page that the warnings of the drawing in the canvas may have changed. */
export const warningsMayChange = (canvas: HTMLElement) =>
  canvas.dispatchEvent(new Event(WARNINGS_CHANGED));

/** Initial or cleared annotations. */
export const UNMARKED: Annotation = { marks: [], dim: false };

/** Whether a click, or a key press on a node, adds to the selection instead of replacing it. */
export const withModifier = (event: unknown) =>
  (event instanceof MouseEvent || event instanceof KeyboardEvent) &&
  (event.ctrlKey || event.metaKey || event.shiftKey);
