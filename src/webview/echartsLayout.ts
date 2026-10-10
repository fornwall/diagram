// Adapts an ECharts option written by a model to the panel: responsive layout, selection styles
// and defaults. Only fills in what the option leaves unset, so explicit choices always win.

import { facetBoxes } from "../chartFacetLayout";
import { isPlainObject } from "../protocol";
import { type ThemeColors, toCss } from "./colors";
import {
  allSeries,
  asArray,
  baseOption,
  isCartesian,
  type JsonObject,
  optionVariants,
  seriesOf,
  seriesPlaces,
} from "./echartsOption";

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
function cloneOption(option: JsonObject): JsonObject {
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
 * which the series of other steps, with ids of their own, would no longer merge into.
 */
function adoptStartingSeries(option: JsonObject, base: JsonObject): void {
  const steps: unknown[] = Array.isArray(option.options) ? option.options : [];
  const step = steps[Number(asArray(base.timeline)[0]?.currentIndex ?? 0)];
  const media = asArray(option.media).find((each) => each.query === undefined)?.option;
  const series = [...seriesOf(base)];
  for (const patch of [step, media]) {
    if (!isPlainObject(patch)) continue;
    const own = seriesOf(patch);
    seriesPlaces(series, own).forEach((place, index) => {
      const each = own[index];
      if (place === series.length && isPlainObject(each) && each.id == null) {
        series.push({ ...each });
      }
    });
  }
  if (series.length > seriesOf(base).length) base.series = series;
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
  adoptStartingSeries(option, base);
  const series = asArray(base.series);
  const cartesian = series.some(isCartesian);
  if (context.reducedMotion) {
    disableAnimation(option);
  }
  hideRepeatedTitle(base, context.title);
  for (const legend of asArray(base.legend)) {
    if (legend.show !== false) {
      legend.type ??= "scroll";
    }
  }
  // Options with media queries handle their own responsiveness.
  if (option.media === undefined) {
    const { width, height } = context;
    const compact = width < 560 || height < 340;
    const charWidth = context.colors.fontSize * 0.6;
    const room = layOut(base, series, cartesian, { width, height, compact, charWidth }, squeeze);
    if (room < MIN_PLOT_HEIGHT && squeeze < SQUEEZES) return undefined;
  }
  styleSeries(base, series, context.colors);
  nameTreemapRoot(series);
  drawLargeSeries(option, series);
  showAxisLines(base);
  compactAxisLabels(base);
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
  const tools = toolboxWidth(base);
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
      const besideTools = side === "top" && tools > 0 ? (tools + 8) * (centered(title) ? 2 : 1) : 0;
      truncateTitle(title, size.width - 16 - besideTools);
    }
  }
  // A timeline takes the bottom of the chart, where ECharts places it unless told otherwise.
  const timeline = asArray(base.timeline).find((t) => t.show !== false);
  if (timeline && !has(timeline, [...BOX_KEYS, "orient"])) {
    reserved.bottom = 44;
  }
  placeLegend(base, series, cartesian, reserved, size);
  placeSliders(base, reserved, size, squeeze);
  if (cartesian) {
    layOutGrid(base, reserved, size);
  }
  for (const title of asArray(base.title)) {
    const grid = gridOf(base, title);
    if (grid) truncateTitle(title, (pixels(grid.width, size.width) ?? size.width) - 16);
  }
  layOutPie(base, series, reserved, size);
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
 * The width of the toolbox that ECharts places across the top right of the chart, as it does
 * unless told otherwise, of the features that the panel keeps: 0 without one.
 */
function toolboxWidth(base: JsonObject): number {
  let width = 0;
  for (const toolbox of asArray(base.toolbox)) {
    if (toolbox.show === false || toolbox.orient === "vertical" || has(toolbox, BOX_KEYS)) continue;
    const features = Object.entries(isPlainObject(toolbox.feature) ? toolbox.feature : {}).filter(
      ([name, settings]) =>
        !Object.hasOwn(PASSING_TOOLS, name) &&
        !(isPlainObject(settings) && settings.show === false),
    );
    if (features.length === 0) continue;
    // ECharts' default icon size, gap between icons and padding.
    const size = typeof toolbox.itemSize === "number" ? toolbox.itemSize : 15;
    const gap = typeof toolbox.itemGap === "number" ? toolbox.itemGap : 8;
    width = Math.max(width, features.length * (size + gap) - gap + 10);
  }
  return width;
}

/** Adds a legend where the chart needs one, and places it beside the plot. */
function placeLegend(
  base: JsonObject,
  series: JsonObject[],
  cartesian: boolean,
  reserved: Insets,
  { width, height, compact, charWidth }: Size,
): void {
  const pies = series.filter((s) => s.type === "pie");
  if (base.legend === undefined) {
    // Several named series: the identity of a series is never only color.
    const named = series.length >= 2 && series.every((s) => seriesName(s) !== undefined);
    // A small pie has no room for labels, so its slices are named by a legend instead.
    const smallPie =
      pies.length === 1 &&
      !isPlainObject(pies[0]?.label) &&
      (width < 420 || height - reserved.top < 260);
    if (named || smallPie) {
      base.legend = { type: "scroll" };
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
    (legend.orient === undefined && !placed && !cartesian && width >= 560)
  ) {
    // Beside a pie or other non-grid chart when there is room, as it then uses the height, and
    // beside any chart when it goes down, on the right unless told the side, where ECharts would
    // center it.
    if (!placed) Object.assign(legend, { orient: "vertical", right: 8, top: "middle" });
    else if (!has(legend, ["left", "right"])) legend.right = 8;
    side = legend.right === undefined ? "left" : "right";
  } else if (!placed) {
    side = cartesian && !compact ? "top" : "bottom";
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
    reserved[side] += side === "top" ? 30 : 32;
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
    if (!has(visualMap, [...BOX_KEYS, "orient"])) {
      if (squeeze >= 1) {
        visualMap.show = false;
        continue;
      }
      Object.assign(visualMap, {
        orient: "horizontal",
        left: "center",
        bottom: reserved.bottom + 4,
        // The length of a continuous bar, but the size of each piece of a piecewise one.
        ...(isContinuous(visualMap) ? { itemHeight: Math.min(200, Math.round(width * 0.4)) } : {}),
      });
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
  if (grids.length <= 1) {
    const grid = grids[0] ?? {};
    if (!has(grid, [...BOX_KEYS, "outerBounds", "outerBoundsMode"])) {
      Object.assign(grid, {
        left: reserved.left + 8,
        right: reserved.right + 20,
        top: reserved.top + 14,
        bottom: reserved.bottom + 8,
      });
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
    const labelWidth = longestText(axis.data, Math.max(slot * 3, maxWidth) / charWidth) * charWidth;
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
  }
  if (facetGrid !== undefined) {
    const xAxes = asArray(base.xAxis);
    for (const axis of xAxes) {
      // Value labels as wide as the longest bound's, beside each other.
      const digits = [axis.min, axis.max].map((bound) =>
        typeof bound === "number" ? compactLabel(bound).length : 4,
      );
      fewerTicks(axis, facetGrid.width - 50, (Math.max(...digits) + 1) * charWidth + 16);
    }
    for (const axis of asArray(base.yAxis)) {
      const xAxis = xAxes.find(({ gridIndex }) => gridIndex === axis.gridIndex);
      let plot = facetGrid.height - (xAxis ? (labelHeights.get(xAxis) ?? LABEL_HEIGHT) : 0);
      // The name above the plot, unless the plot would be too short for it.
      if (typeof axis.name === "string" && axis.name && axis.nameLocation === undefined) {
        if (plot - AXIS_NAME_HEIGHT < MIN_NAMED_FACET) axis.name = "";
        else plot -= AXIS_NAME_HEIGHT;
      }
      fewerTicks(axis, plot, MIN_TICK_GAP);
    }
  }
  for (const axis of asArray(base.yAxis)) {
    const label = isPlainObject(axis.axisLabel) ? axis.axisLabel : {};
    const maxWidth = Math.round(
      (grids.length > 1 ? panelWidth(axis) : width) * (compact ? 0.3 : 0.22),
    );
    if (
      label.width === undefined &&
      longestText(axis.data, maxWidth / charWidth) * charWidth > maxWidth
    ) {
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

interface Facet {
  grid: JsonObject;
  title: JsonObject;
}

const sameBox = (object: JsonObject, box: object, keys: string[]) =>
  keys.every((key) => object[key] === (box as JsonObject)[key]);

/**
 * The panels of a faceted chart, each a grid and the title of the same id, where chartFacets
 * places them, or undefined if the option places its grids otherwise, as a user's options can.
 */
function facetPanels(base: JsonObject): Facet[] | undefined {
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
  return facets;
}

/**
 * Lays out the panels of a faceted chart in pixels, in the space left: the percentages of the
 * option would leave a short panel's plot hardly any of its height. Rows too short to read go in
 * more columns, unless that makes the panels too narrow instead. Returns the size of a grid.
 */
function layOutFacets(
  facets: Facet[],
  reserved: Insets,
  { width, height }: Size,
): { width: number; height: number } {
  const top = reserved.top + 8;
  const left = reserved.left + 16;
  const areaWidth = width - left - reserved.right - 16;
  const areaHeight = height - top - reserved.bottom - 4;
  const count = facets.length;
  const rows = (columns: number) => Math.ceil(count / columns);
  const panelWidth = (columns: number) => (areaWidth - (columns - 1) * FACET_COLUMN_GAP) / columns;
  // How near a number of columns comes to panels of the least readable size, at most 1.
  const fit = (columns: number) =>
    Math.min(
      1,
      areaHeight / rows(columns) / MIN_FACET_HEIGHT,
      panelWidth(columns) / MIN_FACET_WIDTH,
    );
  let columns = facets.filter(({ grid }) => grid.top === facets[0]?.grid.top).length;
  for (let more = columns + 1; more <= count; more++) {
    if (fit(more) > fit(columns)) columns = more;
  }
  const rowHeight = areaHeight / rows(columns);
  const gridWidth = Math.round(panelWidth(columns));
  const gridHeight = Math.max(20, Math.round(rowHeight - FACET_TITLE_HEIGHT - FACET_ROW_GAP));
  facets.forEach(({ grid, title }, index) => {
    const x = Math.round(left + (index % columns) * (panelWidth(columns) + FACET_COLUMN_GAP));
    const y = Math.round(top + Math.floor(index / columns) * rowHeight);
    Object.assign(title, { left: x, top: y });
    Object.assign(grid, {
      left: x,
      top: y + FACET_TITLE_HEIGHT,
      width: gridWidth,
      height: gridHeight,
    });
  });
  return { width: gridWidth, height: gridHeight };
}

/**
 * Gives a value axis of a facet fewer labels than the facets' shared ones when they would pile
 * on each other along its length, at least `gap` apart.
 */
function fewerTicks(axis: JsonObject, length: number, gap: number): void {
  if (axisType(axis) !== "value") return;
  const parts = Math.max(2, Math.floor(length / gap));
  const { min, max, interval } = axis;
  if (typeof min !== "number" || typeof max !== "number" || typeof interval !== "number") {
    if (axis.interval === undefined && axis.splitNumber === undefined && parts < 5) {
      axis.splitNumber = parts;
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
  const small = boxWidth < 380 || boxHeight < 220;
  if (label.show === undefined && label.position === undefined && hasLegend && small) {
    // Too small for labels around the pie: the legend and tooltip name the slices.
    label = pie.label = { ...label, show: false };
    pie.labelLine = { ...(isPlainObject(pie.labelLine) ? pie.labelLine : {}), show: false };
  }
  if (pie.radius === undefined) {
    const outsideLabels =
      label.show !== false &&
      !["inside", "inner", "center"].includes(String(label.position ?? "outside"));
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
}

/** Keeps series that ECharts lays out in a box clear of the title, legend and other components. */
function layOutBoxSeries(series: JsonObject[], reserved: Insets, { width, height }: Size): void {
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
    // Trees and funnels keep ECharts' default margins, for the labels beside them.
    const side = type === "tree" ? Math.round(width * 0.12) : type === "funnel" ? 80 : 12;
    // Room for the breadcrumb of a treemap.
    const breadcrumb = type === "treemap" ? breadcrumbSide(each, height) : undefined;
    Object.assign(each, {
      top: reserved.top + (breadcrumb === "top" ? 36 : 12),
      bottom: reserved.bottom + (breadcrumb === "bottom" ? 36 : 12),
      left: reserved.left + side,
      // Room for the labels right of the last column of sankey nodes.
      right: reserved.right + (type === "sankey" ? Math.round(Math.min(160, width * 0.18)) : side),
    });
  }
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

function layOutRadar(base: JsonObject, reserved: Insets, size: Size): void {
  const radars = asArray(base.radar);
  const radar = radars.length === 1 ? radars[0] : undefined;
  if (!radar || radar.center !== undefined || radar.radius !== undefined) {
    return;
  }
  const boxWidth = size.width - reserved.left - reserved.right;
  const boxHeight = size.height - reserved.top - reserved.bottom;
  radar.center = [reserved.left + boxWidth / 2, reserved.top + boxHeight / 2];
  // Leave room around the radar for the indicator names.
  radar.radius = Math.max(40, Math.min(boxWidth - 140, boxHeight - 56) / 2);
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
      const itemStyle = isPlainObject(each.itemStyle) ? each.itemStyle : {};
      if (each.stack !== undefined) {
        // A thin gap in the background color separates stacked segments.
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
 * Labels the values of value and log axes compactly, as "1.5M" rather than "1,500,000", which
 * would take the plot's width, unless the axis formats its labels itself. ECharts labels them in
 * full, and an option sent as JSON cannot hold a formatter that does this. A parallel axis takes
 * what its parallel component sets for all of them.
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
      if ((type === "value" || type === "log") && !formatted) {
        label.formatter = compactLabel;
        axis.axisLabel = label;
      }
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
