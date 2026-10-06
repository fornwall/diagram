// Transforms of the raw rows: the filters of any chart, and the bins of a histogram.

import { columnName, defaultValueColumns, describeColumns, findColumn } from "./chartColumns";
import { interpolate } from "./chartRows";
import type { ChartFilter, ChartSpec } from "./chartSpec";
import type { Chart } from "./charts";
import type { Cell, DataTable } from "./data";
import { plural } from "./text";

const COMPARE: Record<"lt" | "lte" | "gt" | "gte", (cell: number, value: number) => boolean> = {
  lt: (cell, value) => cell < value,
  lte: (cell, value) => cell <= value,
  gt: (cell, value) => cell > value,
  gte: (cell, value) => cell >= value,
};

function matches(cell: Cell | undefined, { op, value }: ChartFilter): boolean {
  if (op === "eq") return cell === value;
  if (op === "neq") return cell !== value;
  if (op === "contains") {
    return typeof cell === "string" && typeof value === "string" && cell.includes(value);
  }
  return typeof cell === "number" && typeof value === "number" && COMPARE[op](cell, value);
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
  /** The name of each bin, e.g. "[0, 10)", or "7" for a bin of the whole number 7 alone. */
  names: string[];
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
  let whole = true;
  for (const row of table.rows) {
    const value = row[column];
    if (typeof value !== "number") continue;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
    whole &&= Number.isInteger(value);
    count++;
  }
  const name = columnName(table, column);
  if (count === 0) {
    throw new Error(`The value column ${JSON.stringify(name)} holds no numbers to bin.`);
  }
  const bins = spec.bins ?? Math.min(MOST_BINS, Math.ceil(Math.sqrt(count)));
  if (spec.bins === undefined) {
    const round = roundBins(minimum, maximum, bins, whole);
    if (round !== undefined) return { column, name, ...round };
  }
  const edges = evenEdges(minimum, maximum, bins);
  const format = edgeFormat(edges);
  const last = edges.length - 2;
  // The maximum belongs to the last bin, which holds its upper bound.
  const names = edges.slice(0, Math.max(1, edges.length - 1)).map((lower, index) => {
    const upper = edges[index + 1] ?? lower;
    return `[${format(lower)}, ${format(upper)}${index >= last ? "]" : ")"}`;
  });
  return { column, name, edges, names };
}

/** The most bins that automatic binning makes, from the square root of the observations. */
const MOST_BINS = 50;

/**
 * About `bins` bins of a round width, 1, 2 or 5 times a power of ten, as people bin by hand and as
 * d3 and Vega-Lite do. Whole numbers get bins at least 1 wide, each holding the whole numbers from
 * its lower edge, so that no bin falls between two of them. Undefined where the numbers are too
 * large or too close together for round edges.
 */
function roundBins(
  minimum: number,
  maximum: number,
  bins: number,
  whole: boolean,
): Pick<HistogramPlan, "edges" | "names"> | undefined {
  const width = (maximum - minimum) / bins;
  let step = 1;
  if (width > 0 && Number.isFinite(width)) {
    const power = 10 ** Math.floor(Math.log10(width));
    // The tolerance allows for rounding in the logarithm and the power, as for a width of 0.3.
    step =
      [1, 2, 5].map((factor) => factor * power).find((round) => round >= width * 0.999999) ??
      10 * power;
  } else if (!whole) {
    return undefined;
  }
  if (whole) step = Math.max(1, step);
  // Multiples of a fraction's inverse, 3 / 10 for 0.3, are exact where 3 * 0.1 is not.
  const inverse = step < 1 ? Math.round(1 / step) : undefined;
  const at = (value: number) => (inverse === undefined ? value / step : value * inverse);
  const first = Math.floor(at(minimum));
  // A bin of whole numbers ends before the next whole number, so the last one after the maximum.
  const end = whole ? Math.floor(at(maximum)) + 1 : Math.ceil(at(maximum));
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(end) || end - first > 2 * bins + 2) {
    return undefined;
  }
  const edges = Array.from({ length: end - first + 1 }, (_, i) =>
    inverse === undefined ? (first + i) * step : (first + i) / inverse,
  );
  if (!edges.every((edge, i) => Number.isFinite(edge) && !(edge <= (edges[i - 1] ?? -Infinity)))) {
    return undefined;
  }
  const names = edges.slice(0, -1).map((lower, i) => {
    const upper = edges[i + 1] ?? lower;
    if (whole) return step === 1 ? String(lower) : `[${lower}, ${upper})`;
    return `[${lower}, ${upper}${i === edges.length - 2 ? "]" : ")"}`;
  });
  return { edges, names };
}

/** Edges that split the range of the observations into `bins` bins of equal width. */
function evenEdges(minimum: number, maximum: number, bins: number): number[] {
  const edges = [minimum];
  for (let i = 1; i < bins; i++) {
    const edge = interpolate(minimum, maximum, i / bins);
    if (edge > (edges.at(-1) ?? minimum) && edge < maximum) edges.push(edge);
  }
  if (maximum > minimum) edges.push(maximum);
  return edges;
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

export function buildHistogram(
  table: DataTable,
  { column, name, edges, names }: HistogramPlan,
): Chart {
  const counts = Array<number>(names.length).fill(0);
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
  const data = counts.map((value, index) => {
    const lower = edges[index] ?? 0;
    return { name: names[index] ?? "", value, lower, upper: edges[index + 1] ?? lower };
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
    summary:
      `Charted ${plural(count, "observation")} of ${JSON.stringify(name)} in ` +
      `${plural(counts.length, "histogram bin")}` +
      `${skipped > 0 ? `; skipped ${plural(skipped, "row")} without a number` : ""}.`,
  };
}
