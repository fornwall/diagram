// Adapts an ECharts option written by a model to the panel: responsive layout, selection styles
// and defaults. Only fills in what the option leaves unset, so explicit choices always win.

import { isPlainObject } from "../protocol";
import { type ThemeColors, toCss } from "./colors";
import { asArray, baseOption, isCartesian, type JsonObject } from "./echartsOption";

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
function longestText(entries: unknown): number {
  if (!Array.isArray(entries)) {
    return 0;
  }
  const text = (entry: unknown) =>
    String((isPlainObject(entry) ? (entry.name ?? entry.value) : entry) ?? "");
  // Not Math.max(...entries), which overflows the stack with very many entries.
  return entries.reduce((longest: number, entry) => Math.max(longest, text(entry).length), 0);
}

function seriesName(series: JsonObject): string | undefined {
  return typeof series.name === "string" && series.name ? series.name : undefined;
}

function hasNegativeValues(data: unknown): boolean {
  if (!Array.isArray(data)) {
    return false;
  }
  return data.some((item) => {
    const value = isPlainObject(item) ? item.value : item;
    return Array.isArray(value)
      ? value.some((v) => typeof v === "number" && v < 0)
      : typeof value === "number" && value < 0;
  });
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
 * structuredClone, which throws on an option written as JavaScript, as that holds functions (a
 * custom series' renderItem, a formatter, …).
 *
 * Settings accepted by isPlainObject are copied, as that is what every writer here reaches its
 * targets through, so that no object a layout writes to is still one of the caller's. A copy is a
 * plain object of every enumerable property, inherited ones included, as a series written with a
 * prototype of its own keeps its type and its styles that way; a date is copied as a date and a
 * typed array is left as it is, both keeping their value where properties cannot carry it.
 * Functions and data payloads are carried over by reference. Copying every object-valued point,
 * dataset row or hierarchy node would make even a resize allocate the entire dataset again.
 * Other arrays are only copied when they hold objects or arrays; no array is written in place.
 */
function cloneOption(option: JsonObject): JsonObject {
  const copy: JsonObject = {};
  // for...in rather than Object.entries, to copy what the option inherits as well.
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

export function layoutOption(source: JsonObject, context: LayoutContext): JsonObject {
  const option = cloneOption(source);
  const base = baseOption(option);
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
    layOut(base, series, cartesian, { width, height, compact, charWidth });
  }
  styleSeries(series, asArray(base.yAxis), context.colors);
  addInteraction(base, series, cartesian, context.colors);
  return option;
}

/** Timeline and media options can override both global and per-series animation settings, hence all. */
function optionVariants(option: JsonObject): JsonObject[] {
  return [
    baseOption(option),
    ...asArray(option.options),
    ...asArray(option.media).flatMap((media) => asArray(media.option)),
  ];
}

export function disableAnimation(option: JsonObject): void {
  for (const variant of optionVariants(option)) {
    variant.animation = false;
    for (const series of asArray(variant.series)) {
      series.animation = false;
    }
  }
}

/**
 * Makes a highlighted item fade the rest of the chart, which is how an agent's marks stand out with
 * everything else receding: ECharts blurs a chart around a highlighted item only when its series
 * focuses on it. Replaces a focus of the option's own for as long as the marks dim the chart.
 */
export function focusHighlighted(option: JsonObject): void {
  for (const variant of optionVariants(option)) {
    for (const series of asArray(variant.series)) {
      const emphasis = isPlainObject(series.emphasis) ? series.emphasis : {};
      emphasis.focus = "self";
      series.emphasis = emphasis;
    }
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

/** Places the components around the plot, and fits the grid and series into the space left. */
function layOut(base: JsonObject, series: JsonObject[], cartesian: boolean, size: Size): void {
  const reserved: Insets = { top: 0, bottom: 0, left: 0, right: 0 };
  for (const title of asArray(base.title)) {
    const atTop = title.bottom === undefined && (typeof title.top !== "number" || title.top < 40);
    if (title.show !== false && atTop && (title.text || title.subtext)) {
      const height = 10 + (title.text ? 22 : 0) + (title.subtext ? 18 : 0);
      reserved.top = Math.max(reserved.top, height);
    }
  }
  // A timeline takes the bottom of the chart, where ECharts places it unless told otherwise.
  const timeline = asArray(base.timeline).find((t) => t.show !== false);
  if (timeline && !has(timeline, [...BOX_KEYS, "orient"])) {
    reserved.bottom = 44;
  }
  placeLegend(base, series, cartesian, reserved, size);
  placeSliders(base, reserved, size.width);
  if (cartesian) {
    layOutGrid(base, reserved, size);
  }
  layOutPie(base, series, reserved, size);
  layOutBoxSeries(series, reserved, size.width);
  layOutRadar(base, reserved, size);
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
  if (!has(legend, [...BOX_KEYS, "orient"])) {
    // Beside a pie or other non-grid chart when there is room, as it then uses the height.
    side = cartesian ? (compact ? "bottom" : "top") : width >= 560 ? "right" : "bottom";
    if (side === "right") {
      Object.assign(legend, { orient: "vertical", right: 8, top: "middle" });
    } else if (side === "top") {
      Object.assign(legend, { top: reserved.top > 0 ? reserved.top : 6, left: "center" });
    } else {
      Object.assign(legend, { bottom: reserved.bottom + 6, left: "center" });
    }
  } else if (legend.orient === "vertical") {
    side = legend.left !== undefined && legend.right === undefined ? "left" : "right";
  } else {
    // ECharts places a horizontal legend at the bottom unless told otherwise.
    side = legend.top !== undefined && legend.bottom === undefined ? "top" : "bottom";
  }
  if (side === "top" || side === "bottom") {
    reserved[side] += side === "top" ? 30 : 32;
    return;
  }
  const names = Array.isArray(legend.data)
    ? legend.data
    : pies.length > 0 || series.some((s) => s.type === "funnel")
      ? series.flatMap((s) => (Array.isArray(s.data) ? s.data : []))
      : series.map(seriesName);
  // The icon, the gap after it and the padding around the legend.
  const extra = 12 + 5 + 24;
  const legendWidth = Math.min(width * 0.32, Math.max(4, longestText(names)) * charWidth + extra);
  reserved[side] += Math.round(legendWidth) + 16;
}

/** Places data zoom sliders along the axis they control, and visual maps below the chart. */
function placeSliders(base: JsonObject, reserved: Insets, width: number): void {
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
    if (vertical) {
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
      Object.assign(visualMap, {
        orient: "horizontal",
        left: "center",
        bottom: reserved.bottom + 4,
        // The length of a continuous bar, but the size of each piece of a piecewise one.
        ...(isContinuous(visualMap) ? { itemHeight: Math.min(200, Math.round(width * 0.4)) } : {}),
      });
      reserved.bottom += 52;
    } else if (visualMap.orient === "horizontal") {
      reserved[visualMap.top === undefined ? "bottom" : "top"] += 52;
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

/** Fits a single grid into the space left, and keeps the axis labels apart and short. */
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
        Object.assign(grid, { outerBoundsMode: "same", outerBoundsContain: "all" });
      }
    }
    base.grid ??= grid;
  }

  // Rotate category labels when they would overlap, and truncate very long ones.
  const plotWidth = Math.max(80, width - reserved.left - reserved.right - 80);
  // Multi-grid charts need label decisions based on their own panel, not the entire canvas.
  const panelWidth = (axis: JsonObject): number => {
    if (grids.length <= 1) return plotWidth;
    const grid = grids[typeof axis.gridIndex === "number" ? axis.gridIndex : 0];
    const pixels = (value: unknown): number | undefined =>
      typeof value === "number"
        ? value
        : typeof value === "string" && /^\d+(?:\.\d+)?%$/.test(value)
          ? (Number.parseFloat(value) * width) / 100
          : undefined;
    const available =
      pixels(grid?.width) ?? width - (pixels(grid?.left) ?? 0) - (pixels(grid?.right) ?? 0);
    return Math.max(40, available - 50);
  };
  for (const axis of asArray(base.xAxis)) {
    const label = isPlainObject(axis.axisLabel) ? axis.axisLabel : {};
    const count = Array.isArray(axis.data) ? axis.data.length : 0;
    if (count === 0 || label.rotate !== undefined || label.interval !== undefined) {
      continue;
    }
    const labelWidth = longestText(axis.data) * charWidth;
    const slot = panelWidth(axis) / count;
    if (labelWidth > slot - 8) {
      const rotate = labelWidth > slot * 3 ? 45 : 30;
      const maxWidth = Math.max(60, Math.round(height * 0.22));
      axis.axisLabel = {
        rotate,
        hideOverlap: true,
        ...(labelWidth > maxWidth ? { width: maxWidth, overflow: "truncate" } : {}),
        ...label,
      };
    }
  }
  for (const axis of asArray(base.yAxis)) {
    const label = isPlainObject(axis.axisLabel) ? axis.axisLabel : {};
    const maxWidth = Math.round(
      (grids.length > 1 ? panelWidth(axis) : width) * (compact ? 0.3 : 0.22),
    );
    if (label.width === undefined && longestText(axis.data) * charWidth > maxWidth) {
      axis.axisLabel = { width: maxWidth, overflow: "truncate", ...label };
    }
  }
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
function layOutBoxSeries(series: JsonObject[], reserved: Insets, width: number): void {
  for (const each of series) {
    const type = String(each.type);
    const placed = has(each, BOX_KEYS) || (type === "graph" && (each.layout ?? "none") === "none");
    if (placed || !["funnel", "sankey", "tree", "treemap", "graph"].includes(type)) {
      continue;
    }
    // Trees and funnels keep ECharts' default margins, for the labels beside them.
    const side = type === "tree" ? Math.round(width * 0.12) : type === "funnel" ? 80 : 12;
    Object.assign(each, {
      top: reserved.top + 12,
      // Room for the breadcrumb below a treemap.
      bottom: reserved.bottom + (type === "treemap" ? 36 : 12),
      left: reserved.left + side,
      // Room for the labels right of the last column of sankey nodes.
      right: reserved.right + (type === "sankey" ? Math.round(Math.min(160, width * 0.18)) : side),
    });
  }
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

/** Styles bars, sankey nodes and areas to read clearly on the theme's background. */
function styleSeries(series: JsonObject[], yAxes: JsonObject[], colors: ThemeColors): void {
  const background = toCss(colors.background);
  for (const each of series) {
    if (each.type === "bar") {
      const itemStyle = isPlainObject(each.itemStyle) ? each.itemStyle : {};
      if (each.stack !== undefined) {
        // A thin gap in the background color separates stacked segments.
        if (itemStyle.borderColor === undefined && itemStyle.borderWidth === undefined) {
          Object.assign(itemStyle, { borderColor: background, borderWidth: 1 });
        }
      } else if (itemStyle.borderRadius === undefined && !hasNegativeValues(each.data)) {
        // Rounded data ends, square at the baseline.
        const axis = yAxes[typeof each.yAxisIndex === "number" ? each.yAxisIndex : 0];
        const horizontal = axis?.type === "category";
        itemStyle.borderRadius = horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0];
      }
      each.itemStyle = itemStyle;
    }
    if (each.type === "sankey" && each.color === undefined) {
      // ECharts colors sankey nodes by value along the palette, mixing hues; give each node its
      // own categorical color instead.
      const key = each.data != null ? "data" : "nodes";
      const nodes: unknown = each[key];
      if (Array.isArray(nodes)) {
        each[key] = nodes.map((node: unknown, index) => {
          if (!isPlainObject(node)) return node;
          const copy = cloneValue(node) as JsonObject;
          const itemStyle = isPlainObject(copy.itemStyle) ? copy.itemStyle : {};
          itemStyle.color ??= toCss(colors.palette[index % colors.palette.length] ?? colors.blue);
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

/** Adds tooltips, selection in the VS Code focus color, and a description for screen readers. */
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
  const focus = toCss(colors.focus);
  const glow = toCss({ ...colors.focus, a: 0.7 });
  for (const each of series) {
    each.selectedMode ??= "multiple";
    each.select ??= {
      itemStyle: { borderColor: focus, borderWidth: 2.5, shadowBlur: 14, shadowColor: glow },
      label: { fontWeight: "bold" },
    };
  }
  base.aria ??= { enabled: true };
}

/** What the user can change in a shown chart, by component: besides the zoom ranges. */
const USER_STATE: Record<string, string[]> = {
  legend: ["selected", "scrollDataIndex"],
  timeline: ["currentIndex"],
  visualMap: ["range", "selected"],
};

/** Preserves controls across layouts without copying chart data when there are no controls. */
export function keepUserState(option: JsonObject, readShown: () => JsonObject): void {
  const base = baseOption(option);
  // ECharts' getOption deep-copies every data point, even when only control state is needed.
  const graphs = asArray(base.series)
    .map((series, index) => ({ series, index }))
    .filter(({ series }) => series.type === "graph" && series.roam);
  if (
    graphs.length === 0 &&
    ![...Object.keys(USER_STATE), "dataZoom"].some((key) => asArray(base[key]).length > 0)
  ) {
    return;
  }
  const shown = readShown();
  const shownSeries = asArray(shown.series);
  for (const { series: graph, index } of graphs) {
    const current = shownSeries[index];
    for (const key of ["center", "zoom"]) {
      if (current?.[key] !== undefined) graph[key] = current[key];
    }
  }
  for (const [component, keys] of Object.entries(USER_STATE)) {
    const shownComponents = asArray(shown[component]);
    asArray(base[component]).forEach((each, index) => {
      const current = shownComponents[index];
      for (const key of keys) {
        if (current?.[key] !== undefined) {
          each[key] = current[key];
        }
      }
    });
  }
  const shownZooms = asArray(shown.dataZoom);
  asArray(base.dataZoom).forEach((zoom, index) => {
    const current = shownZooms[index];
    if (typeof current?.start === "number" && typeof current.end === "number") {
      Object.assign(zoom, { start: current.start, end: current.end });
      delete zoom.startValue;
      delete zoom.endValue;
    }
  });
}
