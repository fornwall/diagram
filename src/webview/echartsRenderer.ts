// Renders Apache ECharts options, given as JSON or JavaScript, adapted to the panel size and
// VS Code theme. Charts draw as SVG; see src/webview/echartsLibrary.ts for why.

import type * as ECharts from "echarts/core";
import { type Annotation, errorMessage, type RepeatedName } from "../protocol";
import type { ThemeColors } from "./colors";
import { ChartFocus } from "./echartsFocus";
import {
  ChartItems,
  type ItemRef,
  itemKey,
  modelOf,
  parseItemKey,
  type SeriesModel,
} from "./echartsItems";
import { disableAnimation, focusHighlighted, keepUserState, layoutOption } from "./echartsLayout";
import type * as EChartsLibrary from "./echartsLibrary";
import { loadECharts } from "./echartsLoader";
import { type JsonObject, parseOption, seriesTypes } from "./echartsOption";
import { buildEChartsTheme } from "./echartsTheme";
import { type DiagramImage, standaloneSvg } from "./images";
import { type ItemClickHandler, type Renderer, UNMARKED, withModifier } from "./renderer";
import { readThemeColors } from "./vscodeTheme";

/** A zrender element, which can animate, and the group it is in. */
interface Animated {
  parent: Animated | null;
  stopAnimation(scope: undefined, forwardToLast: boolean): unknown;
}

export class EChartsRenderer implements Renderer {
  readonly noun = "chart";
  readonly itemNoun = "chart item";
  readonly sourceName = "ECharts option (JSON or JavaScript)";

  /** The chart's tab stop, around the element that ECharts draws in. */
  private readonly container: HTMLElement;
  private readonly drawing: HTMLElement;
  private readonly focus: ChartFocus;
  /** The library, loaded on the first chart. */
  private echarts: typeof EChartsLibrary | undefined;
  private chart: ECharts.ECharts | undefined;
  /** The items of the chart, worked out when first needed. */
  private chartItems: ChartItems | undefined;
  /** The current VS Code theme, read again after it changed. */
  private theme: { colors: ThemeColors; echarts: object } | undefined;
  private option: JsonObject | undefined;
  private title = "";
  /** The size, motion preference and blur of the last layout, which decide whether to lay out again. */
  private laidOut = "";
  private selectedKeys: ReadonlySet<string> = new Set();
  private selectionScheduled = false;
  /** The marks an agent put on the chart, which a new layout dispatches again. */
  private annotation: Annotation = UNMARKED;
  private hasHighlights = false;
  /** What ECharts shows as selected, as last reported by its selectchanged event. */
  private shownSelected: ECharts.SelectChangedEvent["selected"] = [];
  private resizeFrame = 0;
  private relayoutTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private readonly resizeObserver = new ResizeObserver(() => this.scheduleRelayout());

  constructor(
    private readonly itemClicked: ItemClickHandler,
    private readonly canvas: HTMLElement,
    /** The colors to draw in: the VS Code theme in the panel, the saved ones in a saved chart. */
    private readonly readColors: () => ThemeColors = readThemeColors,
  ) {
    this.container = document.createElement("div");
    this.container.id = "chart";
    this.container.hidden = true;
    // ECharts describes the chart on the element it draws in, as an image.
    this.drawing = document.createElement("div");
    this.drawing.id = "chart-drawing";
    Object.assign(this.drawing.style, { position: "absolute", inset: "0" });
    this.container.append(this.drawing);
    this.container.setAttribute("aria-describedby", this.drawing.id);
    canvas.append(this.container);
    this.focus = new ChartFocus(
      this.container,
      () => {
        const items = this.items();
        return this.chart && items && { chart: this.chart, items };
      },
      () => this.theme?.colors,
      (key, event) => {
        const node = this.items()?.node(key);
        if (node) this.itemClicked({ key, node }, withModifier(event));
        this.scheduleSelection();
      },
    );
    this.resizeObserver.observe(this.container);
    this.reducedMotion.addEventListener("change", () => this.relayout());
  }

  async render(source: string, title: string): Promise<string> {
    const option = parseOption(source);
    this.echarts ??= await loadECharts();
    this.canvas.classList.add("chart-mode");
    this.container.hidden = false;
    this.option = option;
    this.title = title;
    this.container.setAttribute("aria-label", title.trim() || "Chart");
    this.selectedKeys = new Set();
    this.annotation = UNMARKED;
    try {
      this.apply(true);
    } catch (error) {
      // A failed setOption can leave the instance broken: start over.
      this.disposeChart();
      throw new Error(`ECharts could not render this option: ${errorMessage(error)}`);
    }
    // ResizeObserver reports a size in a frame when it differs from the one it reported last, so it
    // misses a container that changes size and back between frames, such as for a status line
    // shown while rendering, or a hidden view shown again. Observing anew reports the size in the
    // next frame the container has one, which the chart may not have been drawn at.
    this.resizeObserver.unobserve(this.container);
    this.resizeObserver.observe(this.container);
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
    this.scheduleSelection();
  }

  labelOf(id: string): string | undefined {
    return this.items()?.labelOf(id);
  }

  repeatedNames(): RepeatedName[] {
    return this.items()?.repeatedNames() ?? [];
  }

  warnings(): string[] {
    return this.items()?.warnings ?? [];
  }

  showMarks(annotation: Annotation): void {
    const wasBlurring = this.blurring();
    const previousIds = new Set(this.annotation.marks.map(({ id }) => id));
    this.annotation = annotation;
    // Only dimming changes the option; relayout applies the highlights itself.
    if (this.blurring() !== wasBlurring) {
      this.relayout();
    } else if (
      previousIds.size !== annotation.marks.length ||
      annotation.marks.some(({ id }) => !previousIds.has(id))
    ) {
      // Notes, mark kinds and order live outside the chart. Re-highlighting unchanged items
      // would downplay every graphic, which is expensive with large series.
      this.highlightMarks(previousIds);
    }
  }

  async themeChanged(): Promise<void> {
    this.theme = undefined;
    this.relayout();
  }

  /** Complete pending animations before exporting, so an early export includes every item. */
  async toImage(background: string): Promise<DiagramImage> {
    if (!this.chart) throw new Error("There is no chart to make an image of.");
    // Export can precede the resize observer or its debounced layout after changing views.
    // Finish both now; hidden charts keep the dimensions of their last visible rendering.
    this.resizeChart();
    this.apply(false, true);
    clearTimeout(this.relayoutTimer);
    const svg = this.container.querySelector("svg");
    if (!svg) {
      throw new Error("There is no chart to make an image of.");
    }
    // ECharts' own export finishes the animations of what it draws, but labels fade in on the text
    // element that holds their lines, and groups move as a whole: finish those too, or the labels
    // of a chart exported as it appears are all but transparent.
    const drawing = this.chart.getZr();
    const finished = new Set<object>();
    for (const item of drawing.storage.getDisplayList(true)) {
      for (let element: Animated | null = item; element && !finished.has(element); ) {
        finished.add(element);
        element.stopAnimation(undefined, true);
        element = element.parent;
      }
    }
    drawing.refreshImmediately();
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
    const chart = echarts.init(this.drawing, theme, { renderer: "svg", width, height });
    chart.on("click", (params: ECharts.ECElementEvent) => {
      if (params.componentType !== "series") {
        return;
      }
      const hit = this.hitFor(params);
      if (hit) this.focus.clicked(hit.key);
      if (hit || !this.navigates(params)) {
        this.itemClicked(hit, withModifier(params.event?.event));
      }
      this.scheduleSelection();
    });
    chart.getZr().on("click", (event) => {
      if (!event.target) {
        this.itemClicked(undefined, withModifier(event.event));
      }
    });
    // After animations and redraws, such as for roaming, the focused item may be elsewhere.
    chart.on("finished", () => this.focus.chartDrawn());
    chart.on("selectchanged", (event) => {
      this.shownSelected = (event as ECharts.SelectChangedEvent).selected;
    });
    return chart;
  }

  private disposeChart(): void {
    this.focus.hide();
    cancelAnimationFrame(this.resizeFrame);
    clearTimeout(this.relayoutTimer);
    this.chart?.dispose();
    this.chart = undefined;
    this.chartItems = undefined;
    this.shownSelected = [];
    this.hasHighlights = false;
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
    const themeChanged = !this.theme && this.chart !== undefined;
    if (!this.theme) {
      const colors = this.readColors();
      this.theme = { colors, echarts: buildEChartsTheme(colors) };
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
    const shown = relayout ? this.chart : undefined;
    if (shown) {
      keepUserState(option, () => shown.getOption() as JsonObject);
    }
    const restoreState = shown && modelState(shown);
    if (themeChanged) {
      // An instance draws in the theme it was made with, and setTheme would make a new model,
      // without the state handed over below.
      this.chart?.dispose();
      this.chart = undefined;
    }
    this.chart ??= this.createChart(echarts, this.theme.echarts, width, height);
    if (restoreState) {
      // The state goes to the model of the option before it is laid out, and resize draws it.
      this.chart.setOption(option, { notMerge: true, lazyUpdate: true });
      restoreState(this.chart);
      this.chart.resize({ width, height });
    } else {
      this.chart.setOption(option, { notMerge: true });
    }
    this.laidOut = laidOut;
    // The items name the data of the model of the previous option, which they would keep alive.
    this.chartItems = undefined;
    this.shownSelected = [];
    this.syncSelection();
    this.highlightMarks();
    this.focus.chartChanged();
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
  private highlightMarks(previousIds?: ReadonlySet<string>): void {
    const chart = this.chart;
    if (!chart) {
      return;
    }
    const items = (ids: Iterable<string>) => [...ids].flatMap((id) => this.items()?.find(id) ?? []);
    if (this.hasHighlights) {
      if (previousIds) {
        const current = new Set(this.annotation.marks.map(({ id }) => id));
        const removed = items([...previousIds].filter((id) => !current.has(id)));
        if (removed.length > 0) {
          chart.dispatchAction({ type: "downplay", batch: removed });
        }
      } else {
        chart.dispatchAction({ type: "downplay" });
      }
    }
    // Downplay clears ECharts' blur state, including any focus set by the source option itself.
    // Restore the remaining marks together, while only downplaying the removed items' graphics.
    const batch = items(this.annotation.marks.map(({ id }) => id));
    if (batch.length > 0) {
      // One action, so that ECharts works out what to blur once, around all of the marks.
      chart.dispatchAction({ type: "highlight", batch });
    }
    this.hasHighlights = this.annotation.marks.length > 0;
  }

  /** The items of the chart, by key, id and name. */
  private items(): ChartItems | undefined {
    if (this.chart) this.chartItems ??= new ChartItems(this.chart);
    return this.chartItems;
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
      this.resizeChart();
      // Layout decisions (legend position, label rotation, …) follow once resizing settles. They
      // can be due without resizing, for a layout made for a size the container had briefly.
      clearTimeout(this.relayoutTimer);
      this.relayoutTimer = setTimeout(() => this.relayout(), 150);
    });
  }

  private resizeChart(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (
      this.chart &&
      width > 0 &&
      height > 0 &&
      (this.chart.getWidth() !== width || this.chart.getHeight() !== height)
    ) {
      this.chart.resize({ width, height });
    }
  }

  /** The item a click on a series hit, if it hit one. */
  private hitFor({ seriesIndex = 0, dataType, dataIndex }: ECharts.ECElementEvent) {
    const key = itemKey({ seriesIndex, dataType, dataIndex });
    const node = this.items()?.node(key);
    return node && { key, node };
  }

  /**
   * Whether a click on a part of a series that is no item zooms out or drills up, which leaves the
   * selection as it is: a treemap's breadcrumb, the root ECharts adds above a sunburst, drawn in
   * its middle once drilled down, or that above a treemap, drawn between its rectangles, where a
   * click zooms out unless the series' nodeClick says otherwise.
   */
  private navigates({ seriesType, seriesIndex = 0, selfType }: ECharts.ECElementEvent): boolean {
    if (selfType === "breadcrumb" || seriesType === "sunburst") return true;
    const series = this.chart && modelOf(this.chart).getSeriesByIndex(seriesIndex);
    return seriesType === "treemap" && series?.get("nodeClick") === "zoomToNode";
  }

  /** Coalesces the panel and ECharts click handlers into one selection update. */
  private scheduleSelection(): void {
    if (this.selectionScheduled) return;
    this.selectionScheduled = true;
    queueMicrotask(() => {
      this.selectionScheduled = false;
      this.syncSelection();
    });
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

/**
 * What the user changed in a shown chart that ECharts keeps in its model rather than its option,
 * and a new option would start over from: where the force layout of a graph left its nodes, which
 * it would place anew at random, the node a treemap or sunburst is drilled down to, and the nodes
 * of a tree that are expanded. Returns how to hand it to the model of the same option laid out
 * anew, before that is laid out.
 */
function modelState(chart: ECharts.ECharts): (chart: ECharts.ECharts) => void {
  const restores: ((series: SeriesModel) => void)[] = [];
  modelOf(chart).eachRawSeries((series) => {
    const points = series.preservedPoints;
    const viewRoot = series.getViewRoot?.().dataIndex;
    const tree = series.subType === "tree" ? series.getRawData().tree : undefined;
    const expanded: boolean[] = [];
    if (tree) {
      for (let index = 0, count = series.getRawData().count(); index < count; index++) {
        expanded[index] = tree.getNodeByDataIndex(index).isExpand;
      }
    }
    restores[series.componentIndex] = (next) => {
      next.preservedPoints = points;
      const nextTree = next.getRawData().tree;
      if (viewRoot !== undefined && nextTree) {
        next.resetViewRoot?.(nextTree.getNodeByDataIndex(viewRoot));
      }
      expanded.forEach((isExpand, index) => {
        const node = nextTree?.getNodeByDataIndex(index);
        if (node) node.isExpand = isExpand;
      });
    };
  });
  return (next) => {
    modelOf(next).eachRawSeries((series) => restores[series.componentIndex]?.(series));
  };
}
