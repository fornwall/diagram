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
  openDataView,
  parseItemKey,
} from "./echartsItems";
import {
  cloneOption,
  disableAnimation,
  focusHighlighted,
  layoutOption,
  minimumHeight,
  sameLayout,
  toolWarnings,
} from "./echartsLayout";
import type * as EChartsLibrary from "./echartsLibrary";
import { loadECharts } from "./echartsLoader";
import {
  type JsonObject,
  optionVariants,
  optionWarnings,
  parseOption,
  seriesTypes,
} from "./echartsOption";
import { keepUserState, modelState } from "./echartsState";
import { buildEChartsTheme } from "./echartsTheme";
import type { DiagramImage } from "./images";
import { type ItemClickHandler, type Renderer, UNMARKED, withModifier } from "./renderer";
import { standaloneSvg } from "./svgImage";
import { readThemeColors } from "./vscodeTheme";

/** How long the size of a chart stays the same before it is laid out for it, rather than resized. */
export const SETTLE_DELAY = 150;
/**
 * How long resizing a chart may take for it to be resized in each frame while its size keeps
 * changing, as when dragging the splitter: about two frames.
 */
const RESIZE_BUDGET = 30;
/** How long a line of values grows in an option formatted for editing before they go on the next. */
const LINE_LENGTH = 100;

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
  private title = "";
  /** The size, motion preference and blur of the last layout, which decide whether to lay out again. */
  private laidOut = "";
  /**
   * The last layout of the option, before the changes that setting it brings, which shares the
   * option's data: a new layout that is the same only needs the chart resized.
   */
  private layout: JsonObject | undefined;
  private selectedKeys: ReadonlySet<string> = new Set();
  private selectionScheduled = false;
  /** The marks an agent put on the chart, which a new layout dispatches again. */
  private annotation: Annotation = UNMARKED;
  private hasHighlights = false;
  /** What ECharts shows as selected, as last reported by its selectchanged event. */
  private shownSelected: ECharts.SelectChangedEvent["selected"] = [];
  /** The height of a drawing taller than the container, which scrolls it. */
  private scrolledHeight: number | undefined;
  /** Whether the next chart is another, to show from its top. */
  private scrollToStart = false;
  private resizeFrame = 0;
  private relayoutTimer: ReturnType<typeof setTimeout> | undefined;
  /** Whether resizing the chart took longer than the budget since its size started changing. */
  private resizesSlowly = false;
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private readonly resizeObserver = new ResizeObserver(() => this.scheduleRelayout());

  constructor(
    private readonly itemClicked: ItemClickHandler,
    private readonly canvas: HTMLElement,
    /** The colors to draw in: the VS Code theme in the panel, the saved ones in a saved chart. */
    private readonly readColors: () => ThemeColors = readThemeColors,
    /**
     * Whether the tab is hidden behind another. Its page then has the size of an empty frame, 300
     * by 150 pixels, which a chart is not laid out for.
     */
    private readonly tabHidden: () => boolean = () => false,
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
      this.apply(false);
    } catch (error) {
      // A failed setOption can leave the instance broken: start over.
      this.disposeChart();
      throw new Error(`ECharts could not render this option: ${errorMessage(error)}`);
    }
    if (this.scrollToStart) {
      this.scrollToStart = false;
      this.container.scrollTop = 0;
    }
    // ResizeObserver reports a size in a frame when it differs from the one it reported last, so it
    // misses a container that changes size and back between frames, such as for a status line
    // shown while rendering, or a hidden view shown again. Observing anew reports the size in the
    // next frame the container has one, which the chart may not have been drawn at.
    this.resizeObserver.unobserve(this.container);
    this.resizeObserver.observe(this.container);
    return seriesTypes(option);
  }

  /** Shows another chart from its top, where a revision keeps the scroll of a tall chart. */
  fitToPanel(): void {
    this.scrollToStart = true;
  }

  hide(): void {
    this.disposeChart();
    this.option = undefined;
    this.scrolls(undefined);
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
    return [
      ...(this.option ? [...optionWarnings(this.option), ...toolWarnings(this.option)] : []),
      ...(this.items()?.warnings ?? []),
    ];
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
      this.guard(() => this.highlightMarks(previousIds));
    }
  }

  async themeChanged(): Promise<void> {
    this.theme = undefined;
    this.relayout();
  }

  /**
   * Lays the chart out again once its tab is shown. The resize observer reports nothing if the tab
   * is shown at the size it last reported, though the chart was laid out for another while hidden.
   */
  tabShown(): void {
    this.scheduleRelayout();
  }

  /**
   * An image of the chart as laid out for its current size, with its animations finished, so that
   * an early export includes every item, and without what the pointer and the toolbox add to it.
   */
  async toImage(background: string): Promise<DiagramImage> {
    if (!this.chart) throw new Error("There is no chart to make an image of.");
    // Export can precede the resize observer or its debounced layout after changing views: lay out
    // for the size now, which leaves nothing to do once it settles. Hidden charts keep the
    // dimensions of their last visible rendering.
    this.apply(true);
    this.cancelRelayout();
    const svg = this.container.querySelector("svg");
    if (!svg) throw new Error("There is no chart to make an image of.");
    // The pointer can still rest on the chart, as when the image is exported from the context menu
    // with the keyboard: leave out the axis pointer and the emphasis it shows, as if it had left.
    // Downplaying everything clears the marks too, so highlight them again.
    this.chart.dispatchAction({ type: "updateAxisPointer", currTrigger: "leave" });
    this.chart.dispatchAction({ type: "downplay" }, { silent: true });
    this.highlightMarked();
    const drawing = this.chart.getZr();
    // ECharts applies the states on its next frame: run it now.
    drawing.animation.trigger("frame");
    // ECharts' own export finishes the animations of what it draws, but labels fade in on the text
    // element that holds their lines, and groups move as a whole: finish those too, or the labels
    // of a chart exported as it appears are all but transparent.
    const finished = new Set<object>();
    for (const item of drawing.storage.getDisplayList(true)) {
      for (let element: Animated | null = item; element && !finished.has(element); ) {
        finished.add(element);
        element.stopAnimation(undefined, true);
        element = element.parent;
      }
    }
    // Leave out the toolbox, as ECharts does from its own images: its buttons do nothing there.
    const toolboxes = drawing.storage
      .getRoots()
      .filter((root) => !root.ignore && componentOf(root) === "toolbox");
    for (const toolbox of toolboxes) toolbox.ignore = true;
    try {
      drawing.refreshImmediately();
      return standaloneSvg(svg, background);
    } finally {
      for (const toolbox of toolboxes) toolbox.ignore = false;
      if (toolboxes.length > 0) drawing.refresh();
    }
  }

  formatForEditing(source: string): string {
    if (source.includes("\n")) {
      return source;
    }
    try {
      JSON.parse(source);
    } catch {
      // Not JSON: an option written as JavaScript, or one with an error, stays as it is.
      return source;
    }
    // Indent the tokens as JSON.stringify would, rather than writing out the parsed values, which
    // would round integers beyond 2^53, such as IDs, in the source that the user edits and saves.
    const tokens = source.match(/"(?:[^"\\]|\\.)*"|[{}[\],:]|[^\s"{}[\],:]+/g) ?? [];
    // Arrays of values alone, such as data of [x, y] points, go on as few lines as fit, by where
    // they start and end: a line for every value would make a large chart's source hundreds of
    // thousands of lines, which take seconds to lay out.
    const valueArrays = new Map<number, number>();
    const open: { start: number; values: boolean }[] = [];
    tokens.forEach((token, index) => {
      if (token === "[") open.push({ start: index, values: true });
      else if (token === "{") for (const array of open) array.values = false;
      else if (token === "]") {
        const array = open.pop();
        if (array?.values) valueArrays.set(array.start, index);
      }
    });
    let text = "";
    let depth = 0;
    /** Where the last line starts in the text. */
    let line = 0;
    const newLine = (indent = depth) => {
      line = text.length + 1;
      text += `\n${"  ".repeat(indent)}`;
    };
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index] ?? "";
      const end = valueArrays.get(index);
      if (end !== undefined) {
        // On the next line, indented, once a line is long, and inside an inner array only once it
        // is as many times as long, so as not to split the arrays of a long one, such as points.
        let nesting = 0;
        for (const each of tokens.slice(index, end + 1)) {
          nesting += each === "[" ? 1 : each === "]" ? -1 : 0;
          if (each !== ",") text += each;
          else if (text.length - line < LINE_LENGTH * nesting) text += ", ";
          else {
            text += ",";
            newLine(depth + 1);
          }
        }
        index = end;
      } else if (token === "{" && tokens[index + 1] === "}") {
        text += "{}";
        index++;
      } else if (token === "{" || token === "[") {
        depth++;
        text += token;
        newLine();
      } else if (token === "}" || token === "]") {
        depth--;
        newLine();
        text += token;
      } else if (token === ",") {
        text += ",";
        newLine();
      } else {
        text += token === ":" ? ": " : token;
      }
    }
    return text;
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
    chart.on("finished", () => this.focus.chartDrawn());
    chart.on("selectchanged", (event) => {
      this.shownSelected = (event as ECharts.SelectChangedEvent).selected;
    });
    // Another step of a timeline shows other data, whose items the next use works out.
    chart.on("timelinechanged", () => {
      this.chartItems = undefined;
    });
    // ECharts takes the blur off the whole chart for any other highlight or downplay, such as the
    // axis pointer's, and when the pointer leaves an item it emphasized, which would end the
    // dimming around the marks until they change: blur the rest again. The marks' own actions are
    // silent, and ECharts handles the pointer leaving first, as it listened first.
    const restoreMarks = () => {
      if (this.blurring()) this.highlightMarked();
    };
    chart.on("highlight", restoreMarks);
    chart.on("downplay", restoreMarks);
    chart.getZr().on("mouseout", restoreMarks);
    return chart;
  }

  private disposeChart(): void {
    this.focus.hide();
    cancelAnimationFrame(this.resizeFrame);
    this.cancelRelayout();
    this.chart?.dispose();
    this.chart = undefined;
    this.chartItems = undefined;
    this.shownSelected = [];
    this.hasHighlights = false;
    this.laidOut = "";
    this.layout = undefined;
  }

  /**
   * Sets the option, laid out for the current size and theme. A relayout of the shown chart keeps
   * what the user changed in it, does not animate, and is skipped when the layout stays the same.
   */
  private apply(relayout: boolean): void {
    const echarts = this.echarts;
    if (!echarts) {
      return;
    }
    // As after ECharts threw in a handler of its own, such as of a click.
    if (this.chart && stuck(this.chart)) this.disposeChart();
    // Source view has no DOM dimensions, and a hidden tab none to go by. Keep an existing chart's
    // size, or use an initial size for both the SVG and its layout; the resize observer fits it
    // when the rendering is shown.
    const measured = this.tabHidden() ? { width: 0, height: 0 } : this.drawingSize();
    const width = measured.width || this.chart?.getWidth() || 800;
    const height = measured.height || this.chart?.getHeight() || 500;
    const reducedMotion = this.reducedMotion.matches;
    // What the layout is drawn with besides the option laid out.
    const look = `${reducedMotion}:${this.blurring()}`;
    const laidOut = `${width}:${height}:${look}`;
    // Check layout inputs before copying the data. Retaining a serialized option would also
    // duplicate every data point in memory just to detect unchanged layouts.
    if (relayout && this.theme && laidOut === this.laidOut) {
      // The chart may still have the size it was resized to meanwhile.
      this.resizeChart();
      return;
    }
    const themeChanged = !this.theme && this.chart !== undefined;
    if (!this.theme) {
      const colors = this.readColors();
      this.theme = { colors, echarts: buildEChartsTheme(colors) };
    }
    const context = { width, height, title: this.title, colors: this.theme.colors, reducedMotion };
    const layout = layoutOption(this.option ?? {}, context);
    // Many charts are laid out the same for another size, such as one that only fills the space,
    // or whose labels fit either way: resizing draws them as a layout would, keeping what the user
    // changed, without setting the option and drawing the chart anew, which takes long for a
    // large one. Not for another theme, motion preference or blur, of which the layout is not all.
    const sameLook = !themeChanged && this.laidOut.endsWith(`:${look}`);
    if (relayout && sameLook && sameLayout(layout, this.layout)) {
      this.laidOut = laidOut;
      this.resizeChart();
      return;
    }
    this.layout = layout;
    // A copy to set, which the changes below make for this chart alone.
    const option = cloneOption(layout);
    if (relayout) {
      disableAnimation(option);
    }
    if (this.blurring()) {
      focusHighlighted(option);
    }
    const shown = relayout ? this.chart : undefined;
    if (shown) {
      keepUserState(option, modelOf(shown).option);
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
    // The items name the data of the model of the previous option, which they would keep alive. A
    // new layout of the same option has the same items, which take a while to work out for a large
    // chart: read them from its own model instead. Not for an option whose timeline steps or media
    // queries set other data, of which the chart may show another now than when they were.
    const sameItems = relayout && optionVariants(this.option ?? {}).length === 1;
    if (!sameItems || !this.chartItems?.rebind(this.chart)) this.chartItems = undefined;
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
    if (this.hasHighlights) {
      if (previousIds) {
        const current = new Set(this.annotation.marks.map(({ id }) => id));
        const removed = this.find([...previousIds].filter((id) => !current.has(id)));
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
    const batch = this.find(this.annotation.marks.map(({ id }) => id));
    if (batch.length > 0) {
      // One action, as each takes the blur off the whole chart first. ECharts blurs a dimmed
      // chart around each item of a batch in turn, which blurs the marks of other series again:
      // the batch highlights them all once more at its end without blurring.
      const again = this.blurring() ? batch.map((item) => ({ ...item, notBlur: true })) : [];
      this.chart?.dispatchAction(
        { type: "highlight", batch: [...batch, ...again] },
        { silent: true },
      );
    }
  }

  /** The items that go by the ids. */
  private find(ids: string[]): ItemRef[] {
    // Each layout calls this, and working out the items of a large chart takes a while.
    if (ids.length === 0) return [];
    const items = this.items();
    return ids.flatMap((id) => items?.find(id) ?? []);
  }

  /** The items of the chart, by key, id and name. */
  private items(): ChartItems | undefined {
    if (this.chart) this.chartItems ??= new ChartItems(this.chart);
    return this.chartItems;
  }

  /** Lays out the shown chart again, keeping what is shown if that fails. */
  private relayout(): void {
    if (this.chart && this.option) this.guard(() => this.apply(true));
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
      if (!this.chart || !stuck(this.chart)) return;
      this.disposeChart();
      try {
        this.apply(false);
      } catch (again) {
        console.error(again);
        this.disposeChart();
      }
    }
  }

  private scheduleRelayout(): void {
    cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = requestAnimationFrame(() => {
      // A change of size, such as showing the chart again, is laid out at once, as only resizing
      // a layout for another size can squeeze labels to a letter. While the size keeps changing,
      // as when dragging the splitter, the chart is only resized, and laid out once that settles.
      // A chart that is slow to resize, such as one of thousands of items, would make every frame
      // of the drag slow: it keeps its size until then instead.
      if (this.relayoutTimer === undefined) {
        this.relayout();
        this.resizesSlowly = false;
      } else if (!this.resizesSlowly) {
        const start = performance.now();
        this.guard(() => this.resizeChart());
        this.resizesSlowly = performance.now() - start > RESIZE_BUDGET;
      }
      clearTimeout(this.relayoutTimer);
      this.relayoutTimer = setTimeout(() => {
        this.relayoutTimer = undefined;
        this.relayout();
      }, SETTLE_DELAY);
    });
  }

  /** Cancels the layout due once the size settles, so that the next change of size lays out at once. */
  private cancelRelayout(): void {
    clearTimeout(this.relayoutTimer);
    this.relayoutTimer = undefined;
  }

  /**
   * The size to draw the chart at: the container's, but no shorter than the chart can be read at,
   * such as one of many facets, which the container then scrolls. Zero for a container without a
   * size, as in the source view.
   */
  private drawingSize(): { width: number; height: number } {
    const { clientWidth, clientHeight } = this.container;
    if (clientWidth === 0 || clientHeight === 0) return { width: 0, height: 0 };
    const least = this.option ? minimumHeight(this.option, clientWidth) : 0;
    this.scrolls(least > clientHeight ? least : undefined);
    // Measured again, without the scroll bar's width. A narrower chart is no shorter to read.
    return { width: this.container.clientWidth, height: Math.max(clientHeight, least) };
  }

  /** Makes the drawing taller than the container, which scrolls it, or fits it to the container. */
  private scrolls(height: number | undefined): void {
    if (height === this.scrolledHeight) return;
    this.scrolledHeight = height;
    this.container.classList.toggle("scrolls", height !== undefined);
    Object.assign(this.drawing.style, {
      bottom: height === undefined ? "0" : "auto",
      height: height === undefined ? "" : `${height}px`,
    });
  }

  private resizeChart(): void {
    if (this.tabHidden()) return;
    const { width, height } = this.drawingSize();
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
      this.guard(() => this.syncSelection());
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
