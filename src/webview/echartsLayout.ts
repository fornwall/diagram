// Adapts an ECharts option written by a model to the panel: responsive layout, selection styles
// and defaults. Only fills in what the option leaves unset, so explicit choices always win.

import { asArray, isPlainObject } from "../protocol";
import { labelTreeNodes, layOutBoxSeries } from "./echartsBoxSeries";
import { cloneOption } from "./echartsClone";
import {
  addInteraction,
  compactAxisLabels,
  drawLargeSeries,
  formatTemplateValues,
  nameTreemapRoot,
  showAxisLines,
  styleSeries,
} from "./echartsDefaults";
import { fewerTimeTicks, LABEL_HEIGHT, layOutGrid } from "./echartsGrid";
import { placeLegend } from "./echartsLegend";
import {
  BOX_KEYS,
  compactLabel,
  has,
  type Insets,
  LABEL_LINE_HEIGHT,
  type LayoutContext,
  layoutSize,
  pixels,
  type Size,
  styleOf,
  widestText,
} from "./echartsMeasure";
import {
  allSeries,
  baseOption,
  isCartesian,
  type JsonObject,
  optionVariants,
  seriesOf,
  seriesPlaces,
} from "./echartsOption";
import { layOutPie } from "./echartsPie";
import { colorLabelsOnItems } from "./echartsTheme";

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
    const size = layoutSize(context, base);
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
      ? size
          .font(styleOf(axis.nameTextStyle), styleOf(shared.nameTextStyle), size.themed)
          .width(axis.name)
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
  const font = size.font(styleOf(radar.axisName), size.themed);
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
  fewerTimeTicks(axis, length, size.font(styleOf(axis.axisLabel), size.themed));
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
