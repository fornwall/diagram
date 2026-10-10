// Renders Mermaid diagrams as SVG, scaled to fit the panel.

import type { Mermaid } from "mermaid";
import type { Annotation, DiagramMark, DiagramNode } from "../protocol";
import { joinWords } from "../text";
import { contrast, lighten, mix, type Rgba, type ThemeColors, toCss } from "./colors";
import type { DiagramImage } from "./images";
import { closeLinkMenu } from "./linkMenu";
import {
  describeError,
  emptyStateError,
  nestingError,
  parsableSource,
  scoreError,
  statementError,
  undefinedEndError,
} from "./mermaidErrors";
import { diagramHeader } from "./mermaidLayout";
import { type DiagramDb, findNodes, NOTHING_DRAWN, WITH_DATABASE } from "./mermaidNodes";
import { arrowDirection, nearestInDirection, type Point } from "./navigation";
import { shortestPath } from "./relationships";
import {
  type ItemClickHandler,
  type Renderer,
  UNMARKED,
  type WebLink,
  withModifier,
} from "./renderer";
import { inlineStyleSheets, SVG_NAMESPACE, standaloneSvg, XLINK_NAMESPACE } from "./svgImage";
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
export const RELAYOUT_DELAY = 200;

/** The diagrams whose edges lead the way they point: those drawn as flowcharts, and state diagrams. */
const PATH_DIAGRAMS = /^(?:flowchart|swimlane$|agentflow$|stateDiagram$)/;

/** Mermaid's default limit: it draws a longer source as an error message instead. */
const MAX_TEXT_SIZE = 50_000;

/** A formula in a label, which Mermaid draws with KaTeX as MathML. */
const FORMULA = /\$\$(.*?)\$\$/;
/** How Mermaid has KaTeX draw a formula. */
const MATHML = { displayMode: true, output: "mathml", throwOnError: false } as const;

/** The contrast that labels need with the color they are drawn on, as WCAG asks of small text. */
const LABEL_CONTRAST = 4.5;

/** A theme that front matter or an init directive chooses, unlike its themeVariables. */
const OWN_THEME = /(?:^|[\s{,])["']?theme["']?\s*:/m;

const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

/**
 * The colors of the sections of mind maps, timelines, kanban boards and pies, and of their labels:
 * VS Code's chart colors, mixed into the background as far as leaves the theme's text legible on
 * them. Mermaid's dark theme colors them almost black, and both of its themes draw some labels
 * illegibly, such as white on pastel or light grey on light colors. Kanban columns are drawn 10
 * points lighter, which their labels and headings must be legible on too.
 */
function sectionColors(
  { dark, palette, background, foreground }: ThemeColors,
  kanban: boolean,
): Record<string, string> {
  const legible = (color: Rgba) =>
    contrast(color, foreground) >= LABEL_CONTRAST &&
    contrast(lighten(color, 10), foreground) >= LABEL_CONTRAST;
  const scale = palette.slice(0, 12).map((hue) => {
    let amount = dark ? 0.45 : 0.5;
    while (amount > 0.15 && !legible(mix(background, hue, amount))) amount -= 0.05;
    return mix(background, hue, amount);
  });
  const label = toCss(foreground);
  const variables: Record<string, string> = { pieSectionTextColor: label };
  // Kanban column headings read in the text color, which in Mermaid's dark theme is a fixed light
  // grey that the high contrast themes' white outshines. Only for kanban boards, as the text of
  // other diagrams is drawn on Mermaid's colors rather than these.
  if (kanban) variables.textColor = label;
  scale.forEach((color, i) => {
    variables[`cScale${i}`] = toCss(color);
    variables[`cScaleLabel${i}`] = label;
    variables[`pie${i + 1}`] = toCss(color);
  });
  if (dark) {
    // Mermaid's dark theme derives the colors of branches, and of a mind map's root, which it draws
    // in the first, from its own colors and the pie colors, ignoring any given, as theme-dark.js
    // does: label them in what is legible on them.
    const branches = [
      lighten(lighten({ r: 0x1f, g: 0x20, b: 0x20, a: 1 }, 16), 20),
      ...scale.slice(1, 8).map((color, i) => lighten(color, i === 4 || i === 5 ? 10 : 20)),
    ];
    branches.forEach((color, i) => {
      const themed = [foreground, background].find(
        (text) => contrast(color, text) >= LABEL_CONTRAST,
      );
      variables[`gitBranchLabel${i}`] = toCss(
        themed ?? (contrast(color, BLACK) > contrast(color, WHITE) ? BLACK : WHITE),
      );
    });
  }
  return variables;
}

/** What a node's links in the source are called in its tooltip: "Open …". */
function describeLinks(targets: readonly WebLink[]): string {
  const [first] = targets;
  if (targets.length > 1 || !first) {
    return joinWords(
      targets.map((t) => t.name),
      "or",
    );
  }
  return first.name === first.url ? first.url : `${first.name} (${first.url})`;
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
 * Hides the date labels on a Gantt chart's axes that repeat the date before or would overlap it.
 * Unless the chart sets a tickInterval, Mermaid has d3 pick about ten ticks, such as one every 12
 * hours for a week, which show each date twice and crowd a narrow panel. Their grid lines stay.
 */
function thinAxisLabels(svg: SVGSVGElement): void {
  for (const axis of svg.querySelectorAll("g.grid")) {
    const labels = Array.from(axis.querySelectorAll(":scope > g.tick > text"), (text) => ({
      text,
      box: text.getBoundingClientRect(),
    }));
    let shown: (typeof labels)[number] | undefined;
    const hidden = labels.filter((label) => {
      const crowded =
        shown !== undefined &&
        (label.text.textContent === shown.text.textContent ||
          label.box.left < shown.box.right + label.box.height / 2);
      if (!crowded) shown = label;
      return crowded;
    });
    for (const { text } of hidden) text.setAttribute("visibility", "hidden");
  }
}

/**
 * Centers the SVG text labels of nodes that Mermaid leaves starting at the left of their room.
 * Its label helper draws a text label from x = 0, for the diagram's CSS to center it, which only
 * flowchart CSS does. It places the label for text centered there: mind map circles, squares and
 * hexagons, and use case ellipses, would show their labels from the middle to the right. It
 * places a state's label for text that fills the state's least width, wider than short names.
 * The shapes that place a label themselves move it from x = 0.
 */
function centerTextLabels(svg: SVGSVGElement): void {
  // Read the styles before changing any, which would have each read compute them again.
  const texts = Array.from(
    svg.querySelectorAll<SVGTextElement>(
      'g.node > g.label[transform^="translate(0,"] text, g.statediagram-state > g.label > g > text:not([transform])',
    ),
  ).filter((text) => getComputedStyle(text).textAnchor === "start");
  for (const text of texts) {
    text.style.textAnchor = "middle";
    const left = (text.closest("g.label") as SVGGElement).transform.baseVal.consolidate();
    if (left?.matrix.e) text.setAttribute("transform", `translate(${-left.matrix.e})`);
  }
}

/**
 * Draws the formulas that name sequence diagram participants in boxes. Mermaid draws them without
 * waiting for KaTeX, so the drawing it returns has their labels empty, or not even there. (It
 * draws participants of other shapes likewise, and there is no telling where their labels go.)
 */
async function drawParticipantFormulas(svg: SVGSVGElement, db: DiagramDb | undefined) {
  const actors = db?.getActors?.();
  const { default: katex } = await import("katex");
  // The top and the bottom box of each participant, named after it, in a group with its label.
  for (const box of svg.querySelectorAll("rect.actor[name]")) {
    const description = actors?.get(box.getAttribute("name") ?? "")?.description;
    const group = box.parentElement;
    const drawn = group?.querySelector(":scope > switch > foreignObject > div > div");
    if (!group || !description || !FORMULA.test(description) || drawn?.hasChildNodes()) continue;
    let label = drawn;
    if (!label) {
      const object = document.createElementNS(SVG_NAMESPACE, "foreignObject");
      for (const name of ["x", "y", "width", "height"]) {
        object.setAttribute(name, box.getAttribute(name) ?? "0");
      }
      label = document.createElement("div");
      label.setAttribute(
        "style",
        "display: flex; flex-direction: column; justify-content: center; height: 100%",
      );
      object.append(label);
      group.append(object);
    }
    // As Mermaid draws the formulas of messages and notes: one line per <br>, text as it is.
    for (const line of description.split(/<br\s*\/?>/i)) {
      const div = document.createElement("div");
      div.style.cssText =
        "display: flex; align-items: center; justify-content: center; white-space: nowrap";
      for (const [i, part] of line.split(FORMULA).entries()) {
        if (i % 2 === 0) div.append(part);
        else div.insertAdjacentHTML("beforeend", katex.renderToString(part, MATHML));
      }
      for (const source of div.querySelectorAll("annotation")) source.remove();
      label.append(div);
    }
  }
}

/**
 * Places a drawing that Mermaid made in the layout container, where it can be measured while the
 * canvas is hidden, and completes it there. The caller takes it out of the container again.
 */
async function layOut(
  markup: string,
  diagramType: string,
  text: string,
  db: () => Promise<DiagramDb | undefined>,
): Promise<SVGSVGElement> {
  // Read as HTML: an XML parser rejects the <br> or &nbsp; of an HTML label, or a control
  // character in any label.
  const drawing = document.createElement("div");
  drawing.innerHTML = markup;
  const svg = drawing.firstElementChild;
  if (!(svg instanceof SVGSVGElement)) {
    throw new Error("Mermaid did not produce an SVG.");
  }
  layoutContainer().append(svg);
  try {
    centerTextLabels(svg);
    if (diagramType === "sequence" && FORMULA.test(text)) {
      await drawParticipantFormulas(svg, await db());
    }
    if (diagramType === "gantt") thinAxisLabels(svg);
    showAllText(svg);
  } catch (error) {
    svg.remove();
    throw error;
  }
  return svg;
}

/**
 * The database of a diagram, which mermaid.render keeps to itself: parsed separately for it. Should
 * that fail, the parts that only the database tells about are left out.
 */
async function databaseOf(mermaid: Mermaid, text: string): Promise<DiagramDb | undefined> {
  try {
    // It throws some errors, such as those in front matter, rather than rejecting.
    return (await mermaid.mermaidAPI.getDiagramFromText(text)).db as DiagramDb;
  } catch {
    return undefined;
  }
}

/** The middle of an element, in client coordinates. */
function center(element: Element): Point {
  const box = element.getBoundingClientRect();
  return [box.left + box.width / 2, box.top + box.height / 2];
}

/** What a drawing shows of the state of its nodes, by node id. */
interface Shown {
  selected: ReadonlyMap<string, boolean>;
  marks: ReadonlyMap<string, DiagramMark["kind"]>;
  /** What the tooltip of a linked node says it opens. */
  links: ReadonlyMap<string, string>;
}
const nothingShown = (): Shown => ({ selected: new Map(), marks: new Map(), links: new Map() });

export class MermaidRenderer implements Renderer {
  readonly noun = "diagram";
  readonly itemNoun = "node";
  readonly sourceName = "Mermaid source";

  private renderCounter = 0;
  supportsPaths = false;
  private drawn = NOTHING_DRAWN;
  private shown = nothingShown();
  /** The selection, code links and marks, which a new drawing of the diagram shows again. */
  private selectedKeys: ReadonlySet<string> = new Set();
  private links: ReadonlyMap<string, string> = new Map();
  private annotation: Annotation = UNMARKED;
  private zoom = 1;
  /** Whether the zoom follows the panel size, until the user zooms by hand. */
  private fitting = true;
  /** Whether the next drawing is of another diagram, which starts scrolled to its top left. */
  private scrollToStart = false;
  private displayedSource: string | undefined;
  /**
   * What the shown drawing was drawn from: its source, the width it was laid out at and Mermaid's
   * configuration. Until redraw, a render of the same draws nothing new.
   */
  private drawnFrom: string | undefined;
  /** The last image, and what it was drawn from, which an image of the same takes again. */
  private image: { from: string; image: DiagramImage } | undefined;
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
    /** Whether the tab is hidden behind another, at the size of an empty frame. */
    private readonly tabHidden: () => boolean,
  ) {
    const activate = (event: MouseEvent | KeyboardEvent) => {
      // The first click of a double click acted already: a second would undo its selection, or
      // open the node's link once more.
      if (event instanceof MouseEvent && event.detail > 1) return;
      const target = event.target instanceof Element ? event.target : undefined;
      const element = target?.closest(".diagram-node");
      const node = element && this.drawn.byElement.get(element);
      if (!element || !node) {
        itemClicked(undefined, withModifier(event));
        return;
      }
      // A link in a label or a shown actor menu leads where it says; anywhere else, and for a key,
      // the node's links do.
      const href = target?.closest("a[data-href]")?.getAttribute("data-href");
      const targets = href ? [{ name: href, url: href }] : this.drawn.links.get(node.id);
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
      if (!(target instanceof SVGElement && this.drawn.byElement.has(target))) return;
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
    // The canvas, which a pick or Highlight Path focuses, passes the keys that move between nodes
    // on to them, as a chart does to its items: an arrow key leads to the drawing's tab stop, or
    // the node nearest the middle if that is out of sight, and Home and End to the first and the
    // last. They scroll the canvas only for a drawing without nodes.
    canvas.addEventListener("keydown", (event) => {
      const { key } = event;
      const moves = key === "Home" || key === "End" || arrowDirection(key) !== undefined;
      const modified = event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
      if (event.target !== canvas || !moves || modified || this.displayedSource === undefined) {
        return;
      }
      const next = key === "Home" || key === "End" ? this.endNode(key) : this.stopInSight();
      if (!next) return;
      event.preventDefault();
      next.focus();
    });
    // Ctrl/Cmd+scroll zooms at the pointer, in proportion to the scrolling, and a trackpad pinch,
    // which Chromium reports as Ctrl+scrolling, as much as the fingers spread. Both send many
    // small deltas: apply them once per frame.
    let wheel: { factor: number; x: number; y: number } | undefined;
    canvas.addEventListener(
      "wheel",
      (event) => {
        if (!(event.ctrlKey || event.metaKey) || this.displayedSource === undefined) return;
        event.preventDefault();
        // Scrolling sideways does not zoom, nor stop the drawing fitting the panel.
        if (!event.deltaY) return;
        // Chromium reports each step of a pinch as Ctrl and a whole wheel tick (a wheelDeltaY of
        // ±120) of deltaY -100·ln(scale) pixels, where scrolling reports at least a pixel for
        // every 3 of wheelDeltaY (see CreateSyntheticWheelFromTouchpadPinchEvent). Scrolling by
        // lines or pages, as Windows can be set to, reports a notch as ±1 or so.
        const { wheelDeltaY = 0 } = event as WheelEvent & { wheelDeltaY?: number };
        const inPixels = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL;
        const pinch =
          inPixels &&
          event.ctrlKey &&
          !event.metaKey &&
          Math.abs(event.deltaY) < Math.abs(wheelDeltaY) / 4;
        const pixels = inPixels
          ? Math.max(-100, Math.min(100, event.deltaY))
          : Math.sign(event.deltaY) * 100;
        const factor = pinch ? Math.exp(-event.deltaY / 100) : WHEEL_ZOOM ** (-pixels / 100);
        const pending = wheel !== undefined;
        wheel = { factor: (wheel?.factor ?? 1) * factor, x: event.clientX, y: event.clientY };
        if (pending) return;
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

  /** How Mermaid is configured for the current VS Code theme, to draw the source. */
  private config(source: string | undefined): Parameters<Mermaid["initialize"]>[0] {
    const colors = readThemeColors();
    const { settings, typeLine } = diagramHeader(source ?? "");
    return {
      startOnLoad: false,
      securityLevel: "strict",
      maxTextSize: MAX_TEXT_SIZE,
      // Throw errors instead of rendering them as a diagram, and clean up after failing.
      suppressErrorRendering: true,
      theme: colors.dark ? "dark" : "default",
      // A diagram that chooses a theme of its own takes it whole: Mermaid would color it with
      // these too, and the text of its nodes in the color meant for VS Code's theme.
      themeVariables: OWN_THEME.test(settings)
        ? {}
        : sectionColors(colors, /^kanban\b/.test(typeLine ?? "")),
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
    const config = this.config(source);
    mermaid.initialize(config);
    const id = `diagram-svg-${++this.renderCounter}`;
    const container = layoutContainer();
    // Gantt charts take the width of the element they are drawn in: give them the width they are
    // shown at, rather than shrinking their text to fit. In the Source view the canvas has no
    // width: keep the last one, or before any, take the one it has in the Visual view. A hidden
    // tab has none to take: the chart is laid out again once the tab is shown.
    let { width } = this.contentSize();
    if (width <= 0 && !container.style.width && !this.tabHidden() && this.canvas.parentElement) {
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
    // A drawing that fails leaves the one shown, and the width it was laid out at.
    const shownWidth = container.style.width;
    const drawWidth = width > 0 ? `${width}px` : shownWidth;
    // The extension sends the diagram shown again, such as with other links, or once the page
    // answers a render that it gave up waiting for: keep the drawing, which takes seconds for a
    // large diagram to make again.
    const drawnFrom = JSON.stringify([source, drawWidth, config]);
    if (drawnFrom === this.drawnFrom && this.displayedSource !== undefined && this.diagramType) {
      this.setZoom(this.zoom);
      if (this.fitting) this.fit();
      this.scrollStart();
      return this.diagramType;
    }
    container.style.width = drawWidth;
    const text = parsableSource(source);
    const drawing = async () => {
      const parsed = await databaseOf(mermaid, text);
      // Mermaid would lay out the first forever, and draw the second out of place.
      const invalid = nestingError(parsed, source) ?? scoreError(parsed, source);
      if (invalid) throw invalid;
      const result = await mermaid.render(id, text, container).catch(async (error: unknown) => {
        throw (
          undefinedEndError(parsed, source) ??
          emptyStateError(error, parsed, source) ??
          (await statementError(error, source, (part) => mermaid.parse(part))) ??
          describeError(error, source, () => mermaid.detectType(text))
        );
      });
      const db = WITH_DATABASE.has(result.diagramType) ? parsed : undefined;
      return {
        result,
        db,
        svg: await layOut(result.svg, result.diagramType, text, async () => db),
      };
    };
    const { result, db, svg } = await drawing().catch((error: unknown) => {
      container.style.width = shownWidth;
      throw error;
    });
    if (width > 0) this.layoutWidth = width;
    this.drawnFrom = drawnFrom;
    this.diagram.replaceChildren(svg);
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
    // the panel itself to the URL. findNodes links its tasks instead.
    if (result.diagramType !== "gantt") result.bindFunctions?.(this.diagram);
    this.diagram.hidden = false;
    this.displayedSource = source;
    this.diagramType = result.diagramType;
    this.supportsPaths = PATH_DIAGRAMS.test(result.diagramType);
    this.prepareSvg(svg, id, db);
    // Until fitting can measure the panel, e.g. while it is hidden, keep the zoom.
    this.setZoom(this.zoom);
    if (this.fitting) {
      this.fit();
    }
    this.scrollStart();
    return result.diagramType;
  }

  /** Scrolls a drawing of another diagram than the one shown before to its top left. */
  private scrollStart(): void {
    if (!this.scrollToStart) return;
    this.scrollToStart = false;
    this.canvas.scrollTo(0, 0);
  }

  /**
   * The diagram as an image, rendered a second time with its labels as SVG text.
   *
   * Mermaid draws a label as HTML in a `foreignObject` unless told otherwise. Most applications
   * that read SVG leave that out, so the labels would go missing where the image is dropped. The
   * copy on screen keeps its HTML labels, which wrap better, and is left untouched: this render
   * goes to a string, not into the panel.
   *
   * Formulas are MathML, which only HTML labels hold: a diagram with any is drawn as in the panel.
   * (Class and sequence diagrams draw formulas as HTML either way, but other diagrams would show
   * their TeX.) standaloneSvg turns its other labels into SVG text, as it does those that some
   * diagrams draw as HTML whatever Mermaid is told.
   */
  async toImage(background: string): Promise<DiagramImage> {
    const source = this.displayedSource;
    if (source === undefined) {
      throw new Error("There is no diagram to make an image of.");
    }
    const config = this.config(source);
    // Exporting, viewing and dragging the same diagram each drew it again, for seconds if large.
    // The image takes the color of the text around the drawing for labels that leave it to CSS.
    const color = getComputedStyle(document.body).color;
    const width = layoutContainer().style.width;
    const from = JSON.stringify([source, background, color, width, config]);
    if (this.image?.from === from) return this.image.image;
    const mermaid = await loadMermaid();
    const text = parsableSource(source);
    mermaid.initialize(
      FORMULA.test(text)
        ? config
        : {
            ...config,
            htmlLabels: false,
            // Swimlane titles still follow this deprecated setting alone.
            flowchart: { htmlLabels: false },
            // SVG text would show the tags of HTML in labels, such as <b> and <a>: keep only their
            // text and the line breaks that Mermaid splits SVG text at.
            dompurifyConfig: { ALLOWED_TAGS: ["br"] },
            // Front matter and init directives must not put HTML labels back into an image.
            secure: [...(mermaid.mermaidAPI.defaultConfig.secure ?? []), "htmlLabels"],
          },
    );
    try {
      const { svg, diagramType } = await mermaid.render(
        // Mermaid scopes the styles and arrowheads of the drawing by this id. Unlike a count, a
        // random one does not repeat in an image from another session, which a document or design
        // that holds both would otherwise draw with the styles and arrowheads of the first.
        `diagram-image-${crypto.randomUUID().slice(0, 8)}`,
        text,
        layoutContainer(),
      );
      const drawing = await layOut(svg, diagramType, text, () => databaseOf(mermaid, text));
      try {
        inlineStyleSheets(drawing);
        const image = standaloneSvg(drawing, background);
        this.image = { from, image };
        return image;
      } finally {
        drawing.remove();
      }
    } finally {
      // Leave Mermaid configured for the panel: a theme change or a resize may render before the
      // next diagram arrives, and would otherwise draw the labels as plain text.
      mermaid.initialize(this.config(source));
    }
  }

  hide(): void {
    this.diagram.hidden = true;
    this.diagram.innerHTML = "";
    this.drawn = NOTHING_DRAWN;
    this.shown = nothingShown();
    this.displayedSource = undefined;
    this.drawnFrom = undefined;
    this.image = undefined;
  }

  showSelection(keys: ReadonlySet<string>): void {
    this.selectedKeys = keys;
    const selected = new Map(Array.from(keys, (key) => [key, true] as const));
    this.shown.selected = this.update(this.shown.selected, selected, (element, on = false) => {
      element.classList.toggle("diagram-selected", on);
      element.setAttribute("aria-pressed", String(on));
    });
  }

  showMarks(annotation: Annotation): void {
    this.annotation = annotation;
    const kinds = new Map(annotation.marks.map((mark) => [mark.id, mark.kind]));
    this.shown.marks = this.update(this.shown.marks, kinds, (element, after, before) => {
      if (before !== undefined) element.classList.remove(`diagram-mark-${before}`);
      if (after !== undefined) element.classList.add(`diagram-mark-${after}`);
      element.classList.toggle("diagram-marked", after !== undefined);
    });
    // Nothing is faded while nothing is marked, however the annotation asks for it.
    this.diagram.classList.toggle("dim-unmarked", annotation.dim && kinds.size > 0);
  }

  showLinks(locations: ReadonlyMap<string, string>): void {
    this.links = locations;
    // A node's code link takes precedence over its links in the source, as on a click.
    const opens = new Map([
      ...Array.from(this.drawn.links, ([id, targets]) => [id, describeLinks(targets)] as const),
      ...locations,
    ]);
    this.shown.links = this.update(this.shown.links, opens, (element, location) => {
      if (this.drawn.byElement.get(element)?.relationship) return;
      element.classList.toggle("diagram-linked", location !== undefined);
      // SVG shows the first title child. Replace only our tooltip, keeping Mermaid's own.
      element.querySelector(":scope > title.diagram-link")?.remove();
      if (location !== undefined) {
        const title = document.createElementNS(SVG_NAMESPACE, "title");
        title.classList.add("diagram-link");
        title.textContent = `Open ${location}`;
        element.prepend(title);
      }
    });
  }

  /**
   * Shows the next state of the nodes on the elements of those whose state changed, and returns
   * it: a click changes just its old and new selection, and a note just the text above the
   * drawing, however large the drawing is.
   */
  private update<T>(
    shown: ReadonlyMap<string, T>,
    next: ReadonlyMap<string, T>,
    show: (element: Element, after: T | undefined, before: T | undefined) => void,
  ): ReadonlyMap<string, T> {
    for (const id of new Set([...shown.keys(), ...next.keys()])) {
      const before = shown.get(id);
      const after = next.get(id);
      if (before === after) continue;
      for (const element of this.drawn.elements.get(id) ?? []) show(element, after, before);
    }
    return next;
  }

  findPath(from: string, to: string): DiagramNode[] | undefined {
    return this.supportsPaths ? shortestPath(this.drawn.nodes, from, to) : undefined;
  }

  drawnNodes(): DiagramNode[] {
    return this.drawn.nodes;
  }

  labelOf(id: string): string | undefined {
    const [element] = this.drawn.elements.get(id) ?? [];
    return element && this.drawn.byElement.get(element)?.label;
  }

  get hasWebLinks(): boolean {
    return this.drawn.links.size > 0;
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
    const focused = this.diagram.contains(document.activeElement);
    // Whatever changed, such as the theme, draw it anew rather than keep the drawing.
    this.drawnFrom = undefined;
    try {
      await this.render(source);
    } catch {
      return false;
    }
    // Replacing the SVG removes its focused node, which was the tab stop, as the new one is. Keep
    // keyboard navigation there, unless the user moved the focus elsewhere meanwhile.
    if (focused && document.hasFocus() && document.activeElement === document.body) {
      this.diagram.querySelector<SVGElement>('[tabindex="0"]')?.focus({ preventScroll: true });
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

  /** Zooms, keeping the point at the given client coordinates (the middle by default) in place. */
  zoomBy(factor: number, x?: number, y?: number): void {
    this.fitting = false;
    this.zoomAt(this.zoom * factor, x, y);
  }

  /** Sets the zoom, keeping the point at the given client coordinates (the middle by default). */
  private zoomAt(value: number, x?: number, y?: number): void {
    const svg = this.diagram.querySelector("svg");
    const before = svg?.getBoundingClientRect();
    this.setZoom(value);
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

  /**
   * Fits the diagram, or lays a Gantt chart out, for the tab shown again, which the resize observer
   * may not report: it reports no size it reported before the tab was hidden.
   */
  tabShown(): void {
    if (this.displayedSource === undefined) return;
    if (this.fitting) this.fit();
    if (this.diagramType === "gantt") this.enqueue(() => this.relayout());
  }

  fitToPanel(): void {
    this.fitting = true;
    this.scrollToStart = true;
  }

  /**
   * Toggles between fitting the panel and the actual size, keeping the middle of what is shown in
   * place, as the zoom buttons do: else the actual size would show the top left of the drawing.
   */
  zoomReset(): void {
    if (this.fitting && this.zoom !== 1) {
      this.fitting = false;
      this.zoomAt(1);
    } else {
      this.fitting = true;
      const zoom = this.fitZoom(this.diagram.querySelector("svg")?.viewBox.baseVal);
      if (zoom !== undefined) this.zoomAt(zoom);
    }
  }

  /**
   * The node to move the focus to from the given one for a key: the nearest in the direction of an
   * arrow key (null if there is none), or the first or last node, in the order of the source, for
   * Home and End. Undefined if the key does not move the focus.
   */
  private neighbor(from: SVGElement, key: string): SVGElement | null | undefined {
    if (key === "Home" || key === "End") return this.endNode(key);
    const direction = arrowDirection(key);
    if (!direction) return undefined;
    const stops = this.diagram.querySelectorAll<SVGElement>(".diagram-node[tabindex]");
    return nearestInDirection(from, direction, stops, center) ?? null;
  }

  /** The first or the last node, in the order of the source. */
  private endNode(key: "Home" | "End"): SVGElement | null {
    const nodes = this.drawn.nodes.filter((node) => !node.relationship);
    const node = key === "Home" ? nodes[0] : nodes.at(-1);
    return (
      this.drawn.elements
        .get(node?.id ?? "")
        ?.find((element): element is SVGElement => element.matches("[tabindex]")) ?? null
    );
  }

  /**
   * The drawing's tab stop if it is in sight in the canvas, else the node or relationship nearest
   * the middle of what the canvas shows, rather than one that the focus would scroll far to.
   */
  private stopInSight(): SVGElement | null {
    const view = this.canvas.getBoundingClientRect();
    const left = view.left + this.canvas.clientLeft;
    const top = view.top + this.canvas.clientTop;
    const right = left + this.canvas.clientWidth;
    const bottom = top + this.canvas.clientHeight;
    const tabStop = this.diagram.querySelector<SVGElement>('.diagram-node[tabindex="0"]');
    const box = tabStop?.getBoundingClientRect();
    if (box && box.right > left && box.left < right && box.bottom > top && box.top < bottom) {
      return tabStop;
    }
    const [x, y] = [(left + right) / 2, (top + bottom) / 2];
    let nearest: SVGElement | null = null;
    let distance = Number.POSITIVE_INFINITY;
    for (const stop of this.diagram.querySelectorAll<SVGElement>(".diagram-node[tabindex]")) {
      const [cx, cy] = center(stop);
      const d = Math.hypot(cx - x, cy - y);
      if (d < distance) [nearest, distance] = [stop, d];
    }
    return nearest;
  }

  /** Makes the element the drawing's tab stop. */
  private setTabStop(element: SVGElement): void {
    const node = this.drawn.byElement.get(element);
    if (!node || element.getAttribute("tabindex") === "0") return;
    this.diagram.querySelector('.diagram-node[tabindex="0"]')?.setAttribute("tabindex", "-1");
    element.setAttribute("tabindex", "0");
    this.tabStop = node.id;
  }

  /** Finds the nodes of a new drawing, and shows their selection, links and marks on it. */
  private prepareSvg(svg: SVGSVGElement, svgId: string, db: DiagramDb | undefined): void {
    this.shown = nothingShown();
    this.drawn = NOTHING_DRAWN;
    try {
      this.drawn = findNodes(svg, `${svgId}-`, db);
    } catch (error) {
      // A drawing unlike what findNodes expects is still worth showing, if without its nodes.
      console.error(error);
    }
    // Keep the tab stop on the same node in a new version of the drawing. Else it starts on the
    // first node, rather than on what comes first in the drawing, such as an edge of a flowchart.
    const stops = svg.querySelectorAll<SVGElement>(".diagram-node[tabindex]");
    const stop =
      Array.from(stops).find((element) => this.drawn.byElement.get(element)?.id === this.tabStop) ??
      this.endNode("Home") ??
      stops[0];
    stop?.setAttribute("tabindex", "0");
    this.showSelection(this.selectedKeys);
    this.showLinks(this.links);
    this.showMarks(this.annotation);
    // Mermaid sizes the drawing to fit its container; setZoom sizes it instead.
    svg.style.maxWidth = "none";
  }

  /**
   * The room for the diagram in the canvas, which is 0 × 0 while it is hidden, as by the Source
   * view, or while the tab is, when the page has the size of an empty frame instead.
   */
  private contentSize(): { width: number; height: number } {
    if (this.tabHidden()) return { width: 0, height: 0 };
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
   * coordinates of its elements unscaled. Closes a node's menu of links, which would stay behind
   * where the node was.
   */
  private setZoom(value: number): void {
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
    if (zoom !== this.zoom) closeLinkMenu();
    this.zoom = zoom;
    const svg = this.diagram.querySelector("svg");
    const natural = svg?.viewBox.baseVal;
    if (svg && natural?.width && natural.height) {
      svg.setAttribute("width", String(natural.width * this.zoom));
      svg.setAttribute("height", String(natural.height * this.zoom));
    }
    const shown = `${Math.round(this.zoom * 100)}%`;
    const action = this.fitting && this.zoom !== 1 ? "Show at actual size" : "Fit to the panel";
    this.zoomButton.textContent = shown;
    this.zoomButton.title = `${action} (Ctrl/Cmd+0)`;
    // The name says what the button does, after the zoom it shows.
    this.zoomButton.setAttribute("aria-label", `${shown}: ${action}`);
  }
}
