// The defaults that the panel fills into a chart's option once laid out, where the option leaves
// them unset: styles that read on the theme's background, compact axis labels, formatted values in
// label templates, series of many points drawn as generated charts draw them, tooltips, selection
// and a description for screen readers.

import { asArray, isPlainObject } from "../protocol";
import { escapeHtml } from "../text";
import { type ThemeColors, toCss } from "./colors";
import { cloneValue } from "./echartsClone";
import { axisType, compactLabel, styleOf } from "./echartsMeasure";
import {
  allSeries,
  baseOption,
  isCartesian,
  type JsonObject,
  optionVariants,
} from "./echartsOption";

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

/** Resolve the source dataset, following transform inputs without looping through cycles. */
function sourceDataset(series: JsonObject, datasets: JsonObject[]): JsonObject | undefined {
  const find = (id: unknown, index: unknown) =>
    id == null ? datasets[Number(index ?? 0)] : datasets.find((dataset) => dataset.id === id);
  let dataset = find(series.datasetId, series.datasetIndex);
  // A transformed dataset is made of the rows of the one it transforms.
  for (let hops = 0; dataset && dataset.source === undefined && hops < datasets.length; hops++) {
    dataset = find(dataset.fromDatasetId, dataset.fromDatasetIndex);
  }
  return dataset;
}

/**
 * Names the whole of an unnamed treemap "All" in its breadcrumb, whose first crumb, for going back
 * up to it, would otherwise be blank: ECharts names it after the series. Only for a chart of the
 * one series, whose name then neither shows in its tooltip nor names its items.
 */
export function nameTreemapRoot(series: JsonObject[]): void {
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
export function styleSeries(base: JsonObject, series: JsonObject[], colors: ThemeColors): void {
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
      const itemStyle = styleOf(each.itemStyle);
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
          ? hasNegativeValues(sourceDataset(each, datasets)?.source, true)
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
          const itemStyle = styleOf(copy.itemStyle);
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

/** Approximate point count for choosing rendering optimizations; headers may add one. */
function pointCount(series: JsonObject, datasets: JsonObject[]): number {
  const dataset = series.data == null ? sourceDataset(series, datasets) : undefined;
  const data = series.data ?? dataset?.source;
  if (Array.isArray(data)) {
    // In row-oriented datasets, each row is a dimension and its columns are points.
    const byRow = dataset && (series.seriesLayoutBy ?? dataset.seriesLayoutBy) === "row";
    return byRow ? (Array.isArray(data[0]) ? data[0].length : 0) : data.length;
  }
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
export function drawLargeSeries(option: JsonObject, series: JsonObject[]): void {
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
      const itemStyle = styleOf(each.itemStyle);
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
export function showAxisLines(base: JsonObject): void {
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
export function compactAxisLabels(base: JsonObject): void {
  const parallels = asArray(base.parallel);
  for (const key of ["xAxis", "yAxis", "radiusAxis", "angleAxis", "singleAxis", "parallelAxis"]) {
    for (const axis of asArray(base[key])) {
      const defaults =
        key === "parallelAxis"
          ? parallels[Number(axis.parallelIndex ?? 0)]?.parallelAxisDefault
          : undefined;
      const shared = styleOf(defaults);
      const type = axisType({ ...shared, ...axis });
      const label = styleOf(axis.axisLabel);
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
export function formatTemplateValues(option: JsonObject): void {
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

/** The tooltip formatters of heatmap cells by the rows' categories, the same in every layout. */
const heatmapFormatters = new WeakMap<object, (params: unknown) => string>();
const NO_ROWS: unknown[] = [];

/**
 * Says the row of a heatmap's cell in its tooltip, which ECharts labels by its column alone, as
 * "10  3": as "10, Mon  3", the way the panel names the cell (see echartsItems.ts). Only for cells
 * on a grid, in a tooltip that the option leaves to ECharts.
 */
export function labelHeatmapRows(base: JsonObject, series: JsonObject[]): void {
  if (asArray(base.tooltip).some((tooltip) => tooltip.formatter !== undefined)) return;
  const yAxes = asArray(base.yAxis);
  for (const each of series) {
    if (each.type !== "heatmap" || (each.coordinateSystem ?? "cartesian2d") !== "cartesian2d") {
      continue;
    }
    const tooltip = styleOf(each.tooltip);
    if (tooltip.formatter !== undefined) continue;
    const rows = yAxes[Number(each.yAxisIndex ?? 0)]?.data;
    const key = Array.isArray(rows) ? rows : NO_ROWS;
    let formatter = heatmapFormatters.get(key);
    if (!formatter) {
      formatter = (params: unknown) => {
        const item = (Array.isArray(params) ? params[0] : params) as JsonObject;
        const { seriesName, name, value, marker } = item;
        const [, y, cell] = Array.isArray(value) ? value : [];
        // The row by its index on the axis, which can list it with a label style of its own.
        const listed = typeof y === "number" && Array.isArray(rows) ? rows[y] : y;
        const row = isPlainObject(listed) ? listed.value : listed;
        const number =
          typeof cell === "number" && Number.isFinite(cell)
            ? groupedNumber.format(Number(cell.toPrecision(12)))
            : String(cell ?? "-");
        // ECharts names an unnamed series "series\0<index>", which its tooltips leave out.
        const title =
          typeof seriesName === "string" && seriesName && !seriesName.includes("\u0000")
            ? `${escapeHtml(seriesName)}<br/>`
            : "";
        return (
          `${title}${typeof marker === "string" ? marker : ""}` +
          `${escapeHtml(`${name ?? ""}, ${row ?? ""}`)}&nbsp;&nbsp;<b>${escapeHtml(number)}</b>`
        );
      };
      heatmapFormatters.set(key, formatter);
    }
    tooltip.formatter = formatter;
    each.tooltip = tooltip;
  }
}

/**
 * Adds tooltips, selection outlined in the foreground color in a glow of the VS Code focus color,
 * and a description for screen readers. An outline of the focus color itself would hardly show on
 * an item of a color like it, as the blue of the first series in most themes, or the orange of
 * the second in high contrast ones.
 */
export function addInteraction(
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
