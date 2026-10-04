// Turning a table and a chart request into an Apache ECharts option.

import { type Columns, chained, columnName, readColumns } from "./chartColumns";
import { buildFacetedChart } from "./chartFacets";
import { boxplotOption, cartesianOption, heatmapOption, scatterOption } from "./chartGrid";
import { hierarchyOption, sankeyOption } from "./chartHierarchy";
import { funnelOption, gaugeOption, pieOption, radarOption } from "./chartItems";
import { type Reading, readRows, tableBytePower } from "./chartRows";
import type { ChartSpec, ChartType } from "./chartSpec";
import { buildHistogram, filterTable, type HistogramPlan, planHistogram } from "./chartTransforms";
import type { DataTable } from "./data";
import { isPlainObject } from "./protocol";
import { quoteAll } from "./text";

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
  const removed = table.rows.length - filtered.rows.length;
  return {
    option: spec.options === undefined ? chart.option : deepMerge(chart.option, spec.options),
    summary:
      removed === 0
        ? chart.summary
        : `${chart.summary.slice(0, -1)}; filters kept ${filtered.rows.length} of ${table.rows.length} rows.`,
  };
}

/** What every facet reads alike: the columns, the notes about them and the unit of sizes. */
interface ChartPlan {
  columns: Columns;
  notes: string[];
  bytePower?: number | undefined;
}

/** Infer the shared columns and units once, rather than rescanning all rows for every facet. */
function planChart(spec: ChartSpec, table: DataTable, faceted: boolean): ChartPlan {
  const notes: string[] = [];
  const columns = readColumns(spec, table, notes);
  return {
    columns,
    notes,
    bytePower: faceted ? tableBytePower(table, columns.values) : undefined,
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
    ...readRows(spec, table, columns, notes, plan.bytePower),
  };
  const option = drawChart(type, reading);
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

/** Which column became which part of the chart, for a model that may have meant another. */
function summarize({ spec, table, columns, names }: Reading): string {
  const labels = columns.labels.map((index) => JSON.stringify(columnName(table, index)));
  const [first = "", second = ""] = labels;
  const values = quoteAll(names);
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
      return `Charted ${values}${by}`;
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
