// Renders Mermaid diagrams as SVG, scaled to fit the panel.

import type { Mermaid } from "mermaid";
import type { DiagramNode } from "../protocol";
import type { Renderer, RendererHost } from "./renderer";
import { isDarkTheme } from "./vscodeTheme";

let loading: Promise<Mermaid> | undefined;
const loadMermaid = () => (loading ??= import("mermaid").then((module) => module.default));

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
/** Fitting a tall diagram to the panel height never shrinks it below this; it scrolls instead. */
const MIN_HEIGHT_FIT = 0.6;

const TYPE_EXAMPLES = '"flowchart TD", "sequenceDiagram", "classDiagram", "erDiagram", "mindmap"';

/** Replaces Mermaid's error for an unknown diagram type, which quotes the whole source. */
function describeError(error: unknown): unknown {
  // Mermaid quotes the source without front matter, directives and comments.
  const text =
    error instanceof Error && error.name === "UnknownDiagramError"
      ? /for text: (.*)$/s.exec(error.message)?.[1]?.trim()
      : undefined;
  if (text === undefined) {
    return error;
  }
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

/** The text of an element, with its lines (separate text nodes) separated by spaces. */
function textOf(element: Element): string {
  const parts: string[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    parts.push(walker.currentNode.nodeValue ?? "");
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export class MermaidRenderer implements Renderer {
  readonly language = "mermaid";
  readonly noun = "diagram";
  readonly itemNoun = "node";
  readonly sourceName = "Mermaid source";

  /** Whether Mermaid must be initialized (again) for the current VS Code theme. */
  private themeStale = true;
  private renderCounter = 0;
  /** The selectable nodes of the shown diagram, by the elements that show them. */
  private nodes = new Map<Element, DiagramNode>();
  private selectedKeys: ReadonlySet<string> = new Set();
  private zoom = 1;
  /** Whether the zoom follows the panel size, until the user zooms by hand. */
  private fitting = true;
  private naturalSize: { width: number; height: number } | undefined;
  private displayedSource: string | undefined;
  private fitFrame = 0;

  constructor(
    host: RendererHost,
    private readonly canvas: HTMLElement,
    private readonly diagram: HTMLElement,
    private readonly zoomButton: HTMLButtonElement,
  ) {
    diagram.addEventListener("click", (event) => {
      const element = event.target instanceof Element && event.target.closest(".diagram-node");
      const node = element ? this.nodes.get(element) : undefined;
      host.itemClicked(
        node ? { key: node.id, node } : undefined,
        event.ctrlKey || event.metaKey || event.shiftKey,
      );
    });
    new ResizeObserver(() => {
      if (this.fitting && this.displayedSource !== undefined) {
        cancelAnimationFrame(this.fitFrame);
        this.fitFrame = requestAnimationFrame(() => this.fit());
      }
    }).observe(canvas);
  }

  async render(source: string): Promise<string> {
    const mermaid = await loadMermaid();
    if (this.themeStale) {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        // Throw errors instead of rendering them as a diagram, and clean up after failing.
        suppressErrorRendering: true,
        theme: isDarkTheme() ? "dark" : "default",
        fontFamily: getComputedStyle(document.body).getPropertyValue("--vscode-font-family"),
      });
      this.themeStale = false;
    }
    const id = `diagram-svg-${++this.renderCounter}`;
    const result = await mermaid.render(id, source).catch((error: unknown) => {
      throw describeError(error);
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
    this.naturalSize = undefined;
  }

  showSelection(keys: ReadonlySet<string>): void {
    this.selectedKeys = keys;
    for (const [element, node] of this.nodes) {
      element.classList.toggle("diagram-selected", keys.has(node.id));
    }
  }

  async themeChanged(): Promise<void> {
    this.themeStale = true;
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
    this.naturalSize = undefined;
    const svg = this.diagram.querySelector("svg");
    if (!svg) {
      return;
    }
    this.findNodes(svg, `${svgId}-`);
    this.showSelection(this.selectedKeys);
    const viewBox = svg.viewBox.baseVal;
    if (viewBox.width > 0 && viewBox.height > 0) {
      this.naturalSize = { width: viewBox.width, height: viewBox.height };
      svg.setAttribute("width", String(viewBox.width));
      svg.setAttribute("height", String(viewBox.height));
      svg.style.maxWidth = "none";
    }
  }

  private findNodes(svg: SVGSVGElement, idPrefix: string): void {
    const add = (element: Element, node: DiagramNode) => {
      element.classList.add("diagram-node");
      this.nodes.set(element, node);
    };
    const withoutPrefix = (id: string) =>
      id.startsWith(idPrefix) ? id.slice(idPrefix.length) : id;

    // Flowchart, class, state, ER, mind map, … nodes, with element ids like "flowchart-A-0".
    for (const element of svg.querySelectorAll("g.node, g.rough-node")) {
      // Class and entity boxes also list their members and attributes.
      const label = textOf(element.querySelector(".label-group, .label.name") ?? element);
      const domId = withoutPrefix(element.id);
      const id = /^(?:flowchart|state|classId|entity)-(.+)-\d+$/.exec(domId)?.[1] ?? label;
      add(element, { id: id || domId, label: label || id || domId });
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

    // Timeline periods and events.
    for (const element of svg.querySelectorAll("g.timeline-node")) {
      const label = textOf(element);
      add(element, { id: label, label });
    }
  }

  /** Scales large diagrams down to the panel width (and height, within reason). */
  private fit(): void {
    if (!this.naturalSize) {
      this.setZoom(1);
      return;
    }
    const style = getComputedStyle(this.canvas);
    const width =
      this.canvas.clientWidth -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight);
    const height =
      this.canvas.clientHeight -
      Number.parseFloat(style.paddingTop) -
      Number.parseFloat(style.paddingBottom);
    if (width <= 0 || height <= 0) {
      return; // Not laid out yet (e.g. the panel is hidden); the resize observer fits later.
    }
    const widthFit = width / this.naturalSize.width;
    const heightFit = height / this.naturalSize.height;
    this.setZoom(Math.min(1, widthFit, Math.max(heightFit, MIN_HEIGHT_FIT)));
  }

  private setZoom(value: number): void {
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
    this.diagram.style.zoom = String(this.zoom);
    this.zoomButton.textContent = `${Math.round(this.zoom * 100)}%`;
    this.zoomButton.title =
      this.fitting && this.zoom !== 1 ? "Show at actual size" : "Fit to the panel";
  }
}
