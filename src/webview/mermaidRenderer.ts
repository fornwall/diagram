// Renders Mermaid diagrams as SVG, scaled to fit the panel.

import mermaid from "mermaid";
import type { DiagramNode } from "../protocol";
import type { Renderer, RendererHost } from "./renderer";
import { isDarkTheme } from "./vscodeTheme";

const NODE_SELECTOR = [
  "g.node", // flowchart, class, state, ER, mindmap, ...
  "g.actor-man", // sequence diagram actors
  "rect.actor",
  "text.actor",
  "g.mindmap-node",
  "g.eventWrapper", // timeline
  "g.task", // gantt
].join(", ");

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
/** Fitting a tall diagram to the panel height never shrinks it below this; it scrolls instead. */
const MIN_HEIGHT_FIT = 0.6;

function initializeMermaid(): void {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: isDarkTheme() ? "dark" : "default",
    fontFamily: getComputedStyle(document.body).getPropertyValue("--vscode-font-family"),
  });
}

export class MermaidRenderer implements Renderer {
  readonly language = "mermaid";
  readonly zoomable = true;
  readonly itemNoun = "node";

  private renderCounter = 0;
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
    initializeMermaid();
    diagram.addEventListener("click", (event) => {
      const node = event.target instanceof Element ? this.nodeFor(event.target) : undefined;
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
    const id = `diagram-svg-${++this.renderCounter}`;
    try {
      // Parse first, so that syntax errors do not leave Mermaid's error graphic in the DOM.
      await mermaid.parse(source);
      const { svg, diagramType, bindFunctions } = await mermaid.render(id, source);
      this.diagram.innerHTML = svg;
      bindFunctions?.(this.diagram);
      this.diagram.hidden = false;
      this.displayedSource = source;
      this.prepareSvg();
      if (this.fitting) {
        this.fit();
      } else {
        this.setZoom(this.zoom);
      }
      return diagramType;
    } catch (error) {
      // Remove the temporary elements Mermaid leaves behind when rendering fails.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
      throw error;
    }
  }

  hide(): void {
    this.diagram.hidden = true;
    this.diagram.innerHTML = "";
    this.displayedSource = undefined;
    this.naturalSize = undefined;
  }

  showSelection(keys: ReadonlySet<string>): void {
    for (const element of this.diagram.querySelectorAll(NODE_SELECTOR)) {
      const node = this.nodeFor(element);
      element.classList.toggle("diagram-selected", node !== undefined && keys.has(node.id));
    }
  }

  async themeChanged(): Promise<void> {
    initializeMermaid();
    if (this.displayedSource !== undefined) {
      const selected = Array.from(this.diagram.querySelectorAll(".diagram-selected"), (element) =>
        this.nodeFor(element),
      ).flatMap((node) => (node ? [node.id] : []));
      try {
        await this.render(this.displayedSource);
        this.showSelection(new Set(selected));
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

  private nodeFor(target: Element): DiagramNode | undefined {
    const element = target.closest(NODE_SELECTOR);
    if (!element || !this.diagram.contains(element)) {
      return undefined;
    }
    // Sequence diagram actors consist of a box and a text that are siblings; select by name.
    const label = (
      element.matches("rect.actor")
        ? element.parentElement?.querySelector("text.actor")?.textContent
        : element.textContent
    )
      ?.replace(/\s+/g, " ")
      .trim();
    const dataId = element.getAttribute("data-id");
    const generatedId = /(?:flowchart|state|classId|entity)-(.+)-\d+$/.exec(element.id)?.[1];
    const id = dataId ?? generatedId ?? label ?? element.id;
    return { id, label: label || id };
  }

  /** Gives the SVG its natural size, so that zooming (and fitting) scales it as a whole. */
  private prepareSvg(): void {
    this.naturalSize = undefined;
    const svg = this.diagram.querySelector("svg");
    const viewBox = svg?.viewBox.baseVal;
    if (!svg || !viewBox || viewBox.width <= 0 || viewBox.height <= 0) {
      return;
    }
    this.naturalSize = { width: viewBox.width, height: viewBox.height };
    svg.setAttribute("width", String(viewBox.width));
    svg.setAttribute("height", String(viewBox.height));
    svg.style.maxWidth = "none";
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
