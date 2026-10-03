// Host-side analytical transforms, keeping generated ECharts options as plain JSON.

import type { ChartFilter, ChartSpec } from "./chartSpec";
import type { Chart } from "./charts";
import { type Cell, type DataTable, findColumn } from "./data";

function matches(cell: Cell | undefined, { op, value }: ChartFilter): boolean {
  switch (op) {
    case "eq":
      return cell === value;
    case "neq":
      return cell !== value;
    case "contains":
      return typeof cell === "string" && typeof value === "string" && cell.includes(value);
    default:
      if (typeof cell !== "number" || !Number.isFinite(cell) || typeof value !== "number")
        return false;
      switch (op) {
        case "lt":
          return cell < value;
        case "lte":
          return cell <= value;
        case "gt":
          return cell > value;
        case "gte":
          return cell >= value;
      }
  }
}

/** AND predicates on parsed cells, before grouping, binning, sorting or limiting. */
export function filterTable(table: DataTable, filters: ChartFilter[] | undefined): DataTable {
  if (filters === undefined || filters.length === 0) return table;
  const predicates = filters.map((filter) => ({
    filter,
    index: findColumn(table, filter.column, "filter"),
  }));
  const rows = table.rows.filter((row) =>
    predicates.every(({ filter, index }) => matches(row[index], filter)),
  );
  if (rows.length === 0) {
    throw new Error(
      "No rows match the chart filters. Change or remove the filters to include data.",
    );
  }
  return { ...table, rows };
}

export interface HistogramPlan {
  column: number;
  name: string;
  /** Distinct finite bounds; constant observations have a single bound. */
  edges: number[];
}

/** Use one set of bin edges for all facets, including facets without numeric observations. */
export function planHistogram(spec: ChartSpec, table: DataTable): HistogramPlan {
  for (const key of ["aggregate", "sort", "limit", "labelColumn"] as const) {
    if (spec[key] !== undefined) {
      throw new Error(
        `A histogram summarizes raw observations in numeric order. Leave "${key}" out; use filters to select observations or facetColumn to group distributions.`,
      );
    }
  }
  if (spec.valueColumns !== undefined && spec.valueColumns.length !== 1) {
    throw new Error(
      'A histogram needs exactly one "valueColumns" entry. Use facetColumn to compare distributions.',
    );
  }
  const explicit = spec.valueColumns?.[0];
  const column =
    explicit === undefined
      ? table.columns.findIndex((column) => column.numeric && column.name !== spec.facetColumn)
      : findColumn(table, explicit, "value");
  if (column < 0)
    throw new Error('No column holds numbers to bin. Set "valueColumns" to a numeric column.');
  let minimum = Infinity;
  let maximum = -Infinity;
  let count = 0;
  for (const row of table.rows) {
    const value = row[column];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
    count++;
  }
  const name = table.columns[column]?.name ?? "";
  if (count === 0)
    throw new Error(`The value column ${JSON.stringify(name)} holds no finite numbers to bin.`);
  const bins = spec.bins ?? Math.min(50, Math.ceil(Math.sqrt(count)));
  if (!Number.isInteger(bins) || bins < 1 || bins > 200)
    throw new Error('Histogram "bins" must be an integer from 1 to 200.');
  const edges = [minimum];
  for (let i = 1; i < bins; i++) {
    // Subtraction can overflow for opposite signs; weighted interpolation remains finite.
    const fraction = i / bins;
    const range = maximum - minimum;
    const edge = Number.isFinite(range)
      ? minimum + range * fraction
      : minimum * (1 - fraction) + maximum * fraction;
    if (edge > (edges.at(-1) ?? minimum) && edge < maximum) edges.push(edge);
  }
  if (maximum > minimum) edges.push(maximum);
  return { column, name, edges };
}

export function buildHistogram(table: DataTable, { column, name, edges }: HistogramPlan): Chart {
  const counts = Array<number>(Math.max(1, edges.length - 1)).fill(0);
  let count = 0;
  for (const row of table.rows) {
    const value = row[column];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    // A boundary belongs to the bin on its right, except the maximum belongs to the last bin.
    let low = 0;
    let high = edges.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((edges[middle] ?? Infinity) <= value) low = middle + 1;
      else high = middle;
    }
    const index = Math.max(0, Math.min(counts.length - 1, low - 1));
    counts[index] = (counts[index] ?? 0) + 1;
    count++;
  }
  const data = counts.map((value, index) => {
    const lower = edges[index] ?? 0;
    const upper = edges[index + 1] ?? lower;
    const last = index === counts.length - 1;
    return { name: `[${lower}, ${upper}${last ? "]" : ")"}`, value, lower, upper };
  });
  const skipped = table.rows.length - count;
  return {
    option: {
      tooltip: { trigger: "item", formatter: "{b}<br/>{a}: {c}" },
      xAxis: {
        type: "category",
        name,
        data: data.map((bin) => bin.name),
        axisLabel: { hideOverlap: true },
      },
      yAxis: { type: "value", name: "count", min: 0, minInterval: 1 },
      series: [{ type: "bar", name: "count", barCategoryGap: "0%", barGap: "0%", data }],
    },
    summary: `Charted ${count} observations of ${JSON.stringify(name)} in ${counts.length} histogram bins${skipped ? `; skipped ${skipped} rows without finite numeric values` : ""}.`,
  };
}
