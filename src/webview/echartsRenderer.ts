// Renders Apache ECharts options, given as JSON or JavaScript, in the VS Code theme. Charts draw
// as SVG; see src/webview/echartsLibrary.ts for why.

import type * as ECharts from "echarts/core";
import { type Annotation, errorMessage, type RepeatedName } from "../protocol";
import type { ThemeColors } from "./colors";
import { capWarnings, dataWarnings } from "./echartsChecks";
import { ChartFocus, ChartNavigation } from "./echartsFocus";
import {
  ChartItems,
  clickedIndex,
  drawnRef,
  type ItemRef,
  itemKey,
  modelOf,
  openDataView,
  parseItemKey,
} from "./echartsItems";
import type * as EChartsLibrary from "./echartsLibrary";
import { loadECharts } from "./echartsLoader";
import { type JsonObject, optionWarnings, parseOption, seriesTypes } from "./echartsOption";
import { buildEChartsTheme } from "./echartsTheme";
import type { DiagramImage, ModelImage } from "./images";
import { describeCallbackError, formatOption } from "./optionSource";
import {
  type Hit,
  type ItemClickHandler,
  type Renderer,
  UNMARKED,
  warningsMayChange,
  withModifier,
} from "./renderer";
import {
  type Area,
  areaAround,
  drawingArea,
  standaloneSvg,
  textSize,
  withTextIn,
} from "./svgImage";
import { readThemeColors } from "./vscodeTheme";

/** A zrender element, which can animate, and the group it is in. */
interface Animated {
  parent: Animated | null;
  stopAnimation(scope: undefined, forwardToLast: boolean): unknown;
}

/**
 * Whether ECharts threw in the middle of an action or a draw, which it marks the start and end of
 * on the instance, and then refuses to take an option or a size.
 */
const stuck = (chart: ECharts.ECharts) =>
  (chart as unknown as { __flagInMainProcess?: boolean }).__flagInMainProcess === true;

/** Whether the event is a click after the first of a double click. */
const repeated = (event: unknown) => event instanceof MouseEvent && event.detail > 1;

/** The type of component, such as "toolbox", that ECharts draws in the group, if any. */
function componentOf(group: object): string | undefined {
  return (group as { __ecComponentInfo?: { mainType: string } | null }).__ecComponentInfo?.mainType;
}

export class EChartsRenderer implements Renderer {
  readonly noun = "chart";
  readonly itemNoun = "chart item";
  readonly sourceName = "ECharts option (JSON or JavaScript)";
  // Legends, zooming, the toolbox and resizing redraw the chart without a new option.
  readonly changesInPlace = true;

  /** The chart's tab stop, around the element that ECharts draws in. */
  private readonly container: HTMLElement;
  get focusTarget(): HTMLElement {
    return this.container;
  }
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
  /** The source of the option, which says where a callback that throws is. */
  private source = "";
  /** What the callbacks of the option threw once the chart was drawn, such as on hovering an item. */
  private callbackWarnings: string[] = [];
  /** What the chart draws of its data other than its option meant. */
  private dataWarnings: string[] = [];
  private selectedKeys: ReadonlySet<string> = new Set();
  private selectionScheduled = false;
  /** The marks an agent put on the chart, which drawing it anew dispatches again. */
  private annotation: Annotation = UNMARKED;
  private hasHighlights = false;
  /** What ECharts shows as selected, as last reported by its selectchanged event. */
  private shownSelected: ECharts.SelectChangedEvent["selected"] = [];
  /**
   * Whether ECharts finished drawing while an option was being applied: it draws an option with
   * nothing to animate as it is set, before the focus is told that the chart changed.
   */
  private drawnWhileApplying = false;
  private resizeFrame = 0;
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private readonly resizeObserver = new ResizeObserver(() => this.scheduleResize());

  constructor(
    private readonly itemClicked: ItemClickHandler,
    private readonly canvas: HTMLElement,
    /**
     * Whether the tab is hidden behind another. Its page then has the size of an empty frame, 300
     * by 150 pixels, which a chart is not resized to.
     */
    private readonly tabHidden: () => boolean,
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
      () => this.chart,
      () => this.items(),
      () => this.theme?.colors,
      (key, event) => {
        const node = this.items()?.node(key);
        if (node) this.itemClicked({ key, node }, withModifier(event));
        this.scheduleSelection();
      },
      (action) => this.guard(action),
    );
    this.resizeObserver.observe(this.container);
    // ECharts adds the toolbox's data view to the element it draws in: mark it, for chart.css to
    // fit it to the chart.
    new MutationObserver(() => {
      if (this.chart) openDataView(this.chart)?.classList.add("chart-data-view");
    }).observe(this.drawing, { childList: true });
    this.reducedMotion.addEventListener("change", () => void this.themeChanged());
    // ECharts lets what a callback throws in a handler of its own, such as a tooltip's formatter
    // on hovering an item, through to the page.
    window.addEventListener("error", ({ error }) => this.reportCallbackError(error));
  }

  async render(source: string, title: string): Promise<string> {
    const option = parseOption(source);
    this.echarts ??= await loadECharts();
    this.canvas.classList.add("chart-mode");
    this.container.hidden = false;
    this.option = option;
    this.source = source;
    this.callbackWarnings = [];
    this.container.setAttribute("aria-label", title.trim() || "Chart");
    this.selectedKeys = new Set();
    this.annotation = UNMARKED;
    try {
      this.apply();
    } catch (error) {
      // A failed setOption can leave the instance broken: start over.
      this.disposeChart();
      throw new Error(
        describeCallbackError(source, error, "drawn") ??
          `ECharts could not render this option: ${errorMessage(error)}`,
      );
    }
    this.dataWarnings = this.checkData(option);
    // ResizeObserver reports a size in a frame when it differs from the one it reported last, so it
    // misses a container that changes size and back between frames, such as for a status line
    // shown while rendering, or a hidden view shown again. Observing anew reports the size in the
    // next frame the container has one, which the chart may not have been drawn at.
    this.resizeObserver.unobserve(this.container);
    this.resizeObserver.observe(this.container);
    return seriesTypes(option);
  }

  /** Shows the keyboard focus of another chart from its first item, where a revision keeps it. */
  fitToPanel(): void {
    this.focus.forget();
  }

  hide(): void {
    this.disposeChart();
    this.theme = undefined;
    this.option = undefined;
    this.source = "";
    this.callbackWarnings = [];
    this.dataWarnings = [];
    this.container.hidden = true;
    this.canvas.classList.remove("chart-mode");
  }

  showSelection(keys: ReadonlySet<string>): void {
    this.selectedKeys = keys;
    // ECharts toggles the selection of clicked items itself, after our click handlers ran.
    this.scheduleSelection();
  }

  repeatedNames(): RepeatedName[] {
    return this.items()?.repeatedNames() ?? [];
  }

  hitsOf(ids: readonly string[]): Hit[] {
    const items = this.items();
    return ids.flatMap((id) => {
      // By its id alone, which a label that several items share is not.
      const [ref, ...others] = items?.find(id) ?? [];
      const key = ref && others.length === 0 ? itemKey(ref) : undefined;
      const node = key === undefined ? undefined : items?.node(key);
      return key !== undefined && node?.id === id ? [{ key, node }] : [];
    });
  }

  warnings(): string[] {
    return capWarnings([
      ...(this.option ? optionWarnings(this.option) : []),
      ...(this.items()?.warnings ?? []),
      ...this.dataWarnings,
      ...this.callbackWarnings,
    ]);
  }

  /** Tells of what a callback of the option threw once the chart was drawn, the first time. */
  private reportCallbackError(error: unknown): void {
    const warning = this.option && describeCallbackError(this.source, error, "used");
    if (!warning || this.callbackWarnings.includes(warning)) return;
    this.callbackWarnings.push(warning);
    warningsMayChange(this.canvas);
  }

  /** What the chart draws of its data other than the option meant, which a failing check leaves unsaid. */
  private checkData(option: JsonObject): string[] {
    try {
      return this.chart ? dataWarnings(this.chart, option) : [];
    } catch (error) {
      console.error(error);
      return [];
    }
  }

  showMarks(annotation: Annotation): void {
    const wasBlurring = this.blurring();
    const previousIds = new Set(this.annotation.marks.map(({ id }) => id));
    this.annotation = annotation;
    // Only dimming changes the option; redraw applies the highlights itself.
    if (this.blurring() !== wasBlurring) {
      this.redraw();
    } else if (
      previousIds.size !== annotation.marks.length ||
      annotation.marks.some(({ id }) => !previousIds.has(id))
    ) {
      // Mark kinds and order do not show on the chart. Re-highlighting unchanged items
      // would downplay every graphic, which is expensive with large series.
      this.guard(() => this.highlightMarks(previousIds));
    }
  }

  itemBounds(id: string): DOMRect | undefined {
    if (!this.chart) return undefined;
    const navigation = new ChartNavigation(this.chart);
    const refs = this.find([id]);
    const box = refs.length === 1 && refs[0] ? navigation.box(refs[0]) : undefined;
    if (!box) return undefined;
    const origin = this.drawing.getBoundingClientRect();
    return new DOMRect(origin.left + box.x, origin.top + box.y, box.width, box.height);
  }

  async themeChanged(): Promise<void> {
    this.theme = undefined;
    this.redraw();
  }

  /**
   * Resizes the chart once its tab is shown. The resize observer reports nothing if the tab is
   * shown at the size it last reported, though the chart kept its size while hidden.
   */
  tabShown(): void {
    this.scheduleResize();
  }

  /**
   * An image of the chart at the size of the panel, with its animations finished, so that an early
   * export includes every item, and without what the pointer and the toolbox add to it.
   */
  async toImage(background: string): Promise<DiagramImage> {
    return this.still(true, (svg) => standaloneSvg(svg, background));
  }

  /**
   * The chart as {@link toImage} draws it, but as its option alone draws it, without the selection
   * and the marks, as a Mermaid diagram's image is. The area around
   * items takes in the text it cuts into, such as their labels on an axis.
   */
  async modelImage(background: string, ids: readonly string[]): Promise<ModelImage> {
    return this.still(false, (svg, chart) => {
      const drawing = drawingArea(svg);
      const navigation = new ChartNavigation(chart);
      const boxes: Area[] = [];
      const missing: string[] = [];
      for (const id of ids) {
        // Every item of a name that several go by, which only a mark must tell apart.
        const before = boxes.length;
        for (const ref of this.find([id])) {
          const box = navigation.box(ref);
          if (box) boxes.push(box);
        }
        if (boxes.length === before) missing.push(id);
      }
      const around = areaAround(drawing, boxes);
      const area = around && withTextIn(svg, drawing, around);
      const { clientWidth: width, clientHeight: height } = this.container;
      return {
        image: standaloneSvg(svg, background, area),
        view: {
          width: drawing.width,
          height: drawing.height,
          area: area && { width: area.width, height: area.height },
          textSize: textSize(svg),
          panel:
            !this.tabHidden() && width > 0 && height > 0 ? { width, height, zoom: 1 } : undefined,
          missing,
        },
      };
    });
  }

  /**
   * Has the chart drawn as {@link toImage} describes, with its marks highlighted and its selection,
   * or without them, which it shows again afterwards.
   */
  private async still<T>(
    marked: boolean,
    draw: (svg: SVGSVGElement, chart: ECharts.ECharts) => T,
  ): Promise<T> {
    // Export can precede the resize observer after changing views.
    this.resize();
    const chart = this.chart;
    const svg = this.container.querySelector("svg");
    if (!chart || !svg) throw new Error("There is no chart to make an image of.");
    // The pointer can still rest on the chart, as when the image is exported from the context menu
    // with the keyboard: leave out the axis pointer and the emphasis it shows, as if it had left.
    // Downplaying everything clears the marks too, so highlight them again, if they are wanted.
    chart.dispatchAction({ type: "updateAxisPointer", currTrigger: "leave" });
    chart.dispatchAction({ type: "downplay" }, { silent: true });
    const selected = marked
      ? []
      : this.shownSelected.flatMap(({ dataIndex, ...series }) =>
          dataIndex.map((index) => ({ ...series, dataIndex: index })),
        );
    if (marked) this.highlightMarked();
    else if (selected.length > 0) chart.dispatchAction({ type: "unselect", batch: selected });
    const drawing = chart.getZr();
    const finish = () => {
      // ECharts applies the states on its next frame: run it now.
      drawing.animation.trigger("frame");
      // ECharts' own export finishes the animations of what it draws, but labels fade in on the
      // text element that holds their lines, and groups move as a whole: finish those too, or the
      // labels of a chart exported as it appears are all but transparent.
      const finished = new Set<object>();
      for (const item of drawing.storage.getDisplayList(true)) {
        for (let element: Animated | null = item; element && !finished.has(element); ) {
          finished.add(element);
          element.stopAnimation(undefined, true);
          element = element.parent;
        }
      }
    };
    finish();
    // Leave out the toolbox, as ECharts does from its own images: its buttons do nothing there.
    const toolboxes = drawing.storage
      .getRoots()
      .filter((root) => !root.ignore && componentOf(root) === "toolbox");
    for (const toolbox of toolboxes) toolbox.ignore = true;
    try {
      drawing.refreshImmediately();
      return draw(svg, chart);
    } finally {
      for (const toolbox of toolboxes) toolbox.ignore = false;
      if (!marked) {
        // Shown again as they were, rather than fading in: the marks after the selection, which
        // ECharts does not fade around them.
        if (selected.length > 0) chart.dispatchAction({ type: "select", batch: selected });
        this.highlightMarked();
        finish();
      }
      if (toolboxes.length > 0 || !marked) drawing.refresh();
    }
  }

  formatForEditing(source: string): string {
    return formatOption(source);
  }

  private createChart(echarts: typeof EChartsLibrary, theme: object): ECharts.ECharts {
    // Source view has no size, and a hidden tab none to go by: the resize observer fits the chart
    // once shown.
    const { clientWidth, clientHeight } = this.container;
    const sized = !this.tabHidden() && clientWidth > 0 && clientHeight > 0;
    // The SVG renderer is registered in echartsLibrary.ts, but each instance still has to ask for
    // it: ECharts draws on a canvas unless told otherwise.
    const chart = echarts.init(this.drawing, theme, {
      renderer: "svg",
      width: sized ? clientWidth : 800,
      height: sized ? clientHeight : 500,
    });
    chart.on("click", (params: ECharts.ECElementEvent) => {
      if (params.componentType !== "series") {
        return;
      }
      // The first click of a double click acted already: a second would undo its selection, or
      // open the item's link once more. ECharts toggles its selection anyway, which this restores.
      if (!repeated(params.event?.event)) {
        const hit = this.hitFor(params);
        if (hit) this.focus.clicked(hit.key);
        if (hit || !this.navigates(params)) {
          this.itemClicked(hit, withModifier(params.event?.event));
        }
      }
      this.scheduleSelection();
    });
    chart.getZr().on("click", (event) => {
      if (!event.target && !repeated(event.event)) {
        this.itemClicked(undefined, withModifier(event.event));
      }
    });
    // After animations and redraws, such as for roaming, the focused item may be elsewhere.
    chart.on("finished", () => {
      this.drawnWhileApplying = true;
      this.focus.chartDrawn();
    });
    chart.on("selectchanged", (event) => {
      // ECharts lists the selected items of a series under each type of its data, as the nodes
      // and the edges of a graph: keep those of each type that are selected.
      const model = modelOf(chart);
      this.shownSelected = (event as ECharts.SelectChangedEvent).selected.map((each) => {
        const series = model.getSeriesByIndex(each.seriesIndex);
        const data = series?.getData(each.dataType);
        const selected = (raw: number) => {
          const index = data?.indexOfRawIndex(raw) ?? -1;
          return index < 0 || series?.isSelected(index, each.dataType) !== false;
        };
        return { ...each, dataIndex: each.dataIndex.filter(selected) };
      });
    });
    // Another step of a timeline shows other data, whose items the next use works out.
    chart.on("timelinechanged", () => {
      this.chartItems = undefined;
    });
    // The toolbox's restore makes the chart's model anew from the option, without the selection,
    // and back at a timeline's first step: select the items again.
    chart.on("restore", () => {
      this.chartItems = undefined;
      this.shownSelected = [];
      this.scheduleSelection();
    });
    // ECharts takes the blur off the whole chart for any other highlight or downplay, such as the
    // axis pointer's, and when the pointer leaves an item it emphasized, which would end the
    // dimming around the marks until they change: blur the rest again. A downplay, as of the axis
    // pointer leaving a category or the pointer a legend entry, takes the highlight off the marks
    // in it too. The marks' own actions are silent, and ECharts handles the pointer leaving first,
    // as it listened first.
    const restoreMarks = () => this.highlightMarked();
    chart.on("highlight", restoreMarks);
    chart.on("downplay", restoreMarks);
    chart.getZr().on("mouseout", restoreMarks);
    return chart;
  }

  private disposeChart(): void {
    this.focus.hide();
    cancelAnimationFrame(this.resizeFrame);
    this.chart?.dispose();
    this.chart = undefined;
    this.chartItems = undefined;
    this.shownSelected = [];
    this.hasHighlights = false;
  }

  /** Sets the option, on a chart made anew for another theme. */
  private apply(): void {
    const echarts = this.echarts;
    if (!echarts) {
      return;
    }
    // As after ECharts threw in a handler of its own, such as of a click.
    if (this.chart && stuck(this.chart)) this.disposeChart();
    if (!this.theme) {
      const colors = readThemeColors();
      this.theme = { colors, echarts: buildEChartsTheme(colors, this.reducedMotion.matches) };
      // An instance draws in the theme it was made with.
      this.chart?.dispose();
      this.chart = undefined;
    } else if (this.chart) {
      // ECharts takes the blur off the series that it blurred, as around marks, by the flags it
      // keeps in their models, which the new option replaces, while it keeps drawing the items
      // with the same graphics: then nothing would take them out of the blur. Take it off first,
      // as each highlight and downplay does, here of no series.
      this.chart.dispatchAction({ type: "downplay", seriesIndex: [] }, { silent: true });
    }
    this.chart ??= this.createChart(echarts, this.theme.echarts);
    this.drawnWhileApplying = false;
    this.chart.setOption(this.option ?? {}, { notMerge: true });
    if (this.blurring()) {
      // ECharts blurs the rest of a chart around a highlight only by emphasis.focus.
      const count = modelOf(this.chart).getSeriesCount();
      const series = Array.from({ length: count }, () => ({ emphasis: { focus: "self" } }));
      this.chart.setOption({ series });
    }
    this.chartItems = undefined;
    this.shownSelected = [];
    this.syncSelection();
    this.highlightMarks();
    this.focus.chartChanged();
    // Drawn already, with nothing to animate: no later drawing shows the focus again.
    if (this.drawnWhileApplying) this.focus.chartDrawn();
  }

  /** Whether the chart fades what is not marked, which needs something to be marked at all. */
  private blurring(): boolean {
    return this.annotation.dim && this.annotation.marks.length > 0;
  }

  /**
   * Marks items the way ECharts marks them itself: the marked ones highlighted, and the rest blurred
   * while the annotation dims the chart. The color a mark reads in cannot come along, as emphasis is
   * styled per series rather than per item; the agent's answer in chat says what each mark means.
   */
  private highlightMarks(previousIds?: ReadonlySet<string>): void {
    const chart = this.chart;
    if (!chart) {
      return;
    }
    if (this.hasHighlights) {
      if (previousIds) {
        const current = new Set(this.annotation.marks.map(({ id }) => id));
        const removed = this.drawn([...previousIds].filter((id) => !current.has(id)));
        if (removed.length > 0) {
          chart.dispatchAction({ type: "downplay", batch: removed }, { silent: true });
        }
      } else {
        chart.dispatchAction({ type: "downplay" }, { silent: true });
      }
    }
    // Downplay clears ECharts' blur state, including any focus set by the source option itself.
    // Restore the remaining marks together, while only downplaying the removed items' graphics.
    this.highlightMarked();
    this.hasHighlights = this.annotation.marks.length > 0;
  }

  /** Highlights the marked items, which blurs the rest of the chart while it is dimmed. */
  private highlightMarked(): void {
    const batch = this.drawn(this.annotation.marks.map(({ id }) => id));
    if (batch.length > 0) {
      // One action, as each takes the blur off the whole chart first. ECharts blurs a dimmed
      // chart around each item of a batch in turn, which blurs the marks of other series again:
      // the batch highlights them all once more at its end without blurring. Marks that do not
      // dim the chart blur nothing, as the option's emphasis.focus would around them.
      const unblurred = batch.map((item) => ({ ...item, notBlur: true }));
      this.chart?.dispatchAction(
        { type: "highlight", batch: this.blurring() ? [...batch, ...unblurred] : unblurred },
        { silent: true },
      );
    }
  }

  /** The items that go by the ids, as ECharts' highlight and downplay find what draws them. */
  private drawn(ids: string[]): ItemRef[] {
    const { chart } = this;
    return chart ? this.find(ids).map((ref) => drawnRef(chart, ref)) : [];
  }

  /** The items that go by the ids. */
  private find(ids: string[]): ItemRef[] {
    // Each drawing calls this, and working out the items of a large chart takes a while.
    if (ids.length === 0) return [];
    const items = this.items();
    return ids.flatMap((id) => items?.find(id) ?? []);
  }

  /** The items of the chart, by key, id and name. */
  private items(): ChartItems | undefined {
    if (this.chart) this.chartItems ??= new ChartItems(this.chart);
    return this.chartItems;
  }

  /** Draws the shown chart anew, keeping what is shown if that fails. */
  private redraw(): void {
    if (this.chart && this.option) this.guard(() => this.apply());
  }

  /**
   * Runs what calls on ECharts, drawing the chart anew once if it throws in the middle of an
   * action or a draw, after which ECharts refuses every later option and size: the panel would go
   * on showing what it drew last.
   */
  private guard(action: () => void): void {
    try {
      action();
    } catch (error) {
      console.error(error);
      this.reportCallbackError(error);
      if (!this.chart || !stuck(this.chart)) return;
      this.disposeChart();
      try {
        this.apply();
      } catch (again) {
        console.error(again);
        this.disposeChart();
      }
    }
  }

  private scheduleResize(): void {
    cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = requestAnimationFrame(() => this.guard(() => this.resize()));
  }

  /** Fits the chart to the container, unless the container has no size, as in the source view. */
  private resize(): void {
    const { clientWidth: width, clientHeight: height } = this.container;
    const chart = this.chart;
    if (!chart || this.tabHidden() || width === 0 || height === 0) return;
    if (chart.getWidth() === width && chart.getHeight() === height) return;
    // A media query can replace the data.
    if (Array.isArray(this.option?.media)) this.chartItems = undefined;
    chart.resize({ width, height });
  }

  /** The item a click on a series hit, if it hit one. */
  private hitFor({ seriesIndex = 0, dataType, dataIndex, event }: ECharts.ECElementEvent) {
    const index =
      this.chart && event
        ? clickedIndex(this.chart, seriesIndex, dataIndex, event.offsetX)
        : dataIndex;
    const key = itemKey({ seriesIndex, dataType, dataIndex: index });
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
      this.guard(() => this.syncSelection());
    });
  }

  /** Makes the items ECharts shows as selected match the selection. */
  private syncSelection(): void {
    const chart = this.chart;
    if (!chart) {
      return;
    }
    // As ECharts draws the items selected, which for a theme river is by their layers.
    const wanted = new Set(
      Array.from(this.selectedKeys, (key) => itemKey(drawnRef(chart, parseItemKey(key)))),
    );
    const shown = new Set<string>();
    const stale: ItemRef[] = [];
    for (const { dataIndex, ...series } of this.shownSelected) {
      for (const index of dataIndex) {
        const item = { ...series, dataIndex: index };
        const key = itemKey(item);
        shown.add(key);
        if (!wanted.has(key)) {
          stale.push(item);
        }
      }
    }
    if (stale.length > 0) {
      chart.dispatchAction({ type: "unselect", batch: stale });
    }
    const added: ItemRef[] = [];
    for (const key of wanted) {
      if (!shown.has(key)) {
        added.push(parseItemKey(key));
      }
    }
    if (added.length > 0) {
      chart.dispatchAction({ type: "select", batch: added });
    }
  }
}
