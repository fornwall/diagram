// Adapts an ECharts option written by a model to the panel: responsive layout, selection styles
// and defaults. Only fills in what the option leaves unset, so explicit choices always win.

import { facetBoxes } from "../chartFacetLayout";
import { asArray, isPlainObject } from "../protocol";
import { escapeHtml } from "../text";
import { type ThemeColors, toCss } from "./colors";
import {
  allSeries,
  baseOption,
  isCartesian,
  type JsonObject,
  optionVariants,
  seriesOf,
  seriesPlaces,
} from "./echartsOption";
import { colorLabelsOnItems, LEGEND_ITEM_GAP, LEGEND_ITEM_WIDTH } from "./echartsTheme";

const BOX_KEYS = ["left", "right", "top", "bottom", "width", "height"];
const has = (object: JsonObject, keys: string[]) => keys.some((key) => object[key] !== undefined);

type Side = "top" | "bottom" | "left" | "right";
/** Space in pixels taken from each side of the chart by the title, legend, sliders, … */
type Insets = Record<Side, number>;

/** A font of chart text, and how wide it draws a text, as ECharts measures it. */
interface Font {
  /** As CSS, as "bold 12px sans-serif". */
  css: string;
  /** The width of a text, as ECharts measures it to break it onto lines. */
  width(text: string): number;
}

interface Size {
  width: number;
  height: number;
  /** Too small for a legend above the grid. */
  compact: boolean;
  /**
   * The font of the first of some text styles that sets each part of it, as its size and weight,
   * or else of the chart's text, as ECharts makes the font of a text.
   */
  font(...styles: JsonObject[]): Font;
}

/** The text style of an option's setting, as its "axisLabel", if it is one. */
const styleOf = (style: unknown): JsonObject => (isPlainObject(style) ? style : {});

/**
 * The text of a category or legend entry: a value, a category `{value}`, or a legend entry or
 * data item named by `{name}` (whose value is a number).
 */
const entryText = (entry: unknown) =>
  String((isPlainObject(entry) ? (entry.name ?? entry.value) : entry) ?? "");

/** The width of the widest category or legend entry (see {@link entryText}). */
function widestText(entries: unknown, width: (text: string) => number, enough = Infinity): number {
  if (!Array.isArray(entries)) {
    return 0;
  }
  // Once the label exceeds every layout threshold, further entries cannot change the result.
  // Dense axes and long legends often reach that point with their very first entry.
  let widest = 0;
  for (const entry of entries) {
    widest = Math.max(widest, width(entryText(entry)));
    if (widest > enough) break;
  }
  return widest;
}

function seriesName(series: JsonObject): string | undefined {
  return typeof series.name === "string" && series.name ? series.name : undefined;
}

const isNegative = (value: unknown) => typeof value === "number" && value < 0;

/**
 * Whether series data or a dataset source holds a negative value: in a value, the value of a data
 * item, a row, or a column. Every field of a dataset row counts, also beside one named "value".
 */
function hasNegativeValues(data: unknown, dataset = false): boolean {
  const entries = Array.isArray(data) ? data : isPlainObject(data) ? Object.values(data) : [];
  return entries.some((entry) => {
    const value = !isPlainObject(entry)
      ? entry
      : dataset
        ? Object.values(entry)
        : (entry.value ?? Object.values(entry));
    return Array.isArray(value) ? value.some(isNegative) : isNegative(value);
  });
}

/** The source of the dataset that a series without data of its own draws from. */
function datasetSource(series: JsonObject, datasets: JsonObject[]): unknown {
  const find = (id: unknown, index: unknown) =>
    id == null ? datasets[Number(index ?? 0)] : datasets.find((dataset) => dataset.id === id);
  let dataset = find(series.datasetId, series.datasetIndex);
  // A transformed dataset is made of the rows of the one it transforms.
  for (let hops = 0; dataset && dataset.source === undefined && hops < datasets.length; hops++) {
    dataset = find(dataset.fromDatasetId, dataset.fromDatasetIndex);
  }
  return dataset?.source;
}

export interface LayoutContext {
  width: number;
  height: number;
  /** The title in the panel header; an identical chart title is hidden. */
  title: string;
  colors: ThemeColors;
  reducedMotion: boolean;
  /**
   * The width of a text in a CSS font as ECharts measures it to break it onto lines, of the
   * library that draws the chart.
   */
  textWidth(text: string, font: string): number;
}

const needsCopy = (value: unknown) => Array.isArray(value) || isPlainObject(value);
/** Layout reads these payloads without changing them; sankey styling copies its nodes below. */
const DATA_KEYS = new Set(["data", "nodes", "links", "edges", "source"]);

/**
 * Copies option settings, so that the layout can fill in what it needs while leaving the option
 * it was given untouched: the renderer keeps that one and lays it out again on a resize. Not
 * structuredClone, which throws on the functions of an option written as JavaScript, such as a
 * custom series' renderItem or a formatter.
 *
 * What isPlainObject accepts is copied, as every writer here reaches its targets through it, so
 * that no object the layout writes to is still the caller's. Functions and data payloads are
 * carried over by reference: copying every point, dataset row or hierarchy node would make each
 * resize allocate the whole dataset again. Other arrays are copied only when they hold objects or
 * arrays; none is written in place.
 */
export function cloneOption(option: JsonObject): JsonObject {
  const copy: JsonObject = {};
  // for...in rather than Object.entries, to copy what the option inherits as well: a series
  // written with a prototype of its own keeps its type and its styles that way.
  for (const key in option) {
    const value = DATA_KEYS.has(key) ? option[key] : cloneValue(option[key]);
    if (key === "__proto__") {
      // An own "__proto__" key, which JSON.parse does produce, has to be defined rather than
      // assigned: assigning it would reach the prototype setter and change the copy instead.
      Object.defineProperty(copy, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } else {
      copy[key] = value;
    }
  }
  return copy;
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.some(needsCopy) ? value.map(cloneValue) : value;
  }
  if (!isPlainObject(value)) {
    // A function or a primitive: never written to, and a function cannot be copied at all.
    return value;
  }
  if (value instanceof Date) {
    // A date is a value in the data of a time axis, not a record of properties to copy.
    return new Date(value.getTime());
  }
  // The data of a large chart can be a typed array, which copying properties would turn into an
  // object of its indices; the layout only reads data.
  return ArrayBuffer.isView(value) ? value : cloneOption(value);
}

/**
 * Whether two layouts of the same option are the same, as for many charts at another size: a
 * treemap, or axes whose labels fit either way. Their data is the option's own, which they share,
 * so this compares the settings around it.
 */
export function sameLayout(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameLayout(item, b[index]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  // Not typed arrays, which a layout carries over rather than copies, nor values of other classes.
  if (ArrayBuffer.isView(a) || Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && sameLayout(a[key], b[key]))
  );
}

/**
 * Gives the base option the series that the chart starts with but that only the current timeline
 * step or the default media option defines, as copies, for the layout to place, style and keep
 * them as any other: what the step or query sets is still merged in over them. Series that only
 * later steps add stay there, so as not to be shown from the start, as do series with an "id",
 * which the series of other steps, with ids of their own, would no longer merge into. Likewise
 * the titles they set, as a step's year often is, for the layout to make room for.
 */
function adoptStartingStep(option: JsonObject, base: JsonObject): void {
  const steps: unknown[] = Array.isArray(option.options) ? option.options : [];
  const step = steps[Number(asArray(base.timeline)[0]?.currentIndex ?? 0)];
  const media = asArray(option.media).find((each) => each.query === undefined)?.option;
  const series = [...seriesOf(base)];
  const titles = asArray(base.title);
  let titled = false;
  for (const patch of [step, media]) {
    if (!isPlainObject(patch)) continue;
    const own = seriesOf(patch);
    seriesPlaces(series, own).forEach((place, index) => {
      const each = own[index];
      if (place === series.length && isPlainObject(each) && each.id == null) {
        series.push({ ...each });
      }
    });
    asArray(patch.title).forEach((title, index) => {
      titles[index] = { ...titles[index], ...title };
      titled = true;
    });
  }
  if (series.length > seriesOf(base).length) base.series = series;
  if (titled) base.title = titles;
}

/**
 * How far a chart too short for its plot to be read gives up what is around the plot, step by
 * step, each giving up what the one before did as well: a visual map below the chart, which then
 * only colors the items, whose values the tooltip gives; a zoom slider below it, for zooming
 * with the wheel and panning with the pointer inside the plot instead; a subtitle; and a title,
 * which the panel's header goes with. A legend stays, which tells the series apart.
 */
const SQUEEZES = 4;

export function layoutOption(source: JsonObject, context: LayoutContext): JsonObject {
  for (let squeeze = 0; ; squeeze++) {
    const option = layOutAround(source, context, squeeze);
    if (option) return option;
  }
}

/**
 * The option laid out for the context, giving up as much as the squeeze says around the plot,
 * unless that leaves the plot too short to read and a further squeeze could help.
 */
function layOutAround(
  source: JsonObject,
  context: LayoutContext,
  squeeze: number,
): JsonObject | undefined {
  const option = cloneOption(source);
  const base = baseOption(option);
  adoptStartingStep(option, base);
  const series = asArray(base.series);
  const cartesian = series.some(isCartesian);
  if (context.reducedMotion) {
    disableAnimation(option);
  }
  hideRepeatedTitle(base, context.title);
  // Options with media queries handle their own responsiveness.
  if (option.media === undefined) {
    const { width, height } = context;
    const compact = width < 560 || height < 340;
    // The text style of the chart: the option's, over the theme's.
    const chartStyle: JsonObject = {
      fontFamily: context.colors.fontFamily,
      fontSize: context.colors.fontSize,
      ...(isPlainObject(base.textStyle) ? base.textStyle : {}),
    };
    const font = (...styles: JsonObject[]): Font => {
      const part = (key: string) =>
        [...styles, chartStyle].map((style) => style[key]).find((value) => value != null);
      // Of pixels, as a number or as "14px".
      const fontSize = /^\d+(?:\.\d+)?(?:px)?$/.test(String(part("fontSize")).trim())
        ? Number.parseFloat(String(part("fontSize")))
        : context.colors.fontSize;
      const css = [part("fontStyle"), part("fontWeight"), `${fontSize}px`, part("fontFamily")]
        .filter((value) => value != null && value !== "")
        .join(" ");
      return { css, width: (text) => context.textWidth(text, css) };
    };
    const size = { width, height, compact, font };
    const room = layOut(base, series, cartesian, size, squeeze, steppedSeries(option, base));
    if (room < MIN_PLOT_HEIGHT && squeeze < SQUEEZES) return undefined;
  }
  // A legend that the layout did not wrap into rows pages through its entries, if they take more.
  for (const legend of asArray(base.legend)) {
    if (legend.show !== false) {
      legend.type ??= "scroll";
    }
  }
  styleSeries(base, series, context.colors);
  colorLabelsOnItems(base, series, context.colors);
  nameTreemapRoot(series);
  drawLargeSeries(option, series);
  showAxisLines(base);
  compactAxisLabels(base);
  formatTemplateValues(option);
  addInteraction(base, series, cartesian, context.colors);
  // A timeline step or media query can set a toolbox of its own too.
  for (const toolbox of optionVariants(option).flatMap((variant) => asArray(variant.toolbox))) {
    keepLastingTools(toolbox);
  }
  return option;
}

/**
 * The toolbox features that change the chart in ways its option does not hold, such as switching
 * between bars and lines: the next layout, as on a resize, would undo them. Each comes with what
 * to use instead, if anything.
 */
const PASSING_TOOLS: Record<string, string | undefined> = {
  magicType: "render each chart type as a chart of its own",
  dataZoom: 'zoom with a "dataZoom" component of type "inside" or "slider"',
  brush: undefined,
};

/** Tells a model which toolbox features it asked for the panel leaves out, and why. */
export function toolWarnings(option: JsonObject): string[] {
  const variants = optionVariants(option);
  const features = variants.flatMap((variant) =>
    asArray(variant.toolbox).flatMap((toolbox) =>
      isPlainObject(toolbox.feature) ? [toolbox.feature] : [],
    ),
  );
  const editable = features.some((feature) => asArray(feature.dataView)[0]?.readOnly === false)
    ? [
        "The panel shows the toolbox's data view read-only, as it lays the chart out again " +
          "whenever its size changes, which would undo an edit of the data.",
      ]
    : [];
  const left = new Set(
    features.flatMap((feature) =>
      Object.keys(feature).filter((name) => Object.hasOwn(PASSING_TOOLS, name)),
    ),
  );
  // A brush component is drawn by the toolbox's brush, which ECharts adds for it.
  if (variants.some((variant) => asArray(variant.brush).length > 0)) left.add("brush");
  if (left.size === 0) return editable;
  const names = [...left].map((name) => `"${name}"`);
  const instead = [...left].flatMap((name) => PASSING_TOOLS[name] ?? []);
  return [
    ...editable,
    `The panel leaves the toolbox feature${names.length > 1 ? "s" : ""} ${names.join(", ")} out ` +
      "of the chart, as it lays the chart out again whenever its size changes, which would undo " +
      `what ${names.length > 1 ? "they change" : "it changes"}${instead.length > 0 ? `: instead, ${instead.join(", and ")}` : ""}.`,
  ];
}

/** Leaves out the toolbox features whose changes would be undone, and lets the data view only show the data. */
function keepLastingTools(toolbox: JsonObject): void {
  if (!isPlainObject(toolbox.feature)) return;
  const feature: JsonObject = {};
  for (const [name, settings] of Object.entries(toolbox.feature)) {
    if (Object.hasOwn(PASSING_TOOLS, name)) continue;
    feature[name] =
      name === "dataView" && isPlainObject(settings) ? { ...settings, readOnly: true } : settings;
  }
  toolbox.feature = feature;
}

export function disableAnimation(option: JsonObject): void {
  // Timeline and media options can override both global and per-series animation settings.
  for (const variant of optionVariants(option)) variant.animation = false;
  for (const series of allSeries(option)) series.animation = false;
}

/**
 * Makes a highlighted item fade the rest of the chart, which is how an agent's marks stand out with
 * everything else receding: ECharts blurs a chart around a highlighted item only when its series
 * focuses on it. Replaces a focus of the option's own for as long as the marks dim the chart.
 */
export function focusHighlighted(option: JsonObject): void {
  for (const series of allSeries(option)) {
    const emphasis = isPlainObject(series.emphasis) ? series.emphasis : {};
    emphasis.focus = "self";
    series.emphasis = emphasis;
  }
}

/** Hides a chart title that repeats the panel header, keeping its subtitle. */
function hideRepeatedTitle(base: JsonObject, header: string): void {
  const repeated = header.trim().toLowerCase();
  for (const title of asArray(base.title)) {
    const text = typeof title.text === "string" ? title.text.trim() : "";
    if (text && text.toLowerCase() === repeated) {
      if (typeof title.subtext === "string" && title.subtext.trim()) {
        title.text = "";
      } else {
        title.show = false;
      }
    }
  }
}

/** A length in pixels, or a percentage of the chart's width. */
const pixels = (value: unknown, width: number): number | undefined =>
  typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+(?:\.\d+)?%$/.test(value)
      ? (Number.parseFloat(value) * width) / 100
      : undefined;

/**
 * Places the components around the plot, giving up as much as the squeeze says (see
 * {@link SQUEEZES}), and fits the grid and series into the space left, whose height it returns.
 */
function layOut(
  base: JsonObject,
  series: JsonObject[],
  cartesian: boolean,
  size: Size,
  squeeze: number,
  stepped: ReadonlySet<unknown>,
): number {
  const reserved: Insets = { top: 0, bottom: 0, left: 0, right: 0 };
  const tools = toolboxSize(base);
  for (const title of asArray(base.title)) {
    if (title.show === false || !(title.text || title.subtext)) {
      continue;
    }
    // A facet's title tells its panel from the others.
    const grid = gridOf(base, title);
    if (squeeze >= 4 && grid === undefined) {
      title.show = false;
      continue;
    }
    if (squeeze >= 3 && title.text) title.subtext = "";
    const { top, bottom } = title;
    const side =
      bottom !== undefined || top === "bottom"
        ? "bottom"
        : top === undefined || top === "top" || (typeof top === "number" && top < 40)
          ? "top"
          : undefined;
    if (side) {
      const height = 10 + (title.text ? 22 : 0) + (title.subtext ? 18 : 0);
      reserved[side] = Math.max(reserved[side], height);
    }
    // A title wider than the panel is cut short rather than cut off, or than the room the
    // toolbox leaves beside it at the top; one that names a grid, such as a facet's, once the
    // grid is laid out.
    if (grid === undefined) {
      const besideTools =
        side === "top" && tools.width > 0 ? (tools.width + 8) * (centered(title) ? 2 : 1) : 0;
      truncateTitle(title, size.width - 16 - besideTools);
    }
  }
  // The row of the toolbox, beside a title, or else above the legend and the plot, which it would
  // cover.
  reserved.top = Math.max(reserved.top, tools.height);
  // A timeline takes the bottom of the chart, where ECharts places it unless told otherwise.
  const timeline = asArray(base.timeline).find((t) => t.show !== false);
  if (timeline && !has(timeline, [...BOX_KEYS, "orient"])) {
    // Within the room reserved for it, which ECharts 6's padding of 15 pixels would overflow.
    timeline.padding ??= 5;
    reserved.bottom = 44;
  }
  // A chart along a single axis, as a theme river, has its legend where a grid's would be.
  placeLegend(base, series, cartesian || series.some(onSingleAxis), reserved, size);
  placeSliders(base, reserved, size, squeeze);
  if (cartesian) {
    layOutGrid(base, reserved, size);
  }
  layOutSingleAxis(base, series, reserved, size);
  layOutCalendar(base, reserved, size);
  layOutParallel(base, reserved, size);
  for (const title of asArray(base.title)) {
    const grid = gridOf(base, title);
    if (grid) truncateTitle(title, (pixels(grid.width, size.width) ?? size.width) - 16);
  }
  layOutPie(base, series, reserved, size);
  labelTreeNodes(series, size);
  layOutBoxSeries(series, reserved, size, stepped);
  layOutRadar(base, reserved, size);
  return size.height - reserved.top - reserved.bottom;
}

/** The series of the base option that the steps of a timeline set something of, merged over it. */
function steppedSeries(option: JsonObject, base: JsonObject): Set<unknown> {
  const series = seriesOf(base);
  const stepped = new Set<unknown>();
  for (const step of Array.isArray(option.options) ? option.options : []) {
    if (!isPlainObject(step)) continue;
    for (const place of seriesPlaces(series, seriesOf(step))) {
      if (place !== undefined) stepped.add(series[place]);
    }
  }
  return stepped;
}

/** The grid that a title names by having its id, such as a facet's. */
const gridOf = (base: JsonObject, title: JsonObject): JsonObject | undefined =>
  title.id === undefined ? undefined : asArray(base.grid).find((grid) => grid.id === title.id);

/** Cuts a title and its subtitle short at a width, unless the title sets one. */
function truncateTitle(title: JsonObject, width: number): void {
  for (const key of ["textStyle", "subtextStyle"]) {
    const style = isPlainObject(title[key]) ? title[key] : {};
    style.width ??= width;
    style.overflow ??= "truncate";
    title[key] = style;
  }
}

/** Whether a title is centered, which keeps it clear of a toolbox on the right on both sides. */
const centered = (title: JsonObject) => title.left === "center" || title.left === "middle";

/**
 * The size of the toolbox that ECharts places across the top right of the chart, as it does
 * unless told otherwise, of the features that the panel keeps: 0 by 0 without one.
 */
function toolboxSize(base: JsonObject): { width: number; height: number } {
  let width = 0;
  let height = 0;
  for (const toolbox of asArray(base.toolbox)) {
    if (toolbox.show === false || toolbox.orient === "vertical" || has(toolbox, BOX_KEYS)) continue;
    const features = Object.entries(isPlainObject(toolbox.feature) ? toolbox.feature : {}).filter(
      ([name, settings]) =>
        !Object.hasOwn(PASSING_TOOLS, name) &&
        !(isPlainObject(settings) && settings.show === false),
    );
    if (features.length === 0) continue;
    // ECharts' default icon size, gap between icons and padding, which the icons are inside of
    // from the top and right.
    const size = typeof toolbox.itemSize === "number" ? toolbox.itemSize : 15;
    const gap = typeof toolbox.itemGap === "number" ? toolbox.itemGap : 10;
    const padding = typeof toolbox.padding === "number" ? toolbox.padding : 15;
    width = Math.max(width, features.length * (size + gap) - gap + padding);
    height = Math.max(height, size + padding);
  }
  return { width, height };
}

/**
 * Adds a legend where the chart needs one, and places it beside the plot: above or below one
 * along axes, and beside one of another kind when there is room.
 */
function placeLegend(
  base: JsonObject,
  series: JsonObject[],
  alongAxes: boolean,
  reserved: Insets,
  size: Size,
): void {
  const { width, height, compact } = size;
  const pies = series.filter((s) => s.type === "pie");
  if (base.legend === undefined) {
    // Several named series: the identity of a series is never only color.
    const named = series.length >= 2 && series.every((s) => seriesName(s) !== undefined);
    // A small pie has no room for labels, so its slices are named by a legend instead, unless
    // the option sets how to label them.
    const [pie] = pies;
    const smallPie =
      pie !== undefined &&
      pies.length === 1 &&
      !labelsSet(pie) &&
      (height - reserved.top < 260 ||
        !pieLabelsFit(pie, width - 16, height - reserved.top - 16, size));
    if (named || smallPie) {
      base.legend = {};
    }
    // Only by the legend, as the room it takes below the pie would make them seem to fit beside a
    // smaller one.
    if (smallPie) hidePieLabels(pie);
  }
  const legend = asArray(base.legend).find((l) => l.show !== false);
  if (!legend) {
    return;
  }
  let side: Side;
  const placed = has(legend, BOX_KEYS);
  const { width: textWidth } = size.font(styleOf(legend.textStyle));
  if (
    legend.orient === "vertical" ||
    (legend.orient === undefined && !placed && !alongAxes && width >= 560)
  ) {
    // Beside a pie or other non-grid chart when there is room, as it then uses the height, and
    // beside any chart when it goes down, on the right unless told the side, where ECharts would
    // center it.
    if (!placed) Object.assign(legend, { orient: "vertical", right: 8, top: "middle" });
    else if (!has(legend, ["left", "right"])) legend.right = 8;
    side = legend.right === undefined ? "left" : "right";
  } else if (!placed) {
    side = alongAxes && !compact ? "top" : "bottom";
    Object.assign(
      legend,
      side === "top"
        ? { top: reserved.top > 0 ? reserved.top : 6, left: "center" }
        : { bottom: reserved.bottom + 6, left: "center" },
    );
  } else {
    // ECharts places a horizontal legend at the bottom unless told otherwise.
    side = legend.top !== undefined && legend.bottom === undefined ? "top" : "bottom";
  }
  if (side === "top" || side === "bottom") {
    // A legend that the panel places wraps into a few rows rather than page through its entries,
    // unless the option says what kind of legend it is: as many as take a fifth of the height.
    const most = Math.max(2, Math.floor((height * 0.2) / LEGEND_ROW));
    const rows =
      !placed && legend.type === undefined
        ? legendRows(legend, series, width - 20, textWidth, most)
        : 1;
    if (rows > 1) legend.type = "plain";
    reserved[side] += (side === "top" ? 30 : 32) + (rows - 1) * LEGEND_ROW;
    return;
  }
  // The icon, the gap after it and the padding around the legend.
  const extra = 12 + 5 + 24;
  const enough = width * 0.32 - extra;
  let widest = 0;
  if (Array.isArray(legend.data)) {
    widest = widestText(legend.data, textWidth, enough);
  } else if (pies.length > 0 || series.some((s) => s.type === "funnel")) {
    // Read each series in place rather than allocating an array of every slice on each resize.
    for (const each of series) {
      widest = Math.max(widest, widestText(each.data, textWidth, enough));
      if (widest > enough) break;
    }
  } else {
    widest = widestText(seriesEntries(series, MAX_READ_CATEGORIES), textWidth, enough);
  }
  // At least as wide as a few characters.
  const legendWidth = Math.min(width * 0.32, Math.max(textWidth("0000"), widest) + extra);
  reserved[side] += Math.round(legendWidth) + 16;
}

/**
 * The entries of a legend of series other than pies and funnels: their names, but the names of
 * the layers of a theme river, in the third field of its data, as ECharts names them: as many as
 * there are, or else a few more than the most that the layout takes.
 */
function seriesEntries(series: JsonObject[], most: number): string[] {
  const entries = new Set<string>();
  for (const each of series) {
    if (each.type !== "themeRiver") {
      const name = seriesName(each);
      if (name !== undefined) entries.add(name);
    } else if (Array.isArray(each.data)) {
      for (const item of each.data) {
        if (Array.isArray(item) && item[2] != null) entries.add(String(item[2]));
        if (entries.size > most) break;
      }
    }
    if (entries.size > most) break;
  }
  return [...entries];
}

/** The height of a row of a legend's entries. */
const LEGEND_ROW = 24;
/** The entries of a legend beyond which it pages through them, however short. */
const MAX_WRAPPED_ENTRIES = 40;

/**
 * The rows that a horizontal legend wraps its entries into in a width, if it takes several and
 * no more than the most there is room for; else 1, for a legend that pages through them instead.
 * The entries name the slices of pies and funnels, or else the series.
 */
function legendRows(
  legend: JsonObject,
  series: JsonObject[],
  width: number,
  textWidth: (text: string) => number,
  most: number,
): number {
  const sliced = series.filter((each) => each.type === "pie" || each.type === "funnel");
  const entries: unknown[] = Array.isArray(legend.data)
    ? legend.data
    : sliced.length > 0
      ? sliced.flatMap((each) =>
          Array.isArray(each.data) ? each.data.slice(0, MAX_WRAPPED_ENTRIES + 1) : [],
        )
      : seriesEntries(series, MAX_WRAPPED_ENTRIES);
  if (entries.length > MAX_WRAPPED_ENTRIES) return 1;
  // As far apart as the theme's, or the option's, entries.
  const gap = typeof legend.itemGap === "number" ? legend.itemGap : LEGEND_ITEM_GAP;
  const icon = typeof legend.itemWidth === "number" ? legend.itemWidth : LEGEND_ITEM_WIDTH;
  let rows = 1;
  let used = 0;
  for (const entry of entries) {
    // The icon and the gap after it, and the gap before the entry after another.
    const size = icon + 5 + textWidth(entryText(entry));
    if (used > 0 && used + gap + size > width) {
      rows++;
      used = size;
    } else {
      used += (used > 0 ? gap : 0) + size;
    }
  }
  return rows <= most ? rows : 1;
}

/** The height in pixels below which a plot, with the labels of its axes, can hardly be read. */
const MIN_PLOT_HEIGHT = 140;
/** The height that a visual map placed below the chart takes. */
const VISUAL_MAP_HEIGHT = 52;

/**
 * Places data zoom sliders along the axis they control, and visual maps below the chart, unless
 * the squeeze gives them up (see {@link SQUEEZES}).
 */
function placeSliders(base: JsonObject, reserved: Insets, { width }: Size, squeeze: number): void {
  for (const zoom of asArray(base.dataZoom)) {
    if (
      zoom.show === false ||
      (zoom.type !== undefined && zoom.type !== "slider") ||
      has(zoom, BOX_KEYS)
    ) {
      continue;
    }
    // Without an orient, ECharts orients a slider along the axis it controls.
    const vertical =
      zoom.orient === "vertical" ||
      (zoom.orient === undefined &&
        (zoom.yAxisIndex ?? zoom.yAxisId) !== undefined &&
        (zoom.xAxisIndex ?? zoom.xAxisId) === undefined);
    if (!vertical && squeeze >= 2) {
      zoom.type = "inside";
    } else if (vertical) {
      Object.assign(zoom, { right: reserved.right + 8, width: 22 });
      reserved.right += 38;
    } else {
      Object.assign(zoom, { bottom: reserved.bottom + 8, height: 22 });
      reserved.bottom += 38;
    }
  }
  for (const visualMap of asArray(base.visualMap)) {
    if (visualMap.show === false) {
      continue;
    }
    // A continuous bar shows the values of its ends only with the handles that make it
    // calculable, as diagram_chart's heatmaps have, or with a text, which it has by default.
    const { formatter, precision } = visualMap;
    if (
      visualMap.text === undefined &&
      !visualMap.calculable &&
      (formatter === undefined || typeof formatter === "string") &&
      isContinuous(visualMap)
    ) {
      // ECharts' default bounds, and the high one first, compactly, or as the handles would write
      // them in the format or precision the option sets: to its whole digits, of 0 by default, of at
      // most 20, and in the first of each placeholder.
      const digits = Math.min(20, Math.max(0, Math.trunc(Number(precision ?? 0)) || 0));
      visualMap.text = [visualMap.max ?? 200, visualMap.min ?? 0].map((bound) => {
        if (formatter === undefined && precision === undefined) return compactLabel(bound);
        const value = Number(bound).toFixed(digits);
        return formatter === undefined
          ? value
          : formatter.replace("{value}", value).replace("{value2}", value);
      });
    }
    if (!has(visualMap, [...BOX_KEYS, "orient"])) {
      if (squeeze >= 1) {
        visualMap.show = false;
        continue;
      }
      Object.assign(visualMap, {
        orient: "horizontal",
        left: "center",
        bottom: reserved.bottom + 4,
      });
      // Within the room reserved for it, which ECharts 6's padding of 15 pixels would overflow.
      visualMap.padding ??= 5;
      // The length of a continuous bar, but the size of each piece of a piecewise one.
      if (isContinuous(visualMap)) visualMap.itemHeight ??= Math.min(200, Math.round(width * 0.4));
      reserved.bottom += VISUAL_MAP_HEIGHT;
    } else if (visualMap.orient === "horizontal") {
      reserved[visualMap.top === undefined ? "bottom" : "top"] += VISUAL_MAP_HEIGHT;
    } else {
      reserved[visualMap.right === undefined ? "left" : "right"] += 80;
    }
  }
}

/** Whether a visual map is a continuous bar rather than pieces, as ECharts decides by default. */
function isContinuous(visualMap: JsonObject): boolean {
  if (visualMap.type !== undefined) {
    return visualMap.type === "continuous";
  }
  const pieces = visualMap.pieces
    ? Array.isArray(visualMap.pieces) && visualMap.pieces.length > 0
    : Number(visualMap.splitNumber) > 0;
  return !visualMap.categories && (!pieces || Boolean(visualMap.calculable));
}

/** Fits a single grid, or the panels of facets, into the space left, and keeps axis labels apart. */
function layOutGrid(base: JsonObject, reserved: Insets, size: Size): void {
  const { width, height, compact } = size;
  const grids = asArray(base.grid);
  /** The size of the plot of each grid, with its labels, where the layout places the grids. */
  let panel: { width: number; height: number } | undefined;
  if (grids.length <= 1) {
    const grid = grids[0] ?? {};
    if (!has(grid, [...BOX_KEYS, "outerBounds", "outerBoundsMode"])) {
      Object.assign(grid, {
        left: reserved.left + 8,
        right: reserved.right + 20,
        top: reserved.top + 14,
        bottom: reserved.bottom + 8,
      });
      panel = {
        width: width - reserved.left - reserved.right - 28,
        height: height - reserved.top - reserved.bottom - 22,
      };
      // The ECharts 6 way to keep axis labels and names inside the grid rectangle.
      if (grid.containLabel === undefined) {
        grid.outerBoundsMode = "same";
      }
    }
    if (grids.length === 0) {
      // Also in place of an empty list of grids, which ECharts would replace by its default grid.
      base.grid = grid;
    }
  }
  const facets = facetPanels(base);
  const facetGrid = facets && layOutFacets(facets, reserved, size);
  panel ??= facetGrid;

  // Rotate category labels when they would overlap, and truncate very long ones.
  const labelHeights = new Map<JsonObject, number>();
  const plotWidth = Math.max(80, width - reserved.left - reserved.right - 80);
  // Multi-grid charts need label decisions based on their own panel, not the entire canvas.
  const panelWidth = (axis: JsonObject): number => {
    if (grids.length <= 1) return plotWidth;
    const grid = grids[typeof axis.gridIndex === "number" ? axis.gridIndex : 0];
    const available =
      pixels(grid?.width, width) ??
      width - (pixels(grid?.left, width) ?? 0) - (pixels(grid?.right, width) ?? 0);
    return Math.max(40, available - 50);
  };
  for (const axis of asArray(base.xAxis)) {
    const label = isPlainObject(axis.axisLabel) ? axis.axisLabel : {};
    const count = Array.isArray(axis.data) ? axis.data.length : 0;
    if (count === 0 || label.rotate !== undefined || label.interval !== undefined) {
      continue;
    }
    const slot = panelWidth(axis) / count;
    // Slanted labels take the height of the plot, of a facet's own in a faceted chart.
    const maxWidth =
      facetGrid === undefined
        ? Math.max(60, Math.round(height * 0.22))
        : Math.max(40, Math.round(facetGrid.height * 0.35));
    const font = size.font(label);
    let labelWidth = widestText(axis.data, font.width, Math.max(slot * 3, maxWidth));
    // ECharts shows each label across the axis where, a third wider, it fits in the width of its
    // category, and else leaves some out: the third is the gap between them.
    const across = (width: number) => width * CATEGORY_LABEL_ROOM <= slot;
    // Labels cut short to the same start are told apart by what follows it.
    // Named below the labels, across the middle of the axis, unless the option names it elsewhere.
    const { name: own, nameLocation: location } = axis;
    const middle = location === undefined || location === "middle" || location === "center";
    const rest =
      !across(labelWidth) &&
      labelWidth > maxWidth &&
      dropSharedStart(axis, label, maxWidth, middle, font);
    if (rest) labelWidth = rest;
    if (!across(labelWidth)) {
      const rotate = labelWidth > slot * 3 ? 45 : 30;
      axis.axisLabel = {
        rotate,
        hideOverlap: true,
        ...(labelWidth > maxWidth ? { width: maxWidth, overflow: "truncate" } : {}),
        ...label,
      };
      const slanted = Math.min(labelWidth, maxWidth) * Math.sin((rotate * Math.PI) / 180);
      labelHeights.set(axis, LABEL_HEIGHT + Math.round(slanted));
    }
    // The shared start names the axis below its labels.
    if (rest && axis.name !== own) {
      axis.nameLocation ??= "middle";
      axis.nameGap ??= (labelHeights.get(axis) ?? LABEL_HEIGHT) + 8;
    }
  }
  // A short or narrow plot, as of a facet or in a small panel, has room for fewer value labels.
  if (panel !== undefined) {
    const faceted = facetGrid !== undefined;
    const xAxes = asArray(base.xAxis);
    for (const axis of xAxes) {
      // Value labels as wide as the longest bound's, beside each other.
      const digits = [axis.min, axis.max].map((bound) =>
        typeof bound === "number" ? compactLabel(bound).length : 4,
      );
      const font = size.font(styleOf(axis.axisLabel));
      const label = font.width("0".repeat(Math.max(...digits) + 1));
      fewerTicks(axis, panel.width - 50, label + 16, faceted);
      fewerTimeTicks(axis, panel.width - 50, font);
    }
    for (const axis of asArray(base.yAxis)) {
      const xAxis = xAxes.find(({ gridIndex }) => gridIndex === axis.gridIndex);
      let plot = panel.height - (xAxis ? (labelHeights.get(xAxis) ?? LABEL_HEIGHT) : 0);
      // The name above the plot, unless a facet's plot would be too short for it.
      if (typeof axis.name === "string" && axis.name && axis.nameLocation === undefined) {
        if (faceted && plot - AXIS_NAME_HEIGHT < MIN_NAMED_FACET) axis.name = "";
        else plot -= AXIS_NAME_HEIGHT;
      }
      fewerTicks(axis, plot, MIN_TICK_GAP, faceted);
    }
  }
  for (const axis of asArray(base.yAxis)) {
    const label = isPlainObject(axis.axisLabel) ? axis.axisLabel : {};
    const maxWidth = Math.round(
      (grids.length > 1 ? panelWidth(axis) : width) * (compact ? 0.3 : 0.22),
    );
    const font = size.font(label);
    if (label.width !== undefined || widestText(axis.data, font.width, maxWidth) <= maxWidth) {
      continue;
    }
    // Labels too long for their width go onto as many lines as the height of each row has room
    // for, and else are told apart by what follows the start they share, if they do.
    const xAxis = asArray(base.xAxis).find(({ gridIndex }) => gridIndex === axis.gridIndex);
    const rowHeight =
      panel === undefined || !Array.isArray(axis.data)
        ? 0
        : (panel.height -
            (xAxis ? (labelHeights.get(xAxis) ?? LABEL_HEIGHT) : 0) -
            (axis.name ? AXIS_NAME_HEIGHT : 0)) /
          axis.data.length;
    const lines = Math.floor((rowHeight - 4) / LABEL_LINE_HEIGHT);
    if (lines >= 2 && wrapsInto(axis.data, maxWidth, lines, font.width)) {
      axis.axisLabel = {
        width: maxWidth,
        overflow: "break",
        lineHeight: LABEL_LINE_HEIGHT - 1,
        ...label,
      };
      continue;
    }
    const { name: own, nameLocation: location } = axis;
    const rest = dropSharedStart(axis, label, maxWidth, true, font);
    const end = location === undefined || location === "start" || location === "end";
    if (rest !== undefined && axis.name !== own && end) {
      // The name above the labels starts at the axis, rather than centered on it, beside them.
      const style = isPlainObject(axis.nameTextStyle) ? axis.nameTextStyle : {};
      style.align ??= axis.position === "right" ? "right" : "left";
      axis.nameTextStyle = style;
    }
    if (rest === undefined || rest > maxWidth) {
      axis.axisLabel = { width: maxWidth, overflow: "truncate", ...label };
    }
  }
  // ECharts names an axis at its end, which an inverse axis has at the bottom or left, below
  // or beside its labels, as a heatmap's rows from the top: name it where the axis starts.
  for (const axis of [...asArray(base.xAxis), ...asArray(base.yAxis)]) {
    if (axis.inverse === true && axis.name && axis.nameLocation === undefined) {
      axis.nameLocation = "start";
    }
  }
}

/** The categories of an axis beyond which the layout reads only as many as it must. */
const MAX_READ_CATEGORIES = 200;
/**
 * How much wider than a category label is the room that ECharts makes sure each has, to show
 * them all.
 */
const CATEGORY_LABEL_ROOM = 1.3;
/** The height of a line of an axis label that goes onto several. */
const LABEL_LINE_HEIGHT = 17;

/** The texts of the categories of an axis, if strings and no more than a few hundred. */
function categoryTexts(data: unknown): string[] | undefined {
  if (!Array.isArray(data) || data.length > MAX_READ_CATEGORIES) return undefined;
  const texts = data.map((entry: unknown) => (isPlainObject(entry) ? entry.value : entry));
  return texts.every((text) => typeof text === "string") ? texts : undefined;
}

/** Whether each category's text goes onto no more than some lines of a width, in a font. */
function wrapsInto(
  data: unknown,
  room: number,
  lines: number,
  width: (text: string) => number,
): boolean {
  const texts = categoryTexts(data);
  if (texts === undefined) return false;
  return texts.every((text) => {
    // Word by word, as ECharts breaks them, and a word wider than a line across lines.
    let count = 1;
    let used = 0;
    for (const word of text.match(WORDS) ?? []) {
      const size = width(word);
      if (used + size <= room) {
        used += size;
        continue;
      }
      if (used > 0) count++;
      count += Math.ceil(size / room) - 1;
      used = size % room || room;
    }
    return count <= lines;
  });
}

/** As much of the start of a text as fits in a width, in a font, but at least a character. */
function startOf(text: string, room: number, width: (text: string) => number): string {
  let used = 0;
  for (let end = 0; end < text.length; end++) {
    // ECharts measures a text as wide as its characters.
    used += width(text.charAt(end));
    if (used > room) return text.slice(0, Math.max(1, end));
  }
  return text;
}

/** By the start they leave out, so that a layout of the same option has the same ones. */
const sharedStartFormatters = new Map<string, (value: unknown) => string>();

/**
 * Labels the categories of an axis by what follows the start they share, when cut short to a
 * width they would read alike, as the "Northern Regional Distribution Center" of "… 0", "… 1",
 * …, and names the axis by that start instead. The start ends with a word. An axis named by the
 * option, or where such a name would not fit, keeps its name, and its labels their last words
 * instead, as many as fit, as "…Center 12", unless those read alike too: then they are what
 * follows the start all the same. Returns the width of the widest label left, if any, in the font
 * of the labels.
 */
function dropSharedStart(
  axis: JsonObject,
  label: JsonObject,
  room: number,
  nameable: boolean,
  font: Font,
): number | undefined {
  const texts = categoryTexts(axis.data);
  // Not of labels that the option hides, which the name would tell nothing of.
  if (!texts || texts.length < 2 || label.formatter !== undefined || label.show === false) {
    return undefined;
  }
  // As ECharts cuts them short, before an ellipsis.
  const cut = (text: string) => startOf(text, room - font.width("…"), font.width);
  if (new Set(texts.map(cut)).size === new Set(texts).size) return undefined;
  let shared = texts[0] ?? "";
  for (const text of texts) {
    let length = 0;
    while (length < shared.length && shared[length] === text[length]) length++;
    shared = shared.slice(0, length);
  }
  const start = /^.*[\s\-_/:.,;|]/s.exec(shared)?.[0];
  const name = start?.replace(/[\s\-_/:.,;|]+$/, "");
  if (!start || !name || texts.some((text) => text.length <= start.length)) return undefined;
  const named = !nameable || (axis.name !== undefined && axis.name !== "");
  if (named) {
    const last = lastWords(room, font);
    // Unless they read alike so too, as of labels that also end alike.
    if (new Set(texts.map(last)).size === new Set(texts).size) {
      label.formatter = last;
      axis.axisLabel = label;
      return Math.max(...texts.map((text) => font.width(last(text))));
    }
  }
  let formatter = sharedStartFormatters.get(start);
  if (!formatter) {
    formatter = (value: unknown) => {
      const text = String(value);
      return text.startsWith(start) ? text.slice(start.length) : text;
    };
    sharedStartFormatters.set(start, formatter);
  }
  label.formatter = formatter;
  axis.axisLabel = label;
  if (!named) axis.name = `${name} …`;
  return Math.max(...texts.map((text) => font.width(text.slice(start.length))));
}

/**
 * By the width and font of the labels they keep, so that a layout of the same option has the
 * same ones.
 */
const lastWordFormatters = new Map<string, (value: unknown) => string>();

/**
 * A formatter of labels wider than some pixels in a font that keeps their last words, as many as
 * fit after an ellipsis, or else the last characters.
 */
function lastWords(room: number, font: Font): (value: unknown) => string {
  const key = `${Math.round(room)} ${font.css}`;
  let formatter = lastWordFormatters.get(key);
  if (!formatter) {
    formatter = (value: unknown) => {
      const text = String(value);
      if (font.width(text) <= room) return text;
      const fits = (end: string) => font.width(`…${end}`) <= room;
      // Each word after the space before it.
      const words = text.split(/(?=\s)/);
      let kept = "";
      for (const word of words.reverse()) {
        if (!fits((word + kept).trimStart())) break;
        kept = word + kept;
      }
      if (kept.trimStart()) return `…${kept.trimStart()}`;
      let end = text.length - 1;
      while (end > 0 && fits(text.slice(end - 1))) end--;
      return `…${text.slice(end)}`;
    };
    lastWordFormatters.set(key, formatter);
  }
  return formatter;
}

/** The height of a row of axis labels, with the gap to the axis. */
const LABEL_HEIGHT = 22;
/** The height that the name of a vertical axis takes above the plot. */
const AXIS_NAME_HEIGHT = 24;
/** The height of a facet's plot below which its axis's name would leave it too short. */
const MIN_NAMED_FACET = 60;
/** The least distance in pixels between the value labels of a vertical axis. */
const MIN_TICK_GAP = 20;
/** The least readable size of a row of facets, and of a facet, which more columns trade off. */
const MIN_FACET_HEIGHT = 150;
const MIN_FACET_WIDTH = 140;
/** The height of a facet's title above its grid, and the gaps between facets. */
const FACET_TITLE_HEIGHT = 26;
const FACET_ROW_GAP = 12;
const FACET_COLUMN_GAP = 24;
/** The size of facets below which the panel scrolls the chart, rather than crush them further. */
const MIN_SCROLLED_FACET_HEIGHT = 100;
const MIN_SCROLLED_FACET_WIDTH = 80;

interface Facet {
  grid: JsonObject;
  title: JsonObject;
}

const sameBox = (object: JsonObject, box: object, keys: string[]) =>
  keys.every((key) => object[key] === (box as JsonObject)[key]);

/**
 * The panels of a faceted chart, each a grid and the title of the same id, where chartFacets
 * places them, in as many columns, or undefined if the option places its grids otherwise, as a
 * user's options can.
 */
function facetPanels(base: JsonObject): { facets: Facet[]; columns: number } | undefined {
  const grids = asArray(base.grid);
  if (grids.length < 2) return undefined;
  const titles = asArray(base.title);
  const columns = grids.filter((grid) => grid.top === grids[0]?.top).length;
  const boxes = facetBoxes(grids.length, columns);
  const facets: Facet[] = [];
  for (const [index, grid] of grids.entries()) {
    const title = grid.id === undefined ? undefined : titles.find(({ id }) => id === grid.id);
    const box = boxes[index];
    if (
      !title ||
      !box ||
      !sameBox(grid, box.grid, BOX_KEYS) ||
      !sameBox(title, box.title, ["left", "right", "top", "bottom"])
    ) {
      return undefined;
    }
    facets.push({ grid, title });
  }
  return { facets, columns };
}

/** The rows of facets in a number of columns, and their width, in the width there is for them. */
const facetGrid = (facets: Facet[], areaWidth: number) => ({
  rows: (columns: number) => Math.ceil(facets.length / columns),
  panelWidth: (columns: number) => (areaWidth - (columns - 1) * FACET_COLUMN_GAP) / columns,
});

/**
 * The least height at which a chart can be read, for the panel to scroll to when it is shorter,
 * or 0 for any height: a row of facets for every few of them, as narrow as they can be.
 */
export function minimumHeight(option: JsonObject, width: number): number {
  const base = baseOption(option);
  const panels = option.media === undefined ? facetPanels(base) : undefined;
  if (!panels) return 0;
  const { facets, columns } = panels;
  const { rows, panelWidth } = facetGrid(facets, width - 32);
  let least = rows(columns);
  for (let more = columns + 1; more <= facets.length; more++) {
    if (panelWidth(more) >= MIN_SCROLLED_FACET_WIDTH) least = Math.min(least, rows(more));
  }
  // The legend of several measures below the facets.
  const legend = asArray(base.legend).some(({ show }) => show !== false) ? 32 : 0;
  return least * MIN_SCROLLED_FACET_HEIGHT + 12 + legend;
}

/**
 * Lays out the panels of a faceted chart for its size in pixels, in the space left: the
 * percentages of the option would leave a short panel's plot hardly any of its height. Rows too
 * short to read go in more columns, unless that makes the panels too narrow instead. Returns the
 * size of a grid in pixels.
 */
function layOutFacets(
  { facets, columns: placed }: { facets: Facet[]; columns: number },
  reserved: Insets,
  size: Size,
): { width: number; height: number } {
  const { width, height } = size;
  const top = reserved.top + 8;
  const left = reserved.left + 16;
  const areaWidth = width - left - reserved.right - 16;
  const areaHeight = height - top - reserved.bottom - 4;
  const { rows, panelWidth } = facetGrid(facets, areaWidth);
  // How near a number of columns comes to panels of the least readable size, at most 1.
  const fit = (columns: number) =>
    Math.min(
      1,
      areaHeight / rows(columns) / MIN_FACET_HEIGHT,
      panelWidth(columns) / MIN_FACET_WIDTH,
    );
  let columns = placed;
  for (let more = columns + 1; more <= facets.length; more++) {
    if (fit(more) > fit(columns)) columns = more;
  }
  const rowHeight = areaHeight / rows(columns);
  const gridWidth = Math.round(panelWidth(columns));
  const gridHeight = Math.max(20, Math.round(rowHeight - FACET_TITLE_HEIGHT - FACET_ROW_GAP));
  facets.forEach(({ grid, title }, index) => {
    const x = Math.round(left + (index % columns) * (panelWidth(columns) + FACET_COLUMN_GAP));
    const y = Math.round(top + Math.floor(index / columns) * rowHeight);
    // In percent of the size laid out for, which a chart resized without a new layout, as while
    // dragging the splitter, scales, rather than cut off panels or leave room beside them.
    const across = (pixels: number) => `${(pixels / width) * 100}%`;
    const down = (pixels: number) => `${(pixels / height) * 100}%`;
    Object.assign(title, { left: across(x), top: down(y) });
    Object.assign(grid, {
      left: across(x),
      top: down(y + FACET_TITLE_HEIGHT),
      width: across(gridWidth),
      height: down(gridHeight),
    });
  });
  shortenFacetTitles(facets, gridWidth - 16, size);
  return { width: gridWidth, height: gridHeight };
}

/**
 * Leaves out the facet column's name, as in "region = ", from the titles of facets when one of
 * them would not fit its panel: the values tell the panels apart, and the panel's header or the
 * chart's title usually names the column.
 */
function shortenFacetTitles(facets: Facet[], width: number, size: Size): void {
  const texts = facets.map(({ title }) => (typeof title.text === "string" ? title.text : ""));
  // In the theme's font of titles, but of chartFacets' size.
  const font = size.font(styleOf(facets[0]?.title.textStyle), { fontSize: 13, fontWeight: 600 });
  if (texts.every((text) => font.width(text) <= width)) return;
  const values = facets.map(({ grid }) => facetValue(grid.id));
  // chartFacets titles a facet "<column> = <value>", the value quoted when values would collide.
  const prefixes = texts.map((text, index) => {
    const value = values[index];
    if (value === undefined) return undefined;
    const label = value.value === null ? "(missing)" : String(value.value);
    const suffix = [label, JSON.stringify(value.value)].find(
      (each) => text.endsWith(each) && text.slice(0, -each.length).endsWith(" = "),
    );
    return suffix === undefined ? undefined : text.slice(0, -suffix.length);
  });
  const prefix = prefixes[0];
  if (prefix === undefined || prefixes.some((each) => each !== prefix)) return;
  facets.forEach(({ title }, index) => {
    title.text = texts[index]?.slice(prefix.length);
  });
}

/** The value of a facet, by the id that chartFacets gives its grid. */
function facetValue(id: unknown): { value: unknown } | undefined {
  if (typeof id !== "string" || !id.startsWith("facet:")) return undefined;
  try {
    return { value: JSON.parse(id.slice("facet:".length)) };
  } catch {
    return undefined;
  }
}

/**
 * Gives a time axis across the chart fewer labels when they would run into each other along its
 * length, as they would in a narrow plot: ECharts steps its ticks by the split number alone, and
 * draws every label. Only of an axis whose labels the panel formats (see {@link TIME_LABELS}),
 * as wide as "Feb 13" or "12:30".
 */
function fewerTimeTicks(axis: JsonObject, length: number, font: Font): void {
  const label = isPlainObject(axis.axisLabel) ? axis.axisLabel : {};
  if (
    axisType(axis) !== "time" ||
    label.formatter !== undefined ||
    axis.splitNumber !== undefined ||
    axis.interval !== undefined ||
    axis.minInterval !== undefined
  ) {
    return;
  }
  // ECharts rounds the step down to a whole one, which can make half as many ticks again as the
  // split number asks for, as with value axes; it asks for 6 itself.
  const asked = Math.max(2, Math.floor(length / (font.width("Feb 13") + 16) / 1.5));
  if (asked < 6) axis.splitNumber = asked;
}

/**
 * Gives a value axis fewer labels when they would pile on each other along its length, at least
 * `gap` apart. A facet's axis with the bounds and interval that the facets share gets wider ones;
 * the bounds and interval of any other axis are the option's own, which this leaves alone.
 */
function fewerTicks(axis: JsonObject, length: number, gap: number, faceted: boolean): void {
  if (axisType(axis) !== "value") return;
  const parts = Math.max(2, Math.floor(length / gap));
  const { min, max, interval } = axis;
  if (
    !faceted ||
    typeof min !== "number" ||
    typeof max !== "number" ||
    typeof interval !== "number"
  ) {
    // ECharts rounds the interval to a nice one, which can make half as many ticks again as the
    // split number asks for: 7 for 5 from 0 to 6.
    const asked = Math.max(2, Math.floor(parts / 1.5));
    if (axis.interval === undefined && axis.splitNumber === undefined && asked < 5) {
      axis.splitNumber = asked;
    }
    return;
  }
  if (!(interval > 0) || (max - min) / interval <= parts + 1e-9) return;
  // The same bounds and interval give every facet, of the same size, the same ticks. A step of
  // counts stays a whole number of them.
  const whole = typeof axis.minInterval === "number" ? axis.minInterval : 0;
  for (let step = niceAbove(interval); Number.isFinite(step); step = niceAbove(step)) {
    if (whole > 0 && !Number.isInteger(round(step / whole))) continue;
    const low = round(Math.floor(min / step + 1e-9) * step);
    const high = round(Math.ceil(max / step - 1e-9) * step);
    if ((high - low) / step <= parts + 1e-9) {
      Object.assign(axis, { min: low, max: high, interval: step });
      return;
    }
  }
}

const round = (value: number) => Number(value.toPrecision(12));

/** The smallest of 1, 2, 2.5 and 5 times a power of 10 above a step. */
function niceAbove(step: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(step));
  for (const multiple of [1, 2, 2.5, 5]) {
    const nice = round(multiple * magnitude);
    if (nice > step * (1 + 1e-9)) return nice;
  }
  return round(10 * magnitude);
}

/** Fits a single pie into the space left, with labels around it when they fit. */
function layOutPie(base: JsonObject, series: JsonObject[], reserved: Insets, size: Size): void {
  const pies = series.filter((s) => s.type === "pie");
  const pie = pies.length === 1 ? pies[0] : undefined;
  if (!pie || has(pie, [...BOX_KEYS, "center"])) {
    return;
  }
  // ECharts 6 lays out pies in a box; the radius percentage is relative to the box.
  Object.assign(pie, {
    left: reserved.left + 8,
    right: reserved.right + 8,
    top: reserved.top + 8,
    bottom: reserved.bottom + 8,
  });
  const boxWidth = size.width - reserved.left - reserved.right - 16;
  const boxHeight = size.height - reserved.top - reserved.bottom - 16;
  let label = isPlainObject(pie.label) ? pie.label : {};
  const hasLegend = asArray(base.legend).some((l) => l.show !== false);
  if (
    !labelsSet(pie) &&
    hasLegend &&
    (boxHeight < 220 || !pieLabelsFit(pie, boxWidth, boxHeight, size))
  ) {
    // Too small for labels around the pie: the legend and tooltip name the slices.
    label = hidePieLabels(pie);
  }
  const outsideLabels =
    label.show !== false &&
    !["inside", "inner", "center"].includes(String(label.position ?? "outside"));
  // A radius of the option's own stays as it is, as of a doughnut.
  const chosen = pie.radius === undefined;
  if (chosen) {
    // In a wide box, the labels fit beside the pie, which can then take more of the height.
    const ratio = boxWidth / Math.max(1, boxHeight);
    const radius = !outsideLabels
      ? 90
      : ratio >= 1.6
        ? 76
        : ratio >= 1.2
          ? 68
          : ratio >= 0.9
            ? 58
            : 50;
    pie.radius = `${radius}%`;
  }
  const line = isPlainObject(pie.labelLine) ? pie.labelLine : {};
  const outer = outerRadius(pie.radius, Math.min(boxWidth, boxHeight) / 2);
  // ECharts' parts of a label line.
  const [length, length2] = [line.length ?? 15, line.length2 ?? 30];
  const labels = pieLabels(pie, size);
  if (
    !outsideLabels ||
    (label.alignTo ?? "edge") !== "edge" ||
    outer === undefined ||
    typeof length !== "number" ||
    typeof length2 !== "number" ||
    labels === undefined ||
    // Beside the pie: after the line, the gap to the label, and ECharts' margin to the edge.
    labels.every(
      ({ across, whole }) => across * (outer + length) + length2 + 5 + 10 + whole <= boxWidth / 2,
    )
  ) {
    return;
  }
  // Labels that do not fit beside the pie on one line go onto several, from the edge of the box
  // in to their line, and a pie of the panel's radius leaves the room for them.
  label.alignTo ??= "edge";
  label.edgeDistance ??= 8;
  const lines = label.width === undefined && label.overflow === undefined;
  if (lines) label.overflow = "break";
  pie.label = label;
  // The second part of a line is drawn out to its label at the edge anyway.
  line.length2 ??= 0;
  pie.labelLine = line;
  const most = labeledRadius(labels, boxWidth, length);
  const half = Math.min(boxWidth, boxHeight) / 2;
  if (chosen && outer > most) {
    pie.radius = scaleRadius(pie.radius, Math.max(most, MIN_LABELED_PIE * half) / outer);
  }
  // A word of a name wider than the room beside the pie, as of the option's radius, is cut short
  // rather than broken within it, which ECharts does to a word longer than a line, and the rest of
  // the label, as the share it tells, goes onto lines after it; a label of no name to cut short, or
  // beside too little room for its share, is cut short whole. The tooltip tells it whole.
  const radius = outerRadius(pie.radius, half) ?? outer;
  const edge = typeof label.edgeDistance === "number" ? label.edgeDistance : 8;
  // The room beside each slice whose label has a word wider than it.
  const rooms = labels.map(({ across, word }) => {
    const room = boxWidth / 2 - edge - 5 - across * (radius + length);
    return room < word ? room : undefined;
  });
  if (lines && Array.isArray(pie.data) && rooms.some((room) => room !== undefined)) {
    const { template, values } = labelTemplate(label);
    const width = labelWidth(label, size);
    pie.data = pie.data.map((item: unknown, index) => {
      const room = rooms[index];
      if (room === undefined) return item;
      const own: JsonObject = isPlainObject(item) ? item : { value: item };
      const itemLabel = isPlainObject(own.label) ? own.label : {};
      // A word as much of it as fits, with its ellipsis and the punctuation after it, as the ":"
      // of "{b}: {d}%". The ellipsis is of dots, which ECharts measures as wide as the browser
      // draws them: it breaks a line again where those differ, and "…" it takes for a wide one.
      const cut = (word: string) => {
        if (width(`${word}:`) <= room) return word;
        let kept = word.length - 1;
        while (kept > 0 && width(`${word.slice(0, kept)}...:`) > room) kept--;
        return kept > 0 ? `${word.slice(0, kept)}...` : undefined;
      };
      const name = own.name;
      const words = typeof name === "string" ? (name.match(WORDS) ?? []).map(cut) : [];
      const formatter =
        typeof name === "string" &&
        // Of a template, rather than a function of the option's own, which formats it.
        (label.formatter === undefined || typeof label.formatter === "string") &&
        template.includes("{b}") &&
        // Not of the markup of a template, which ECharts would read in the name.
        !/[{}]/.test(name) &&
        words.every((word) => word !== undefined) &&
        // Nor beside a value that the room is too narrow for, as "25.74%".
        room >= (values > 0 ? width(SHARE) : 0)
          ? template.replaceAll("{b}", () => words.join(""))
          : undefined;
      return {
        ...own,
        label: formatter
          ? { formatter, ...itemLabel }
          : { overflow: "truncate", ellipsis: "…", ...itemLabel },
      };
    });
  }
}

/**
 * The template that labels the slices of a pie, by default their names, and how many values it
 * tells besides, as the "{d}" of "{b}: {d}%".
 */
function labelTemplate(label: JsonObject): { template: string; values: number } {
  const template = typeof label.formatter === "string" ? label.formatter : "{b}";
  return { template, values: template.match(/\{(?!b\})[^{}|]*\}/g)?.length ?? 0 };
}

/** A value as wide as most that a label tells, as "25.74%". */
const SHARE = "00.00%";

/**
 * The words of a text as ECharts breaks it onto lines between them: runs of letters of alphabets,
 * which end at a space and at some punctuation, and each other character on its own, as one of
 * Chinese, which it breaks between any two.
 */
const WORDS = /[!-%'-+\-.0-:<->@-\\^-\u024f\u0370-\u10ff\u1200-\u13ff\u1e00-\u206f]+|[\s\S]/g;

/**
 * The width of a text in the font of the names of a pie's labels: of the rich text style that
 * their template sets them in, as the "name" of "{name|{b}}", over the label's own, as ECharts
 * makes a name's font, as its size or weight, and else the chart's.
 */
function labelWidth(label: JsonObject, size: Size): (text: string) => number {
  const { template } = labelTemplate(label);
  const name = /\{(\w+)\|[^{}]*\{b\}/.exec(template)?.[1];
  const rich = isPlainObject(label.rich) && name !== undefined ? label.rich[name] : undefined;
  return size.font(...(isPlainObject(rich) ? [rich, label] : [label])).width;
}

/** Hides the labels of a pie's slices and their lines. Returns the label settings. */
function hidePieLabels(pie: JsonObject): JsonObject {
  const label = { ...(isPlainObject(pie.label) ? pie.label : {}), show: false };
  pie.label = label;
  pie.labelLine = { ...(isPlainObject(pie.labelLine) ? pie.labelLine : {}), show: false };
  return label;
}

/**
 * Whether the option sets how to label the slices of a pie, as with a template that tells their
 * shares: then it labels them, as long as it shows them, for want of room as well.
 */
const labelsSet = (pie: JsonObject) =>
  isPlainObject(pie.label) && Object.keys(pie.label).length > 0;

/** The least radius of a pie with labels beside it, as a share of the radius it could have. */
const MIN_LABELED_PIE = 0.4;

/** The label of a slice of a pie, as wide as some pixels. */
interface PieLabel {
  /** How far across the pie the slice's middle is from its center, from 0 at the top to 1. */
  across: number;
  /** The width of the label on one line. */
  whole: number;
  /** The least width it goes onto three lines of, at least that of its longest word. */
  least: number;
  /** The width of its longest word. */
  word: number;
}

/**
 * The labels of a pie's slices, as ECharts places them: around the pie from its top, clockwise,
 * unless told otherwise. Undefined for more slices than the layout reads, which have no room for
 * labels; none for the slices of a dataset.
 */
function pieLabels(pie: JsonObject, size: Size): PieLabel[] | undefined {
  const data: unknown[] = Array.isArray(pie.data) ? pie.data : [];
  if (data.length > MAX_READ_CATEGORIES) return undefined;
  const label = isPlainObject(pie.label) ? pie.label : {};
  const width = labelWidth(label, size);
  // ECharts labels a slice by its name, and a template adds its text and its values, each about
  // as wide as "25.74".
  const { template, values } = labelTemplate(label);
  const named = template.includes("{b}");
  const value = (item: unknown) => {
    const number = Number(isPlainObject(item) ? item.value : item);
    return Number.isFinite(number) && number > 0 ? number : 0;
  };
  const total = data.reduce((sum: number, item) => sum + value(item), 0);
  const start = typeof pie.startAngle === "number" ? pie.startAngle : 90;
  const turn = pie.clockwise === false ? 1 : -1;
  let before = 0;
  return data.map((item) => {
    const share = total > 0 ? value(item) / total : 1 / data.length;
    const middle = ((start + turn * 360 * (before + share / 2)) * Math.PI) / 180;
    before += share;
    const name = named ? String((isPlainObject(item) ? item.name : undefined) ?? "") : "";
    // With the punctuation after it, as the ":" of "{b}: {d}%".
    const word = Math.max(
      values > 0 ? width(SHARE) : 0,
      ...(name.match(WORDS) ?? []).map((part) => width(`${part}:`)),
    );
    const whole = width(
      template.replace(/\{[^{}|]*\}/g, (field) => (field === "{b}" ? name : SHARE.slice(0, -1))),
    );
    return {
      across: Math.abs(Math.cos(middle)),
      whole,
      least: Math.max(word, Math.ceil(whole / 3)),
      word,
    };
  });
}

/**
 * The most radius of a pie in a box whose labels go from the edge of the box in to their lines,
 * of a first part of a length, each as wide as the least it goes onto lines of.
 */
function labeledRadius(labels: PieLabel[], boxWidth: number, length: number): number {
  // The gap from the line to the label, the label's distance from the edge, and a margin.
  const room = boxWidth / 2 - 5 - 8 - 4;
  return Math.min(
    boxWidth / 2,
    ...labels.map(({ across, least }) =>
      across > 0.01 ? (room - least) / across - length : boxWidth / 2,
    ),
  );
}

/** Whether a pie's labels fit beside it in a box, on lines from its edge, if need be. */
function pieLabelsFit(pie: JsonObject, boxWidth: number, boxHeight: number, size: Size): boolean {
  const labels = pieLabels(pie, size);
  const line = isPlainObject(pie.labelLine) ? pie.labelLine : {};
  const half = Math.min(boxWidth, boxHeight) / 2;
  // Beside the radius that the option gives, or else as small as the panel makes a pie.
  const radius = pie.radius === undefined ? MIN_LABELED_PIE * half : outerRadius(pie.radius, half);
  return (
    labels !== undefined &&
    radius !== undefined &&
    labeledRadius(labels, boxWidth, typeof line.length === "number" ? line.length : 15) >= radius
  );
}

/** The outer radius in pixels of a pie, of a box of a size half that, if it can tell. */
function outerRadius(radius: unknown, half: number): number | undefined {
  return pixels(Array.isArray(radius) ? radius[radius.length - 1] : radius, half);
}

/** A pie's radius, inner and outer, scaled by a factor, as percentages or pixels. */
function scaleRadius(radius: unknown, factor: number): unknown {
  const scale = (value: unknown) =>
    typeof value === "number"
      ? Math.round(value * factor)
      : typeof value === "string" && value.endsWith("%")
        ? `${Math.round(Number.parseFloat(value) * factor)}%`
        : value;
  return Array.isArray(radius) ? radius.map(scale) : scale(radius);
}

/**
 * Keeps series that ECharts lays out in a box clear of the title, legend and other components.
 * The nodes of a force layout that a timeline's steps set stay ECharts' to place, as those of the
 * step shown would replace the nodes placed.
 */
function layOutBoxSeries(
  series: JsonObject[],
  reserved: Insets,
  size: Size,
  stepped: ReadonlySet<unknown>,
): void {
  const { width, height } = size;
  for (const each of series) {
    const type = String(each.type);
    const placed =
      has(each, BOX_KEYS) ||
      (type === "graph" && (each.coordinateSystem ?? "view") !== "view") ||
      (type === "chord" && each.center !== undefined);
    if (placed || !["funnel", "sankey", "tree", "treemap", "graph", "chord"].includes(type)) {
      continue;
    }
    if (type === "graph" && (each.layout ?? "none") === "none") {
      // ECharts fits the nodes where they are into 80% of the chart, keeping their aspect: fit
      // them so into the space left instead, as a box alone would stretch them to fill it.
      const marginX = Math.round((width - reserved.left - reserved.right) * 0.1);
      const marginY = Math.round((height - reserved.top - reserved.bottom) * 0.1);
      Object.assign(each, {
        top: reserved.top + marginY,
        bottom: reserved.bottom + marginY,
        left: reserved.left + marginX,
        right: reserved.right + marginX,
      });
      each.preserveAspect ??= true;
      continue;
    }
    const area: Area = {
      left: reserved.left + 8,
      top: reserved.top + 8,
      width: width - reserved.left - reserved.right - 16,
      height: height - reserved.top - reserved.bottom - 16,
    };
    if (
      type === "graph" &&
      each.layout === "force" &&
      !stepped.has(each) &&
      placeForceNodes(each, area, size)
    ) {
      fitPlacedGraph(each, area, size);
      each.preserveAspect ??= true;
      continue;
    }
    if (type === "graph" && each.layout === "force")
      spreadForce(
        each,
        width - reserved.left - reserved.right,
        height - reserved.top - reserved.bottom,
      );
    // Trees and funnels keep ECharts' default margins, for the labels beside them.
    const side = type === "tree" ? Math.round(width * 0.12) : type === "funnel" ? 80 : 12;
    const [left, right] =
      type === "funnel"
        ? funnelSides(each, side, size)
        : type === "tree"
          ? treeSides(each, side, size)
          : // Room for the labels right of the last column of sankey nodes.
            [side, type === "sankey" ? Math.round(Math.min(160, width * 0.18)) : side];
    // Room for the breadcrumb of a treemap.
    const breadcrumb = type === "treemap" ? breadcrumbSide(each, height) : undefined;
    Object.assign(each, {
      top: reserved.top + (breadcrumb === "top" ? 36 : 12),
      bottom: reserved.bottom + (breadcrumb === "bottom" ? 36 : 12),
      left: reserved.left + left,
      right: reserved.right + right,
    });
  }
}

/**
 * The room a funnel keeps on its left and right: the margin, and on the side of its labels, which
 * ECharts draws beside it on the right unless told otherwise, as much as they take, up to 40% of
 * the width: its widest part spans the box it is laid out in.
 */
function funnelSides(funnel: JsonObject, margin: number, size: Size): [number, number] {
  const label = isPlainObject(funnel.label) ? funnel.label : {};
  const position = String(label.position ?? "outer");
  if (
    label.show === false ||
    funnel.orient === "horizontal" ||
    ["inner", "inside", "center", "insideLeft", "insideRight"].includes(position)
  ) {
    return [margin, margin];
  }
  const most = Math.round(size.width * 0.4);
  const { width } = size.font(label);
  // A template adds its text, and a value of about 6 characters for each other placeholder.
  const { formatter } = label;
  const added =
    typeof formatter === "string"
      ? width(
          formatter.replace(/\{[^{}]*\}/g, "") +
            "000.00".repeat(formatter.match(/\{(?!b\})[^{}]*\}/g)?.length ?? 0),
        )
      : 0;
  const line = isPlainObject(funnel.labelLine) ? funnel.labelLine : {};
  // The label line, the gap after it, and a margin to the edge.
  const gap = (typeof line.length === "number" ? line.length : 20) + 13;
  const text = widestText(funnel.data, width, most) + added;
  const room = Math.max(margin, Math.min(most, Math.round(text + gap)));
  return position.startsWith("left") ? [room, margin] : [margin, room];
}

/**
 * Labels the nodes of a tree laid out from left to right, or right to left, beside them, as
 * ECharts' examples do, unless told otherwise: the nodes with children before them, toward the
 * root, and the leaves after them. ECharts centers a label on its node, where it runs over the
 * node and its lines. A label longer than the room the tree keeps beside it (see
 * {@link treeSides}) goes onto lines, if the deepest nodes are far enough apart, or is cut short.
 */
function labelTreeNodes(series: JsonObject[], { width, height }: Size): void {
  for (const tree of series) {
    const orient = tree.orient ?? "LR";
    const label = isPlainObject(tree.label) ? tree.label : {};
    if (
      tree.type !== "tree" ||
      (tree.layout ?? "orthogonal") !== "orthogonal" ||
      (orient !== "LR" && orient !== "RL") ||
      label.position !== undefined
    ) {
      continue;
    }
    const [before, after] = orient === "LR" ? ["left", "right"] : ["right", "left"];
    const [root] = Array.isArray(tree.data) ? tree.data : [];
    const apart = height / Math.max(1, deepestShown(root, tree).length);
    const beside = (side: string) => ({
      position: side,
      align: side === "left" ? "right" : "left",
      verticalAlign: "middle",
      width: Math.round(width * MAX_TREE_LABELS) - 12,
      overflow: apart >= 2 * LABEL_LINE_HEIGHT + 4 ? "break" : "truncate",
    });
    tree.label = { ...beside(before), ...label };
    const leaves = isPlainObject(tree.leaves) ? tree.leaves : {};
    const leafLabel = isPlainObject(leaves.label) ? leaves.label : {};
    if (leafLabel.position === undefined) {
      tree.leaves = { ...leaves, label: { ...beside(after), ...leafLabel } };
    }
  }
}

/** The width of the labels beside a tree, at most, as a share of the chart's width. */
const MAX_TREE_LABELS = 0.4;

/** The nodes of the deepest level of a tree that ECharts shows, at first, below its root. */
function deepestShown(root: unknown, tree: JsonObject): unknown[] {
  // ECharts shows two levels below the root unless told otherwise.
  const depth = typeof tree.initialTreeDepth === "number" ? tree.initialTreeDepth : 2;
  let deepest: unknown[] = [root];
  for (let level = 0; depth < 0 || level < depth; level++) {
    const next = deepest.flatMap((node) =>
      isPlainObject(node) && Array.isArray(node.children) && node.collapsed !== true
        ? node.children
        : [],
    );
    if (next.length === 0) break;
    deepest = next;
  }
  return deepest;
}

/**
 * The room a tree laid out from left to right, or right to left, keeps beside it: the margin, or
 * as much as the labels at its ends take, of its root and of the nodes of the deepest level it
 * shows, beside them (see {@link labelTreeNodes}) or centered on them, up to 40% of the width.
 */
function treeSides(tree: JsonObject, margin: number, size: Size): [number, number] {
  const orient = tree.orient ?? "LR";
  const [root] = Array.isArray(tree.data) ? tree.data : [];
  if ((tree.layout ?? "orthogonal") !== "orthogonal" || (orient !== "LR" && orient !== "RL")) {
    return [margin, margin];
  }
  if (!isPlainObject(root)) return [margin, margin];
  const deepest = deepestShown(root, tree);
  const position = (label: unknown) => (isPlainObject(label) ? label.position : undefined);
  const leaves = isPlainObject(tree.leaves) ? tree.leaves.label : undefined;
  const most = Math.round(size.width * MAX_TREE_LABELS);
  // The width a label takes beyond its node on a side: all of it on that side, none on the
  // other, and half when centered on it. Past the symbol, with a gap to the edge.
  const room = (labels: unknown[], placed: unknown, side: "left" | "right", font: Font) => {
    const share = placed === side ? 1 : placed === "left" || placed === "right" ? 0 : 0.5;
    const text = widestText(labels, font.width, most) * share;
    return Math.max(margin, Math.min(most, Math.round(text + 12)));
  };
  const rootSide = orient === "LR" ? "left" : "right";
  const endSide = orient === "LR" ? "right" : "left";
  const font = size.font(styleOf(tree.label));
  const start = room([root], position(tree.label), rootSide, font);
  // The leaves are labeled as "leaves" says, and the nodes whose children are not shown yet not.
  const isLeaf = (node: unknown) => !isPlainObject(node) || !Array.isArray(node.children);
  const end = Math.max(
    room(
      deepest.filter(isLeaf),
      position(leaves) ?? position(tree.label),
      endSide,
      size.font(styleOf(leaves), styleOf(tree.label)),
    ),
    room(
      deepest.filter((node) => !isLeaf(node)),
      position(tree.label),
      endSide,
      font,
    ),
  );
  return orient === "LR" ? [start, end] : [end, start];
}

/** A part of the chart, in pixels. */
interface Area {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The width of the room for a graph's nodes in an area as a share of its height, less what their
 * symbols and labels take around them on average, of 0.4 to 2.5.
 */
function nodesAspect(graph: JsonObject, nodes: JsonObject[], area: Area, size: Size): number {
  const extents = nodes.map((node) => nodeExtent(node, graph, size));
  const average = (side: number) =>
    extents.reduce((sum, extent) => sum + (extent[side] ?? 0), 0) / Math.max(1, extents.length);
  const width = area.width - average(0) - average(1);
  const height = area.height - average(2) - average(3);
  return Math.min(2.5, Math.max(0.4, width / Math.max(1, height)));
}

/** The most nodes of a force layout that the panel places itself, quickly enough on a resize. */
const MAX_PLACED_NODES = 200;
/** The length of an edge that the panel places the nodes of a force layout at, unless told. */
const FORCE_EDGE = 100;
/** The length in pixels of an edge of a force layout that the panel draws, at most. */
const MAX_EDGE = 200;

/** The nodes of force layouts as placed, by the nodes and links that they were placed from. */
const placedNodes = new WeakMap<object, { links: unknown; force: string; nodes: unknown[] }>();

/**
 * Places the nodes of a force layout where ECharts' force layout brings them to rest, as a layout
 * of placed nodes for ECharts to fit into the space there is. ECharts places them at random around
 * the middle of the chart and pushes them apart without bound, by how far depending on the shape
 * of the graph and where they started: of random graphs, half of those in a narrow panel and of
 * those in a wide one had nodes or labels past its edges. Placed so, a graph is drawn whole, and
 * the same each time; a node dragged moves alone, rather than pulling the others along. Not one
 * whose nodes the option places or fixes, or whose layout it starts or animates otherwise, nor
 * one of more nodes than the panel places quickly.
 */
function placeForceNodes(graph: JsonObject, area: Area, size: Size): boolean {
  const key = graph.data != null ? "data" : "nodes";
  const nodes: unknown = graph[key];
  const links: unknown = graph.links ?? graph.edges;
  const force = isPlainObject(graph.force) ? graph.force : {};
  if (
    !Array.isArray(nodes) ||
    nodes.length === 0 ||
    nodes.length > MAX_PLACED_NODES ||
    ["initLayout", "friction", "layoutAnimation"].some((name) => force[name] !== undefined) ||
    !nodes.every((node) => isPlainObject(node) && node.x == null && node.y == null && !node.fixed)
  ) {
    return false;
  }
  // The edge length and repulsion that the option gives, or else ECharts' proportions of them.
  const edgeLength = force.edgeLength ?? (force.repulsion === undefined ? FORCE_EDGE : 30);
  const repulsion =
    force.repulsion ?? (force.edgeLength === undefined ? 50 * (FORCE_EDGE / 30) ** 2 : [0, 50]);
  const gravity = typeof force.gravity === "number" ? force.gravity : 0.1;
  // As wide as the area for them is, apart from their labels, in steps of a fourth of a doubling.
  const stretch = 2 ** (Math.round(4 * Math.log2(nodesAspect(graph, nodes, area, size))) / 4);
  const settings = JSON.stringify([edgeLength, repulsion, gravity, stretch]);
  const cached = placedNodes.get(nodes);
  let placed =
    cached && cached.links === links && cached.force === settings ? cached.nodes : undefined;
  if (!placed) {
    const points = restingPoints(nodes, Array.isArray(links) ? links : [], {
      edgeLength,
      repulsion,
      gravity,
      stretch,
    });
    if (!points) return false;
    placed = nodes.map((node: JsonObject, index) => ({ ...node, ...points[index] }));
    placedNodes.set(nodes, { links, force: settings, nodes: placed });
  }
  graph[key] = placed;
  graph.layout = "none";
  return true;
}

/** A setting of a range by value, as a repulsion or edge length, as its least and most. */
function settingRange(setting: unknown): [number, number] | undefined {
  const [low, high] = Array.isArray(setting) ? setting : [setting, setting];
  return typeof low === "number" && typeof high === "number" ? [low, high] : undefined;
}

/**
 * ECharts' maps of the values of items onto a range, from the least to the most of them: to the
 * middle of the range for an item without one, or items of one value.
 */
function mapValues(items: unknown[], [low, high]: [number, number]): number[] {
  const values = items.map((item) =>
    isPlainObject(item) && typeof item.value === "number" ? item.value : Number.NaN,
  );
  const finite = values.filter(Number.isFinite);
  const [least, most] = [Math.min(...finite), Math.max(...finite)];
  return values.map((value) =>
    Number.isFinite(value) && most > least
      ? low + ((value - least) / (most - least)) * (high - low)
      : (low + high) / 2,
  );
}

/** A node of a force layout as it moves: where it is and was, and how hard it pushes the others. */
interface Moving {
  x: number;
  y: number;
  /** Where it was, less the push of the others, which moves it on the next step. */
  px: number;
  py: number;
  repulsion: number;
}

/**
 * Where ECharts' force layout brings nodes to rest, as its forceHelper.js moves them, from places
 * that a seeded random number generator gives, but pulled toward the middle of where they are
 * rather than of the chart, which is what ECharts takes for the middle of nodes placed for it.
 * Each node pushes the others away by its repulsion, by its value of a range, and each link pulls
 * its ends toward its length, by its value of a range, the longest for the smallest. Undefined for
 * settings of kinds that ECharts would not lay out by.
 */
function restingPoints(
  nodes: JsonObject[],
  links: unknown[],
  force: { edgeLength: unknown; repulsion: unknown; gravity: number; stretch: number },
): { x: number; y: number }[] | undefined {
  const repulsions = settingRange(force.repulsion);
  const lengths = settingRange(force.edgeLength);
  if (!repulsions || !lengths) return undefined;
  let seed = 1;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  // At first within a square as wide as the nodes take apart, around 0.
  const span = (FORCE_EDGE * Math.sqrt(nodes.length)) / 2;
  const moving: Moving[] = mapValues(nodes, repulsions).map((repulsion) => {
    const [x, y] = [(random() - 0.5) * span, (random() - 0.5) * span];
    return { x, y, px: x, py: y, repulsion };
  });
  // Links name their ends by id, name or index.
  const indices = new Map(nodes.map((node, index) => [String(node.id ?? node.name), index]));
  const end = (value: unknown) =>
    moving[typeof value === "number" ? value : (indices.get(String(value)) ?? -1)];
  const pulled = links.filter((link) => isPlainObject(link) && link.ignoreForceLayout !== true);
  const edgeLengths = mapValues(pulled, [lengths[1], lengths[0]]);
  const edges = pulled.flatMap((link, index) => {
    const [n1, n2] = isPlainObject(link) ? [end(link.source), end(link.target)] : [];
    return n1 && n2 ? [{ n1, n2, length: edgeLengths[index] ?? 0 }] : [];
  });
  // Pulled toward the middle harder up and down than across, nodes take a width of about the
  // square of that times their height.
  const pull = Math.sqrt(force.stretch);
  for (let friction = 0.6; friction >= 0.01; friction *= 0.992) {
    for (const { n1, n2, length } of edges) {
      const distance = Math.hypot(n2.x - n1.x, n2.y - n1.y);
      const [ux, uy] = distance > 0 ? [(n2.x - n1.x) / distance, (n2.y - n1.y) / distance] : [0, 0];
      const pull = (distance - length) * friction;
      const share = n2.repulsion / (n1.repulsion + n2.repulsion) || 0;
      n1.x += ux * share * pull;
      n1.y += uy * share * pull;
      n2.x -= ux * (1 - share) * pull;
      n2.y -= uy * (1 - share) * pull;
    }
    let [left, right, top, bottom] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const { x, y } of moving) {
      [left, right, top, bottom] = [
        Math.min(left, x),
        Math.max(right, x),
        Math.min(top, y),
        Math.max(bottom, y),
      ];
    }
    for (const node of moving) {
      node.x += ((left + right) / 2 - node.x) * (force.gravity / pull) * friction;
      node.y += ((top + bottom) / 2 - node.y) * force.gravity * pull * friction;
    }
    for (let i = 0; i < moving.length; i++) {
      const n1 = moving[i] as Moving;
      for (let j = i + 1; j < moving.length; j++) {
        const n2 = moving[j] as Moving;
        let vx = n2.x - n1.x;
        let vy = n2.y - n1.y;
        let squared = vx * vx + vy * vy;
        if (squared === 0) [vx, vy, squared] = [random() - 0.5, random() - 0.5, 1];
        const push = (n1.repulsion + n2.repulsion) / squared;
        n1.px += vx * push;
        n1.py += vy * push;
        n2.px -= vx * push;
        n2.py -= vy * push;
      }
    }
    for (const node of moving) {
      node.x += (node.x - node.px) * friction;
      node.y += (node.y - node.py) * friction;
      node.px = node.x;
      node.py = node.y;
    }
  }
  return moving.map(({ x, y }) => ({ x, y }));
}

/**
 * How far a node of a graph takes room from where it is, to the left, right, top and bottom: half
 * its symbol, and its label, which the theme places right of the node unless told otherwise, 5
 * pixels from it.
 */
function nodeExtent(
  node: JsonObject,
  graph: JsonObject,
  size: Size,
): [number, number, number, number] {
  const symbol = (value: unknown): number[] | undefined =>
    typeof value === "number"
      ? [value, value]
      : Array.isArray(value) && value.every((each) => typeof each === "number")
        ? [value[0] ?? 0, value[1] ?? value[0] ?? 0]
        : undefined;
  const [width = 10, height = 10] = symbol(node.symbolSize) ?? symbol(graph.symbolSize) ?? [];
  const [x, y] = [width / 2, height / 2];
  const own = isPlainObject(node.label) ? node.label : {};
  const label = { ...(isPlainObject(graph.label) ? graph.label : {}), ...own };
  if (label.show !== true) return [x, x, y, y];
  const text = size.font(label).width(String(node.name ?? ""));
  // A line of text, half above and below the middle of the node beside it.
  const line = LABEL_LINE_HEIGHT / 2;
  switch (label.position ?? "right") {
    case "left":
      return [x + 5 + text, x, Math.max(y, line), Math.max(y, line)];
    case "right":
      return [x, x + 5 + text, Math.max(y, line), Math.max(y, line)];
    case "top":
      return [Math.max(x, text / 2), Math.max(x, text / 2), y + 5 + 2 * line, y];
    case "bottom":
      return [Math.max(x, text / 2), Math.max(x, text / 2), y, y + 5 + 2 * line];
    default:
      return [Math.max(x, text / 2), Math.max(x, text / 2), Math.max(y, line), Math.max(y, line)];
  }
}

/**
 * The most pixels a unit of a graph's placed nodes can take along an axis for them to fit into a
 * length, with what each takes beyond where it is before and after it: no two of them too far
 * apart for what they take between them. Infinite for nodes all in one place.
 */
function mostScale(at: number[], before: number[], after: number[], length: number): number {
  let most = Number.POSITIVE_INFINITY;
  at.forEach((first, i) => {
    at.forEach((second, j) => {
      if (second > first) {
        most = Math.min(most, (length - (after[j] ?? 0) - (before[i] ?? 0)) / (second - first));
      }
    });
  });
  return most;
}

/**
 * Fits a graph's placed nodes into an area of the chart, as large as there is room for and in the
 * middle of it, with the room each takes around it for its symbol and label: the box that ECharts
 * fits them into, keeping their aspect, is where their bounds go, as much bigger than the area as
 * labels may take beyond them, which are not as long as the longest at every edge.
 */
function fitPlacedGraph(graph: JsonObject, area: Area, size: Size): void {
  const data: unknown = graph.data ?? graph.nodes;
  const nodes = (Array.isArray(data) ? data : []).filter(isPlainObject);
  const xs = nodes.map((node) => Number(node.x));
  const ys = nodes.map((node) => Number(node.y));
  const extents = nodes.map((node) => nodeExtent(node, graph, size));
  const side = (index: number) => extents.map((extent) => extent[index] ?? 0);
  const [left, right, top, bottom] = [side(0), side(1), side(2), side(3)];
  const fit = (before: number[][], after: number[][]) =>
    Math.min(
      mostScale(xs, before[0] ?? [], after[0] ?? [], area.width),
      mostScale(ys, before[1] ?? [], after[1] ?? [], area.height),
    );
  // Where labels take more than the area, the nodes alone fill it.
  const none = nodes.map(() => 0);
  let scale = fit([left, top], [right, bottom]);
  if (!(scale > 0)) scale = fit([none, none], [none, none]);
  // No longer edges than a force layout spread over the panel had, of a few nodes in a large one.
  const [shortest = FORCE_EDGE, longest = FORCE_EDGE] =
    settingRange(isPlainObject(graph.force) ? graph.force.edgeLength : undefined) ?? [];
  scale = Math.min(scale, MAX_EDGE / ((shortest + longest) / 2));
  // ECharts widens bounds of no width or height by a unit each way.
  const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
  const [minY, maxY] = [Math.min(...ys), Math.max(...ys)];
  const [fromX, toX] = maxX > minX ? [minX, maxX] : [minX - 1, maxX + 1];
  const [fromY, toY] = maxY > minY ? [minY, maxY] : [minY - 1, maxY + 1];
  const units = Number.isFinite(scale) && scale > 0 ? scale : 1;
  // Where the nodes and what they take reach, from where the bounds start, and so where they
  // start in the middle of the area.
  const reach = (
    at: number[],
    before: number[],
    after: number[],
    from: number,
  ): [number, number] => {
    const starts = at.map((each, index) => (each - from) * units - (before[index] ?? 0));
    const ends = at.map((each, index) => (each - from) * units + (after[index] ?? 0));
    return [Math.min(...starts), Math.max(...ends)];
  };
  const [startX, endX] = reach(xs, left, right, fromX);
  const [startY, endY] = reach(ys, top, bottom, fromY);
  Object.assign(graph, {
    left: Math.round(area.left + (area.width - (endX - startX)) / 2 - startX),
    top: Math.round(area.top + (area.height - (endY - startY)) / 2 - startY),
    width: (toX - fromX) * units,
    height: (toY - fromY) * units,
  });
}

/**
 * Spreads the nodes of a force layout over the space there is for them, unless the option says how
 * far. ECharts' defaults are for no size, and huddle a few nodes in the middle of a chart: edges as
 * long as half the room each node has, with the repulsion that ECharts' defaults have to them.
 */
function spreadForce(graph: JsonObject, width: number, height: number): void {
  const force = isPlainObject(graph.force) ? graph.force : {};
  if (force.edgeLength !== undefined || force.repulsion !== undefined) return;
  const nodes: unknown = graph.data ?? graph.nodes;
  const count = Array.isArray(nodes) ? Math.max(1, nodes.length) : 1;
  const edgeLength = Math.round(
    Math.min(MAX_EDGE, Math.max(10, 0.5 * Math.sqrt((width * height) / count))),
  );
  // ECharts' defaults: an edge length of 30 and a repulsion of 50.
  graph.force = { ...force, edgeLength, repulsion: Math.round(50 * (edgeLength / 30) ** 2) };
}

/** The side of the chart a treemap shows its breadcrumb on, which is the bottom unless moved. */
function breadcrumbSide(treemap: JsonObject, height: number): "top" | "bottom" | undefined {
  const breadcrumb = isPlainObject(treemap.breadcrumb) ? treemap.breadcrumb : {};
  if (breadcrumb.show === false) {
    return undefined;
  }
  // ECharts places the breadcrumb by its top when set, and by its bottom otherwise.
  const { top } = breadcrumb;
  if (top === undefined || top === "bottom") {
    return "bottom";
  }
  if (top === "middle" || top === "center") {
    return undefined;
  }
  const offset = top === "top" ? 0 : pixels(top, height);
  return offset === undefined ? "bottom" : offset < height / 2 ? "top" : "bottom";
}

/** The days of a calendar's range, from its first to its last, as UTC dates. */
function calendarDays(range: unknown): [Date, Date] | undefined {
  const ends = Array.isArray(range) ? range : [range, range];
  const day = (end: unknown, last: boolean) => {
    const match = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(String(end ?? "").trim());
    if (!match) return undefined;
    const [, year, month, date] = match.map(Number);
    if (year === undefined) return undefined;
    // The first or last day of a year or month that a range names.
    if (month === undefined || Number.isNaN(month)) {
      return new Date(Date.UTC(year, last ? 11 : 0, last ? 31 : 1));
    }
    if (date === undefined || Number.isNaN(date)) {
      return new Date(Date.UTC(year, last ? month : month - 1, last ? 0 : 1));
    }
    return new Date(Date.UTC(year, month - 1, date));
  };
  const first = day(ends[0], false);
  const last = day(ends[ends.length - 1], true);
  return first && last && first <= last ? [first, last] : undefined;
}

/** The size of a calendar's cells below which its labels run into each other. */
const MIN_CALENDAR_CELL = 12;

/**
 * Fits a calendar into the space left, as a grid is: ECharts places it 80 pixels in from the
 * left and 60 down from the top, its cells 20 pixels square, so that a year runs past the right
 * of a narrow chart and leaves a wide one mostly empty. Its cells, square across the chart, as
 * large as there is room for, or down it, a week a row, in a chart too narrow for those to read.
 */
function layOutCalendar(base: JsonObject, reserved: Insets, { width, height }: Size): void {
  const calendars = asArray(base.calendar);
  const calendar = calendars.length === 1 ? calendars[0] : undefined;
  if (!calendar || has(calendar, [...BOX_KEYS, "cellSize", "orient"]) || calendar.show === false) {
    return;
  }
  const days = calendarDays(calendar.range);
  if (!days) return;
  const [first, last] = days;
  const dayLabel = isPlainObject(calendar.dayLabel) ? calendar.dayLabel : {};
  const firstDay = typeof dayLabel.firstDay === "number" ? dayLabel.firstDay : 0;
  const count = Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1;
  const weeks = Math.ceil((((first.getUTCDay() - firstDay + 7) % 7) + count) / 7);
  const boxWidth = width - reserved.left - reserved.right;
  const boxHeight = height - reserved.top - reserved.bottom;
  // Across, the year and the days are labeled on the left and the months above; down, the year
  // and the days above and the months on the left.
  const across = Math.min(30, Math.floor(Math.min((boxWidth - 80) / weeks, (boxHeight - 38) / 7)));
  const tall = Math.floor((boxHeight - 66) / weeks);
  const wide = Math.min(60, Math.floor((boxWidth - 56) / 7));
  if (across >= MIN_CALENDAR_CELL || across >= Math.min(tall, wide)) {
    Object.assign(calendar, {
      left: reserved.left + 64,
      top: reserved.top + 30,
      cellSize: [Math.max(1, across), Math.max(1, across)],
    });
    // Rows too close for a label each name every other day, as Monday, Wednesday and Friday.
    if (across < MIN_CALENDAR_CELL && dayLabel.show !== false && dayLabel.nameMap === undefined) {
      calendar.dayLabel = { ...dayLabel, nameMap: ["", "M", "", "W", "", "F", ""] };
    }
    return;
  }
  Object.assign(calendar, {
    orient: "vertical",
    // Centered across the chart, which a week takes only a few pixels of.
    left: reserved.left + 40 + Math.round((boxWidth - 56 - 7 * wide) / 2),
    top: reserved.top + 58,
    cellSize: [wide, Math.min(wide, tall)],
  });
}

/**
 * Fits parallel coordinates into the space left, with room for the names above their axes.
 * ECharts places them 80 pixels in from each side and 60 from the top and bottom, which leaves the
 * axes of a narrow chart too close for their names, which it cuts short to the room between two
 * axes, as "Horsep…": names that do not fit go on two rows instead, every other one raised, each
 * as wide as the room between three axes. Only of axes across the chart that the option names and
 * places as ECharts does.
 */
function layOutParallel(base: JsonObject, reserved: Insets, size: Size): void {
  const { width } = size;
  const parallels = asArray(base.parallel);
  if (parallels.length > 1 || asArray(base.parallelAxis).length < 2) return;
  const parallel = parallels[0] ?? {};
  const axes = asArray(base.parallelAxis);
  const shared = isPlainObject(parallel.parallelAxisDefault) ? parallel.parallelAxisDefault : {};
  const nameKeys = ["nameLocation", "nameGap", "nameRotate", "nameTruncate"];
  if (
    has(parallel, BOX_KEYS) ||
    (parallel.layout ?? "horizontal") !== "horizontal" ||
    parallel.axisExpandable === true ||
    has(shared, nameKeys) ||
    axes.some((axis) => has(axis, nameKeys) || Number(axis.parallelIndex ?? 0) !== 0)
  ) {
    return;
  }
  // The width of each axis's name, in the font of its own or of all.
  const names = axes.map((axis) =>
    typeof axis.name === "string"
      ? size.font(styleOf(axis.nameTextStyle), styleOf(shared.nameTextStyle)).width(axis.name)
      : 0,
  );
  const half = (index: number) => (names[index] ?? 0) / 2;
  // The first name centered above the first axis, and the labels of the last right of it.
  const left = Math.round(Math.max(24, half(0) + 8));
  const right = Math.round(Math.max(48, half(axes.length - 1) + 8));
  const step = (width - reserved.left - reserved.right - left - right) / (axes.length - 1);
  const longest = Math.max(...names);
  const rows = longest + 8 > step ? 2 : 1;
  if (rows === 2) {
    axes.forEach((axis, index) => {
      // ECharts' gap from the axis to its name, and a line more for every other one.
      axis.nameGap = 15 + (index % 2) * LABEL_LINE_HEIGHT;
      axis.nameTruncate = { maxWidth: Math.max(40, Math.round(2 * step - 8)) };
    });
  }
  Object.assign(parallel, {
    left: reserved.left + left,
    right: reserved.right + right,
    top: reserved.top + 15 + rows * LABEL_LINE_HEIGHT + 8,
    bottom: reserved.bottom + 24,
  });
  if (parallels.length === 0) base.parallel = parallel;
}

function layOutRadar(base: JsonObject, reserved: Insets, size: Size): void {
  const radars = asArray(base.radar);
  const radar = radars.length === 1 ? radars[0] : undefined;
  if (!radar || radar.center !== undefined || radar.radius !== undefined) {
    return;
  }
  const boxWidth = size.width - reserved.left - reserved.right;
  const boxHeight = size.height - reserved.top - reserved.bottom;
  radar.center = [reserved.left + boxWidth / 2, reserved.top + boxHeight / 2];
  // Leave room beside the radar for the names of its indicators, of up to a fourth of the width.
  const font = size.font(styleOf(radar.axisName));
  const nameWidth = Math.min(widestText(radar.indicator, font.width, boxWidth / 4), boxWidth / 4);
  radar.radius = Math.max(40, Math.min(boxWidth - 2 * nameWidth - 40, boxHeight - 56) / 2);
}

/** Whether a series is drawn along a single axis, as a theme river is unless told otherwise. */
const onSingleAxis = (series: JsonObject) =>
  (series.coordinateSystem ?? (series.type === "themeRiver" ? "singleAxis" : undefined)) ===
  "singleAxis";

/** The width of a theme river's layer names beside it, at most, as a share of the chart's width. */
const MAX_LAYER_NAMES = 0.25;

/**
 * Fits a single axis into the space left, as a grid is, with room for its labels. ECharts places
 * it 5% in from each side, under a legend or title, and starts the name of each layer of a theme
 * river where the layer starts, on top of it: the panel ends the names there instead, in room
 * that it keeps beside the river for them.
 */
function layOutSingleAxis(
  base: JsonObject,
  series: JsonObject[],
  reserved: Insets,
  size: Size,
): void {
  const { width, height } = size;
  const axes = asArray(base.singleAxis);
  const axis = axes.length === 1 ? axes[0] : undefined;
  if (!axis || has(axis, BOX_KEYS) || axis.orient === "vertical") return;
  // The labels of the axis, below it unless placed above.
  const labels = isPlainObject(axis.axisLabel) && axis.axisLabel.show === false ? 0 : LABEL_HEIGHT;
  const above = axis.position === "top";
  const top = reserved.top + 14 + (above ? labels : 0);
  const bottom = reserved.bottom + 8 + (above ? 0 : labels);
  let left = 24;
  for (const river of series) {
    const label = isPlainObject(river.label) ? river.label : {};
    if (river.type !== "themeRiver" || label.show === false) continue;
    label.align ??= "right";
    river.label = label;
    // The names of the layers, in the data's third field, as in ["2026-01-05", 12, "Docs"].
    const names = Array.isArray(river.data)
      ? river.data.map((item: unknown) => (Array.isArray(item) ? item[2] : undefined))
      : [];
    // ECharts' default size of the names.
    const fontSize = typeof label.fontSize === "number" ? label.fontSize : 11;
    // The names of layers that start thin, close together, apart, where they all fit below the
    // top of where the river starts, around the middle of its axis, as ECharts moves them down
    // from there, and else onto its axis labels or legend: else as many as there is room for. The
    // legend and tooltip name the others. Each name is as tall as its font is large.
    const layers = new Set(names.filter((name: unknown) => name != null).map(String)).size;
    const room = height - top - bottom;
    // ECharts draws the river across the axis but for 10% at each side.
    const start = Array.isArray(river.data) ? riverStart(river.data) * 0.8 * room : 0;
    river.labelLayout ??=
      layers * fontSize <= (room + start + fontSize) / 2
        ? { moveOverlap: "shiftY", hideOverlap: true }
        : { hideOverlap: true };
    if (label.align !== "right") continue;
    // ECharts' default margin of the names.
    const margin = (typeof label.margin === "number" ? label.margin : 4) + 8;
    const most = Math.round(width * MAX_LAYER_NAMES);
    const text = widestText(names, size.font(label, { fontSize }).width, most);
    if (text + margin > most && label.width === undefined) {
      Object.assign(label, { width: most - margin, overflow: label.overflow ?? "truncate" });
    }
    left = Math.max(left, Math.round(Math.min(text + margin, most)));
  }
  Object.assign(axis, { left: reserved.left + left, right: reserved.right + 24, top, bottom });
  const length = width - reserved.left - left - reserved.right - 24;
  fewerTimeTicks(axis, length, size.font(styleOf(axis.axisLabel)));
}

/**
 * How thick a theme river is where it starts, at its first time, as a share of where it is
 * thickest, of data as ["2026-01-05", 12, "Docs"]: 0 where its times do not tell which is first.
 */
function riverStart(data: unknown[]): number {
  const sums = new Map<string, number>();
  let first: { at: number; key: string } | undefined;
  for (const item of data) {
    if (!Array.isArray(item)) continue;
    const key = String(item[0]);
    const value = Number(item[1]);
    sums.set(key, (sums.get(key) ?? 0) + (Number.isFinite(value) && value > 0 ? value : 0));
    const at = typeof item[0] === "number" ? item[0] : Date.parse(key);
    if (Number.isFinite(at) && (first === undefined || at < first.at)) first = { at, key };
  }
  let most = 0;
  for (const sum of sums.values()) most = Math.max(most, sum);
  return first && most > 0 ? (sums.get(first.key) ?? 0) / most : 0;
}

/** The type of an axis, which ECharts makes "category" for one with data. */
const axisType = (axis: JsonObject | undefined) =>
  axis?.type ?? (axis?.data ? "category" : "value");

/**
 * Names the whole of an unnamed treemap "All" in its breadcrumb, whose first crumb, for going back
 * up to it, would otherwise be blank: ECharts names it after the series. Only for a chart of the
 * one series, whose name then neither shows in its tooltip nor names its items.
 */
function nameTreemapRoot(series: JsonObject[]): void {
  const [treemap] = series;
  const breadcrumb = isPlainObject(treemap?.breadcrumb) ? treemap.breadcrumb : {};
  if (
    series.length === 1 &&
    treemap?.type === "treemap" &&
    (treemap.name === undefined || treemap.name === "") &&
    breadcrumb.show !== false
  ) {
    treemap.name = "All";
  }
}

/** Styles bars, sankey nodes and areas to read clearly on the theme's background. */
function styleSeries(base: JsonObject, series: JsonObject[], colors: ThemeColors): void {
  const background = toCss(colors.background);
  const xAxes = asArray(base.xAxis);
  const yAxes = asArray(base.yAxis);
  const datasets = asArray(base.dataset);
  for (const each of series) {
    if (each.type === "bar") {
      // The theme keeps bars narrow, but not short of a width that the series sets, nor apart
      // when it sets no gap between them, as the bins of a histogram.
      const touching = Number.parseFloat(String(each.barCategoryGap)) === 0;
      if (each.barWidth !== undefined || touching) each.barMaxWidth ??= "100%";
      const itemStyle = isPlainObject(each.itemStyle) ? each.itemStyle : {};
      if (each.stack !== undefined || touching) {
        // A thin gap in the background color separates stacked segments, and bars that touch,
        // as the bins of a histogram.
        if (itemStyle.borderColor === undefined && itemStyle.borderWidth === undefined) {
          Object.assign(itemStyle, { borderColor: background, borderWidth: 1 });
        }
      } else if (
        itemStyle.borderRadius === undefined &&
        // The corners of a polar bar's sector go in another order, and by angle and radius.
        isCartesian(each) &&
        !(each.data == null
          ? hasNegativeValues(datasetSource(each, datasets), true)
          : hasNegativeValues(each.data))
      ) {
        // Rounded data ends, square at the baseline. ECharts draws bars from the axis of
        // categories, or else of time, or else from the x axis.
        const xAxis = xAxes[typeof each.xAxisIndex === "number" ? each.xAxisIndex : 0];
        const yAxis = yAxes[typeof each.yAxisIndex === "number" ? each.yAxisIndex : 0];
        const [x, y] = [axisType(xAxis), axisType(yAxis)];
        const horizontal = x !== "category" && (y === "category" || (y === "time" && x !== "time"));
        const [valueAxis, ends] = horizontal ? [xAxis, [0, 4, 4, 0]] : [yAxis, [4, 4, 0, 0]];
        itemStyle.borderRadius = valueAxis?.inverse ? ends.map((radius) => 4 - radius) : ends;
      }
      each.itemStyle = itemStyle;
    }
    if (each.type === "sankey" && each.color === undefined) {
      // ECharts colors sankey nodes by value along the palette, mixing hues; give each node its
      // own categorical color instead, shared by the nodes of the same name in other stages.
      const key = each.data != null ? "data" : "nodes";
      const nodes: unknown = each[key];
      if (Array.isArray(nodes)) {
        const colorIndices = new Map<unknown, number>();
        each[key] = nodes.map((node: unknown, index) => {
          if (!isPlainObject(node)) return node;
          const name = node.name === undefined ? index : String(node.name);
          const colorIndex = colorIndices.get(name) ?? colorIndices.size;
          colorIndices.set(name, colorIndex);
          const copy = cloneValue(node) as JsonObject;
          const itemStyle = isPlainObject(copy.itemStyle) ? copy.itemStyle : {};
          itemStyle.color ??= toCss(
            colors.palette[colorIndex % colors.palette.length] ?? colors.blue,
          );
          copy.itemStyle = itemStyle;
          return copy;
        });
      }
    }
    if (each.type === "line" && isPlainObject(each.areaStyle)) {
      const area = each.areaStyle;
      if (area.opacity === undefined && area.color === undefined) {
        // A wash rather than a block, unless stacked areas need to read as bands.
        area.opacity = each.stack !== undefined ? 0.55 : 0.15;
      }
    }
  }
}

/**
 * Series with this many points are thinned out or drawn as one shape, as generated charts are
 * (see src/chartGrid.ts): ECharts' default `largeThreshold` for points. The SVG renderer would
 * otherwise create an element per point, or a line through every one, which the browser takes
 * seconds to draw again whenever the pointer moves over the chart.
 */
const LARGE_POINTS = 2000;

/** The number of points of a series: of its data, or of the rows or columns of its dataset. */
function pointCount(series: JsonObject, datasets: JsonObject[]): number {
  const data = series.data ?? datasetSource(series, datasets);
  if (Array.isArray(data)) return data.length;
  // A typed array holds the values of its points one after the other: at least one each.
  if (ArrayBuffer.isView(data)) return "length" in data ? Number(data.length) : 0;
  const column = isPlainObject(data) ? Object.values(data).find(Array.isArray) : undefined;
  return column?.length ?? 0;
}

/** Whether a series marks a statistic of its data, such as its average, which sampling would change. */
const marksStatistics = (series: JsonObject) =>
  ["markPoint", "markLine", "markArea"].some((key) => {
    const marker = series[key];
    return (
      isPlainObject(marker) &&
      Array.isArray(marker.data) &&
      marker.data.flat().some((point) => isPlainObject(point) && point.type !== undefined)
    );
  });

/**
 * Lets ECharts draw series of many points as generated charts draw them, unless the option says
 * otherwise: an unstacked line sampled with LTTB where its points outnumber the pixels, which
 * keeps its shape, and a scatter series as one shape, when its points all look the same, as that
 * draws them all alike. Series of fewer points stay as they are.
 */
function drawLargeSeries(option: JsonObject, series: JsonObject[]): void {
  const base = baseOption(option);
  const datasets = asArray(base.dataset);
  // A visual map can color or size each point, which one shape cannot.
  const visualMaps = optionVariants(option).some((variant) => variant.visualMap !== undefined);
  for (const each of series) {
    if (!isCartesian(each) || pointCount(each, datasets) < LARGE_POINTS) continue;
    if (each.type === "line" && each.sampling === undefined) {
      // Sampling each series of a stack on its own would misalign them.
      if (each.stack === undefined && !marksStatistics(each)) each.sampling = "lttb";
    } else if (each.type === "scatter" && each.large === undefined) {
      const itemStyle = isPlainObject(each.itemStyle) ? each.itemStyle : {};
      const alike =
        !visualMaps &&
        typeof each.symbol !== "function" &&
        typeof each.symbolSize !== "function" &&
        typeof itemStyle.color !== "function" &&
        // Data items that are objects can style themselves.
        !(Array.isArray(each.data) && each.data.some(isPlainObject));
      if (alike) each.large = true;
    }
  }
}

/**
 * Draws the axis line and ticks of the axes outside a grid, which the theme hides on value axes,
 * as ECharts themes axes by type alone: a polar chart would lose its outer circle, and parallel
 * coordinates and a single axis their axes. A parallel axis takes what its parallel component
 * sets for all of them.
 */
function showAxisLines(base: JsonObject): void {
  const parallels = asArray(base.parallel);
  for (const key of ["angleAxis", "parallelAxis", "singleAxis"]) {
    for (const axis of asArray(base[key])) {
      const parallel = key === "parallelAxis" ? parallels[Number(axis.parallelIndex ?? 0)] : {};
      const defaults = parallel?.parallelAxisDefault;
      for (const part of ["axisLine", "axisTick"]) {
        const settings = isPlainObject(axis[part]) ? axis[part] : {};
        const shared = isPlainObject(defaults) ? defaults[part] : undefined;
        settings.show ??= (isPlainObject(shared) ? shared.show : undefined) ?? true;
        axis[part] = settings;
      }
    }
  }
}

const plainNumber = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 20,
  useGrouping: false,
});
const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 20,
});
/**
 * A number in full below 10,000, so that a year reads as "2015", and exactly in thousands,
 * millions, … from there, as "12.5K".
 */
const compactLabel = (value: unknown) =>
  typeof value !== "number"
    ? String(value)
    : (Math.abs(value) < 10_000 ? plainNumber : compactNumber).format(value);

/**
 * The templates of the labels of a time axis by the unit of the time each labels, ECharts' own but
 * for a day, which ECharts labels by its number alone, as "3" among other numbers: by its month
 * as well, as "Feb 3". As in ECharts' own, the label of a time that starts a larger unit than the
 * ticks' step, as the "2026" of January 1st among days, is bold.
 */
const TIME_LABELS = {
  year: "{yyyy}",
  month: "{MMM}",
  day: "{MMM} {d}",
  hour: "{HH}:{mm}",
  minute: "{HH}:{mm}",
  second: "{HH}:{mm}:{ss}",
  millisecond: "{HH}:{mm}:{ss} {SSS}",
};
const timeLabels = () =>
  Object.fromEntries(
    Object.entries(TIME_LABELS).map(([unit, template]) => [
      unit,
      [template, `{primary|${template}}`],
    ]),
  );

/**
 * Labels the values of value and log axes compactly, as "1.5M" rather than "1,500,000", which
 * would take the plot's width, and the days of time axes by their month (see {@link TIME_LABELS}),
 * unless the axis formats its labels itself. An option sent as JSON cannot hold a formatter that
 * does the one. A parallel axis takes what its parallel component sets for all of them.
 */
function compactAxisLabels(base: JsonObject): void {
  const parallels = asArray(base.parallel);
  for (const key of ["xAxis", "yAxis", "radiusAxis", "angleAxis", "singleAxis", "parallelAxis"]) {
    for (const axis of asArray(base[key])) {
      const defaults =
        key === "parallelAxis"
          ? parallels[Number(axis.parallelIndex ?? 0)]?.parallelAxisDefault
          : undefined;
      const shared = isPlainObject(defaults) ? defaults : {};
      const type = axisType({ ...shared, ...axis });
      const label = isPlainObject(axis.axisLabel) ? axis.axisLabel : {};
      const formatted = [label, shared.axisLabel].some(
        (each) => isPlainObject(each) && each.formatter !== undefined,
      );
      if (formatted) continue;
      if (type === "value" || type === "log") label.formatter = compactLabel;
      else if (type === "time") {
        label.formatter = timeLabels();
        // ECharts adds the label of a month's or year's start between those of the ticks, however
        // near one, which a day's label as wide as "Feb 2" then runs into.
        label.hideOverlap ??= true;
      } else continue;
      axis.axisLabel = label;
    }
  }
}

/** What a template's placeholders stand for, of what ECharts gives a formatter of an item. */
const TEMPLATE_PARAMS: Record<string, string> = {
  a: "seriesName",
  b: "name",
  c: "value",
  d: "percent",
};
const groupedNumber = new Intl.NumberFormat("en-US", { maximumFractionDigits: 20 });
/** By template and whether it is HTML, so that a layout of the same option has the same ones. */
const templateFormatters = new Map<string, (params: unknown) => string>();

/**
 * A formatter in place of a template of an item's value, such as "{b}: {c}" or a pie's
 * "{b}: {c} ({d}%)", that writes a number as ECharts' templates do not: grouped by thousands and
 * without the leftovers of adding fractions, as "1,234.3" rather than "1234.3000000000002".
 * Undefined for a template without "{c}", or with placeholders the panel leaves to ECharts, such
 * as a dimension's "{@score}" or a series' "{c1}" in an axis tooltip.
 */
function templateFormatter(template: unknown, html: boolean) {
  if (typeof template !== "string" || !template.includes("{c}")) return undefined;
  const placeholders = template.match(/\{[^{}|]*\}/g) ?? [];
  if (!placeholders.every((each) => Object.hasOwn(TEMPLATE_PARAMS, each.slice(1, -1)))) {
    return undefined;
  }
  const key = `${html}:${template}`;
  let formatter = templateFormatters.get(key);
  if (!formatter) {
    formatter = (params: unknown) => {
      const item = (Array.isArray(params) ? params[0] : params) as JsonObject;
      return template.replace(/\{([abcd])\}/g, (_, name: string) => {
        const value = item?.[TEMPLATE_PARAMS[name] ?? ""];
        const text =
          typeof value === "number" && Number.isFinite(value)
            ? groupedNumber.format(Number(value.toPrecision(12)))
            : String(value ?? "-");
        return html ? escapeHtml(text) : text;
      });
    };
    templateFormatters.set(key, formatter);
  }
  return formatter;
}

/**
 * Formats the values in the templates of labels and item tooltips (see {@link templateFormatter}),
 * as of the pies and funnels that diagram_chart makes, which an option sent as JSON cannot do.
 */
function formatTemplateValues(option: JsonObject): void {
  const replace = (owner: unknown, html: boolean) => {
    if (!isPlainObject(owner)) return;
    const formatter = templateFormatter(owner.formatter, html);
    if (formatter) owner.formatter = formatter;
  };
  for (const series of allSeries(option)) {
    replace(series.label, false);
    replace(series.tooltip, true);
  }
  // The tooltip of an axis lists the items of every series at once.
  for (const variant of optionVariants(option)) {
    for (const tooltip of asArray(variant.tooltip)) {
      if ((tooltip.trigger ?? "item") === "item") replace(tooltip, true);
    }
  }
}

/**
 * Adds tooltips, selection outlined in the foreground color in a glow of the VS Code focus color,
 * and a description for screen readers. An outline of the focus color itself would hardly show on
 * an item of a color like it, as the blue of the first series in most themes, or the orange of
 * the second in high contrast ones.
 */
function addInteraction(
  base: JsonObject,
  series: JsonObject[],
  cartesian: boolean,
  colors: ThemeColors,
): void {
  // An axis crosshair for line and bar charts, per item otherwise.
  if (base.tooltip === undefined) {
    const axisTrigger = cartesian && series.some((s) => s.type === "line" || s.type === "bar");
    const onlyBars = series.every((s) => s.type === "bar");
    base.tooltip = axisTrigger
      ? { trigger: "axis", axisPointer: { type: onlyBars ? "shadow" : "line" } }
      : { trigger: "item" };
  }
  for (const tooltip of asArray(base.tooltip)) {
    tooltip.confine ??= true;
  }
  const outline = toCss(colors.foreground);
  const glow = toCss({ ...colors.focus, a: 0.7 });
  for (const each of series) {
    each.selectedMode ??= "multiple";
    each.select ??= {
      itemStyle: { borderColor: outline, borderWidth: 2.5, shadowBlur: 14, shadowColor: glow },
      label: { fontWeight: "bold" },
    };
  }
  base.aria ??= { enabled: true };
}
