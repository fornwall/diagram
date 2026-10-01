// Renders Mermaid diagrams as SVG, scaled to fit the panel.

import type { Mermaid } from "mermaid";
import type { DiagramNode } from "../protocol";
import { mix, type ThemeColors, toCss } from "./colors";
import { type Renderer, type RendererHost, withModifier } from "./renderer";
import { readThemeColors } from "./vscodeTheme";

let loading: Promise<Mermaid> | undefined;
const loadMermaid = () => (loading ??= import("mermaid").then((module) => module.default));

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
/** Fitting a tall diagram to the panel height never shrinks it below this; it scrolls instead. */
const MIN_HEIGHT_FIT = 0.6;

/** Mermaid's default limit: it draws a longer source as an error message instead. */
const MAX_TEXT_SIZE = 50_000;

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
 * entity attributes, a C4 type and description, requirement fields or kanban card metadata.
 */
function nameOf(element: Element): string {
  const title = element.querySelector(".label-group, .label.name, .cluster-label, .c4-name");
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
  /** The selectable nodes of the shown diagram, by the elements that show them. */
  private nodes = new Map<Element, DiagramNode>();
  private selectedKeys: ReadonlySet<string> = new Set();
  private zoom = 1;
  /** Whether the zoom follows the panel size, until the user zooms by hand. */
  private fitting = true;
  private displayedSource: string | undefined;
  private fitFrame = 0;

  constructor(
    host: RendererHost,
    private readonly canvas: HTMLElement,
    private readonly diagram: HTMLElement,
    private readonly zoomButton: HTMLElement,
  ) {
    const activate = (event: MouseEvent | KeyboardEvent) => {
      const element = event.target instanceof Element && event.target.closest(".diagram-node");
      const node = element ? this.nodes.get(element) : undefined;
      host.itemClicked(node && { key: node.id, node }, withModifier(event));
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

  async render(source: string): Promise<string> {
    if (source.length > MAX_TEXT_SIZE) {
      throw new Error(
        `The diagram is too long: ${source.length} characters, where Mermaid allows ${MAX_TEXT_SIZE}. Split it into smaller diagrams.`,
      );
    }
    const mermaid = await loadMermaid();
    const colors = readThemeColors();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      maxTextSize: MAX_TEXT_SIZE,
      // Throw errors instead of rendering them as a diagram, and clean up after failing.
      suppressErrorRendering: true,
      theme: colors.dark ? "dark" : "default",
      themeVariables: colors.dark ? darkScale(colors) : {},
      fontFamily: colors.fontFamily,
    });
    const id = `diagram-svg-${++this.renderCounter}`;
    const result = await mermaid.render(id, source).catch((error: unknown) => {
      throw describeError(error, source);
    });
    this.diagram.innerHTML = result.svg;
    result.bindFunctions?.(this.diagram);
    this.diagram.hidden = false;
    this.displayedSource = source;
    this.prepareSvg(id);
    if (this.fitting) {
      this.fit();
    } else {
      this.setZoom(this.zoom);
    }
    return result.diagramType;
  }

  hide(): void {
    this.diagram.hidden = true;
    this.diagram.innerHTML = "";
    this.nodes.clear();
    this.displayedSource = undefined;
  }

  showSelection(keys: ReadonlySet<string>): void {
    this.selectedKeys = keys;
    for (const [element, node] of this.nodes) {
      const selected = keys.has(node.id);
      element.classList.toggle("diagram-selected", selected);
      element.setAttribute("aria-pressed", String(selected));
    }
  }

  async themeChanged(): Promise<void> {
    if (this.displayedSource !== undefined) {
      try {
        await this.render(this.displayedSource);
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
  private prepareSvg(svgId: string): void {
    this.nodes.clear();
    const svg = this.diagram.querySelector("svg");
    if (!svg) {
      return;
    }
    this.findNodes(svg, `${svgId}-`);
    this.showSelection(this.selectedKeys);
    const viewBox = svg.viewBox.baseVal;
    if (viewBox.width > 0 && viewBox.height > 0) {
      svg.setAttribute("width", String(viewBox.width));
      svg.setAttribute("height", String(viewBox.height));
      svg.style.maxWidth = "none";
    }
  }

  private findNodes(svg: SVGSVGElement, idPrefix: string): void {
    const focusable = new Set<string>();
    const add = (element: Element, node: DiagramNode) => {
      element.classList.add("diagram-node");
      this.nodes.set(element, node);
      // One tab stop per node, although some are drawn as several elements.
      if (!focusable.has(node.id)) {
        focusable.add(node.id);
        element.setAttribute("tabindex", "0");
        element.setAttribute("role", "button");
        element.setAttribute("aria-label", node.label);
      }
    };
    const withoutPrefix = (id: string) =>
      id.startsWith(idPrefix) ? id.slice(idPrefix.length) : id;

    // Nodes and groups (subgraphs, composite states, kanban columns, architecture services, …).
    // Their element ids are the source ids, some decorated like "flowchart-A-0", and mind map
    // node ids are generated ("node_0").
    for (const element of svg.querySelectorAll(
      "g.node, g.rough-node, g.cluster, g.statediagram-cluster, g.architecture-service",
    )) {
      const label = nameOf(element);
      if (!label) {
        continue; // Start and end states, forks and joins.
      }
      const domId = element.getAttribute("data-id") ?? withoutPrefix(element.id);
      const decorated = /^(?:flowchart|state|classId|entity)-(.+)-\d+$|^service-(.+)$/.exec(domId);
      const id =
        decorated?.[1] ?? decorated?.[2] ?? (/^(?:node_\d+)?$/.test(domId) ? label : domId);
      add(element, { id, label });
    }

    // Sequence diagram participants. Their copies below the diagram lack the participant
    // attributes, but have the same label.
    const participants = new Map<string, DiagramNode>();
    for (const element of svg.querySelectorAll('[data-et="participant"]')) {
      const label = textOf(element);
      const node = { id: element.getAttribute("data-id") || label, label };
      participants.set(label, node);
      add(element, node);
    }
    for (const element of svg.querySelectorAll(".actor-bottom")) {
      const group = element.querySelector("text") ? element : element.parentElement;
      const node = group && participants.get(textOf(group));
      if (node) {
        add(group, node);
      }
    }

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
        add(group, { id: label, label });
      }
    }

    // Timeline periods and events, and quadrant chart points.
    for (const element of svg.querySelectorAll("g.timeline-node, g.data-point")) {
      const label = textOf(element);
      add(element, { id: label, label });
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
