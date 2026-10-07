// Turning a table and a chart request into an Apache ECharts option.

import { type Columns, chained, columnName, readColumns } from "./chartColumns";
import { buildFacetedChart } from "./chartFacets";
import { boxplotOption, cartesianOption, heatmapOption, scatterOption } from "./chartGrid";
import { hierarchyOption, sankeyOption } from "./chartHierarchy";
import { funnelOption, gaugeOption, pieOption, radarOption } from "./chartItems";
import { type Reading, readRows, tableMultiples } from "./chartRows";
import type { ChartSpec, ChartType } from "./chartSpec";
import { buildHistogram, filterTable, type HistogramPlan, planHistogram } from "./chartTransforms";
import type { DataTable } from "./data";
import type { Unit } from "./dataNumber";
import { isPlainObject } from "./protocol";
import { formatCount, plural, quoteAll } from "./text";

export interface Chart {
  /** The ECharts option, as plain JSON that leaves colors, fonts and layout to the webview. */
  option: Record<string, unknown>;
  /** Which columns and rows were charted, e.g. `Charted "size" by "dir".`, for a model. */
  summary: string;
}

/** Build a chart, apply option overrides, and summarize how the data was interpreted. */
export function buildChart(spec: ChartSpec, table: DataTable): Chart {
  if (spec.bins !== undefined && spec.type !== "histogram") {
    throw new Error(
      '"bins" is only supported for histograms. Remove it or set "type" to "histogram".',
    );
  }
  const filtered = filterTable(table, spec.filters);
  let histogram: HistogramPlan | undefined;
  let facetPlan: ChartPlan | undefined;
  const single = (request: ChartSpec, data: DataTable, reference?: DataTable): Chart => {
    const { type } = request;
    if (type === "histogram") {
      histogram ??= planHistogram(request, reference ?? data);
      return buildHistogram(data, histogram);
    }
    if (reference !== undefined) facetPlan ??= planChart(request, reference, true);
    return buildSingleChart(type, request, data, facetPlan);
  };
  const chart =
    spec.facetColumn === undefined
      ? single(spec, filtered)
      : buildFacetedChart(spec, filtered, single);
  // Filtering comes first, so it is said first, rather than within the last facet's summary.
  return {
    option: spec.options === undefined ? chart.option : deepMerge(chart.option, spec.options),
    summary:
      filtered === table
        ? chart.summary
        : `The filters kept ${formatCount(filtered.rows.length)} of ${plural(table.rows.length, "row")}. ${chart.summary}`,
  };
}

/** What every facet reads alike: the columns, the notes about them and the multiples of units. */
interface ChartPlan {
  columns: Columns;
  notes: string[];
  multiples?: Partial<Record<Unit, number>> | undefined;
}

/** Infer the shared columns and units once, rather than rescanning all rows for every facet. */
function planChart(spec: ChartSpec, table: DataTable, faceted: boolean): ChartPlan {
  const notes: string[] = [];
  const columns = readColumns(spec, table, notes);
  return {
    columns,
    notes,
    multiples: faceted ? tableMultiples(table, columns.values) : undefined,
  };
}

/** The chart types drawn from rows; a histogram is built from the raw observations instead. */
type RowChartType = Exclude<ChartType, "histogram">;

function buildSingleChart(
  type: RowChartType,
  spec: ChartSpec,
  table: DataTable,
  plan = planChart(spec, table, false),
): Chart {
  const { columns } = plan;
  // Each panel adds its own omissions and aggregation notes.
  const notes = [...plan.notes];
  const reading: Reading = {
    spec,
    table,
    columns,
    notes,
    ...readRows(spec, table, columns, notes, plan.multiples),
  };
  const option = drawChart(type, reading);
  checkItems(type, spec, option);
  return {
    option,
    summary: `${summarize(reading)}${notes.map((note) => `; ${note}`).join("")}.`,
  };
}

/** Draws the rows as the requested chart, adding what the drawing worked out to the notes. */
function drawChart(type: RowChartType, reading: Reading): Record<string, unknown> {
  switch (type) {
    case "bar":
    case "horizontalBar":
    case "stackedBar":
    case "line":
    case "area":
    case "stackedArea":
      return cartesianOption(type, reading);
    case "scatter":
      return scatterOption(reading);
    case "pie":
    case "doughnut":
      return pieOption(type === "doughnut", reading);
    case "funnel":
      return funnelOption(reading);
    case "radar":
      return radarOption(reading);
    case "treemap":
    case "sunburst":
      return hierarchyOption(type, reading);
    case "sankey":
      return sankeyOption(reading);
    case "heatmap":
      return heatmapOption(reading);
    case "boxplot":
      return boxplotOption(reading);
    case "gauge":
      return gaugeOption(reading);
  }
}

/**
 * The most items of the charts that draw each item as a shape of its own, with what they are and
 * how to have fewer. The panel draws every shape as an element, and ECharts lays out pie and funnel
 * labels and radar legends in time that grows faster than their number, while the panel does
 * nothing else: beyond these, a chart takes seconds to minutes to draw, and has more items than
 * can be told apart. Many bars or points are drawn as a shape per series, lines are sampled,
 * treemaps leave out nodes too small to see, and sankeys sum up nodes.
 */
type ItemLimit = [most: number, items: string, advice: string];
const SLICES: ItemLimit = [
  1000,
  "slices",
  'Set "sort": "descending" and a "limit" to sum the smallest up as "Other".',
];
const MOST_ITEMS: Partial<Record<RowChartType, ItemLimit>> = {
  pie: SLICES,
  doughnut: SLICES,
  funnel: [1000, "stages", 'Keep fewer rows with "filters" or "limit", or "aggregate" them.'],
  radar: [1000, "shapes", 'Keep fewer rows with "filters" or "limit", or "aggregate" them.'],
  boxplot: [10_000, "boxes", 'Group by a label column with fewer values, or use "filters".'],
  sunburst: [
    10_000,
    "nodes",
    'Draw a treemap, which leaves out nodes too small to see, or keep fewer rows with "filters".',
  ],
  heatmap: [
    100_000,
    "cells",
    'Keep fewer rows or columns with "filters" or "valueColumns", or summarize the data into ' +
      "coarser labels first, such as days instead of minutes.",
  ],
};

/** Refuses a chart with more items, those of hierarchies included, than its type may have. */
function checkItems(type: RowChartType, spec: ChartSpec, option: Record<string, unknown>): void {
  const limit = MOST_ITEMS[type];
  if (!limit) return;
  const [most, items, advice] = limit;
  const count = (data: unknown): number =>
    Array.isArray(data)
      ? data.reduce((sum: number, item) => sum + 1 + count(isPlainObject(item) && item.children), 0)
      : 0;
  const series = option.series;
  const data = Array.isArray(series) && isPlainObject(series[0]) ? series[0].data : undefined;
  // The "Other" slice that a pie's "limit" sums the rest up as comes on top of the slices it keeps.
  const last: unknown = Array.isArray(data) ? data.at(-1) : undefined;
  const other =
    limit === SLICES && spec.limit !== undefined && isPlainObject(last) && last.name === "Other";
  const drawn = count(data) - (other ? 1 : 0);
  if (drawn > most) {
    throw new Error(
      `The ${type} chart would have ${formatCount(drawn)} ${items}, more than the ` +
        `${formatCount(most)} the panel draws: they would hold it up and could not be told ` +
        `apart. ${advice}`,
    );
  }
}

/** Which column became which part of the chart, for a model that may have meant another. */
function summarize({ spec, table, columns, names }: Reading): string {
  const labels = columns.labels.map((index) => JSON.stringify(columnName(table, index)));
  const [first = "", second = ""] = labels;
  const values = spec.aggregate === "count" ? "the number of rows" : quoteAll(names);
  const by = labels.length === 0 ? " by row number" : ` by ${labels.join(", ")}`;
  // Points and boxes that no column labels are not "by row number": nothing names them.
  const whenLabeled = labels.length === 0 ? "" : by;
  switch (spec.type) {
    case "scatter":
      return columns.times === undefined
        ? `Charted ${JSON.stringify(names[1])} against ${JSON.stringify(names[0])}${whenLabeled}`
        : `Charted ${values} against ${first}`;
    case "radar":
      return `Charted ${values} on an axis each${by}`;
    case "treemap":
    case "sunburst":
      return chained(columns)
        ? `Charted ${values} by the levels of ${labels.join(", ")}`
        : `Charted ${values}${by}`;
    case "sankey":
      if (labels.length >= 2) {
        return `Charted ${values} as flows from ${labels.join(" to ")}`;
      }
      return columns.separator === undefined
        ? `Charted ${values} as flows from ${first} to a node per value column`
        : `Charted ${values} as flows between the levels of ${first}`;
    case "heatmap":
      return labels.length >= 2
        ? `Charted ${values} by ${first} (rows) and ${second} (columns)`
        : `Charted ${values} (columns)${by} (rows)`;
    case "boxplot":
      return `Charted the spread of ${values}${whenLabeled}`;
    default:
      return labels.length >= 2
        ? `Charted ${values} by ${first}, a series per label of ${second}`
        : `Charted ${values}${by}`;
  }
}

function mergeValue(target: unknown, source: unknown): unknown {
  if (isPlainObject(source)) {
    if (Array.isArray(target) && target.length > 0 && target.every(isPlainObject)) {
      // {"series": {...}} adjusts every series.
      return target.map((item) => deepMerge(item, source));
    }
    return deepMerge(isPlainObject(target) ? target : {}, source);
  }
  if (
    Array.isArray(source) &&
    source.length > 0 &&
    source.every(isPlainObject) &&
    (Array.isArray(target) || isPlainObject(target))
  ) {
    // {"series": [{...}]} adjusts the first series, and so on. ECharts reads a single component
    // as an array of one, so {"xAxis": [{...}]} adjusts a generated {"xAxis": {...}} too.
    const items = Array.isArray(target) ? target : [target];
    return Array.from({ length: Math.max(items.length, source.length) }, (_, i) =>
      i < source.length ? mergeValue(items[i], source[i]) : items[i],
    );
  }
  return structuredClone(source);
}

/**
 * Returns a deep merge of source into target, without changing either, as a JSON Merge Patch
 * (RFC 7396) does: plain objects merge recursively, null removes a key, and other values replace
 * the target's. Unlike a merge patch, an array of objects merges element by element into an
 * array or an object, and an object merges into each object of an array.
 */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value === null) {
      delete result[key];
    } else if (key !== "__proto__") {
      // Assigning "__proto__" would change the result's prototype.
      result[key] = mergeValue(target[key], value);
    }
  }
  return result;
}
