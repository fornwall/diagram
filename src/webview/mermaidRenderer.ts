// Renders Mermaid diagrams as SVG, scaled to fit the panel.

import type { Mermaid } from "mermaid";
import type { Annotation, DiagramMark, DiagramNode } from "../protocol";
import { mix, type ThemeColors, toCss } from "./colors";
import { type DiagramImage, standaloneSvg } from "./images";
import { describeError, parsableSource } from "./mermaidErrors";
import { shortestPath } from "./relationships";
import {
  type ItemClickHandler,
  type Renderer,
  UNMARKED,
  type WebLink,
  withModifier,
} from "./renderer";
import { readThemeColors } from "./vscodeTheme";

let loading: Promise<Mermaid> | undefined;
const loadMermaid = () => (loading ??= import("mermaid").then((module) => module.default));

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
/** The zoom of a mouse wheel notch, or of as much scrolling on a trackpad. */
const WHEEL_ZOOM = 1.2;
/** Fitting a tall diagram to the panel height never shrinks it below this; it scrolls instead. */
const MIN_HEIGHT_FIT = 0.6;
/**
 * How much the canvas width must change for a Gantt chart to be laid out again (scaling it to fit
 * meanwhile), and how long after the last change: not for a scrollbar, nor for each step of a drag.
 */
const RELAYOUT_THRESHOLD = 16;
const RELAYOUT_DELAY = 200;

/** Mermaid's default limit: it draws a longer source as an error message instead. */
const MAX_TEXT_SIZE = 50_000;

/** The namespace of the <title> elements that show where a linked node leads. */
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
/** The namespace of the targets of links that SVG draws, as Mermaid writes them. */
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

/**
 * Mermaid's dark theme colors mind maps, timelines, pies and kanban columns almost black. Use
 * VS Code's chart colors instead, toned down to carry the theme's light text.
 */
function darkScale({ palette, background }: ThemeColors): Record<string, string> {
  const scale = palette.slice(0, 12).map((hue) => toCss(mix(background, hue, 0.45)));
  return Object.fromEntries(
    scale.flatMap((color, i) => [
      [`cScale${i}`, color],
      [`pie${i + 1}`, color],
    ]),
  );
}

/**
 * The diagram types whose items Mermaid draws without their data, and the parts of their
 * databases that findNodes reads it from.
 */
const WITH_DATABASE = new Set([
  "pie",
  "gitGraph",
  "xychart",
  "flowchart-v2",
  "flowchart",
  "classDiagram",
  "stateDiagram",
  "er",
  "requirement",
  "sequence",
  "gantt",
]);
interface DiagramDb {
  getData?(): {
    edges: {
      id: string;
      start: string;
      end: string;
      label?: string;
      thickness?: string;
      arrowTypeStart?: string;
      arrowTypeEnd?: string;
    }[];
  };
  getMessages?(): { id: string; from?: string; to?: string; message?: string }[];
  getSections?(): Map<string, number>;
  getCommitsArray?(): { id: string; message: string; seq: number; tags: string[] }[];
  getDirection?(): string;
  /** A Gantt chart's task links, by task id. */
  getLinks?(): Map<string, unknown>;
  /** A sequence diagram's actors, by id, with their links by name. */
  getActors?(): Map<string, { links?: Record<string, unknown> | null }>;
  getXYChartData?(): {
    plots: { type: "bar" | "line"; title: string; data: [string, number][] }[];
  };
}

/** What a node's links in the source are called in its tooltip: "Open …". */
function describeLinks(targets: readonly WebLink[]): string {
  const [first] = targets;
  if (targets.length > 1 || !first) {
    return new Intl.ListFormat("en", { type: "disjunction" }).format(targets.map((t) => t.name));
  }
  return first.name === first.url ? first.url : `${first.name} (${first.url})`;
}

/** The text of an element, with its lines (separate text nodes) separated by spaces. */
function textOf(element: Element): string {
  const parts: string[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    parts.push(walker.currentNode.nodeValue ?? "");
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * The name of a node or group: the title of a box that also shows a stereotype, class members,
 * entity attributes, a C4 type and description, requirement fields, kanban card metadata or
 * further state descriptions. Mermaid names a state by its first description (an alias is one),
 * and shows its id only when it has none.
 */
function nameOf(element: Element): string {
  // A state label that is not split in title and descriptions starts with an empty rect.
  const title = element.querySelector(
    ".label-group, .label.name, .cluster-label, .c4-name, .statediagram-state > .label > :first-child:not(rect)",
  );
  if (title) {
    return textOf(title);
  }
  // Requirement boxes and kanban cards draw each line as a label, the name first after any
  // "<<Requirement>>" or "<<Element>>" line.
  for (const line of element.querySelectorAll(".label")) {
    const text = textOf(line);
    if (text && !/^<<.*>>$/.test(text)) {
      return text;
    }
  }
  return textOf(element);
}

/**
 * Where Mermaid lays out a drawing before returning it as markup. By default it does so in the body,
 * where the drawing would take room from the panel until Mermaid finishes, reflowing it meanwhile.
 */
let container: HTMLElement | undefined;
function layoutContainer(): HTMLElement {
  if (!container) {
    container = document.createElement("div");
    container.className = "mermaid-layout";
    container.setAttribute("aria-hidden", "true");
    document.body.append(container);
  }
  return container;
}

/**
 * Grows the view box of a drawing in the layout container to take in all of its text, which the
 * SVG would clip: Mermaid leaves some outside, such as long radar axis and quadrant point labels.
 */
function showAllText(svg: SVGSVGElement): void {
  const box = svg.viewBox.baseVal;
  const toUser = svg.getScreenCTM()?.inverse();
  if (!box.width || !box.height || !toUser) {
    return;
  }
  let [left, top, right, bottom] = [box.x, box.y, box.x + box.width, box.y + box.height];
  for (const text of svg.querySelectorAll("text, foreignObject")) {
    const bounds = text.getBoundingClientRect();
    if (bounds.width && bounds.height) {
      const start = new DOMPoint(bounds.left, bounds.top).matrixTransform(toUser);
      const end = new DOMPoint(bounds.right, bounds.bottom).matrixTransform(toUser);
      left = Math.min(left, start.x);
      top = Math.min(top, start.y);
      right = Math.max(right, end.x);
      bottom = Math.max(bottom, end.y);
    }
  }
  if (right - left > box.width || bottom - top > box.height) {
    svg.setAttribute("viewBox", `${left} ${top} ${right - left} ${bottom - top}`);
  }
}

/**
 * Centers the SVG text labels of nodes that Mermaid leaves starting at the middle of the node.
 * Its label helper draws a text label from x = 0, for the diagram's CSS to center it, which only
 * flowchart CSS does: mind map circles, squares and hexagons, and use case ellipses, would show
 * their labels from the middle to the right. The shapes that place a label themselves move it
 * from x = 0.
 */
function centerTextLabels(svg: SVGSVGElement): void {
  for (const text of svg.querySelectorAll<SVGTextElement>(
    'g.node > g.label[transform^="translate(0,"] text',
  )) {
    if (getComputedStyle(text).textAnchor === "start") {
      text.style.textAnchor = "middle";
    }
  }
}

export class MermaidRenderer implements Renderer {
  readonly noun = "diagram";
  readonly itemNoun = "node";
  readonly sourceName = "Mermaid source";

  private renderCounter = 0;
  supportsPaths = false;
  /** The selectable nodes of the shown diagram, by the elements that show them. */
  private nodes = new Map<Element, DiagramNode>();
  /** One node can have several visual parts, such as a bar and its label. */
  private elementsById = new Map<string, Element[]>();
  private drawn: DiagramNode[] = [];
  private selectedKeys: ReadonlySet<string> = new Set();
  private shownSelectedKeys: ReadonlySet<string> = new Set();
  private shownMarks = new Map<string, DiagramMark["kind"]>();
  private shownLinks: ReadonlyMap<string, string> = new Map();
  /** Where the nodes link to in the code, by node id, for as long as the diagram is shown. */
  private links: ReadonlyMap<string, string> = new Map();
  /** The links in the source from nodes, by node id; see render. */
  private webLinks = new Map<string, WebLink[]>();
  /** The marks an agent put on the diagram, which a re-render for a new theme puts back. */
  private annotation: Annotation = UNMARKED;
  private zoom = 1;
  /** Whether the zoom follows the panel size, until the user zooms by hand. */
  private fitting = true;
  private displayedSource: string | undefined;
  private diagramType: string | undefined;
  /** The width of the container that the drawing was laid out in. */
  private layoutWidth = 0;
  private fitFrame = 0;
  private relayoutTimer: ReturnType<typeof setTimeout> | undefined;
  /** The node that has the drawing's tab stop. */
  private tabStop: string | undefined;

  constructor(
    itemClicked: ItemClickHandler,
    private readonly canvas: HTMLElement,
    private readonly diagram: HTMLElement,
    private readonly zoomButton: HTMLElement,
    /** Runs a task in the panel's render queue. */
    private readonly enqueue: (task: () => Promise<void>) => void,
  ) {
    const activate = (event: MouseEvent | KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : undefined;
      const element = target?.closest(".diagram-node");
      const node = element && this.nodes.get(element);
      if (!element || !node) {
        itemClicked(undefined, withModifier(event));
        return;
      }
      // A link in a label or a shown actor menu leads where it says; anywhere else, and for a key,
      // the node's links do.
      const href = target?.closest("a[data-href]")?.getAttribute("data-href");
      const targets = href ? [{ name: href, url: href }] : this.webLinks.get(node.id);
      itemClicked(
        { key: node.id, node, links: targets && { targets, anchor: element } },
        withModifier(event),
      );
    };
    diagram.addEventListener("click", activate);
    // Nodes are buttons for the keyboard, with one tab stop for the drawing: arrow keys move
    // between them, Home and End to the first and the last.
    diagram.addEventListener("keydown", (event) => {
      const { target } = event;
      if (!(target instanceof SVGElement && this.nodes.has(target))) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate(event);
        return;
      }
      const next = this.neighbor(target, event.key);
      if (next !== undefined) {
        event.preventDefault();
        if (next) next.focus();
      }
    });
    diagram.addEventListener("focusin", ({ target }) => {
      if (target instanceof SVGElement && target.hasAttribute("tabindex")) this.setTabStop(target);
    });
    // Ctrl/Cmd+scroll zooms at the pointer, in proportion to the scrolling: a trackpad pinch,
    // which Chromium reports as such, sends many small deltas. Apply them once per frame.
    let wheel: { factor: number; x: number; y: number } | undefined;
    canvas.addEventListener(
      "wheel",
      (event) => {
        if (!(event.ctrlKey || event.metaKey) || this.displayedSource === undefined) return;
        event.preventDefault();
        const pixels =
          event.deltaY *
          (event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? 16
            : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
              ? canvas.clientHeight
              : 1);
        const factor = WHEEL_ZOOM ** (-Math.max(-100, Math.min(100, pixels)) / 100);
        if (wheel) {
          wheel = { factor: wheel.factor * factor, x: event.clientX, y: event.clientY };
          return;
        }
        wheel = { factor, x: event.clientX, y: event.clientY };
        requestAnimationFrame(() => {
          if (wheel && this.displayedSource !== undefined) {
            this.zoomBy(wheel.factor, wheel.x, wheel.y);
          }
          wheel = undefined;
        });
      },
      { passive: false },
    );
    new ResizeObserver(() => {
      if (this.displayedSource === undefined) return;
      if (this.fitting) {
        cancelAnimationFrame(this.fitFrame);
        // The user may zoom by hand before the frame.
        this.fitFrame = requestAnimationFrame(() => {
          if (this.fitting && this.displayedSource !== undefined) this.fit();
        });
      }
      if (this.diagramType === "gantt") {
        clearTimeout(this.relayoutTimer);
        this.relayoutTimer = setTimeout(() => this.enqueue(() => this.relayout()), RELAYOUT_DELAY);
      }
    }).observe(canvas);
  }

  /** How Mermaid is configured for the current VS Code theme. */
  private config(): Parameters<Mermaid["initialize"]>[0] {
    const colors = readThemeColors();
    return {
      startOnLoad: false,
      securityLevel: "strict",
      maxTextSize: MAX_TEXT_SIZE,
      // Throw errors instead of rendering them as a diagram, and clean up after failing.
      suppressErrorRendering: true,
      theme: colors.dark ? "dark" : "default",
      themeVariables: colors.dark ? darkScale(colors) : {},
      fontFamily: colors.fontFamily,
    };
  }

  async render(source: string): Promise<string> {
    if (source.length > MAX_TEXT_SIZE) {
      throw new Error(
        `The diagram is too long: ${source.length} characters, where Mermaid allows ${MAX_TEXT_SIZE}. Split it into smaller diagrams.`,
      );
    }
    const mermaid = await loadMermaid();
    mermaid.initialize(this.config());
    const id = `diagram-svg-${++this.renderCounter}`;
    const container = layoutContainer();
    // Gantt charts take the width of the element they are drawn in: give them the width they are
    // shown at, rather than shrinking their text to fit. In the Source view the canvas has no
    // width: keep the last one, or before any, take the one it has in the Visual view.
    let { width } = this.contentSize();
    if (width <= 0 && !container.style.width && this.canvas.parentElement) {
      const style = getComputedStyle(this.canvas);
      // The canvas keeps room for a scrollbar.
      const scroller = document.createElement("div");
      scroller.style.overflow = "scroll";
      container.append(scroller);
      width =
        this.canvas.parentElement.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight) -
        (scroller.offsetWidth - scroller.clientWidth);
      scroller.remove();
    }
    if (width > 0) {
      container.style.width = `${width}px`;
      this.layoutWidth = width;
    }
    const text = parsableSource(source);
    const result = await mermaid.render(id, text, container).catch((error: unknown) => {
      throw describeError(error, source, () => mermaid.detectType(text));
    });
    // mermaid.render keeps the diagram's database to itself: parse again for it. Should that
    // fail, the items are just not selectable.
    const db: DiagramDb | undefined = WITH_DATABASE.has(result.diagramType)
      ? await mermaid.mermaidAPI.getDiagramFromText(text).then(
          (parsed) => parsed.db as DiagramDb,
          () => undefined,
        )
      : undefined;
    // Measured where it is laid out even while the canvas is hidden.
    const drawing = document.createElement("div");
    drawing.innerHTML = result.svg;
    container.append(drawing);
    const svg = drawing.querySelector("svg");
    if (svg) {
      showAllText(svg);
    }
    this.diagram.replaceChildren(...drawing.childNodes);
    drawing.remove();
    // A click selects, and links open through the extension, which checks their URLs. A link that
    // Mermaid draws, from a click directive or a label, would open its URL, written by a model, on
    // that same click, in a trusted workspace without asking. Keep where it leads as data.
    for (const link of this.diagram.querySelectorAll("a")) {
      const href = (
        link.getAttribute("href") ?? link.getAttributeNS(XLINK_NAMESPACE, "href")
      )?.trim();
      link.removeAttribute("href");
      link.removeAttributeNS(XLINK_NAMESPACE, "href");
      if (href) link.setAttribute("data-href", href);
    }
    // A Gantt chart binds nothing but its links, to open them with window.open, which would take
    // the panel itself to the URL. prepareSvg links its tasks instead.
    if (result.diagramType !== "gantt") result.bindFunctions?.(this.diagram);
    this.diagram.hidden = false;
    this.displayedSource = source;
    this.diagramType = result.diagramType;
    this.supportsPaths = result.diagramType.startsWith("flowchart") && db?.getData !== undefined;
    this.prepareSvg(id, db);
    // Until fitting can measure the panel, e.g. while it is hidden, keep the zoom.
    this.setZoom(this.zoom);
    if (this.fitting) {
      this.fit();
    }
    return result.diagramType;
  }

  /**
   * The diagram as an image, rendered a second time with its labels as SVG text.
   *
   * Mermaid draws a label as HTML in a `foreignObject` unless told otherwise. Most applications
   * that read SVG leave that out, so the labels would go missing where the image is dropped, and an
   * SVG holding one cannot be rasterized to a PNG at all. The copy on screen keeps its HTML labels,
   * which wrap better, and is left untouched: this render goes to a string, not into the panel.
   */
  async toImage(background: string): Promise<DiagramImage> {
    const source = this.displayedSource;
    if (source === undefined) {
      throw new Error("There is no diagram to make an image of.");
    }
    const mermaid = await loadMermaid();
    mermaid.initialize({
      ...this.config(),
      htmlLabels: false,
      // SVG text would show the tags of HTML in labels, such as <b> and <a>: keep only their text,
      // the line breaks that Mermaid splits SVG text at, and formulas, which are MathML.
      dompurifyConfig: { USE_PROFILES: { mathMl: true }, ADD_TAGS: ["br"] },
      // Front matter and init directives must not put HTML labels back into an image.
      secure: [...(mermaid.mermaidAPI.defaultConfig.secure ?? []), "htmlLabels"],
    });
    try {
      const { svg } = await mermaid.render(
        `diagram-image-${++this.renderCounter}`,
        parsableSource(source),
        layoutContainer(),
      );
      const parsed = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
      if (!(parsed instanceof SVGSVGElement)) {
        throw new Error("Mermaid did not produce an SVG to make an image of.");
      }
      layoutContainer().append(parsed);
      centerTextLabels(parsed);
      showAllText(parsed);
      const image = standaloneSvg(parsed, background);
      parsed.remove();
      return image;
    } finally {
      // Leave Mermaid configured for the panel: a theme change or a resize may render before the
      // next diagram arrives, and would otherwise draw the labels as plain text.
      mermaid.initialize(this.config());
    }
  }

  hide(): void {
    this.diagram.hidden = true;
    this.diagram.innerHTML = "";
    this.nodes.clear();
    this.elementsById.clear();
    this.drawn = [];
    this.shownSelectedKeys = new Set();
    this.shownMarks.clear();
    this.shownLinks = new Map();
    this.displayedSource = undefined;
  }

  showSelection(keys: ReadonlySet<string>): void {
    this.selectedKeys = keys;
    const update = (id: string, selected: boolean) => {
      for (const element of this.elementsById.get(id) ?? []) {
        element.classList.toggle("diagram-selected", selected);
        element.setAttribute("aria-pressed", String(selected));
      }
    };
    // A click changes just its old and new selection, even in a large diagram. Avoid writing
    // attributes on every node (and invalidating browser accessibility/style state) each time.
    for (const id of this.shownSelectedKeys) {
      if (!keys.has(id)) update(id, false);
    }
    for (const id of keys) {
      if (!this.shownSelectedKeys.has(id)) update(id, true);
    }
    this.shownSelectedKeys = keys;
  }

  showMarks(annotation: Annotation): void {
    this.annotation = annotation;
    const kinds = new Map(annotation.marks.map((mark) => [mark.id, mark.kind]));
    // Notes and captions can change without touching the drawing. Only visit the visual parts
    // whose mark changed, rather than every node and relationship in a large diagram.
    const changed = new Set([...this.shownMarks.keys(), ...kinds.keys()]);
    for (const id of changed) {
      const before = this.shownMarks.get(id);
      const after = kinds.get(id);
      if (before === after) continue;
      for (const element of this.elementsById.get(id) ?? []) {
        if (before !== undefined) element.classList.remove(`diagram-mark-${before}`);
        if (after !== undefined) element.classList.add(`diagram-mark-${after}`);
        element.classList.toggle("diagram-marked", after !== undefined);
      }
    }
    this.shownMarks = kinds;
    // Nothing is faded while nothing is marked, however the annotation asks for it.
    this.diagram.classList.toggle("dim-unmarked", annotation.dim && kinds.size > 0);
  }

  findPath(from: string, to: string): DiagramNode[] | undefined {
    return this.supportsPaths ? shortestPath(this.drawnNodes(), from, to) : undefined;
  }

  drawnNodes(): DiagramNode[] {
    // Several elements can show one node, e.g. a Gantt task's bar and its label.
    return this.drawn;
  }

  labelOf(id: string): string | undefined {
    const [element] = this.elementsById.get(id) ?? [];
    return element && this.nodes.get(element)?.label;
  }

  showLinks(locations: ReadonlyMap<string, string>): void {
    this.links = locations;
    // A node's code link takes precedence over its links in the source, as on a click.
    const shown = new Map([
      ...Array.from(this.webLinks, ([id, targets]) => [id, describeLinks(targets)] as const),
      ...locations,
    ]);
    for (const id of new Set([...this.shownLinks.keys(), ...shown.keys()])) {
      const location = shown.get(id);
      if (this.shownLinks.get(id) === location) continue;
      for (const element of this.elementsById.get(id) ?? []) {
        if (this.nodes.get(element)?.relationship) continue;
        element.classList.toggle("diagram-linked", location !== undefined);
        // SVG shows the first title child. Replace only our tooltip, keeping Mermaid's own.
        element.querySelector(":scope > title.diagram-link")?.remove();
        if (location !== undefined) {
          const title = document.createElementNS(SVG_NAMESPACE, "title");
          title.classList.add("diagram-link");
          title.textContent = `Open ${location}`;
          element.prepend(title);
        }
      }
    }
    this.shownLinks = shown;
  }

  get hasWebLinks(): boolean {
    return this.webLinks.size > 0;
  }

  async themeChanged(): Promise<void> {
    if (this.displayedSource !== undefined) {
      await this.redraw(this.displayedSource);
    }
  }

  /**
   * Renders the shown diagram again, keeping the keyboard focus on the node that has it. Failing
   * that, as it rendered before, keeps what is shown.
   */
  private async redraw(source: string): Promise<boolean> {
    const focused = document.activeElement;
    const node = focused ? this.nodes.get(focused) : undefined;
    try {
      await this.render(source);
    } catch {
      return false;
    }
    // Replacing the SVG removes its focused node. Keep keyboard navigation on that node, unless
    // the user moved focus elsewhere while Mermaid was rendering.
    if (node && !focused?.isConnected && document.activeElement === document.body) {
      for (const [element, candidate] of this.nodes) {
        if (
          candidate.id === node.id &&
          element instanceof SVGElement &&
          element.hasAttribute("tabindex")
        ) {
          element.focus({ preventScroll: true });
          break;
        }
      }
    }
    return true;
  }

  /**
   * Lays a Gantt chart out again at the width of the canvas, which Mermaid draws it at, rather than
   * scaling it with its text. A zoom by hand stays as much larger or smaller than fitting, and the
   * canvas stays scrolled to the same part of the chart.
   */
  private async relayout(): Promise<void> {
    const source = this.displayedSource;
    const room = this.contentSize();
    if (
      source === undefined ||
      this.diagramType !== "gantt" ||
      room.width <= 0 ||
      Math.abs(room.width - this.layoutWidth) < RELAYOUT_THRESHOLD
    ) {
      return;
    }
    const fitted = (width: number) =>
      this.fitZoom(this.diagram.querySelector("svg")?.viewBox.baseVal, { ...room, width });
    const relativeZoom = this.zoom / (fitted(this.layoutWidth) ?? this.zoom);
    const { scrollLeft, scrollTop, scrollWidth, scrollHeight } = this.canvas;
    if (!(await this.redraw(source))) return;
    if (!this.fitting) {
      this.setZoom((fitted(room.width) ?? 1) * relativeZoom);
    }
    this.canvas.scrollLeft = (scrollLeft * this.canvas.scrollWidth) / scrollWidth;
    this.canvas.scrollTop = (scrollTop * this.canvas.scrollHeight) / scrollHeight;
  }

  formatForEditing(source: string): string {
    return source;
  }

  /** Zooms, keeping the point at the given client coordinates (the middle by default) in place. */
  zoomBy(factor: number, x?: number, y?: number): void {
    this.fitting = false;
    const svg = this.diagram.querySelector("svg");
    const before = svg?.getBoundingClientRect();
    this.setZoom(this.zoom * factor);
    if (!svg || !before?.width || !before.height) return;
    const view = this.canvas.getBoundingClientRect();
    const anchorX = x ?? view.left + view.width / 2;
    const anchorY = y ?? view.top + view.height / 2;
    const after = svg.getBoundingClientRect();
    // Scrolling stops at the edges, so a diagram that fits the canvas stays centered instead.
    this.canvas.scrollLeft +=
      after.left + ((anchorX - before.left) * after.width) / before.width - anchorX;
    this.canvas.scrollTop +=
      after.top + ((anchorY - before.top) * after.height) / before.height - anchorY;
  }

  /** Toggles between fitting the panel and the actual size. */
  zoomReset(): void {
    if (this.fitting && this.zoom !== 1) {
      this.fitting = false;
      this.setZoom(1);
    } else {
      this.fitting = true;
      this.fit();
    }
  }

  /**
   * The node to move the focus to from the given one for a key: the nearest in the direction of an
   * arrow key (null if there is none), or the first or last node, in the order of the source, for
   * Home and End. Undefined if the key does not move the focus.
   */
  private neighbor(from: SVGElement, key: string): SVGElement | null | undefined {
    if (key === "Home" || key === "End") {
      const nodes = this.drawn.filter((node) => !node.relationship);
      const node = key === "Home" ? nodes[0] : nodes.at(-1);
      return (
        this.elementsById
          .get(node?.id ?? "")
          ?.find((element): element is SVGElement => element.matches("[tabindex]")) ?? null
      );
    }
    const stops = this.diagram.querySelectorAll<SVGElement>(".diagram-node[tabindex]");
    const direction = {
      ArrowRight: [1, 0],
      ArrowLeft: [-1, 0],
      ArrowDown: [0, 1],
      ArrowUp: [0, -1],
    }[key];
    if (!direction) return undefined;
    const [dx, dy] = direction as [number, number];
    const center = (element: Element) => {
      const box = element.getBoundingClientRect();
      return [box.left + box.width / 2, box.top + box.height / 2] as const;
    };
    const [x, y] = center(from);
    // The nearest node ahead, preferring one in line with this one.
    let best: SVGElement | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const stop of stops) {
      const [cx, cy] = center(stop);
      const ahead = (cx - x) * dx + (cy - y) * dy;
      const aside = Math.abs((cx - x) * dy) + Math.abs((cy - y) * dx);
      const score = ahead + 2 * aside;
      if (stop !== from && ahead > 0.5 && score < bestScore) {
        best = stop;
        bestScore = score;
      }
    }
    return best;
  }

  /** Makes the element the drawing's tab stop. */
  private setTabStop(element: SVGElement): void {
    const node = this.nodes.get(element);
    if (!node || element.getAttribute("tabindex") === "0") return;
    this.diagram.querySelector('.diagram-node[tabindex="0"]')?.setAttribute("tabindex", "-1");
    element.setAttribute("tabindex", "0");
    this.tabStop = node.id;
  }

  /** Finds the selectable nodes. */
  private prepareSvg(svgId: string, db?: DiagramDb): void {
    this.nodes.clear();
    this.elementsById.clear();
    this.drawn = [];
    this.shownSelectedKeys = new Set();
    this.shownMarks.clear();
    this.shownLinks = new Map();
    const svg = this.diagram.querySelector("svg");
    if (!svg) {
      return;
    }
    this.findNodes(svg, `${svgId}-`, db);
    const uniqueNodes = new Map<string, DiagramNode>();
    for (const [element, node] of this.nodes) {
      uniqueNodes.set(node.id, node);
      const elements = this.elementsById.get(node.id) ?? [];
      elements.push(element);
      this.elementsById.set(node.id, elements);
      element.setAttribute("aria-pressed", "false");
    }
    this.drawn = [...uniqueNodes.values()];
    this.findWebLinks(svg, db);
    // Keep the tab stop on the same node in a new version of the drawing.
    const stops = svg.querySelectorAll<SVGElement>(".diagram-node[tabindex]");
    const stop =
      Array.from(stops).find((element) => this.nodes.get(element)?.id === this.tabStop) ?? stops[0];
    stop?.setAttribute("tabindex", "0");
    this.showSelection(this.selectedKeys);
    this.showLinks(this.links);
    this.showMarks(this.annotation);
    // Mermaid sizes the drawing to fit its container; setZoom sizes it instead.
    svg.style.maxWidth = "none";
  }

  /**
   * Finds the nodes that links in the source lead from: those that a click directive wraps in a
   * link, those with a link in their label, the first one if several, linked Gantt tasks, and
   * sequence diagram actors with links, which can have several.
   */
  private findWebLinks(svg: SVGSVGElement, db: DiagramDb | undefined): void {
    this.webLinks.clear();
    const toLink = (url: unknown) =>
      typeof url === "string" && url.trim() ? { name: url.trim(), url: url.trim() } : undefined;
    for (const link of svg.querySelectorAll("a[data-href]")) {
      const element = link.querySelector(".diagram-node") ?? link.closest(".diagram-node");
      const node = element && this.nodes.get(element);
      const target = toLink(link.getAttribute("data-href"));
      if (node && !node.relationship && target && !this.webLinks.has(node.id)) {
        this.webLinks.set(node.id, [target]);
      }
    }
    // A Gantt chart draws none, but keeps them by task id. (A state diagram keeps objects there.)
    for (const [id, url] of db?.getLinks?.() ?? []) {
      const target = toLink(url);
      if (target && this.elementsById.has(id)) this.webLinks.set(id, [target]);
    }
    // An actor's links are drawn as a menu, which Mermaid hides unless sequence.forceMenus, and
    // opens with a script that the strict security level removes.
    for (const [id, actor] of db?.getActors?.() ?? []) {
      const targets = Object.entries(actor.links ?? {}).flatMap(([name, url]) => {
        const target = toLink(url);
        return target ? [{ ...target, name: name.trim() || target.url }] : [];
      });
      if (targets.length > 0 && this.elementsById.has(id)) this.webLinks.set(id, targets);
    }
  }

  /**
   * Joins renderer metadata to DOM IDs; endpoint names are never inferred from generated IDs.
   * `nodeIds` gives the id of each node by the id Mermaid draws it with.
   */
  private findRelationships(
    svg: SVGSVGElement,
    db: DiagramDb | undefined,
    nodeIds: ReadonlyMap<string, string>,
    add: (element: Element, node: DiagramNode) => void,
  ): void {
    const used = new Set(Array.from(this.nodes.values(), (node) => node.id));
    const names = new Map(Array.from(this.nodes.values(), (node) => [node.id, node.label]));
    const unique = (base: string) => {
      let id = base;
      for (let n = 2; used.has(id); n++) id = `${base} (${n})`;
      used.add(id);
      return id;
    };
    const plainText = (text: string) => {
      // Most messages are plain text and most edges have no label. Avoid constructing a
      // complete HTML document for each of them; entities and markup still use the parser.
      if (!/[<&]/.test(text)) return text.replace(/\s+/g, " ").trim();
      const doc = new DOMParser().parseFromString(
        text.replace(/<br\s*\/?\s*>/gi, " "),
        "text/html",
      );
      return textOf(doc.body);
    };
    const addLine = (line: Element, node: DiagramNode) => {
      add(line, node);
      // A wide invisible stroke makes thin lines practical mouse targets without changing the drawing.
      const hit = line.cloneNode(false) as SVGElement;
      for (const name of hit.getAttributeNames()) {
        if (!["d", "x1", "x2", "y1", "y2", "transform"].includes(name)) hit.removeAttribute(name);
      }
      hit.classList.add("diagram-relationship-hit");
      hit.setAttribute("aria-hidden", "true");
      line.before(hit);
      add(hit, node);
    };
    const relation = (
      kind: "edge" | "message",
      id: string,
      source: string,
      target: string,
      text: string,
      start: boolean,
      end: boolean,
    ): DiagramNode => {
      if (start && !end) [source, target] = [target, source];
      const direction = start && end ? "both" : !start && !end ? "undirected" : "forward";
      const arrow = direction === "both" ? "↔" : direction === "undirected" ? "—" : "→";
      return {
        id: unique(`${kind}:${id}`),
        label: `${names.get(source) ?? source} ${arrow} ${names.get(target) ?? target}${text ? `: ${text}` : ""}`,
        relationship: { kind, source, target, direction },
      };
    };
    // Edges of flowcharts and class, state, ER and requirement diagrams, which Mermaid lays out
    // alike. Diamonds, lollipops, cardinalities and "contains" circles are not arrowheads.
    const arrowhead = (marker = "") =>
      /^(?:arrow_|extension$|dependency$|requirement_arrow$)/.test(marker);
    if (db?.getData) {
      const edges = db.getData().edges;
      const counts = new Map<string, number>();
      for (const edge of edges) counts.set(edge.id, (counts.get(edge.id) ?? 0) + 1);
      const labels = new Map(
        Array.from(svg.querySelectorAll(".edgeLabel .label[data-id]"), (element) => [
          element.getAttribute("data-id"),
          element,
        ]),
      );
      const lines = new Map(
        Array.from(svg.querySelectorAll('[data-et="edge"][data-id]'), (line) => [
          line.getAttribute("data-id"),
          line,
        ]),
      );
      for (const edge of edges) {
        const line = lines.get(edge.id);
        const source = nodeIds.get(edge.start) ?? edge.start;
        const target = nodeIds.get(edge.end) ?? edge.end;
        // Ambiguous duplicate renderer IDs cannot safely identify a relationship, and one with an
        // end that is not a node, like a state diagram's start, cannot be described.
        if (
          !line ||
          counts.get(edge.id) !== 1 ||
          edge.thickness === "invisible" ||
          !names.has(source) ||
          !names.has(target)
        )
          continue;
        const label = labels.get(edge.id);
        const node = relation(
          "edge",
          edge.id,
          source,
          target,
          label ? textOf(label) : plainText(edge.label ?? ""),
          arrowhead(edge.arrowTypeStart),
          arrowhead(edge.arrowTypeEnd),
        );
        addLine(line, node);
        if (label) add(label, node);
      }
    }
    if (db?.getMessages) {
      const messages = new Map(db.getMessages().map((message) => [`i${message.id}`, message]));
      for (const line of svg.querySelectorAll('[data-et="message"][data-id]')) {
        const id = line.getAttribute("data-id") ?? "";
        const message = messages.get(id);
        if (
          !message?.from ||
          !message.to ||
          line.getAttribute("data-from") !== message.from ||
          line.getAttribute("data-to") !== message.to
        )
          continue;
        const node = relation(
          "message",
          id,
          message.from,
          message.to,
          plainText(message.message ?? ""),
          line.hasAttribute("marker-start"),
          line.hasAttribute("marker-end"),
        );
        // Mermaid emits the message's label immediately before its line (self messages are paths).
        let label = line.previousElementSibling;
        addLine(line, node);
        while (label?.matches(".messageText")) {
          add(label, node);
          label = label.previousElementSibling;
        }
      }
    }
  }

  private findNodes(svg: SVGSVGElement, idPrefix: string, db?: DiagramDb): void {
    const focusable = new Set<string>();
    const add = (element: Element, node: DiagramNode) => {
      element.classList.add("diagram-node");
      element.setAttribute("data-diagram-id", node.id);
      if (node.relationship) element.classList.add("diagram-relationship");
      this.nodes.set(element, node);
      // One focusable element per node, although some are drawn as several.
      if (!focusable.has(node.id)) {
        focusable.add(node.id);
        element.setAttribute("tabindex", "-1");
        element.setAttribute("role", "button");
        element.setAttribute("aria-label", node.label);
      }
    };
    /** Adds the elements that show the nodes in order, when there is one for each node. */
    const addInOrder = (elements: NodeListOf<Element>, nodes: DiagramNode[]) => {
      if (elements.length === nodes.length) {
        for (const [i, element] of elements.entries()) {
          add(element, nodes[i] as DiagramNode);
        }
      }
    };
    const withoutPrefix = (id: string) =>
      id.startsWith(idPrefix) ? id.slice(idPrefix.length) : id;
    /** Ids for nodes that go by their names, numbering repeated names: "a", "a (2)", … */
    const named = new Set<string>();
    // The next number to try for each name, so that many equal names take linear time.
    const next = new Map<string, number>();
    const uniqueId = (name: string) => {
      let id = name;
      let n = next.get(name) ?? 2;
      while (named.has(id)) {
        id = `${name} (${n++})`;
      }
      next.set(name, n);
      named.add(id);
      return id;
    };

    // Nodes and groups (subgraphs, composite states, kanban columns, architecture services, …).
    // Their element ids are the source ids, some decorated like "flowchart-A-0". Mermaid makes up
    // the ids of mind map nodes ("node_0"), notes ("note0", "state-A----note-2") and subgraphs
    // titled with spaces and no id ("subGraph0"), so those go by their names.
    const nodeIds = new Map<string, string>();
    for (const element of svg.querySelectorAll(
      "g.node, g.rough-node, g.cluster, g.statediagram-cluster, g.architecture-service",
    )) {
      const label = nameOf(element);
      if (!label) {
        continue; // Start and end states, forks and joins.
      }
      const domId = element.getAttribute("data-id") ?? withoutPrefix(element.id);
      const decorated = /^(?:flowchart|state|classId|entity)-(.+)-\d+$|^service-(.+)$/.exec(domId);
      const id = /^(?:node_\d+|note\d+|subGraph\d+|state-.+----note-\d+)?$/.test(domId)
        ? uniqueId(label)
        : (decorated?.[1] ?? decorated?.[2] ?? domId);
      nodeIds.set(domId, id);
      add(element, { id, label });
    }

    // Footer copies retain the participant's name, even when several share a display label.
    const participants = new Map<string, DiagramNode>();
    for (const element of svg.querySelectorAll('[data-et="participant"]')) {
      const label = textOf(element);
      const node = { id: element.getAttribute("data-id") || label, label };
      participants.set(node.id, node);
      add(element, node);
    }
    for (const element of svg.querySelectorAll(".actor-bottom")) {
      const group = element.tagName === "g" ? element : element.parentElement;
      const node = participants.get(element.getAttribute("name") ?? "");
      if (group && node) {
        add(group, node);
      }
    }
    // An actor's menu of links, when sequence.forceMenus shows it, is numbered like its lifeline.
    for (const menu of svg.querySelectorAll('g.actorPopupMenu:not([display="none"])')) {
      const line = svg.querySelector(`line[id="${CSS.escape(menu.id.replace(/_popup$/, ""))}"]`);
      const node = participants.get(line?.getAttribute("data-id") ?? "");
      if (node) {
        add(menu, node);
      }
    }

    this.findRelationships(svg, db, nodeIds, add);

    // Gantt tasks: a bar and a label with ids derived from the task id.
    for (const bar of svg.querySelectorAll("rect.task")) {
      const text = document.getElementById(`${bar.id}-text`);
      if (text) {
        const node = { id: withoutPrefix(bar.id), label: textOf(text) };
        add(bar, node);
        add(text, node);
      }
    }

    // User journey tasks: groups of the task box, its people, and a line down to its score. The
    // name is in a text per line, which may also have an HTML label (in a switch) to stand in for.
    for (const line of svg.querySelectorAll("line.task-line")) {
      const group = line.parentElement;
      const label = group && Array.from(group.querySelectorAll("text.task"), textOf).join(" ");
      if (group && label) {
        add(group, { id: uniqueId(label), label });
      }
    }

    // Pie slices and their percentages, for the sections of at least 1% (see createPieArcs in
    // Mermaid), and legend entries, for all sections.
    const sections = Array.from(db?.getSections?.() ?? [], ([label, value]) => ({
      node: { id: label, label },
      value,
    }));
    const sum = sections.reduce((total, { value }) => total + value, 0);
    const slices = sections.filter(({ value }) => (value / sum) * 100 >= 1).map(({ node }) => node);
    addInOrder(svg.querySelectorAll("path.pieCircle"), slices);
    addInOrder(svg.querySelectorAll("text.slice"), slices);
    addInOrder(
      svg.querySelectorAll("g.legend"),
      sections.map(({ node }) => node),
    );

    // Git graph commits: one or more bullets each, with the commit id among their classes, in the
    // order of the database's commits (reversed from bottom to top), and a label with the id
    // except for merges and cherry-picks (or with showCommitLabel off). Mermaid generates ids like
    // "1-7754f83" at random in each parse, so those commits go by their sequence number, and are
    // named by the drawn id. Their tags follow in the same order, each commit's last first, as a
    // box, a hole and a text. Tags need not be unique.
    const commits = db?.getCommitsArray?.() ?? [];
    if (db?.getDirection?.() === "BT") {
      commits.reverse();
    }
    const bullets = new Map<string, Element[]>();
    for (const bullet of svg.querySelectorAll(".commit-bullets > *")) {
      const classes = bullet.getAttribute("class")?.split(" ") ?? [];
      const id = classes.filter((name) => !/^commit(?:\d+|-[a-z-]+\d*)?$/.test(name)).join(" ");
      const elements = bullets.get(id) ?? [];
      elements.push(bullet);
      bullets.set(id, elements);
    }
    const tagLabels = Array.from(svg.querySelectorAll("text.tag-label"));
    const tagCount = commits.reduce((count, { tags }) => count + tags.length, 0);
    const commitLabels = new Map(
      Array.from(svg.querySelectorAll("text.commit-label"), (label) => [textOf(label), label]),
    );
    if (bullets.size === commits.length && tagLabels.length === tagCount) {
      let tagIndex = 0;
      for (const [i, [drawnId, elements]] of [...bullets].entries()) {
        const { id, message, seq, tags } = commits[i] as (typeof commits)[number];
        const generated = /^\d+-[0-9a-f]{7}$/.test(id);
        const commitLabel = commitLabels.get(drawnId)?.parentElement;
        const node = {
          id: generated ? String(seq) : id,
          label:
            tags.join(", ") ||
            (generated ? message || (commitLabel ? drawnId : `commit ${seq}`) : id),
        };
        for (const element of elements) {
          add(element, node);
        }
        if (commitLabel) {
          add(commitLabel, node);
        }
        const tagEnd = tagIndex + tags.length;
        for (; tagIndex < tagEnd; tagIndex++) {
          const tag = tagLabels[tagIndex] as Element;
          const hole = tag.previousElementSibling;
          const background = hole?.previousElementSibling;
          add(tag, node);
          if (hole?.matches(".tag-hole") && background?.matches(".tag-label-bkg")) {
            add(hole, node);
            add(background, node);
          }
        }
      }
    }
    // Git graph branches, by their labels.
    for (const label of svg.querySelectorAll("g.branchLabel")) {
      const name = textOf(label);
      const node = { id: name, label: name };
      const background = label.previousElementSibling;
      if (background?.matches("rect.branchLabelBkg")) {
        add(background, node);
      }
      add(label, node);
    }

    // XY chart bars, in the order of their plot's data, and lines (Mermaid draws no points), named
    // like chart items.
    const plots = db?.getXYChartData?.().plots ?? [];
    for (const [i, { type, title, data }] of plots.entries()) {
      const series = title || `Series ${i + 1}`;
      if (type === "line") {
        const line = { id: uniqueId(series), label: series };
        for (const path of svg.querySelectorAll(`g.line-plot-${i} > path`)) {
          add(path, line);
        }
        continue;
      }
      const prefix = plots.length > 1 ? `${series}/` : "";
      const bars = data.map(([x, y]) => ({
        id: uniqueId(prefix + x),
        // A category without a value gets an invisible bar.
        label: y === undefined ? x : `${x}: ${y}`,
      }));
      addInOrder(svg.querySelectorAll(`g.bar-plot-${i} > rect`), bars);
    }

    // Timeline periods and events, and quadrant chart points.
    for (const element of svg.querySelectorAll("g.timeline-node, g.data-point")) {
      const label = textOf(element);
      add(element, { id: uniqueId(label), label });
    }
  }

  /** The room for the diagram in the canvas, which is 0 × 0 while it is hidden. */
  private contentSize(): { width: number; height: number } {
    const style = getComputedStyle(this.canvas);
    const sum = (a: string, b: string) => Number.parseFloat(a) + Number.parseFloat(b);
    return {
      width: this.canvas.clientWidth - sum(style.paddingLeft, style.paddingRight),
      height: this.canvas.clientHeight - sum(style.paddingTop, style.paddingBottom),
    };
  }

  /** Scales large diagrams down to the panel width (and height, within reason). */
  private fit(): void {
    const zoom = this.fitZoom(this.diagram.querySelector("svg")?.viewBox.baseVal);
    // Undefined until the canvas is laid out (e.g. the panel is hidden); the resize observer fits later.
    if (zoom !== undefined) this.setZoom(zoom);
  }

  /** The zoom that fits a drawing of the given size into the room, if there is any. */
  private fitZoom(
    natural: DOMRect | undefined,
    { width, height } = this.contentSize(),
  ): number | undefined {
    if (!natural?.width || !natural.height) return 1;
    if (width <= 0 || height <= 0) return undefined;
    return Math.min(1, width / natural.width, Math.max(height / natural.height, MIN_HEIGHT_FIT));
  }

  /**
   * Scales the drawing by its size, rather than by CSS zoom, which would leave the client
   * coordinates of its elements unscaled.
   */
  private setZoom(value: number): void {
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
    const svg = this.diagram.querySelector("svg");
    const natural = svg?.viewBox.baseVal;
    if (svg && natural?.width && natural.height) {
      svg.setAttribute("width", String(natural.width * this.zoom));
      svg.setAttribute("height", String(natural.height * this.zoom));
    }
    this.zoomButton.textContent = `${Math.round(this.zoom * 100)}%`;
    this.zoomButton.title =
      this.fitting && this.zoom !== 1 ? "Show at actual size" : "Fit to the panel";
  }
}
