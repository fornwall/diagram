import { type DiagramLanguage, errorMessage, type FromWebview, type ToWebview } from "../protocol";
import { toCss } from "./colors";
import { pngDataUrl } from "./images";
import { runsCode } from "./optionSource";
import type { Renderer } from "./renderer";
import { readThemeColors } from "./vscodeTheme";

/** Reuse isolated canvases so validation never replaces the drawing or its editing draft. */
export class DraftRenderer {
  private readonly renderers = new Map<
    DiagramLanguage,
    { root: HTMLElement; renderer: Renderer }
  >();

  constructor(private readonly enqueue: (task: () => Promise<void>) => void) {}

  private async renderer(
    language: DiagramLanguage,
  ): Promise<{ root: HTMLElement; renderer: Renderer }> {
    const kept = this.renderers.get(language);
    if (kept) return kept;
    // Renderers use fixed element ids. A shadow root keeps them out of the visible panel's DOM.
    const host = document.createElement("div");
    host.inert = true;
    host.setAttribute("aria-hidden", "true");
    Object.assign(host.style, {
      position: "fixed",
      left: "-100000px",
      top: "0",
      pointerEvents: "none",
    });
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      .draft-canvas { position: relative; overflow: auto; padding: 16px; box-sizing: border-box; }
      .draft-canvas.chart-mode { overflow: hidden; padding: 0; }
      .draft-diagram { width: max-content; min-width: 100%; text-align: center; }
      .draft-diagram svg { display: inline-block; vertical-align: top; overflow: visible; }
      .draft-diagram foreignObject { overflow: visible; }
      #chart { position: absolute; inset: 8px 12px 10px; }
      #chart.scrolls { overflow: hidden auto; }
      #chart-focus { position: absolute; pointer-events: none; box-sizing: border-box; }
      #chart-status { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
    `;
    const root = document.createElement("div");
    root.className = "draft-canvas";
    shadow.append(style, root);
    document.body.append(host);
    let renderer: Renderer;
    try {
      if (language === "mermaid") {
        const { MermaidRenderer } = await import("./mermaidRenderer");
        const diagram = document.createElement("div");
        diagram.className = "draft-diagram";
        root.append(diagram);
        renderer = new MermaidRenderer(
          () => {},
          root,
          diagram,
          document.createElement("button"),
          this.enqueue,
          () => false,
        );
      } else {
        const { EChartsRenderer } = await import("./echartsRenderer");
        renderer = new EChartsRenderer(() => {}, root, readThemeColors);
      }
    } catch (error) {
      host.remove();
      throw error;
    }
    const created = { root, renderer };
    this.renderers.set(language, created);
    return created;
  }

  async validate(
    message: Extract<ToWebview, { type: "validateDraft" }>,
    size: { width: number; height: number },
  ): Promise<Extract<FromWebview, { type: "draftResult" }>> {
    let drawing: Renderer | undefined;
    try {
      if (message.language === "echarts" && runsCode(message.source)) {
        throw new Error(
          "Draft validation accepts ECharts data options without executable JavaScript.",
        );
      }
      const { root, renderer } = await this.renderer(message.language);
      drawing = renderer;
      root.style.width = `${Math.max(320, size.width || 1000)}px`;
      root.style.height = `${Math.max(240, size.height || 700)}px`;
      renderer.fitToPanel();
      const diagramType = await renderer.render(message.source, message.title);
      const items = renderer.drawnNodes?.() ?? [];
      if (items.length > 5000)
        throw new Error(
          "The draft has more than 5,000 graph items; simplify it before validating.",
        );
      let image: string | undefined;
      if (message.image) {
        const drawn = await renderer.modelImage(toCss(readThemeColors().background), []);
        image = await pngDataUrl(drawn.image, { maxSide: 1568, maxPixels: 1_150_000 });
      }
      return {
        type: "draftResult",
        requestId: message.requestId,
        diagramType,
        items,
        warnings: renderer.warnings?.() ?? [],
        ...(image && { image }),
      };
    } catch (error) {
      return { type: "draftResult", requestId: message.requestId, error: errorMessage(error) };
    } finally {
      drawing?.hide();
    }
  }
}
