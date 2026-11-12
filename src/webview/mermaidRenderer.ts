// Adds selection.transition() for Mermaid's tooltips; d3's sideEffects flag would drop it.
import { interrupt } from "d3-transition";
import type { Mermaid } from "mermaid";
import type { Annotation, DiagramMark, DiagramNode } from "../protocol";
import { joinWords } from "../text";
import {
  contrast,
  LABEL_CONTRAST,
  labelColorOn,
  mix,
  type Rgba,
  type ThemeColors,
  toCss,
} from "./colors";
import type { DiagramImage, ModelImage } from "./images";
import { closeLinkMenu } from "./linkMenu";
import {
  describeError,
  duplicateEdgeError,
  emptyStateError,
  nestingError,
  numberError,
  parsableSource,
  statementError,
  themeColorError,
  undefinedEndError,
} from "./mermaidErrors";
import { diagramHeader } from "./mermaidLayout";
import { type DiagramDb, findNodes, NOTHING_DRAWN, WITH_DATABASE } from "./mermaidNodes";
import {
  colorLabelsOnBlocks,
  drawnAtWidth,
  elementConfig,
  mermaidTheme,
  setsOwnWidth,
  sizeConfig,
  themeFixedColors,
  withOwnThemeVariables,
} from "./mermaidTheme";
import { arrowDirection, nearestInDirection, type Point } from "./navigation";
import {
  type ItemClickHandler,
  type Renderer,
  UNMARKED,
  type WebLink,
  warningsMayChange,
  withModifier,
} from "./renderer";
import {
  type Area,
  areaAround,
  boxOf,
  drawingArea,
  hrefOf,
  inlineStyleSheets,
  SVG_NAMESPACE,
  standaloneSvg,
  textSize,
  XLINK_NAMESPACE,
} from "./svgImage";
import { parseColor, readThemeColors } from "./vscodeTheme";

let loading: Promise<Mermaid> | undefined;
let renderCounter = 0;
// Reset, or a diagram with an unreadable theme color would fail every later one.
async function loadMermaid(): Promise<Mermaid> {
  loading ??= import("mermaid").then((module) => module.default);
  const mermaid = await loading;
  mermaid.mermaidAPI.reset();
  return mermaid;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const WHEEL_ZOOM = 1.2;
// Width change and delay before relaying out a chart drawn at the panel width: not for a
// scrollbar, nor each step of a drag.
const RELAYOUT_THRESHOLD = 16;
export const RELAYOUT_DELAY = 200;

// Mermaid's default limit.
const MAX_TEXT_SIZE = 50_000;

const FORMULA = /\$\$(.*?)\$\$/;
// As Mermaid has KaTeX draw formulas.
const MATHML = { displayMode: true, output: "mathml", throwOnError: false } as const;

// A theme chosen by front matter or an init directive.
const OWN_THEME = /(?:^|[\s{,])["']?theme["']?\s*:\s*["']?([\w-]*)/m;

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

// Where Mermaid lays out drawings; by default the body, which would reflow the panel.
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

// Mermaid leaves some text outside the view box, such as long radar and quadrant labels.
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

// Hides Gantt axis labels that repeat or overlap the previous one, as d3's default ticks do.
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

// Mermaid draws SVG text labels from x = 0 for CSS to center, which only flowcharts do.
function centerTextLabels(svg: SVGSVGElement): void {
  // Read all styles before writing any, to avoid recomputing them.
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

// Hand-drawn `g.rough-node` is left out: its hatched fills leave labels on the background.
const FILLABLE = "g.node, g.cluster";
const GROUP = "g.cluster, g.statediagram-cluster";
const SHAPE = "rect, path, polygon, circle, ellipse";
const LABEL = "foreignObject, text";
// A label and what Mermaid draws behind its text alone.
const IN_LABEL = "g.label, .cluster-label, foreignObject, text";
// Class diagram notes, which Mermaid fills inline.
const NOTE = /-note\d+$/;
const FILL_STYLE = /(?:^|;)\s*fill\s*:/;

interface FillShape {
  shape: SVGGeometryElement;
  box: DOMRect;
  fill: string;
  // Including the opacity of its groups within the node.
  opacity: number;
  toShape: DOMMatrix | undefined;
}

// Mermaid writes an ER entity's own fill inline only on every other row.
function filledEntities(svg: SVGSVGElement, db: DiagramDb | undefined): Element[] {
  return (db?.getData?.().nodes ?? [])
    .filter((node) =>
      [...(node.cssStyles ?? []), ...(node.cssCompiledStyles ?? [])].some((style) =>
        FILL_STYLE.test(style),
      ),
    )
    .flatMap((node) => svg.querySelector(`#${CSS.escape(`${svg.id}-${node.id}`)}`) ?? []);
}

// Keeps labels legible on fills set by the source, which are inline, unlike the theme's. Each label
// goes by the fill under its middle. The drawing must be in the document.
function colorLabelsOnFills(
  svg: SVGSVGElement,
  colors: ThemeColors,
  filled: Iterable<Element> = [],
): void {
  const owners = new Set<Element>(filled);
  const colored = new Set<Element>();
  for (const element of svg.querySelectorAll<SVGElement | HTMLElement>("[style]")) {
    const owner = element.closest(FILLABLE);
    if (!owner || NOTE.test(owner.id)) continue;
    const { color, fill } = element.style;
    const text = element.matches("text, tspan");
    if (color || (text && fill)) colored.add(owner);
    // Class diagrams also fill HTML label spans, to no effect.
    else if (fill && !text && !element.closest("foreignObject")) owners.add(owner);
  }
  if (owners.size === 0) return;
  // Not those of nested nodes.
  const own = (owner: Element, selector: string) =>
    Array.from(owner.querySelectorAll(selector)).filter((e) => e.closest(FILLABLE) === owner);
  // Read all fills before writing any color, to avoid recomputing styles.
  const opacityOf = (element: Element) => Number(getComputedStyle(element).opacity);
  const drawn = Array.from(owners, (owner) => {
    const shapes = own(owner, SHAPE)
      .filter((shape) => !shape.closest(IN_LABEL))
      .map((shape): FillShape => {
        const style = getComputedStyle(shape);
        let opacity = Number(style.fillOpacity) * Number(style.opacity);
        for (
          let group = shape.parentElement;
          group && group !== owner;
          group = group.parentElement
        ) {
          opacity *= opacityOf(group);
        }
        return {
          shape: shape as SVGGeometryElement,
          box: shape.getBoundingClientRect(),
          fill: style.fill,
          opacity,
          toShape: (shape as SVGGeometryElement).getScreenCTM()?.inverse(),
        };
      });
    return {
      owner,
      shapes,
      area: Math.max(0, ...shapes.map(({ box }) => box.width * box.height)),
      labels: colored.has(owner)
        ? []
        : own(owner, LABEL).map((label) => ({ label, box: label.getBoundingClientRect() })),
    };
  });
  const link = svg.querySelector(`:is(${FILLABLE}) foreignObject a`)
    ? parseColor(getComputedStyle(document.body).getPropertyValue("--vscode-textLink-foreground"))
    : undefined;

  const parsed = new Map<string, Rgba | undefined>();
  // The topmost shape filling the point, blended over `below`.
  const paintAt = (shapes: FillShape[], x: number, y: number, below: Rgba) => {
    for (const { shape, box, fill, opacity, toShape } of shapes.toReversed()) {
      if (x < box.left || x > box.right || y < box.top || y > box.bottom || !toShape) continue;
      if (!shape.isPointInFill(new DOMPoint(x, y).matrixTransform(toShape))) continue;
      if (!parsed.has(fill)) parsed.set(fill, parseColor(fill));
      const paint = parsed.get(fill);
      const alpha = (paint?.a ?? 0) * (Number.isFinite(opacity) ? opacity : 1);
      if (paint && alpha > 0) return mix(below, paint, alpha);
    }
    return undefined;
  };
  // Outermost first, to layer their fills.
  const groups = drawn
    .filter(({ owner }) => owner.matches("g.cluster"))
    .sort((a, b) => b.area - a.area);
  const labeled: { label: Element; color: string; links: boolean }[] = [];
  for (const { owner, shapes, area, labels } of drawn) {
    const inside = owner.matches("g.cluster") ? area : 0;
    for (const { label, box } of labels) {
      const [x, y] = [box.left + box.width / 2, box.top + box.height / 2];
      let backdrop = colors.background;
      for (const group of groups) {
        if (group.owner === owner || group.area <= inside) continue;
        backdrop = paintAt(group.shapes, x, y, backdrop) ?? backdrop;
      }
      const under = paintAt(shapes, x, y, backdrop);
      if (!under) continue;
      labeled.push({
        label,
        color: toCss(labelColorOn(under, colors)),
        links: link !== undefined && contrast(under, mix(under, link, link.a)) >= LABEL_CONTRAST,
      });
    }
  }
  // Mermaid's theme colors labels without `!important`, so inline colors win.
  for (const { label, color, links } of labeled) {
    if (label instanceof SVGTextElement) {
      for (const text of [label, ...label.querySelectorAll("tspan")]) text.style.fill = color;
    } else {
      for (const html of label.querySelectorAll<HTMLElement>("*")) {
        if (!(links && html.closest("a"))) html.style.color = color;
      }
    }
  }
}

// Mermaid doesn't wait for KaTeX on participant boxes, leaving their labels empty or missing.
async function drawParticipantFormulas(svg: SVGSVGElement, db: DiagramDb | undefined) {
  const actors = db?.getActors?.();
  const { default: katex } = await import("katex");
  // Each participant's top and bottom box.
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
    // As Mermaid draws message formulas: one line per <br>.
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

// MathML structure without annotations, which drawings leave out.
function mathKey(element: Element): string {
  if (element.localName.startsWith("annotation")) return "";
  const inside = Array.from(element.childNodes, (child) =>
    child instanceof Element ? mathKey(child) : (child.nodeValue ?? "").trim(),
  ).join("");
  return element.localName === "semantics" ? inside : `<${element.localName}>${inside}</>`;
}

// Tags drawn formulas with their TeX, which items go by: the MathML text of x^2 is "x 2".
async function markFormulas(svg: SVGSVGElement, text: string): Promise<void> {
  const { default: katex } = await import("katex");
  const drawn = document.createElement("template");
  const sources = new Map<string, string>();
  for (const [, formula = ""] of text.matchAll(new RegExp(FORMULA, "g"))) {
    drawn.innerHTML = katex.renderToString(formula, MATHML);
    const math = drawn.content.querySelector("math");
    if (math && !sources.has(mathKey(math))) sources.set(mathKey(math), formula);
  }
  for (const math of svg.querySelectorAll("math")) {
    const formula = sources.get(mathKey(math));
    if (formula !== undefined) math.setAttribute("data-tex", formula);
  }
}

// Completes a drawing in the layout container, where it can be measured while the canvas is
// hidden. The caller takes it out again.
async function layOut(
  markup: string,
  diagramType: string,
  text: string,
  colors: ThemeColors,
  db: () => Promise<DiagramDb | undefined>,
): Promise<SVGSVGElement> {
  // An XML parser rejects <br>, &nbsp; or control characters in labels.
  const drawing = document.createElement("div");
  drawing.innerHTML = markup;
  const svg = drawing.firstElementChild;
  if (!(svg instanceof SVGSVGElement)) {
    throw new Error("Mermaid did not produce an SVG.");
  }
  layoutContainer().append(svg);
  try {
    centerTextLabels(svg);
    themeFixedColors(svg, diagramType, colors);
    if (diagramType === "sequence") colorLabelsOnBlocks(svg, colors);
    colorLabelsOnFills(svg, colors, diagramType === "er" ? filledEntities(svg, await db()) : []);
    if (diagramType === "sequence" && FORMULA.test(text)) {
      await drawParticipantFormulas(svg, await db());
    }
    if (FORMULA.test(text)) await markFormulas(svg, text);
    if (diagramType === "gantt") thinAxisLabels(svg);
    // Mermaid multiplies sankey flows into the background, turning them black on a dark one.
    if (diagramType === "sankey" && colors.dark) {
      for (const flow of svg.querySelectorAll<SVGElement>("g.link")) {
        flow.style.mixBlendMode = "screen";
      }
    }
    showAllText(svg);
  } catch (error) {
    svg.remove();
    throw error;
  }
  return svg;
}

// mermaid.render keeps the database to itself, so parse separately.
async function databaseOf(mermaid: Mermaid, text: string): Promise<DiagramDb | undefined> {
  try {
    // Some errors, such as in front matter, are thrown rather than rejected.
    return (await mermaid.mermaidAPI.getDiagramFromText(text)).db as DiagramDb;
  } catch {
    return undefined;
  }
}

function center(element: Element): Point {
  const box = element.getBoundingClientRect();
  return [box.left + box.width / 2, box.top + box.height / 2];
}

// By node id.
interface Shown {
  selected: ReadonlyMap<string, boolean>;
  marks: ReadonlyMap<string, DiagramMark["kind"]>;
  // Tooltip text of linked nodes.
  links: ReadonlyMap<string, string>;
}
const nothingShown = (): Shown => ({ selected: new Map(), marks: new Map(), links: new Map() });

export class MermaidRenderer implements Renderer {
  readonly noun = "diagram";
  readonly itemNoun = "node";
  readonly sourceName = "Mermaid source";

  private drawn = NOTHING_DRAWN;
  private shown = nothingShown();
  // Shown again by a new drawing.
  private selectedKeys: ReadonlySet<string> = new Set();
  private links: ReadonlyMap<string, string> = new Map();
  private annotation: Annotation = UNMARKED;
  private zoom = 1;
  // Until the user zooms by hand.
  private fitting = true;
  // Another diagram starts scrolled to its top left.
  private scrollToStart = false;
  private displayedSource: string | undefined;
  // Source, layout width and config; until redraw, rendering the same draws nothing new.
  private drawnFrom: string | undefined;
  private image: { from: string; image: DiagramImage } | undefined;
  private diagramType: string | undefined;
  // Whether the diagram sets its own width rather than the panel sizing it.
  private ownWidth = false;
  // Of most of the drawing's text, at actual size.
  private textSize: number | undefined;
  private layoutWidth = 0;
  private fitFrame = 0;
  private relayoutTimer: ReturnType<typeof setTimeout> | undefined;
  private tabStop: string | undefined;
  private readonly resizeObserver = new ResizeObserver(() => {
    if (this.displayedSource === undefined) return;
    cancelAnimationFrame(this.fitFrame);
    // The user may zoom by hand before the frame.
    this.fitFrame = requestAnimationFrame(() => {
      if (this.displayedSource === undefined) return;
      if (this.fitting) this.fit();
      this.showStart();
    });
    if (drawnAtWidth(this.diagramType, this.ownWidth)) {
      clearTimeout(this.relayoutTimer);
      this.relayoutTimer = setTimeout(() => this.enqueue(() => this.relayout()), RELAYOUT_DELAY);
    }
    // Warnings depend on the panel width.
    warningsMayChange(this.canvas);
  });

  constructor(
    itemClicked: ItemClickHandler,
    private readonly canvas: HTMLElement,
    private readonly diagram: HTMLElement,
    private readonly zoomButton: HTMLElement,
    private readonly enqueue: (task: () => Promise<void>) => void,
    private readonly tabHidden: () => boolean,
  ) {
    const activate = (event: MouseEvent | KeyboardEvent) => {
      // The first click of a double click already acted.
      if (event instanceof MouseEvent && event.detail > 1) return;
      const target = event.target instanceof Element ? event.target : undefined;
      const element = target?.closest(".diagram-node");
      const node = element && this.drawn.byElement.get(element);
      if (!element || !node) {
        itemClicked(undefined, withModifier(event));
        return;
      }
      // Labels and edge surroundings aren't focusable: keep the keyboard on the node.
      if (event instanceof MouseEvent) this.tabStopOf(node.id)?.focus({ preventScroll: true });
      // A link in a label or actor menu wins over the node's links.
      const href = target?.closest("a[data-href]")?.getAttribute("data-href");
      const targets = href ? [{ name: href, url: href }] : this.drawn.links.get(node.id);
      itemClicked(
        { key: node.id, node, links: targets && { targets, anchor: element } },
        withModifier(event),
      );
    };
    diagram.addEventListener("click", activate);
    // Shift+click would also extend the text selection; cancel it and move focus as a click would.
    diagram.addEventListener("pointerdown", (event) => {
      if (!event.shiftKey || event.button !== 0) return;
      const element =
        event.target instanceof Element ? event.target.closest(".diagram-node") : null;
      const stop = element && this.tabStopOf(this.drawn.byElement.get(element)?.id ?? "");
      if (!stop) return;
      event.preventDefault();
      stop.focus({ preventScroll: true });
    });
    // One tab stop for the drawing; arrow keys, Home and End move between nodes.
    diagram.addEventListener("keydown", (event) => {
      const { target } = event;
      if (!(target instanceof SVGElement && this.drawn.byElement.has(target))) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate(event);
        return;
      }
      // Modified arrow keys are other shortcuts.
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const next = this.neighbor(target, event.key);
      if (next !== undefined) {
        event.preventDefault();
        if (next) next.focus();
      }
    });
    diagram.addEventListener("focusin", ({ target }) => {
      if (target instanceof SVGElement && target.hasAttribute("tabindex")) this.setTabStop(target);
    });
    // The focused canvas passes node navigation keys on to the tab stop, or the node nearest the
    // middle if that is out of sight.
    canvas.addEventListener("keydown", (event) => {
      const { key } = event;
      const moves = key === "Home" || key === "End" || arrowDirection(key) !== undefined;
      const modified = event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
      if (event.target !== canvas || !moves || modified) return;
      const next = key === "Home" || key === "End" ? this.endNode(key) : this.stopInSight();
      if (!next) return;
      event.preventDefault();
      next.focus();
    });
    // Ctrl/Cmd+scroll and pinch (Ctrl+scroll in Chromium) zoom at the pointer, once per frame.
    let wheel: { factor: number; x: number; y: number } | undefined;
    canvas.addEventListener(
      "wheel",
      (event) => {
        if (!(event.ctrlKey || event.metaKey) || this.displayedSource === undefined) return;
        event.preventDefault();
        if (!event.deltaY) return;
        // Chromium reports a pinch step as a whole wheel tick (wheelDeltaY ±120) with deltaY
        // -100·ln(scale); scrolling gives at least 1px per 3 wheelDeltaY. Line or page scrolling
        // reports about ±1 per notch.
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
    this.resizeObserver.observe(canvas);
  }

  // Mermaid config for the theme and width; by default those of the drawing shown.
  private config(
    source: string,
    colors = readThemeColors(),
    width = this.layoutWidth,
    ownWidth = this.ownWidth,
  ): Parameters<Mermaid["initialize"]>[0] {
    const { settings, typeLine } = diagramHeader(source);
    const keyword = typeLine?.split(/\s/)[0];
    return {
      startOnLoad: false,
      securityLevel: "strict",
      maxTextSize: MAX_TEXT_SIZE,
      // Throw instead of rendering errors as a diagram.
      suppressErrorRendering: true,
      // A diagram choosing its own theme takes it whole, without the VS Code colors.
      ...(![undefined, "base"].includes(OWN_THEME.exec(settings)?.[1])
        ? { theme: "base", themeVariables: {} }
        : mermaidTheme(colors, keyword)),
      ...elementConfig(colors.fontFamily),
      ...sizeConfig(keyword, ownWidth, width),
    };
  }

  async render(source: string): Promise<string> {
    if (source.length > MAX_TEXT_SIZE) {
      throw new Error(
        `The diagram is too long: ${source.length} characters, where Mermaid allows ${MAX_TEXT_SIZE}. Split it into smaller diagrams.`,
      );
    }
    const mermaid = await loadMermaid();
    const colors = readThemeColors();
    const id = `diagram-svg-${++renderCounter}`;
    const container = layoutContainer();
    // Lay out at the shown width rather than shrinking text to fit. The Source view's canvas has
    // no width: keep the last, or measure the Visual view's. A hidden tab relays out once shown.
    let { width } = this.contentSize();
    if (width <= 0 && this.layoutWidth <= 0 && !this.tabHidden() && this.canvas.parentElement) {
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
    const text = parsableSource(source);
    const keyword = diagramHeader(source).typeLine?.split(/\s/)[0];
    // The diagram's settings may set colors Mermaid cannot read.
    const configure = async () => {
      const ownWidth = await setsOwnWidth(
        mermaid,
        this.config(source, colors, 0, true),
        text,
        keyword,
      );
      const config = await withOwnThemeVariables(
        mermaid,
        this.config(source, colors, width > 0 ? width : this.layoutWidth, ownWidth),
        text,
        colors,
      );
      mermaid.initialize(config);
      return { ownWidth, config };
    };
    const { ownWidth, config } = await configure().catch((error: unknown) => {
      throw themeColorError(error, source) ?? error;
    });
    // A failed drawing keeps the shown one and its width; drafts share the container.
    const shownWidth = container.style.width;
    const laidOut = width > 0 ? width : this.layoutWidth;
    const drawWidth = laidOut > 0 ? `${laidOut}px` : shownWidth;
    // Large diagrams take seconds to redraw; skip if unchanged.
    const drawnFrom = JSON.stringify([source, drawWidth, config]);
    if (drawnFrom === this.drawnFrom && this.diagramType) {
      this.present();
      return this.diagramType;
    }
    container.style.width = drawWidth;
    const drawing = async () => {
      const parsed = await databaseOf(mermaid, text);
      // Mermaid would lay out the first forever, and misplace the second.
      const invalid = nestingError(parsed, source) ?? numberError(parsed, source);
      if (invalid) throw invalid;
      const result = await mermaid.render(id, text, container).catch(async (error: unknown) => {
        throw (
          undefinedEndError(parsed, source) ??
          emptyStateError(error, parsed, source) ??
          duplicateEdgeError(error, parsed, source) ??
          (await statementError(error, source, (part) => mermaid.parse(part))) ??
          themeColorError(error, source) ??
          describeError(error, source, () => mermaid.detectType(text))
        );
      });
      const db = WITH_DATABASE.has(result.diagramType) ? parsed : undefined;
      const svg = await layOut(result.svg, result.diagramType, text, colors, async () => db);
      // Measured in the layout container, as the canvas may be hidden.
      return { result, db, svg, size: textSize(svg) };
    };
    const { result, db, svg, size } = await drawing().catch((error: unknown) => {
      container.style.width = shownWidth;
      throw error;
    });
    if (width > 0) this.layoutWidth = width;
    this.drawnFrom = drawnFrom;
    this.hideTooltip();
    this.diagram.replaceChildren(svg);
    // Links open via the extension, which checks URLs; Mermaid's would open model-written URLs
    // directly.
    for (const link of this.diagram.querySelectorAll("a")) {
      const href = hrefOf(link)?.trim();
      link.removeAttribute("href");
      link.removeAttributeNS(XLINK_NAMESPACE, "href");
      if (href) link.setAttribute("data-href", href);
    }
    // Gantt binds only window.open links, which would navigate the panel; findNodes links tasks.
    if (result.diagramType !== "gantt") result.bindFunctions?.(this.diagram);
    this.diagram.hidden = false;
    this.displayedSource = source;
    this.diagramType = result.diagramType;
    this.ownWidth = ownWidth;
    this.textSize = size;
    this.prepareSvg(svg, id, db);
    this.present();
    return result.diagramType;
  }

  // Fitting keeps the zoom until the panel can be measured.
  private present(): void {
    this.setZoom(this.zoom);
    if (this.fitting) this.fit();
    this.showStart();
  }

  // Centers the first node of another diagram; once the canvas has a size.
  private showStart(): void {
    if (!this.scrollToStart || this.contentSize().width <= 0) return;
    this.scrollToStart = false;
    // As found rather than drawn: sequence diagrams draw participant footers first.
    const shown = (node: DiagramNode) => this.drawn.elements.get(node.id)?.[0];
    const first = this.drawn.nodes.find(
      (node) => !node.relationship && !shown(node)?.matches(GROUP),
    );
    const box = first && shown(first)?.getBoundingClientRect();
    if (!box?.width) {
      this.canvas.scrollTo(0, 0);
      return;
    }
    const view = this.canvas.getBoundingClientRect();
    const [x, y] = [
      view.left + this.canvas.clientLeft + this.canvas.clientWidth / 2,
      view.top + this.canvas.clientTop + this.canvas.clientHeight / 2,
    ];
    this.canvas.scrollTo(
      this.canvas.scrollLeft + box.left + box.width / 2 - x,
      this.canvas.scrollTop + box.top + box.height / 2 - y,
    );
  }

  // With SVG text labels, as most SVG readers drop `foreignObject`. Formulas keep HTML for MathML.
  async toImage(background: string): Promise<DiagramImage> {
    const source = this.displayedSource;
    if (source === undefined) {
      throw new Error("There is no diagram to make an image of.");
    }
    const colors = readThemeColors();
    const mermaid = await loadMermaid();
    const text = parsableSource(source);
    const config = await withOwnThemeVariables(mermaid, this.config(source, colors), text, colors);
    // For labels that leave their color to CSS.
    const color = getComputedStyle(document.body).color;
    // A draft may have changed the container width since.
    const container = layoutContainer();
    if (this.layoutWidth > 0) container.style.width = `${this.layoutWidth}px`;
    const width = container.style.width;
    const from = JSON.stringify([source, background, color, width, config]);
    if (this.image?.from === from) return this.image.image;
    mermaid.initialize(
      FORMULA.test(text)
        ? config
        : {
            ...config,
            htmlLabels: false,
            // Swimlane titles still follow this deprecated setting alone.
            flowchart: { htmlLabels: false },
            // SVG text would show HTML tags; keep only line breaks.
            dompurifyConfig: { ALLOWED_TAGS: ["br"] },
            // Front matter must not put HTML labels back.
            secure: [...(mermaid.mermaidAPI.defaultConfig.secure ?? []), "htmlLabels"],
          },
    );
    try {
      const { svg, diagramType } = await mermaid.render(
        // Mermaid scopes styles by this id; random so images from different sessions don't clash.
        `diagram-image-${crypto.randomUUID().slice(0, 8)}`,
        text,
        container,
      );
      const drawing = await layOut(svg, diagramType, text, colors, () => databaseOf(mermaid, text));
      try {
        inlineStyleSheets(drawing);
        const image = standaloneSvg(drawing, background);
        this.image = { from, image };
        return image;
      } finally {
        drawing.remove();
      }
    } finally {
      // Restore the panel config, which a theme change or resize may render with.
      mermaid.initialize(this.config(source));
    }
  }

  // The drawing as shown, without selection, marks and links, rather than drawn anew.
  async modelImage(background: string, ids: readonly string[]): Promise<ModelImage> {
    const shown = this.diagram.querySelector("svg");
    const natural = shown?.viewBox.baseVal;
    if (this.displayedSource === undefined || !shown || !natural) {
      throw new Error("There is no diagram to make an image of.");
    }
    // Measured in a copy at actual size: the drawing has no layout while hidden, and text zoomed
    // far out has other widths.
    const svg = shown.cloneNode(true) as SVGSVGElement;
    svg.setAttribute("width", String(natural.width));
    svg.setAttribute("height", String(natural.height));
    layoutContainer().append(svg);
    try {
      const drawing = drawingArea(svg);
      const boxes: Area[] = [];
      const missing: string[] = [];
      for (const id of ids) {
        const elements = svg.querySelectorAll(`[data-diagram-id="${CSS.escape(id)}"]`);
        const found = Array.from(elements, (element) => boxOf(svg, element) ?? []).flat();
        if (found.length > 0) boxes.push(...found);
        else missing.push(id);
      }
      const area = areaAround(drawing, boxes);
      const room = this.contentSize();
      return {
        image: standaloneSvg(svg, background, area),
        view: {
          width: drawing.width,
          height: drawing.height,
          area: area && { width: area.width, height: area.height },
          textSize: textSize(svg),
          panel: room.width > 0 && room.height > 0 ? { ...room, zoom: this.zoom } : undefined,
          missing,
        },
      };
    } finally {
      svg.remove();
    }
  }

  hide(): void {
    this.hideTooltip();
    this.diagram.hidden = true;
    this.diagram.innerHTML = "";
    this.drawn = NOTHING_DRAWN;
    this.shown = nothingShown();
    this.displayedSource = undefined;
    this.drawnFrom = undefined;
    this.image = undefined;
  }

  // Mermaid hides it only when the pointer leaves the node.
  private hideTooltip(): void {
    const tooltip = document.querySelector<HTMLElement>(".mermaidTooltip");
    if (!tooltip || !this.diagram.querySelector("[title].hover")) return;
    interrupt(tooltip);
    tooltip.style.opacity = "0";
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
    // Nothing is faded while nothing is marked.
    this.diagram.classList.toggle("dim-unmarked", annotation.dim && kinds.size > 0);
  }

  itemBounds(id: string): DOMRect | undefined {
    const boxes = (this.drawn.elements.get(id) ?? [])
      .map((element) => element.getBoundingClientRect())
      .filter((box) => box.width > 0 || box.height > 0);
    if (boxes.length === 0) return undefined;
    const left = Math.min(...boxes.map((box) => box.left));
    const top = Math.min(...boxes.map((box) => box.top));
    return new DOMRect(
      left,
      top,
      Math.max(...boxes.map((box) => box.right)) - left,
      Math.max(...boxes.map((box) => box.bottom)) - top,
    );
  }

  showLinks(locations: ReadonlyMap<string, string>): void {
    this.links = locations;
    // Code links win over source links, as on a click.
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

  // Touches only changed nodes, however large the drawing.
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

  drawnNodes(): DiagramNode[] {
    return this.drawn.nodes;
  }

  get hasWebLinks(): boolean {
    return this.drawn.links.size > 0;
  }

  async themeChanged(): Promise<void> {
    if (this.displayedSource !== undefined) {
      await this.redraw(this.displayedSource);
    }
  }

  // On failure, keeps what is shown.
  private async redraw(source: string): Promise<boolean> {
    const focused = this.diagram.contains(document.activeElement);
    this.drawnFrom = undefined;
    try {
      await this.render(source);
    } catch {
      return false;
    }
    // Replacing the SVG drops the focused node; refocus the new tab stop unless focus moved.
    if (focused && document.hasFocus() && document.activeElement === document.body) {
      this.diagram.querySelector<SVGElement>('[tabindex="0"]')?.focus({ preventScroll: true });
    }
    return true;
  }

  // Lays a width-drawn chart out again rather than scaling its text, keeping relative zoom and scroll.
  private async relayout(): Promise<void> {
    const source = this.displayedSource;
    const room = this.contentSize();
    if (
      source === undefined ||
      !drawnAtWidth(this.diagramType, this.ownWidth) ||
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
    warningsMayChange(this.canvas);
    if (!this.fitting) {
      this.setZoom((fitted(room.width) ?? 1) * relativeZoom);
    }
    this.canvas.scrollLeft = (scrollLeft * this.canvas.scrollWidth) / scrollWidth;
    this.canvas.scrollTop = (scrollTop * this.canvas.scrollHeight) / scrollHeight;
  }

  // Keeps the point at the given client coordinates (default the middle) in place.
  zoomBy(factor: number, x?: number, y?: number): void {
    this.fitting = false;
    this.zoomAt(this.zoom * factor, x, y);
  }

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

  // The resize observer doesn't re-report sizes from before the tab was hidden; observing anew does.
  tabShown(): void {
    this.resizeObserver.unobserve(this.canvas);
    this.resizeObserver.observe(this.canvas);
  }

  fitToPanel(): void {
    this.fitting = true;
    this.scrollToStart = true;
  }

  // Toggles fit/actual size, keeping the middle in place.
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

  // Null if there is no node that way; undefined if the key doesn't move focus.
  private neighbor(from: SVGElement, key: string): SVGElement | null | undefined {
    if (key === "Home" || key === "End") return this.endNode(key);
    const direction = arrowDirection(key);
    if (!direction) return undefined;
    const stops = this.diagram.querySelectorAll<SVGElement>(".diagram-node[tabindex]");
    return nearestInDirection(from, direction, stops, center) ?? null;
  }

  // In source order.
  private endNode(key: "Home" | "End"): SVGElement | null {
    const nodes = this.drawn.nodes.filter((node) => !node.relationship);
    const node = key === "Home" ? nodes[0] : nodes.at(-1);
    return node ? this.tabStopOf(node.id) : null;
  }

  private tabStopOf(id: string): SVGElement | null {
    const elements = this.drawn.elements.get(id) ?? [];
    return elements.find((element): element is SVGElement => element.matches("[tabindex]")) ?? null;
  }

  // The tab stop if in sight, else the node nearest the middle, rather than scrolling far.
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

  private setTabStop(element: SVGElement): void {
    const node = this.drawn.byElement.get(element);
    if (!node || element.getAttribute("tabindex") === "0") return;
    this.diagram.querySelector('.diagram-node[tabindex="0"]')?.setAttribute("tabindex", "-1");
    element.setAttribute("tabindex", "0");
    this.tabStop = node.id;
  }

  private prepareSvg(svg: SVGSVGElement, svgId: string, db: DiagramDb | undefined): void {
    this.shown = nothingShown();
    this.drawn = NOTHING_DRAWN;
    try {
      this.drawn = findNodes(svg, `${svgId}-`, db);
    } catch (error) {
      // Still worth showing, without nodes.
      console.error(error);
    }
    // Keep the tab stop on the same node, else start on the first node in source order.
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

  // 0 × 0 while hidden, by the Source view or the tab.
  private contentSize(): { width: number; height: number } {
    if (this.tabHidden()) return { width: 0, height: 0 };
    const style = getComputedStyle(this.canvas);
    const sum = (a: string, b: string) => Number.parseFloat(a) + Number.parseFloat(b);
    return {
      width: this.canvas.clientWidth - sum(style.paddingLeft, style.paddingRight),
      height: this.canvas.clientHeight - sum(style.paddingTop, style.paddingBottom),
    };
  }

  // To the panel width (and height, within reason).
  private fit(): void {
    const zoom = this.fitZoom(this.diagram.querySelector("svg")?.viewBox.baseVal);
    // Undefined until the canvas is laid out; the resize observer fits later.
    if (zoom !== undefined) this.setZoom(zoom);
  }

  private fitZoom(
    natural: DOMRect | undefined,
    { width, height } = this.contentSize(),
  ): number | undefined {
    if (!natural?.width || !natural.height) return 1;
    if (width <= 0 || height <= 0) return undefined;
    // Fit the width, but keep text readable (9px) and don't shrink below 60% to fit the height.
    const readable = this.textSize ? 9 / this.textSize : 0;
    return Math.min(
      1,
      Math.max(width / natural.width, readable),
      Math.max(height / natural.height, 0.6),
    );
  }

  // By size rather than CSS zoom, which leaves client coordinates unscaled.
  private setZoom(value: number): void {
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
    if (zoom !== this.zoom) closeLinkMenu(this.canvas);
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
    this.zoomButton.setAttribute("aria-label", `${shown}: ${action}`);
  }
}
