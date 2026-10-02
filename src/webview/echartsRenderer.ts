// Renders Apache ECharts options, given as JSON or JavaScript, adapted to the panel size and
// VS Code theme. Charts draw as SVG; see src/webview/echartsLibrary.ts for why.

import type * as ECharts from "echarts/core";
import { type Annotation, errorMessage, isPlainObject } from "../protocol";
import type { ThemeColors } from "./colors";
import { disableAnimation, focusHighlighted, keepUserState, layoutOption } from "./echartsLayout";
import type * as EChartsLibrary from "./echartsLibrary";
import { asArray, baseOption, type JsonObject, parseOption, seriesTypes } from "./echartsOption";
import { buildEChartsTheme } from "./echartsTheme";
import { type DiagramImage, standaloneSvg } from "./images";
import { type Hit, type Renderer, type RendererHost, UNMARKED, withModifier } from "./renderer";
import { readThemeColors } from "./vscodeTheme";

/** A data item, or a node or edge of a graph, as ECharts' select actions refer to it. */
interface ItemRef {
  seriesIndex: number;
  dataType?: string | undefined;
  dataIndex: number;
}

function valueText(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  if (Array.isArray(value)) {
    return `(${value.map((item) => String(item)).join(", ")})`;
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

const itemKey = ({ seriesIndex, dataType, dataIndex }: ItemRef) =>
  `${seriesIndex}:${dataType ?? ""}:${dataIndex}`;

function parseItemKey(key: string): ItemRef {
  const [series, dataType, data] = key.split(":");
  return { seriesIndex: Number(series), dataType: dataType || undefined, dataIndex: Number(data) };
}

/** Resolves the panel's "Series/Name" ids, including unnamed series and names containing slashes. */
function itemQuery(
  id: string,
  series: JsonObject[],
): { name: string; seriesIndex?: number; seriesName?: string } {
  let prefixLength = 0;
  let seriesIndex: number | undefined;
  if (series.length > 1) {
    for (const [index, each] of series.entries()) {
      const prefix = `${each.name || `Series ${index + 1}`}/`;
      if (prefix.length > prefixLength && id.startsWith(prefix)) {
        prefixLength = prefix.length;
        seriesIndex = index;
      }
    }
  }
  if (seriesIndex !== undefined) {
    return { seriesIndex, name: id.slice(prefixLength) };
  }
  // Dataset dimensions can supply a series name absent from the source option.
  const slash = series.length > 1 ? id.indexOf("/") : -1;
  return slash > 0 ? { seriesName: id.slice(0, slash), name: id.slice(slash + 1) } : { name: id };
}

export class EChartsRenderer implements Renderer {
  readonly noun = "chart";
  readonly itemNoun = "chart item";
  readonly sourceName = "ECharts option (JSON or JavaScript)";

  private readonly container: HTMLElement;
  /** The library, loaded on the first chart. */
  private echarts: typeof EChartsLibrary | undefined;
  private chart: ECharts.ECharts | undefined;
  /** The current VS Code theme, read again after it changed. */
  private theme: { colors: ThemeColors; echarts: object } | undefined;
  private option: JsonObject | undefined;
  private title = "";
  /** The size, motion preference and blur of the last layout, which decide whether to lay out again. */
  private laidOut = "";
  private selectedKeys: ReadonlySet<string> = new Set();
  /** The marks an agent put on the chart, which a new layout dispatches again. */
  private annotation: Annotation = UNMARKED;
  /** What ECharts shows as selected, as last reported by its selectchanged event. */
  private shownSelected: ECharts.SelectChangedEvent["selected"] = [];
  private resizeFrame = 0;
  private relayoutTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  constructor(
    private readonly host: RendererHost,
    private readonly canvas: HTMLElement,
    /** The colors to draw in: the VS Code theme in the panel, the saved ones in a saved chart. */
    private readonly readColors: () => ThemeColors = readThemeColors,
  ) {
    this.container = document.createElement("div");
    this.container.id = "chart";
    this.container.hidden = true;
    canvas.append(this.container);
    new ResizeObserver(() => this.scheduleRelayout()).observe(this.container);
    this.reducedMotion.addEventListener("change", () => this.relayout());
  }

  async render(source: string, title: string): Promise<string> {
    const option = parseOption(source);
    this.echarts ??= await import("./echartsLibrary");
    this.canvas.classList.add("chart-mode");
    this.container.hidden = false;
    this.option = option;
    this.title = title;
    this.selectedKeys = new Set();
    this.annotation = UNMARKED;
    try {
      this.apply(true);
    } catch (error) {
      // A failed setOption can leave the instance broken: start over.
      this.disposeChart();
      throw new Error(`ECharts could not render this option: ${errorMessage(error)}`);
    }
    return seriesTypes(option);
  }

  hide(): void {
    this.disposeChart();
    this.option = undefined;
    this.container.hidden = true;
    this.canvas.classList.remove("chart-mode");
  }

  showSelection(keys: ReadonlySet<string>): void {
    this.selectedKeys = keys;
    // ECharts toggles the selection of clicked items itself, after our click handlers ran.
    queueMicrotask(() => this.syncSelection());
  }

  showMarks(annotation: Annotation): void {
    const wasBlurring = this.blurring();
    this.annotation = annotation;
    // Only dimming changes the option; relayout applies the highlights itself.
    if (this.blurring() !== wasBlurring) {
      this.relayout();
    } else {
      this.highlightMarks();
    }
  }

  async themeChanged(): Promise<void> {
    this.theme = undefined;
    this.relayout();
  }

  /**
   * The chart as it is drawn. ECharts' SVG renderer writes real `text` elements and keeps its
   * tooltips in separate HTML outside the SVG, so what is on screen is already the whole image.
   */
  async toImage(background: string): Promise<DiagramImage> {
    const svg = this.container.querySelector("svg");
    if (!svg) {
      throw new Error("There is no chart to make an image of.");
    }
    return standaloneSvg(svg, background);
  }

  formatForEditing(source: string): string {
    if (source.includes("\n")) {
      return source;
    }
    try {
      return JSON.stringify(JSON.parse(source), null, 2);
    } catch {
      // Not JSON: an option written as JavaScript, or one with an error, stays as it is.
      return source;
    }
  }

  private createChart(
    echarts: typeof EChartsLibrary,
    theme: object,
    width: number,
    height: number,
  ): ECharts.ECharts {
    // The SVG renderer is registered in echartsLibrary.ts, but each instance still has to ask for
    // it: ECharts draws on a canvas unless told otherwise.
    const chart = echarts.init(this.container, theme, { renderer: "svg", width, height });
    chart.on("click", (params: ECharts.ECElementEvent) => {
      if (params.componentType !== "series") {
        return;
      }
      this.host.itemClicked(this.hitFor(params), withModifier(params.event?.event));
      queueMicrotask(() => this.syncSelection());
    });
    chart.getZr().on("click", (event) => {
      if (!event.target) {
        this.host.itemClicked(undefined, withModifier(event.event));
      }
    });
    chart.on("selectchanged", (event) => {
      this.shownSelected = (event as ECharts.SelectChangedEvent).selected;
    });
    return chart;
  }

  private disposeChart(): void {
    cancelAnimationFrame(this.resizeFrame);
    clearTimeout(this.relayoutTimer);
    this.chart?.dispose();
    this.chart = undefined;
    this.shownSelected = [];
    this.laidOut = "";
  }

  /**
   * Sets the option, laid out for the current size and theme. A relayout of the shown chart keeps
   * what the user changed in it, and is skipped when the layout stays the same.
   */
  private apply(animate: boolean, relayout = false): void {
    const echarts = this.echarts;
    if (!echarts) {
      return;
    }
    // Source view has no DOM dimensions. Keep an existing chart's size, or use an initial size
    // for both the SVG and its layout; the resize observer fits it when the rendering is shown.
    const width = this.container.clientWidth || this.chart?.getWidth() || 800;
    const height = this.container.clientHeight || this.chart?.getHeight() || 500;
    const reducedMotion = this.reducedMotion.matches;
    const laidOut = `${width}:${height}:${reducedMotion}:${this.blurring()}`;
    // Check layout inputs before copying the data. Retaining a serialized option would also
    // duplicate every data point in memory just to detect unchanged layouts.
    if (relayout && this.theme && laidOut === this.laidOut) {
      return;
    }
    if (!this.theme) {
      const colors = this.readColors();
      this.theme = { colors, echarts: buildEChartsTheme(colors) };
      this.chart?.setTheme(this.theme.echarts);
    }
    const option = layoutOption(this.option ?? {}, {
      width,
      height,
      title: this.title,
      colors: this.theme.colors,
      reducedMotion,
    });
    if (!animate) {
      disableAnimation(option);
    }
    if (this.blurring()) {
      focusHighlighted(option);
    }
    if (relayout && this.chart) {
      keepUserState(option, this.chart.getOption() as JsonObject);
    }
    this.chart ??= this.createChart(echarts, this.theme.echarts, width, height);
    this.chart.setOption(option, { notMerge: true });
    this.laidOut = laidOut;
    this.shownSelected = [];
    this.syncSelection();
    this.highlightMarks();
  }

  /** Whether the chart fades what is not marked, which needs something to be marked at all. */
  private blurring(): boolean {
    return this.annotation.dim && this.annotation.marks.length > 0;
  }

  /**
   * Marks items the way ECharts marks them itself: the marked ones highlighted, and the rest blurred
   * while the annotation dims the chart. The color a mark reads in cannot come along, as emphasis is
   * styled per series rather than per item; the notes above the chart carry it instead.
   */
  private highlightMarks(): void {
    const chart = this.chart;
    if (!chart) {
      return;
    }
    // Drops the marks from before, and any blur with them.
    chart.dispatchAction({ type: "downplay" });
    const series = asArray(baseOption(this.option ?? {}).series);
    const batch = this.annotation.marks.map(({ id }) => itemQuery(id, series));
    if (batch.length > 0) {
      // One action, so that ECharts works out what to blur once, around all of the marks.
      chart.dispatchAction({ type: "highlight", batch });
    }
  }

  /** Lays out the shown chart again, keeping what is shown if that fails. */
  private relayout(): void {
    if (this.chart && this.option) {
      try {
        this.apply(false, true);
      } catch (error) {
        console.error(error);
      }
    }
  }

  private scheduleRelayout(): void {
    cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = requestAnimationFrame(() => {
      // The panel can become hidden between the resize observation and this frame.
      if (!this.chart || this.container.clientWidth === 0 || this.container.clientHeight === 0) {
        return;
      }
      this.chart.resize({ width: "auto", height: "auto" });
      // Layout decisions (legend position, label rotation, …) follow once resizing settles.
      clearTimeout(this.relayoutTimer);
      this.relayoutTimer = setTimeout(() => this.relayout(), 150);
    });
  }

  private hitFor(params: ECharts.ECElementEvent): Hit {
    const { seriesIndex = 0, dataIndex, dataType } = params;
    const data: unknown = params.data;
    let label: string | undefined;
    if (dataType === "edge" && isPlainObject(data)) {
      label = `${String(data.source)} → ${String(data.target)}`;
    } else if (typeof params.name === "string" && params.name.trim()) {
      // ECharts resolves annotations by the exact data name, including surrounding spaces.
      label = params.name;
    }
    label ??= valueText(params.value) ?? `Item ${dataIndex + 1}`;
    const seriesCount = asArray(baseOption(this.option ?? {}).series).length;
    const rawName = params.seriesName;
    // ECharts names unnamed series "series\0<index>".
    const name =
      typeof rawName === "string" && rawName && !rawName.includes("\u0000")
        ? rawName
        : `Series ${seriesIndex + 1}`;
    return {
      key: itemKey({ seriesIndex, dataType, dataIndex }),
      node: { id: seriesCount > 1 ? `${name}/${label}` : label, label },
    };
  }

  /** Makes the items ECharts shows as selected match the selection. */
  private syncSelection(): void {
    const chart = this.chart;
    if (!chart) {
      return;
    }
    const shown = new Set<string>();
    const stale: ItemRef[] = [];
    for (const { dataIndex, ...series } of this.shownSelected) {
      for (const index of dataIndex) {
        const item = { ...series, dataIndex: index };
        const key = itemKey(item);
        shown.add(key);
        if (!this.selectedKeys.has(key)) {
          stale.push(item);
        }
      }
    }
    if (stale.length > 0) {
      chart.dispatchAction({ type: "unselect", batch: stale });
    }
    const added: ItemRef[] = [];
    for (const key of this.selectedKeys) {
      if (!shown.has(key)) {
        added.push(parseItemKey(key));
      }
    }
    if (added.length > 0) {
      chart.dispatchAction({ type: "select", batch: added });
    }
  }
}
