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
import { colorLabelsOnItems } from "./echartsTheme";

const BOX_KEYS = ["left", "right", "top", "bottom", "width", "height"];
const has = (object: JsonObject, keys: string[]) => keys.some((key) => object[key] !== undefined);

type Side = "top" | "bottom" | "left" | "right";
/** Space in pixels taken from each side of the chart by the title, legend, sliders, … */
type Insets = Record<Side, number>;

interface Size {
  width: number;
  height: number;
  /** Too small for a legend above the grid. */
  compact: boolean;
  /** The approximate width of a character of chart text. */
  charWidth: number;
}

/**
 * The length of the longest category or legend entry: a value, a category `{value}`, or a legend
 * entry or data item named by `{name}` (whose value is a number).
 */
function longestText(entries: unknown, enough = Infinity): number {
  if (!Array.isArray(entries)) {
    return 0;
  }
  const text = (entry: unknown) =>
    String((isPlainObject(entry) ? (entry.name ?? entry.value) : entry) ?? "");
  // Once the label exceeds every layout threshold, further entries cannot change the result.
  // Dense axes and long legends often reach that point with their very first entry.
  let longest = 0;
  for (const entry of entries) {
    longest = Math.max(longest, text(entry).length);
    if (longest > enough) break;
  }
  return longest;
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
    const charWidth = context.colors.fontSize * 0.6;
    const room = layOut(base, series, cartesian, { width, height, compact, charWidth }, squeeze);
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
  for (const title of asArray(base.title)) {
    const grid = gridOf(base, title);
    if (grid) truncateTitle(title, (pixels(grid.width, size.width) ?? size.width) - 16);
  }
  layOutPie(base, series, reserved, size);
  labelTreeNodes(series, size);
  layOutBoxSeries(series, reserved, size);
  layOutRadar(base, reserved, size);
  return size.height - reserved.top - reserved.bottom;
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
  { width, height, compact, charWidth }: Size,
): void {
  const pies = series.filter((s) => s.type === "pie");
  if (base.legend === undefined) {
    // Several named series: the identity of a series is never only color.
    const named = series.length >= 2 && series.every((s) => seriesName(s) !== undefined);
    // A small pie has no room for labels, so its slices are named by a legend instead, unless
    // the option says to label them.
    const [pie] = pies;
    const label = isPlainObject(pie?.label) ? pie.label : {};
    const smallPie =
      pie !== undefined &&
      pies.length === 1 &&
      label.show === undefined &&
      label.position === undefined &&
      (height - reserved.top < 260 ||
        !pieLabelsFit(pie, width - 16, height - reserved.top - 16, charWidth));
    if (named || smallPie) {
      base.legend = {};
    }
  }
  const legend = asArray(base.legend).find((l) => l.show !== false);
  if (!legend) {
    return;
  }
  let side: Side;
  const placed = has(legend, BOX_KEYS);
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
        ? legendRows(legend, series, width - 20, charWidth, most)
        : 1;
    if (rows > 1) legend.type = "plain";
    reserved[side] += (side === "top" ? 30 : 32) + (rows - 1) * LEGEND_ROW;
    return;
  }
  // The icon, the gap after it and the padding around the legend.
  const extra = 12 + 5 + 24;
  const enough = (width * 0.32 - extra) / charWidth;
  let longest = 0;
  if (Array.isArray(legend.data)) {
    longest = longestText(legend.data, enough);
  } else if (pies.length > 0 || series.some((s) => s.type === "funnel")) {
    // Read each series in place rather than allocating an array of every slice on each resize.
    for (const each of series) {
      longest = Math.max(longest, longestText(each.data, enough));
      if (longest > enough) break;
    }
  } else {
    longest = longestText(series.map(seriesName), enough);
  }
  const legendWidth = Math.min(width * 0.32, Math.max(4, longest) * charWidth + extra);
  reserved[side] += Math.round(legendWidth) + 16;
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
  charWidth: number,
  most: number,
): number {
  const sliced = series.filter((each) => each.type === "pie" || each.type === "funnel");
  const entries: unknown[] = Array.isArray(legend.data)
    ? legend.data
    : sliced.length > 0
      ? sliced.flatMap((each) =>
          Array.isArray(each.data) ? each.data.slice(0, MAX_WRAPPED_ENTRIES + 1) : [],
        )
      : series.map(seriesName).filter((name) => name !== undefined);
  if (entries.length > MAX_WRAPPED_ENTRIES) return 1;
  let rows = 1;
  let used = 0;
  for (const entry of entries) {
    const text = String((isPlainObject(entry) ? (entry.name ?? entry.value) : entry) ?? "");
    // The icon and the gap after it, and the gap before the entry after another.
    const size = 12 + 5 + text.length * charWidth;
    if (used > 0 && used + 10 + size > width) {
      rows++;
      used = size;
    } else {
      used += (used > 0 ? 10 : 0) + size;
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
  const { width, height, compact, charWidth } = size;
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
    let labelWidth = longestText(axis.data, Math.max(slot * 3, maxWidth) / charWidth) * charWidth;
    // Labels cut short to the same start are told apart by what follows it.
    const rest =
      labelWidth > Math.max(maxWidth, slot - 8) &&
      dropSharedStart(axis, label, maxWidth / charWidth);
    if (rest) labelWidth = rest * charWidth;
    if (labelWidth > slot - 8) {
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
    if (rest) {
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
      fewerTicks(axis, panel.width - 50, (Math.max(...digits) + 1) * charWidth + 16, faceted);
      fewerTimeTicks(axis, panel.width - 50, charWidth);
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
    if (
      label.width !== undefined ||
      longestText(axis.data, maxWidth / charWidth) * charWidth <= maxWidth
    ) {
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
    if (lines >= 2 && wrapsInto(axis.data, maxWidth / charWidth, lines)) {
      axis.axisLabel = {
        width: maxWidth,
        overflow: "break",
        lineHeight: LABEL_LINE_HEIGHT - 1,
        ...label,
      };
      continue;
    }
    const rest = dropSharedStart(axis, label, maxWidth / charWidth);
    if (rest !== undefined) {
      // The name above the labels starts at the axis, rather than centered on it, beside them.
      const style = isPlainObject(axis.nameTextStyle) ? axis.nameTextStyle : {};
      style.align ??= axis.position === "right" ? "right" : "left";
      axis.nameTextStyle = style;
    }
    if (rest === undefined || rest * charWidth > maxWidth) {
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
/** The height of a line of an axis label that goes onto several. */
const LABEL_LINE_HEIGHT = 17;

/** The texts of the categories of an axis, if strings and no more than a few hundred. */
function categoryTexts(data: unknown): string[] | undefined {
  if (!Array.isArray(data) || data.length > MAX_READ_CATEGORIES) return undefined;
  const texts = data.map((entry: unknown) => (isPlainObject(entry) ? entry.value : entry));
  return texts.every((text) => typeof text === "string") ? texts : undefined;
}

/** Whether each category's text goes onto no more than some lines of a number of characters. */
function wrapsInto(data: unknown, columns: number, lines: number): boolean {
  const texts = categoryTexts(data);
  if (texts === undefined) return false;
  return texts.every((text) => {
    // Word by word, as ECharts breaks them, and a word longer than a line across lines.
    let count = 1;
    let used = 0;
    for (const word of text.split(/\s+/).filter(Boolean)) {
      if (used > 0 && used + 1 + word.length <= columns) {
        used += 1 + word.length;
        continue;
      }
      if (used > 0) count++;
      count += Math.ceil(word.length / columns) - 1;
      used = word.length % columns || columns;
    }
    return count <= lines;
  });
}

/** By the start they leave out, so that a layout of the same option has the same ones. */
const sharedStartFormatters = new Map<string, (value: unknown) => string>();

/**
 * Labels the categories of an axis by what follows the start they share, when cut short to a
 * number of characters they would read alike, as the "Northern Regional Distribution Center" of
 * "… 0", "… 1", …, and names the axis by that start instead. The start ends with a word. Returns
 * the length of the longest label left, if any.
 */
function dropSharedStart(axis: JsonObject, label: JsonObject, visible: number): number | undefined {
  const texts = categoryTexts(axis.data);
  // Not of labels that the option hides, which the name would tell nothing of.
  if (!texts || texts.length < 2 || label.formatter !== undefined || label.show === false) {
    return undefined;
  }
  const cut = (text: string) => text.slice(0, Math.max(1, Math.floor(visible) - 1));
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
  axis.name = typeof axis.name === "string" && axis.name ? `${axis.name}: ${name} …` : `${name} …`;
  return Math.max(...texts.map((text) => text.length - start.length));
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
  { width, height }: Size,
): { width: number; height: number } {
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
  shortenFacetTitles(facets, gridWidth - 16);
  return { width: gridWidth, height: gridHeight };
}

/**
 * Leaves out the facet column's name, as in "region = ", from the titles of facets when one of
 * them would not fit its panel: the values tell the panels apart, and the panel's header or the
 * chart's title usually names the column.
 */
function shortenFacetTitles(facets: Facet[], width: number): void {
  const texts = facets.map(({ title }) => (typeof title.text === "string" ? title.text : ""));
  const style = facets[0]?.title.textStyle;
  const fontSize = isPlainObject(style) && typeof style.fontSize === "number" ? style.fontSize : 13;
  // Bold characters, a little wider than others.
  if (texts.every((text) => text.length * fontSize * 0.62 <= width)) return;
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
function fewerTimeTicks(axis: JsonObject, length: number, charWidth: number): void {
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
  const asked = Math.max(2, Math.floor(length / (6 * charWidth + 16) / 1.5));
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
    label.show === undefined &&
    label.position === undefined &&
    hasLegend &&
    (boxHeight < 220 || !pieLabelsFit(pie, boxWidth, boxHeight, size.charWidth))
  ) {
    // Too small for labels around the pie: the legend and tooltip name the slices.
    label = pie.label = { ...label, show: false };
    pie.labelLine = { ...(isPlainObject(pie.labelLine) ? pie.labelLine : {}), show: false };
  }
  const outsideLabels =
    label.show !== false &&
    !["inside", "inner", "center"].includes(String(label.position ?? "outside"));
  if (pie.radius === undefined) {
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
  const labels = pieLabels(pie, size.charWidth);
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
  // in to their line, and the pie leaves the room for them.
  label.alignTo ??= "edge";
  label.edgeDistance ??= 8;
  if (label.width === undefined) label.overflow ??= "break";
  pie.label = label;
  // The second part of a line is drawn out to its label at the edge anyway.
  line.length2 ??= 0;
  pie.labelLine = line;
  const most = labeledRadius(labels, boxWidth, length);
  const least = MIN_LABELED_PIE * (Math.min(boxWidth, boxHeight) / 2);
  if (outer > most) pie.radius = scaleRadius(pie.radius, Math.max(most, least) / outer);
}

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
}

/**
 * The labels of a pie's slices, as ECharts places them: around the pie from its top, clockwise,
 * unless told otherwise. Undefined for more slices than the layout reads, which have no room for
 * labels; none for the slices of a dataset.
 */
function pieLabels(pie: JsonObject, charWidth: number): PieLabel[] | undefined {
  const data: unknown[] = Array.isArray(pie.data) ? pie.data : [];
  if (data.length > MAX_READ_CATEGORIES) return undefined;
  const label = isPlainObject(pie.label) ? pie.label : {};
  // ECharts labels a slice by its name, and a template adds its text and, for each value, about
  // 6 characters, as "25.74".
  const template = typeof label.formatter === "string" ? label.formatter : "{b}";
  const values = template.match(/\{(?!b\})[^{}|]*\}/g)?.length ?? 0;
  const added = template.replace(/\{[^{}|]*\}/g, "").length + 6 * values;
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
    const word = Math.max(values > 0 ? 7 : 0, ...name.split(/\s+/).map((part) => part.length + 1));
    const chars = name.length + added;
    return {
      across: Math.abs(Math.cos(middle)),
      whole: chars * charWidth,
      least: Math.max(word, Math.ceil(chars / 3)) * charWidth,
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
function pieLabelsFit(
  pie: JsonObject,
  boxWidth: number,
  boxHeight: number,
  charWidth: number,
): boolean {
  const labels = pieLabels(pie, charWidth);
  const line = isPlainObject(pie.labelLine) ? pie.labelLine : {};
  return (
    labels !== undefined &&
    labeledRadius(labels, boxWidth, typeof line.length === "number" ? line.length : 15) >=
      MIN_LABELED_PIE * (Math.min(boxWidth, boxHeight) / 2)
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

/** Keeps series that ECharts lays out in a box clear of the title, legend and other components. */
function layOutBoxSeries(
  series: JsonObject[],
  reserved: Insets,
  { width, height, charWidth }: Size,
): void {
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
        ? funnelSides(each, side, width, charWidth)
        : type === "tree"
          ? treeSides(each, side, width, charWidth)
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
function funnelSides(
  funnel: JsonObject,
  margin: number,
  width: number,
  charWidth: number,
): [number, number] {
  const label = isPlainObject(funnel.label) ? funnel.label : {};
  const position = String(label.position ?? "outer");
  if (
    label.show === false ||
    funnel.orient === "horizontal" ||
    ["inner", "inside", "center", "insideLeft", "insideRight"].includes(position)
  ) {
    return [margin, margin];
  }
  const most = Math.round(width * 0.4);
  // A template adds its text, and a value of about 6 characters for each other placeholder.
  const { formatter } = label;
  const added =
    typeof formatter === "string"
      ? formatter.replace(/\{[^{}]*\}/g, "").length +
        6 * (formatter.match(/\{(?!b\})[^{}]*\}/g)?.length ?? 0)
      : 0;
  const line = isPlainObject(funnel.labelLine) ? funnel.labelLine : {};
  // The label line, the gap after it, and a margin to the edge.
  const gap = (typeof line.length === "number" ? line.length : 20) + 13;
  const text = (longestText(funnel.data, most / charWidth) + added) * charWidth;
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
function treeSides(
  tree: JsonObject,
  margin: number,
  width: number,
  charWidth: number,
): [number, number] {
  const orient = tree.orient ?? "LR";
  const [root] = Array.isArray(tree.data) ? tree.data : [];
  if ((tree.layout ?? "orthogonal") !== "orthogonal" || (orient !== "LR" && orient !== "RL")) {
    return [margin, margin];
  }
  if (!isPlainObject(root)) return [margin, margin];
  const deepest = deepestShown(root, tree);
  const position = (label: unknown) => (isPlainObject(label) ? label.position : undefined);
  const leaves = isPlainObject(tree.leaves) ? tree.leaves.label : undefined;
  const most = Math.round(width * MAX_TREE_LABELS);
  // The width a label takes beyond its node on a side: all of it on that side, none on the
  // other, and half when centered on it. Past the symbol, with a gap to the edge.
  const room = (labels: unknown[], placed: unknown, side: "left" | "right") => {
    const share = placed === side ? 1 : placed === "left" || placed === "right" ? 0 : 0.5;
    const text = longestText(labels, most / charWidth) * charWidth * share;
    return Math.max(margin, Math.min(most, Math.round(text + 12)));
  };
  const rootSide = orient === "LR" ? "left" : "right";
  const endSide = orient === "LR" ? "right" : "left";
  const start = room([root], position(tree.label), rootSide);
  // The leaves are labeled as "leaves" says, and the nodes whose children are not shown yet not.
  const isLeaf = (node: unknown) => !isPlainObject(node) || !Array.isArray(node.children);
  const end = Math.max(
    room(deepest.filter(isLeaf), position(leaves) ?? position(tree.label), endSide),
    room(
      deepest.filter((node) => !isLeaf(node)),
      position(tree.label),
      endSide,
    ),
  );
  return orient === "LR" ? [start, end] : [end, start];
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
    Math.min(200, Math.max(10, 0.5 * Math.sqrt((width * height) / count))),
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
  const nameWidth = Math.min(longestText(radar.indicator) * size.charWidth, boxWidth / 4);
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
  { width, charWidth }: Size,
): void {
  const axes = asArray(base.singleAxis);
  const axis = axes.length === 1 ? axes[0] : undefined;
  if (!axis || has(axis, BOX_KEYS) || axis.orient === "vertical") return;
  let left = 24;
  for (const river of series) {
    const label = isPlainObject(river.label) ? river.label : {};
    if (river.type !== "themeRiver" || label.show === false) continue;
    label.align ??= "right";
    river.label = label;
    if (label.align !== "right") continue;
    // ECharts' default size and margin of the names, which name the layers in the data's third
    // field, as in ["2026-01-05", 12, "Docs"].
    const nameChar = (typeof label.fontSize === "number" ? label.fontSize : 11) * 0.6;
    const margin = (typeof label.margin === "number" ? label.margin : 4) + 8;
    const most = Math.round(width * MAX_LAYER_NAMES);
    const names = Array.isArray(river.data)
      ? river.data.map((item: unknown) => (Array.isArray(item) ? item[2] : undefined))
      : [];
    const text = longestText(names, most / nameChar) * nameChar;
    if (text + margin > most && label.width === undefined) {
      Object.assign(label, { width: most - margin, overflow: label.overflow ?? "truncate" });
    }
    left = Math.max(left, Math.round(Math.min(text + margin, most)));
  }
  // The labels of the axis, below it unless placed above.
  const labels = isPlainObject(axis.axisLabel) && axis.axisLabel.show === false ? 0 : LABEL_HEIGHT;
  const above = axis.position === "top";
  Object.assign(axis, {
    left: reserved.left + left,
    right: reserved.right + 24,
    top: reserved.top + 14 + (above ? labels : 0),
    bottom: reserved.bottom + 8 + (above ? 0 : labels),
  });
  fewerTimeTicks(axis, width - reserved.left - left - reserved.right - 24, charWidth);
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
      else if (type === "time") label.formatter = timeLabels();
      else continue;
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
