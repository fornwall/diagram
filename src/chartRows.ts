// The rows a chart draws: labeled, without totals or parent rows, grouped, sorted and limited.

import {
  type Columns,
  chained,
  columnName,
  isCartesian,
  isTotalsLabel,
  readsLevels,
} from "./chartColumns";
import type { Aggregation, ChartSpec, ChartType } from "./chartSpec";
import { type Multiples, showInMultiples } from "./chartUnits";
import type { Cell, DataTable } from "./data";
import { scale } from "./dataNumber";
import { formatCount, plural, quoteAll } from "./text";

/** The most levels of a row, as the hierarchy built from them is walked recursively. */
const MAX_LEVELS = 100;

export interface Row {
  /** What names the row: one label per label column, or the levels of a path in one of them. */
  labels: string[];
  values: (number | null)[];
}

/** A table read as a chart: which columns play which role, and the rows to draw. */
export interface Reading {
  spec: ChartSpec;
  table: DataTable;
  columns: Columns;
  /** The value columns' names, with the multiple of bytes or seconds that they are shown in. */
  names: string[];
  /** Explicit axis maxima converted to the same units as the values. */
  maxima: number[];
  rows: Row[];
  /** How the data was read, as the clauses of the summary; the drawing adds to it. */
  notes: string[];
}

/** A row's first label: the category, slice, group or outermost node that it names. */
export function label({ labels }: Row): string {
  return labels[0] ?? "";
}

/**
 * Notes how many items repeat an earlier label: slices of the same name share a legend entry, and
 * bars of the same name read as one category, both suggesting rows that "aggregate" would combine.
 */
export function noteRepeatedLabels(
  { spec, rows, notes }: Reading,
  item: string,
  items: string,
): void {
  if (spec.aggregate !== undefined) {
    return;
  }
  const repeats = rows.length - new Set(rows.map(label)).size;
  if (repeats > 0) {
    notes.push(
      `${repeats} ${repeats === 1 ? `${item} repeats` : `${items} repeat`} the label of an ` +
        'earlier one; "aggregate" combines the rows of each label',
    );
  }
}

export function addValues(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isFinite(sum)) {
    throw new Error(
      "The chart's total exceeds the numeric range. Rescale the values before charting them.",
    );
  }
  return sum;
}

/** The quantile of sorted numbers, interpolating between them, as R's default quantile does. */
export function quantile(sorted: number[], share: number): number {
  const at = (sorted.length - 1) * share;
  const below = Math.floor(at);
  const left = sorted[below] ?? 0;
  return interpolate(left, sorted[below + 1] ?? left, at - below);
}

/** The number a fraction of the way from `left` to `right`. */
export function interpolate(left: number, right: number, fraction: number): number {
  // Weighted interpolation avoids overflow when opposite signs make the difference infinite.
  const difference = right - left;
  return Number.isFinite(difference)
    ? left + difference * fraction
    : left * (1 - fraction) + right * fraction;
}

/** The smallest of 1, 2 or 5 times a power of ten that is at least a positive value. */
export function roundStep(value: number): number {
  const power = 10 ** Math.floor(Math.log10(value));
  // The tolerance allows for rounding in the logarithm and the power, as for 0.3.
  return (
    [1, 2, 5].map((factor) => factor * power).find((round) => round >= value * 0.999999) ??
    10 * power
  );
}

/**
 * Counts steps of `step` to a value, and back. Multiples of a fraction's inverse, 3 / 10 for 0.3,
 * are exact where 3 * 0.1 is not.
 */
export function stepsOf(step: number): { count(value: number): number; at(steps: number): number } {
  const inverse = step < 1 ? Math.round(1 / step) : undefined;
  return inverse === undefined
    ? { count: (value) => value / step, at: (steps) => steps * step }
    : { count: (value) => value * inverse, at: (steps) => steps / inverse };
}

/** Recognize a named totals row only when its values match the preceding sums within 1%. */
function hasTotalsRow(table: DataTable, labelColumn: number, valueColumns: number[]): boolean {
  const last = table.rows.at(-1);
  const label = last?.[labelColumn];
  if (last === undefined || table.rows.length < 3 || !isTotalsLabel(label)) {
    return false;
  }
  let checked = 0;
  for (const column of valueColumns) {
    const total = last[column];
    if (typeof total === "number") {
      let sum = 0;
      for (let i = 0; i < table.rows.length - 1; i++) {
        const value = table.rows[i]?.[column];
        if (typeof value === "number") sum += value;
      }
      if (Math.abs(total - sum) > Math.abs(total) * 0.01) {
        return false;
      }
      checked++;
    }
  }
  return checked > 0;
}

/** Sorts rows by a key, empty keys last and equal ones in their order. */
function sortRows(
  rows: Row[],
  sort: NonNullable<ChartSpec["sort"]>,
  key: (row: Row) => number | null,
  limit?: number,
): Row[] {
  const direction = sort === "ascending" ? 1 : -1;
  const keyed = rows.map((row, index) => ({ row, index, key: key(row) }));
  type Keyed = (typeof keyed)[number];
  const order = (left: Keyed, right: Keyed): number => {
    const { key: x } = left;
    const { key: y } = right;
    if (x === null || y === null) {
      return x === y ? left.index - right.index : x === null ? 1 : -1;
    }
    return (x - y) * direction || left.index - right.index;
  };
  // Small limits need only the best rows. Keep the worst retained row at the heap root.
  if (limit !== undefined && limit > 0 && limit < rows.length / 4) {
    const heap: Keyed[] = [];
    for (const candidate of keyed) {
      if (heap.length < limit) {
        let at = heap.length;
        heap.push(candidate);
        while (at > 0) {
          const parent = Math.floor((at - 1) / 2);
          const previous = heap[parent];
          if (!previous || order(candidate, previous) <= 0) break;
          heap[at] = previous;
          at = parent;
        }
        heap[at] = candidate;
      } else if (heap[0] && order(candidate, heap[0]) < 0) {
        let at = 0;
        while (at * 2 + 1 < heap.length) {
          let child = at * 2 + 1;
          const left = heap[child];
          const right = heap[child + 1];
          if (left && right && order(right, left) > 0) child++;
          const next = heap[child];
          if (!next || order(candidate, next) >= 0) break;
          heap[at] = next;
          at = child;
        }
        heap[at] = candidate;
      }
    }
    return heap.sort(order).map(({ row }) => row);
  }
  return keyed.sort(order).map(({ row }) => row);
}

/** The sum of a row's values, or null without any. */
function rowTotal({ values }: Row): number | null {
  let total: number | null = null;
  for (const value of values) {
    if (value !== null) total = addValues(total ?? 0, value);
  }
  return total;
}

/** Keys rows by the total of the first values of the rows with their first label. */
function labelTotals(rows: Row[]): (row: Row) => number | null {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const value = row.values[0] ?? null;
    if (value !== null) totals.set(label(row), addValues(totals.get(label(row)) ?? 0, value));
  }
  return (row) => totals.get(label(row)) ?? null;
}

/** Drop parent rows to avoid counting both directory totals and their files in du -a output. */
function withoutNests(rows: Row[]): Row[] {
  // A tree of the parent paths, rather than a set of every prefix serialized.
  interface Path extends Map<string, Path> {}
  const roots: Path = new Map();
  for (const { labels } of rows) {
    let path = roots;
    for (let level = 0; level < labels.length - 1; level++) {
      const label = labels[level] ?? "";
      let child = path.get(label);
      if (!child) {
        child = new Map();
        path.set(label, child);
      }
      path = child;
    }
  }
  if (roots.size === 0) return rows;
  return rows.filter(({ labels }) => {
    if (labels.length === 0) return true;
    let path = roots;
    for (const label of labels) {
      const child = path.get(label);
      if (!child) return true;
      path = child;
    }
    return false;
  });
}

/** What grouping did with the values of each group, for the note about it. */
const AGGREGATED: Record<Aggregation, string> = {
  sum: "summing their values",
  mean: "averaging their values",
  count: "counting the rows of each group",
  min: "taking the smallest of their values",
  max: "taking the largest of their values",
  median: "taking the median of their values",
};

interface GroupColumn {
  value: number | null;
  count: number;
  /** A power-of-two scale used only when a mean's running sum would overflow. */
  scale?: number;
  /** Only a median needs to retain all observations. */
  samples?: number[] | undefined;
}

/** Aggregate rows by their labels, preserving the order of each group's first appearance. */
function groupRows(rows: Row[], how: Aggregation): Row[] {
  const groups = new Map<string, { labels: string[]; columns: GroupColumn[]; rows: number }>();
  for (const { labels, values } of rows) {
    const key = JSON.stringify(labels);
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        labels,
        columns: values.map(() => ({
          value: null,
          count: 0,
          samples: how === "median" ? [] : undefined,
        })),
        rows: 0,
      };
      groups.set(key, group);
    }
    group.rows++;
    values.forEach((value, index) => {
      const column = group.columns[index];
      if (value === null || column === undefined) {
        return;
      }
      column.count++;
      if (column.samples !== undefined) {
        column.samples.push(value);
        return;
      }
      if (how === "mean") {
        value *= column.scale ?? 1;
        if (!Number.isFinite((column.value ?? 0) + value)) {
          column.scale = (column.scale ?? 1) / 2;
          column.value = (column.value ?? 0) / 2;
          value /= 2;
        }
      }
      column.value =
        how === "min"
          ? Math.min(column.value ?? value, value)
          : how === "max"
            ? Math.max(column.value ?? value, value)
            : addValues(column.value ?? 0, value);
    });
  }
  return [...groups.values()].map(({ labels, columns, rows: count }) => ({
    labels,
    values:
      how === "count"
        ? [count]
        : columns.map(({ value, count, scale, samples }) => {
            if (count === 0) {
              return null;
            }
            if (samples !== undefined) {
              return quantile(
                samples.sort((x, y) => x - y),
                0.5,
              );
            }
            return how === "mean" ? (value ?? 0) / count / (scale ?? 1) : value;
          }),
  }));
}

/** The labels of a table row: one per label column, the levels of its path, or its row number. */
function rowLabels(
  row: Cell[],
  index: number,
  { labels, separator }: Columns,
  type: ChartType,
): string[] {
  const first = labels[0];
  if (first === undefined) {
    return [String(index + 1)];
  }
  const parts =
    separator === undefined
      ? labels.map((column) => String(row[column] ?? ""))
      : String(row[first] ?? "").split(separator);
  if (type === "sankey" && separator === undefined) {
    // Each label column is a stage, which an empty label in between skips rather than shifting
    // the later stages into its place.
    while (parts.length > 1 && parts.at(-1) === "") parts.pop();
    return parts;
  }
  // Levels leave out the empty labels so that "src/" and "src" nest alike; any other chart keeps
  // an empty label as the category it is.
  const levels = readsLevels(type) ? parts.filter((part) => part !== "") : parts;
  return levels.length > 0 ? levels : [""];
}

/**
 * Remove totals and parent rows, aggregate, then discard unusable rows, sort and limit.
 * Group before limiting so "the 10 largest" selects groups. Scale sizes, durations and axis names
 * together, by the `shared` multiples of their units when facets must agree on them.
 */
export function readRows(
  spec: ChartSpec,
  table: DataTable,
  columns: Columns,
  notes: string[],
  shared?: Multiples,
): Pick<Reading, "rows" | "names" | "maxima"> {
  const { type } = spec;
  const valueIndices = columns.values;
  const name = (index: number) => columnName(table, index);

  let tableRows = table.rows;
  const labelIndex = columns.labels[0];
  if (labelIndex !== undefined && hasTotalsRow(table, labelIndex, valueIndices)) {
    tableRows = tableRows.slice(0, -1);
    notes.push(
      `left out the last row, ${JSON.stringify(table.rows.at(-1)?.[labelIndex])}, a total of the others`,
    );
  }
  const nested = readsLevels(type);
  let rows: Row[] = tableRows.map((row, i) => ({
    labels: rowLabels(row, i, columns, type),
    values: valueIndices.map((index) => {
      const cell = row[index];
      return typeof cell === "number" ? cell : null;
    }),
  }));
  if (nested) {
    if (rows.some(({ labels }) => labels.length > MAX_LEVELS)) {
      throw new Error(
        `A ${type} chart supports at most ${MAX_LEVELS} hierarchy levels per row. ` +
          "Select fewer label columns or shorten the paths before charting them.",
      );
    }
    const nests = rows.length;
    rows = withoutNests(rows);
    const left = nests - rows.length;
    if (left > 0) {
      notes.push(
        `left out ${plural(left, "row")} that other rows nest under, as the values of their ` +
          "children total them",
      );
    }
  }

  if (spec.aggregate !== undefined) {
    const ungrouped = rows.length;
    rows = groupRows(rows, spec.aggregate);
    const by = columns.labels.length === 0 ? "row number" : quoteAll(columns.labels.map(name));
    notes.push(
      `grouped ${plural(ungrouped, "row")} into ${formatCount(rows.length)} by ${by}, ${AGGREGATED[spec.aggregate]}`,
    );
  }

  if (columns.timeAxis) {
    // A row without a date has nowhere to sit on a time axis, as a last row named like a total
    // that totals nothing.
    const dated = rows.filter((row) => label(row) !== "" && !isTotalsLabel(label(row)));
    const left = rows.length - dated.length;
    if (left > 0) {
      notes.push(`left out ${plural(left, "row")} without a date`);
    }
    rows = dated;
  }

  // A share of a total has no size without a positive value, and a point needs both an x and a y.
  // A flow with one node per value column leaves out single flows instead of whole rows.
  const positive =
    ["pie", "doughnut", "funnel", "treemap", "sunburst"].includes(type) ||
    (type === "sankey" && chained(columns));
  if (positive || type === "scatter") {
    const charted = rows.filter(({ values }) =>
      positive ? (values[0] ?? 0) > 0 : !values.includes(null),
    );
    const left = rows.length - charted.length;
    // A facet without points is an empty panel, as one without bars is, rather than no chart.
    if (charted.length === 0 && shared === undefined) {
      const quoted = quoteAll(valueIndices.map(name));
      const values = rows.map(({ values }) => values[0]);
      throw new Error(
        positive
          ? `A ${type} chart needs positive numbers, as it sizes each item by its value, but ` +
              `${quoted} has none` +
              (values.some((value) => (value ?? 0) < 0)
                ? ". Chart negative values as a bar chart instead."
                : values.includes(0)
                  ? ', only zeros. Choose a column with positive numbers in "valueColumns".'
                  : ".")
          : `A scatter chart needs rows with numbers in both ${quoted}, but none has. Choose ` +
              '"valueColumns" that are filled in the same rows.',
      );
    }
    if (left > 0) {
      const without = positive ? "a positive value" : "both an x and a y value";
      notes.push(`left out ${plural(left, "row")} without ${without}`);
    }
    rows = charted;
  }
  const beforeLimit = rows.length;
  const combineOther = type === "pie" || type === "doughnut";
  if (spec.sort !== undefined) {
    // A stack shows the total of its row, and a series per label of a second label column draws
    // the rows of a first label together, so sort by the total of those rows.
    const key =
      isCartesian(type) && columns.labels.length >= 2
        ? labelTotals(rows)
        : type === "stackedBar" || type === "stackedArea"
          ? rowTotal
          : (row: Row) => row.values[0] ?? null;
    rows = sortRows(rows, spec.sort, key, combineOther ? undefined : spec.limit);
    if (columns.timeAxis) {
      notes.push('the time axis orders the rows by time, so "sort" only chose the rows to keep');
    }
  }
  if (spec.limit !== undefined && beforeLimit > spec.limit) {
    if (combineOther) {
      // A row named "Other" in the data is summed up too, rather than becoming a second slice.
      const kept: Row[] = [];
      let other = 0;
      let summed = 0;
      for (const row of rows) {
        if (kept.length < spec.limit && label(row) !== "Other") {
          kept.push(row);
        } else {
          other = addValues(other, row.values[0] ?? 0);
          summed++;
        }
      }
      rows = [...kept, { labels: ["Other"], values: [other] }];
      notes.push(
        `kept the first ${plural(spec.limit, "row")} and summed up the other ${formatCount(summed)} as "Other"`,
      );
    } else {
      notes.push(`kept the first ${formatCount(spec.limit)} of ${plural(beforeLimit, "row")}`);
      rows.length = Math.min(rows.length, spec.limit);
    }
  }

  // Sizes and durations are shown in the multiple of their unit that suits the largest, and counts
  // of rows as they are.
  const { names, sizes } =
    spec.aggregate === "count"
      ? { names: ["rows"], sizes: [1] }
      : showInMultiples(table, valueIndices, rows, notes, shared);
  const max = spec.max;
  const maxima = max === undefined ? [] : sizes.map((size) => scale(max, 1 / size));
  return { rows, names, maxima };
}
