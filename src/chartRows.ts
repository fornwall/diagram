// The rows a chart draws: labeled, without totals or parent rows, grouped, sorted and limited.

import {
  type Columns,
  chained,
  columnName,
  isCartesian,
  isTotalsLabel,
  readsLevels,
} from "./chartColumns";
import { labelOrder } from "./chartDates";
import { quantile, Sum, withoutNoise } from "./chartNumbers";
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
 * Items in the order of their labels where those have one, as numbers, dates written alike and
 * weekdays do, and otherwise in their own order.
 */
export function inLabelOrder<T>(items: readonly T[], labelOf: (item: T) => string): T[] {
  const labels = items.map(labelOf);
  const order = labelOrder(labels);
  if (order === undefined) return [...items];
  const keys = labels.map(order);
  return [...items.keys()]
    .sort((a, b) => (keys[a] ?? 0) - (keys[b] ?? 0))
    .map((index) => items[index] as T);
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
      `${formatCount(repeats)} ${repeats === 1 ? `${item} repeats` : `${items} repeat`} the label of an ` +
        'earlier one; "aggregate" combines the rows of each label',
    );
  }
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
      const sum = new Sum();
      try {
        for (let i = 0; i < table.rows.length - 1; i++) {
          const value = table.rows[i]?.[column];
          if (typeof value === "number") sum.add(value);
        }
      } catch {
        // An overflowing sum cannot establish that this finite value is a total.
        return false;
      }
      if (Math.abs(total - sum.value) > Math.abs(total) * 0.01) {
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
): Row[] {
  const direction = sort === "ascending" ? 1 : -1;
  return rows
    .map((row) => ({ row, key: key(row) }))
    .sort(({ key: x }, { key: y }) =>
      x === null || y === null ? (x === null ? 1 : 0) - (y === null ? 1 : 0) : (x - y) * direction,
    )
    .map(({ row }) => row);
}

/** The sum of a row's values, or null without any. */
function rowTotal({ values }: Row): number | null {
  let total: Sum | undefined;
  for (const value of values) {
    if (value !== null) total = (total ?? new Sum()).add(value);
  }
  return total?.value ?? null;
}

/** Keys rows by the total of the first values of the rows with their first label. */
function labelTotals(rows: Row[]): (row: Row) => number | null {
  const totals = new Map<string, Sum>();
  for (const row of rows) {
    const value = row.values[0] ?? null;
    if (value === null) continue;
    totals.set(label(row), (totals.get(label(row)) ?? new Sum()).add(value));
  }
  const finished = new Map([...totals].map(([key, total]) => [key, total.value]));
  return (row) => finished.get(label(row)) ?? null;
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

/** How the numbers of a column of a group combine into one; "count" counts the group's rows. */
const COMBINE: Record<Exclude<Aggregation, "count">, (values: number[]) => number> = {
  sum: (values) => values.reduce((sum, value) => sum.add(value), new Sum()).value,
  mean: (values) => {
    const { length } = values;
    try {
      return withoutNoise(COMBINE.sum(values) / length);
    } catch {
      // The mean can be finite even when its sum overflows. Scale only then, to preserve
      // tiny values when large observations cancel, and use a power of two to avoid noise.
    }
    const divisor = 2 ** Math.ceil(Math.log2(length));
    const sum = values.reduce((sum, value) => sum.add(value / divisor), new Sum()).value;
    return withoutNoise(sum / (length / divisor));
  },
  min: (values) => values.reduce((min, value) => Math.min(min, value)),
  max: (values) => values.reduce((max, value) => Math.max(max, value)),
  median: (values) => {
    values.sort((x, y) => x - y);
    return withoutNoise(quantile(values, 0.5));
  },
};

/** Aggregate rows by their labels, preserving the order of each group's first appearance. */
function groupRows(rows: Row[], how: Aggregation): Row[] {
  const groups = new Map<string, { labels: string[]; rows: number; columns: number[][] }>();
  for (const { labels, values } of rows) {
    const key = JSON.stringify(labels);
    let group = groups.get(key);
    if (group === undefined) {
      group = { labels, rows: 0, columns: values.map(() => []) };
      groups.set(key, group);
    }
    group.rows++;
    values.forEach((value, index) => {
      if (value !== null) group.columns[index]?.push(value);
    });
  }
  return [...groups.values()].map(({ labels, rows, columns }) => ({
    labels,
    values:
      how === "count"
        ? [rows]
        : columns.map((values) => (values.length === 0 ? null : COMBINE[how](values))),
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
 * together, by the `shared` multiples of their units when facets must agree on them. A facet
 * without a row to draw says why in `empty` rather than failing, as other facets may have rows.
 */
export function readRows(
  spec: ChartSpec,
  table: DataTable,
  columns: Columns,
  notes: string[],
  shared?: Multiples,
): Pick<Reading, "rows" | "names" | "maxima"> & { empty?: string } {
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
  let empty: string | undefined;
  const positive =
    ["pie", "doughnut", "funnel", "treemap", "sunburst"].includes(type) ||
    (type === "sankey" && chained(columns));
  if (positive || type === "scatter") {
    const charted = rows.filter(({ values }) =>
      positive ? (values[0] ?? 0) > 0 : !values.includes(null),
    );
    const left = rows.length - charted.length;
    if (charted.length === 0) {
      const quoted = quoteAll(valueIndices.map(name));
      const values = rows.map(({ values }) => values[0]);
      empty = positive
        ? `A ${type} chart needs positive numbers, as it sizes each item by its value, but ` +
          `${quoted} has none` +
          (values.some((value) => (value ?? 0) < 0)
            ? ". Chart negative values as a bar chart instead."
            : values.includes(0)
              ? ', only zeros. Choose a column with positive numbers in "valueColumns".'
              : ".")
        : `A scatter chart needs rows with numbers in both ${quoted}, but none has. Choose ` +
          '"valueColumns" that are filled in the same rows.';
      if (shared === undefined) throw new Error(empty);
    }
    if (left > 0) {
      const without = positive ? "a positive value" : "both an x and a y value";
      notes.push(`left out ${plural(left, "row")} without ${without}`);
    }
    rows = charted;
  } else if (
    shared !== undefined &&
    rows.every(({ values }) => values.every((value) => value === null))
  ) {
    // A facet without a number to draw is an empty panel, as one without a point of a scatter is.
    empty = `No row has a number in ${quoteAll(valueIndices.map(name))} to chart.`;
    notes.push("no row has a number to draw");
  }
  const beforeLimit = rows.length;
  const combineOther = type === "pie" || type === "doughnut";
  // Box plots sort their completed boxes by median, preserving input order for ties.
  if (spec.sort !== undefined && type !== "boxplot") {
    // A stack shows the total of its row, and a series per label of a second label column draws
    // the rows of a first label together, so sort by the total of those rows.
    const key =
      isCartesian(type) && columns.labels.length >= 2
        ? labelTotals(rows)
        : type === "stackedBar" || type === "stackedArea"
          ? rowTotal
          : (row: Row) => row.values[0] ?? null;
    rows = sortRows(rows, spec.sort, key);
  }
  if (spec.limit !== undefined && beforeLimit > spec.limit) {
    if (combineOther) {
      // A row named "Other" in the data is summed up too, rather than becoming a second slice.
      const kept: Row[] = [];
      const other = new Sum();
      let summed = 0;
      for (const row of rows) {
        if (kept.length < spec.limit && label(row) !== "Other") {
          kept.push(row);
        } else {
          other.add(row.values[0] ?? 0);
          summed++;
        }
      }
      rows = [...kept, { labels: ["Other"], values: [other.value] }];
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
  return { rows, names, maxima, ...(empty === undefined ? {} : { empty }) };
}
