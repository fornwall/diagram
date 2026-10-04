// Host-side analytical transforms, keeping generated ECharts options as plain JSON.

import { columnName, defaultValueColumns, describeColumns, findColumn } from "./chartColumns";
import type { ChartFilter, ChartSpec } from "./chartSpec";
import type { Chart } from "./charts";
import type { Cell, DataTable } from "./data";

function matches(cell: Cell | undefined, { op, value }: ChartFilter): boolean {
  switch (op) {
    case "eq":
      return cell === value;
    case "neq":
      return cell !== value;
    case "contains":
      return typeof cell === "string" && typeof value === "string" && cell.includes(value);
    default:
      if (typeof cell !== "number" || typeof value !== "number") {
        return false;
      }
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
      `No rows match the chart filters: ${emptyingFilter(table, predicates)}. Change or remove ` +
        "the filters to include data.",
    );
  }
  return { ...table, rows };
}

/** Which filter left no rows, and why it might have, when its value has the wrong type. */
function emptyingFilter(
  table: DataTable,
  predicates: { filter: ChartFilter; index: number }[],
): string {
  let rows = table.rows;
  for (const { filter, index } of predicates) {
    const { column, op, value } = filter;
    const before = rows.length;
    rows = rows.filter((row) => matches(row[index], filter));
    if (rows.length > 0) continue;
    const kept = `${JSON.stringify(column)} ${op} ${JSON.stringify(value)} matches none of ${
      before === table.rows.length ? "the" : "the remaining"
    } ${before} rows`;
    const numeric = table.columns[index]?.numeric === true;
    if (numeric && typeof value === "string") {
      const number = Number(value);
      return `${kept}; the column holds numbers${
        op !== "contains" && value.trim() !== "" && Number.isFinite(number)
          ? `, so compare with ${number} rather than ${JSON.stringify(value)}`
          : ""
      }`;
    }
    if (!numeric && typeof value === "number") {
      return `${kept}; the column holds text, so compare with ${JSON.stringify(String(value))}`;
    }
    return kept;
  }
  return "together they match no row";
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
        `A histogram bins the raw rows of one column. Leave "${key}" out; select rows with ` +
          '"filters", or compare groups with "facetColumn".',
      );
    }
  }
  if (spec.valueColumns !== undefined && spec.valueColumns.length !== 1) {
    throw new Error(
      'A histogram bins one column; give one in "valueColumns", and compare groups with "facetColumn".',
    );
  }
  const explicit = spec.valueColumns?.[0];
  const column =
    explicit === undefined
      ? defaultValueColumns(table, [], 1)[0]
      : findColumn(table, explicit, "value");
  if (column === undefined) {
    throw new Error(
      `No column holds numbers to bin. Columns: ${describeColumns(table)}. If the data was not ` +
        'split into columns as intended, set "format".',
    );
  }
  let minimum = Infinity;
  let maximum = -Infinity;
  let count = 0;
  for (const row of table.rows) {
    const value = row[column];
    if (typeof value !== "number") continue;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
    count++;
  }
  const name = columnName(table, column);
  if (count === 0) {
    throw new Error(`The value column ${JSON.stringify(name)} holds no numbers to bin.`);
  }
  const bins = spec.bins ?? Math.min(50, Math.ceil(Math.sqrt(count)));
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

/**
 * Edges rounded to a tenth of the bin width, e.g. 0.3 for 0.30000000000000004, which tells
 * adjacent edges apart. Widths too small or too large for that keep every digit.
 */
function edgeFormat(edges: number[]): (edge: number) => string {
  const width = (edges[1] ?? 0) - (edges[0] ?? 0);
  const decimals = 1 - Math.floor(Math.log10(width));
  if (!(decimals >= 0 && decimals <= 100)) return String;
  return (edge) => String(Number(edge.toFixed(decimals)));
}

export function buildHistogram(table: DataTable, { column, name, edges }: HistogramPlan): Chart {
  const counts = Array<number>(Math.max(1, edges.length - 1)).fill(0);
  let count = 0;
  for (const row of table.rows) {
    const value = row[column];
    if (typeof value !== "number") continue;
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
  const format = edgeFormat(edges);
  const data = counts.map((value, index) => {
    const lower = edges[index] ?? 0;
    const upper = edges[index + 1] ?? lower;
    const last = index === counts.length - 1;
    return { name: `[${format(lower)}, ${format(upper)}${last ? "]" : ")"}`, value, lower, upper };
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
    summary: `Charted ${count} observations of ${JSON.stringify(name)} in ${counts.length} histogram bins${skipped ? `; skipped ${skipped} rows without a number` : ""}.`,
  };
}
