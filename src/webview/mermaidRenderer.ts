// Renders Mermaid diagrams as SVG, scaled to fit the panel.

import type { Mermaid } from "mermaid";
import type { Annotation, DiagramMark, DiagramNode } from "../protocol";
import { mix, type ThemeColors, toCss } from "./colors";
import { type DiagramImage, standaloneSvg } from "./images";
import { shortestPath } from "./relationships";
import { type ItemClickHandler, type Renderer, UNMARKED, withModifier } from "./renderer";
import { readThemeColors } from "./vscodeTheme";

let loading: Promise<Mermaid> | undefined;
const loadMermaid = () => (loading ??= import("mermaid").then((module) => module.default));

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
/** Fitting a tall diagram to the panel height never shrinks it below this; it scrolls instead. */
const MIN_HEIGHT_FIT = 0.6;

/** Mermaid's default limit: it draws a longer source as an error message instead. */
const MAX_TEXT_SIZE = 50_000;

/** The namespace of the <title> elements that show where a linked node leads. */
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

const TYPE_EXAMPLES = '"flowchart TD", "sequenceDiagram", "classDiagram", "erDiagram", "mindmap"';

/** Replaces Mermaid's error for an unknown diagram type, which quotes the whole source. */
function unknownTypeError(message: string): Error {
  // Mermaid quotes the source without front matter, directives and comments.
  const text = /for text: (.*)$/s.exec(message)?.[1]?.trim() ?? "";
  if (text.startsWith("```")) {
    return new Error(
      `Remove the code fence around the diagram: the source must start with the diagram type, e.g. ${TYPE_EXAMPLES}.`,
    );
  }
  if (!text) {
    return new Error(
      `The diagram is empty: start it with the diagram type, e.g. ${TYPE_EXAMPLES}.`,
    );
  }
  const type = text.split(/\s/, 1)[0]?.slice(0, 40);
  return new Error(
    `Unknown diagram type "${type}": the first line must declare the type, e.g. ${TYPE_EXAMPLES}.`,
  );
}

/**
 * The source line of each line that Mermaid parses. Mermaid parses the source without its front
 * matter, directives, comment lines and leading blank lines (see preprocessDiagram in Mermaid),
 * and numbers the lines in its errors accordingly.
 */
function parsedLines(source: string): number[] {
  const normalized = source.replace(/\r\n?/g, "\n");
  let text = normalized;
  /** The offset in the normalized source of each character of the text. */
  let origins = Array.from({ length: text.length }, (_, i) => i);
  // Mermaid's patterns, in its order.
  for (const removed of [
    /^([^\S\n\r]*)-{3}\s*[\n\r](.*?)[\n\r]\1-{3}\s*[\n\r]+/gs,
    /%{2}{\s*(?:(\w+)\s*:|(\w+))\s*(?:(\w+)|((?:(?!}%{2}).|\r?\n)*))?\s*(?:}%{2})?/gi,
    /^\s*%%(?!\{)[^\n]+\n?/gm,
    /^\s+/g,
  ]) {
    let kept = "";
    const keptOrigins: number[] = [];
    let from = 0;
    const keep = (to: number) => {
      kept += text.slice(from, to);
      for (const origin of origins.slice(from, to)) {
        keptOrigins.push(origin);
      }
    };
    for (const match of text.matchAll(removed)) {
      keep(match.index);
      from = match.index + match[0].length;
    }
    keep(text.length);
    text = kept;
    origins = keptOrigins;
  }
  // The origins of the parsed lines increase, so count the source lines in one pass.
  let line = 1;
  let counted = 0;
  const lineAt = (offset = normalized.length) => {
    for (; counted < offset; counted++) {
      if (normalized[counted] === "\n") {
        line++;
      }
    }
    return line;
  };
  const lines = [lineAt(origins[0])];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) {
    lines.push(lineAt(origins[i + 1]));
  }
  return lines;
}

/** Makes Mermaid's error clear, and its line numbers those of the source. */
function describeError(error: unknown, source: string): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  if (error.name === "UnknownDiagramError") {
    return unknownTypeError(error.message);
  }
  // js-yaml numbers the lines of the front matter after its "---" line, from 0.
  const yaml = error as Error & { reason?: string; mark?: { line: number } };
  if (error.name === "YAMLException" && yaml.mark) {
    return new Error(
      `Invalid YAML in the front matter on line ${yaml.mark.line + 2}: ${yaml.reason ?? error.message}.`,
    );
  }
  const edgeLimit = /^Edge limit exceeded.* the limit is (\d+)/.exec(error.message);
  if (edgeLimit) {
    return new Error(
      `The diagram has more than ${edgeLimit[1]} edges, more than Mermaid draws: split it into smaller diagrams.`,
    );
  }
  const lines = parsedLines(source);
  error.message = error.message.replace(
    /\bon line (\d+)/g,
    (_, line: string) => `on line ${lines[Number(line) - 1] ?? line}`,
  );
  return error;
}

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
  "sequence",
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
  getXYChartData?(): {
    plots: { type: "bar" | "line"; title: string; data: [string, number][] }[];
  };
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
  /** The marks an agent put on the diagram, which a re-render for a new theme puts back. */
  private annotation: Annotation = UNMARKED;
  private zoom = 1;
  /** Whether the zoom follows the panel size, until the user zooms by hand. */
  private fitting = true;
  private displayedSource: string | undefined;
  private fitFrame = 0;

  constructor(
    itemClicked: ItemClickHandler,
    private readonly canvas: HTMLElement,
    private readonly diagram: HTMLElement,
    private readonly zoomButton: HTMLElement,
  ) {
    const activate = (event: MouseEvent | KeyboardEvent) => {
      const element = event.target instanceof Element && event.target.closest(".diagram-node");
      const node = element ? this.nodes.get(element) : undefined;
      itemClicked(node && { key: node.id, node }, withModifier(event));
    };
    diagram.addEventListener("click", activate);
    // Nodes are buttons for the keyboard.
    diagram.addEventListener("keydown", (event) => {
      const onNode = event.target instanceof Element && this.nodes.has(event.target);
      if (onNode && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        activate(event);
      }
    });
    new ResizeObserver(() => {
      if (this.fitting && this.displayedSource !== undefined) {
        cancelAnimationFrame(this.fitFrame);
        this.fitFrame = requestAnimationFrame(() => this.fit());
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
    const result = await mermaid.render(id, source).catch((error: unknown) => {
      throw describeError(error, source);
    });
    // mermaid.render keeps the diagram's database to itself: parse again for it. Should that
    // fail, the items are just not selectable.
    const db: DiagramDb | undefined = WITH_DATABASE.has(result.diagramType)
      ? await mermaid.mermaidAPI.getDiagramFromText(source).then(
          (parsed) => parsed.db as DiagramDb,
          () => undefined,
        )
      : undefined;
    this.diagram.innerHTML = result.svg;
    result.bindFunctions?.(this.diagram);
    this.diagram.hidden = false;
    this.displayedSource = source;
    this.supportsPaths = result.diagramType.startsWith("flowchart") && db?.getData !== undefined;
    this.prepareSvg(id, db);
    if (this.fitting) {
      this.fit();
    } else {
      this.setZoom(this.zoom);
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
      // Front matter and init directives must not put HTML labels back into an image.
      secure: [...(mermaid.mermaidAPI.defaultConfig.secure ?? []), "htmlLabels"],
    });
    try {
      const { svg } = await mermaid.render(`diagram-image-${++this.renderCounter}`, source);
      const parsed = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
      if (!(parsed instanceof SVGSVGElement)) {
        throw new Error("Mermaid did not produce an SVG to make an image of.");
      }
      return standaloneSvg(parsed, background);
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

  showLinks(locations: ReadonlyMap<string, string>): void {
    this.links = locations;
    for (const id of new Set([...this.shownLinks.keys(), ...locations.keys()])) {
      const location = locations.get(id);
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
    this.shownLinks = locations;
  }

  async themeChanged(): Promise<void> {
    if (this.displayedSource !== undefined) {
      const focused = document.activeElement;
      const node = focused ? this.nodes.get(focused) : undefined;
      try {
        await this.render(this.displayedSource);
        // Replacing the SVG removes its focused node. Keep keyboard navigation on that node,
        // unless the user moved focus elsewhere while Mermaid was rendering.
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
      } catch {
        // It rendered before with another theme; keep what is shown.
      }
    }
  }

  formatForEditing(source: string): string {
    return source;
  }

  zoomBy(factor: number): void {
    this.fitting = false;
    this.setZoom(this.zoom * factor);
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

  /** Finds the selectable nodes, and gives the SVG its natural size for zooming as a whole. */
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
    this.showSelection(this.selectedKeys);
    this.showLinks(this.links);
    this.showMarks(this.annotation);
    const viewBox = svg.viewBox.baseVal;
    if (viewBox.width > 0 && viewBox.height > 0) {
      svg.setAttribute("width", String(viewBox.width));
      svg.setAttribute("height", String(viewBox.height));
      svg.style.maxWidth = "none";
    }
  }

  /** Join renderer metadata to DOM IDs; endpoint names are never inferred from generated IDs. */
  private findRelationships(
    svg: SVGSVGElement,
    db: DiagramDb | undefined,
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
    if (this.supportsPaths && db?.getData) {
      const edges = db.getData().edges;
      const byId = new Map<string, typeof edges>();
      for (const edge of edges) byId.set(edge.id, [...(byId.get(edge.id) ?? []), edge]);
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
        // Ambiguous duplicate renderer IDs cannot safely identify a relationship.
        if (!line || byId.get(edge.id)?.length !== 1 || edge.thickness === "invisible") continue;
        const label = labels.get(edge.id);
        const node = relation(
          "edge",
          edge.id,
          edge.start,
          edge.end,
          label ? textOf(label) : plainText(edge.label ?? ""),
          edge.arrowTypeStart !== "none" && !!edge.arrowTypeStart,
          edge.arrowTypeEnd !== "none" && !!edge.arrowTypeEnd,
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
      // One tab stop per node, although some are drawn as several elements.
      if (!focusable.has(node.id)) {
        focusable.add(node.id);
        element.setAttribute("tabindex", "0");
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

    this.findRelationships(svg, db, add);

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
      bullets.set(id, [...(bullets.get(id) ?? []), bullet]);
    }
    const tagLabels = Array.from(svg.querySelectorAll("text.tag-label"));
    const tagCount = commits.reduce((count, { tags }) => count + tags.length, 0);
    const commitLabels = new Map(
      Array.from(svg.querySelectorAll("text.commit-label"), (label) => [textOf(label), label]),
    );
    if (bullets.size === commits.length && tagLabels.length === tagCount) {
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
        for (const tag of tagLabels.splice(0, tags.length)) {
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

  /** Scales large diagrams down to the panel width (and height, within reason). */
  private fit(): void {
    const natural = this.diagram.querySelector("svg")?.viewBox.baseVal;
    if (!natural?.width || !natural.height) {
      this.setZoom(1);
      return;
    }
    const style = getComputedStyle(this.canvas);
    const sum = (a: string, b: string) => Number.parseFloat(a) + Number.parseFloat(b);
    const width = this.canvas.clientWidth - sum(style.paddingLeft, style.paddingRight);
    const height = this.canvas.clientHeight - sum(style.paddingTop, style.paddingBottom);
    if (width <= 0 || height <= 0) {
      return; // Not laid out yet (e.g. the panel is hidden); the resize observer fits later.
    }
    const heightFit = Math.max(height / natural.height, MIN_HEIGHT_FIT);
    this.setZoom(Math.min(1, width / natural.width, heightFit));
  }

  private setZoom(value: number): void {
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
    this.diagram.style.zoom = String(this.zoom);
    this.zoomButton.textContent = `${Math.round(this.zoom * 100)}%`;
    this.zoomButton.title =
      this.fitting && this.zoom !== 1 ? "Show at actual size" : "Fit to the panel";
  }
}
