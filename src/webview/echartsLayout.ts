// Adapts an ECharts option written by a model to the panel: responsive layout, selection styles
// and defaults. Only fills in what the option leaves unset, so explicit choices always win.

import { facetBoxes } from "../chartFacetLayout";
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
import { placeLegend } from "./echartsLegend";
import {
  axisType,
  BOX_KEYS,
  categoryTexts,
  compactLabel,
  type Font,
  has,
  type Insets,
  LABEL_LINE_HEIGHT,
  type LayoutContext,
  layoutSize,
  lineCount,
  pixels,
  type Size,
  startOf,
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
  // Of a grid that the layout places, as wide as the room for it less what its vertical axes take
  // beside it; else of about as much.
  const plotWidth = Math.max(
    80,
    panel !== undefined && grids.length <= 1
      ? panel.width - besidePlot(base, size, Math.round(width * (compact ? 0.3 : 0.22)))
      : width - reserved.left - reserved.right - 80,
  );
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
    if (count === 0 || label.rotate !== undefined) {
      continue;
    }
    // The option can show every label, or every so many, which then stay shown however they are
    // turned; else ECharts leaves out those that would overlap along the slant.
    const { interval } = label;
    const chosen = typeof interval === "number" && interval >= 0;
    const slot = (panelWidth(axis) / count) * (chosen ? interval + 1 : 1);
    // Slanted labels take the height of the plot, of a facet's own in a faceted chart.
    const maxWidth =
      facetGrid === undefined
        ? Math.max(60, Math.round(height * 0.22))
        : Math.max(40, Math.round(facetGrid.height * 0.35));
    const font = size.font(label, size.themed);
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
      // ECharts keeps turned labels a third of a line apart across the slant, as it measures them
      // on one, and else leaves some out, and hides those whose lines overlap: steeper where
      // categories are too narrow for either at 30°, as of labels of several lines.
      const lineHeight = typeof label.lineHeight === "number" ? label.lineHeight : font.size;
      const lines = labelLines(axis.data, label, font);
      const tall = Math.max(font.size * CATEGORY_LABEL_ROOM, lines * lineHeight);
      const apart = (angle: number) => tall <= slot * Math.sin((angle * Math.PI) / 180);
      const rotate = labelWidth > slot * 3 || !apart(30) ? 45 : 30;
      axis.axisLabel = {
        rotate,
        ...(chosen ? {} : { hideOverlap: true }),
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
      const font = size.font(styleOf(axis.axisLabel), size.themed);
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
    const font = size.font(label, size.themed);
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
    if (lines >= 2 && wrapsInto(axis.data, maxWidth, lines, font.breakWidth)) {
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

/**
 * The width that the axes of the first grid take beside its plot, as ECharts keeps their labels
 * and names within the grid. A vertical axis takes the margin and its widest label, or half its
 * name, centered on it above or below, where wider, or its name along it beside them, on the side
 * ECharts places it: the first left and the next right, unless placed. A horizontal axis takes its
 * name, after its end or before its start, with the gap to it. The labels of a value axis are as
 * wide as the panel labels its values, compactly as "12.5K" (see {@link compactAxisLabels}), and
 * those of a category axis as its widest, but no wider than the most that the layout cuts them to.
 */
function besidePlot(base: JsonObject, size: Size, most: number): number {
  const sides = { left: 0, right: 0 };
  const onGrid = (axis: JsonObject) => Number(axis.gridIndex ?? 0) === 0;
  const used = new Set<string>();
  for (const axis of asArray(base.yAxis).filter(onGrid)) {
    const { position } = axis;
    const placed = position === "left" || position === "right";
    const side = placed ? position : used.has("left") ? "right" : "left";
    used.add(side);
    if (axis.show === false) continue;
    const label = styleOf(axis.axisLabel);
    const font = size.font(label, size.themed);
    let room = 0;
    if (label.show !== false && label.inside !== true) {
      const type = axisType(axis);
      const { formatter } = label;
      let text = UNKNOWN_LABELS;
      if (type === "category") {
        // Of a width that the option sets, the layout leaves them as wide as it makes them: as
        // wide as it, where it cuts them short or breaks them onto lines, or else whole.
        const { width, overflow } = label;
        const cut =
          width === undefined
            ? most
            : typeof width === "number" &&
                width > 0 &&
                ["truncate", "break", "breakAll"].includes(String(overflow))
              ? width
              : Infinity;
        text = Math.min(widestText(axis.data, font.width, cut), cut);
      } else if (formatter === undefined || typeof formatter === "string") {
        // As wide as the labels of its bounds, where the option sets them, or else as "-1500".
        const bounds = [axis.min, axis.max];
        const digits = bounds.every((bound) => typeof bound === "number")
          ? Math.max(...bounds.map((bound) => compactLabel(bound).length))
          : 5;
        const value = type === "time" ? "Feb 13" : "0".repeat(digits);
        text = font.width(formatter === undefined ? value : formatter.replaceAll("{value}", value));
      }
      room = text + (typeof label.margin === "number" ? label.margin : 8);
    }
    const { name, nameLocation: location } = axis;
    if (typeof name === "string" && name && axis.nameRotate === undefined) {
      const nameFont = size.font(styleOf(axis.nameTextStyle), size.themed);
      if (location === undefined || location === "end" || location === "start") {
        room = Math.max(room, nameFont.width(name) / 2);
      } else if (location === "middle" || location === "center") {
        // Along the axis, its gap from it, or past its labels where they reach further.
        const gap = typeof axis.nameGap === "number" ? axis.nameGap : 15;
        room = Math.max(room + 8, gap) + nameFont.size + 8;
      }
    }
    // Axes on the same side are drawn over each other, unless the option offsets one past another.
    const offset = typeof axis.offset === "number" ? axis.offset : 0;
    sides[side] = Math.max(sides[side], room + offset);
  }
  for (const axis of asArray(base.xAxis).filter(onGrid)) {
    const { name, nameLocation: location } = axis;
    if (axis.show === false || typeof name !== "string" || !name) continue;
    if (location !== undefined && location !== "end" && location !== "start") continue;
    const nameWidth = size.font(styleOf(axis.nameTextStyle), size.themed).width(name);
    const room = nameWidth + (typeof axis.nameGap === "number" ? axis.nameGap : 15);
    // An inverse axis starts on the right, where the layout names it unless the option does.
    const side =
      location === undefined || (location === "start") === (axis.inverse === true)
        ? "right"
        : "left";
    sides[side] = Math.max(sides[side], room);
  }
  return sides.left + sides.right;
}

/** The width of the labels of an axis that the option formats in a way the layout cannot tell. */
const UNKNOWN_LABELS = 44;

/**
 * How much wider than a category label is the room that ECharts makes sure each has, to show
 * them all.
 */
const CATEGORY_LABEL_ROOM = 1.3;
/** Whether each category's text goes onto no more than some lines of a width, in a font. */
function wrapsInto(
  data: unknown,
  room: number,
  lines: number,
  width: (text: string) => number,
): boolean {
  const texts = categoryTexts(data);
  if (texts === undefined) return false;
  return texts.every((text) => lineCount(text, room, width) <= lines);
}

/**
 * The most lines that ECharts draws a category label on: those of its own, and those it breaks
 * it onto in the width of a label that the option breaks.
 */
function labelLines(data: unknown, label: JsonObject, font: Font): number {
  const texts = categoryTexts(data) ?? [];
  const breaks = label.overflow === "break" || label.overflow === "breakAll";
  const room =
    typeof label.width === "number" && label.width > 0 && breaks ? label.width : Infinity;
  return Math.max(1, ...texts.map((text) => lineCount(text, room, font.breakWidth)));
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
  const cut = (text: string) => startOf(text, room - font.width("…"), font.breakWidth);
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
  const title = { ...size.themed, fontSize: 13, fontWeight: 600 };
  const font = size.font(styleOf(facets[0]?.title.textStyle), title);
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
