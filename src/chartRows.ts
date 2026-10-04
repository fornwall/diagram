// The rows a chart draws: labeled, without totals or parent rows, grouped, sorted and limited.

import { type Columns, chained, columnName, readsLevels } from "./chartColumns";
import { type Aggregation, type ChartSpec, type ChartType, quoteAll } from "./chartSpec";
import type { Cell, DataTable } from "./data";

/** Bounds prefix construction and recursive hierarchy traversal in both the host and renderer. */
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
  /** The value columns' names, carrying the unit that sizes in bytes are shown in. */
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
  const seen = new Set<string>();
  let repeats = 0;
  for (const row of rows) {
    const name = label(row);
    if (seen.has(name)) repeats++;
    else seen.add(name);
  }
  if (repeats > 0) {
    notes.push(
      `${repeats} ${repeats === 1 ? `${item} repeats` : `${items} repeat`} the label of an ` +
        'earlier one; "aggregate" combines the rows of each label',
    );
  }
}

/** E.g. "1 row" or "3 rows". */
export function plural(count: number, noun: string, nouns = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : nouns}`;
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
  const right = sorted[below + 1] ?? left;
  const fraction = at - below;
  // Weighted interpolation avoids overflow when opposite signs make the difference infinite.
  const difference = right - left;
  return Number.isFinite(difference)
    ? left + difference * fraction
    : left * (1 - fraction) + right * fraction;
}

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];
/** A unit of bytes that a header states, as kubectl's "MEMORY(bytes)" or "Size (KB)". */
const STATED_BYTE_UNIT = /\s*\((?:[Bb]ytes|[kKMGTPE]?i?B|[KMGTPE]i)\)$/;

/** The power of 1024 to show sizes up to `max` bytes in. */
function bytePower(max: number): number {
  let power = 0;
  while (power < BYTE_UNITS.length - 1 && max >= 1024 ** (power + 1)) {
    power++;
  }
  return power;
}

/** The power of 1024 for the byte columns among `values`, over every row of a table. */
export function tableBytePower(table: DataTable, values: number[]): number {
  let largest = 0;
  for (const column of values) {
    if (table.columns[column]?.unit !== "bytes") continue;
    for (const row of table.rows) {
      const value = row[column];
      if (typeof value === "number") largest = Math.max(largest, Math.abs(value));
    }
  }
  return bytePower(largest);
}

/** Recognize a named totals row only when its values match the preceding sums within 1%. */
function hasTotalsRow(table: DataTable, labelColumn: number, valueColumns: number[]): boolean {
  const last = table.rows.at(-1);
  const label = last?.[labelColumn];
  if (
    last === undefined ||
    table.rows.length < 3 ||
    typeof label !== "string" ||
    !/^(?:total|totals|sum|grand total)\s*:?$/i.test(label)
  ) {
    return false;
  }
  let checked = 0;
  for (const column of valueColumns) {
    const total = last[column];
    if (typeof total === "number") {
      let sum = 0;
      for (let i = 0; i < table.rows.length - 1; i++) {
        const value = table.rows[i]?.[column];
        if (typeof value === "number") {
          sum += value;
        }
      }
      if (Math.abs(total - sum) > Math.abs(total) * 0.01) {
        return false;
      }
      checked++;
    }
  }
  return checked > 0;
}

/** Sorts rows by their first value, empty values last. */
function sortRows(rows: Row[], sort: ChartSpec["sort"], limit?: number): Row[] {
  if (sort === undefined) {
    return rows;
  }
  const direction = sort === "ascending" ? 1 : -1;
  const compare = ({ values: [x = null] }: Row, { values: [y = null] }: Row): number => {
    if (x === null || y === null) {
      return x === y ? 0 : x === null ? 1 : -1;
    }
    return (x - y) * direction;
  };
  // Small limits need only the best rows. Keep the worst retained row at the heap root,
  // including its original index so ties keep the same order as a stable full sort.
  if (limit !== undefined && limit > 0 && limit < rows.length / 4) {
    const heap: { row: Row; index: number }[] = [];
    const order = (left: (typeof heap)[number], right: (typeof heap)[number]): number =>
      compare(left.row, right.row) || left.index - right.index;
    rows.forEach((row, index) => {
      const candidate = { row, index };
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
    });
    return heap.sort(order).map(({ row }) => row);
  }
  // readRows owns these rows; sorting them cannot reorder the source table.
  return rows.sort(compare);
}

/** Drop parent rows to avoid counting both directory totals and their files in du -a output. */
function withoutNests(rows: Row[]): Row[] {
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
  // Store only parent paths, without copying and serializing every prefix or retaining leaves.
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
  samples?: number[];
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
 * Group before limiting so "the 10 largest" selects groups. Scale byte values and axis names
 * together, by `sharedBytePower` when facets must agree on the unit.
 */
export function readRows(
  spec: ChartSpec,
  table: DataTable,
  columns: Columns,
  notes: string[],
  sharedBytePower?: number,
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
      `grouped ${ungrouped} rows into ${rows.length} by ${by}, ${AGGREGATED[spec.aggregate]}`,
    );
  }

  if (columns.timeAxis) {
    // A row without a date has nowhere to sit on a time axis.
    const dated = rows.filter((row) => label(row) !== "");
    const left = rows.length - dated.length;
    if (left > 0) {
      notes.push(`left out ${plural(left, "row")} without a date`);
    }
    rows = dated;
  }

  // A share of a total has no size without a positive value, and a point needs both an x and a y.
  // A flow with one node per value column leaves out single flows instead of whole rows.
  const positive =
    type === "pie" ||
    type === "doughnut" ||
    type === "funnel" ||
    type === "treemap" ||
    type === "sunburst" ||
    (type === "sankey" && chained(columns));
  if (positive || type === "scatter") {
    const charted = rows.filter(({ values }) =>
      positive ? (values[0] ?? 0) > 0 : !values.includes(null),
    );
    const left = rows.length - charted.length;
    if (charted.length === 0) {
      const quoted = quoteAll(valueIndices.map(name));
      throw new Error(
        positive
          ? `A ${type} chart needs positive numbers, as it sizes each item by its value, but ` +
              `${quoted} has none. Chart negative values as a bar chart instead.`
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
  rows = sortRows(rows, spec.sort, combineOther ? undefined : spec.limit);
  if (spec.sort !== undefined && columns.timeAxis) {
    notes.push("sorted the rows by value rather than in time order, which a line runs back over");
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
      notes.push(`kept the first ${spec.limit} rows and summed up the other ${summed} as "Other"`);
    } else {
      notes.push(`kept the first ${spec.limit} of ${beforeLimit} rows`);
      rows.length = Math.min(rows.length, spec.limit);
    }
  }

  // Sizes in bytes are shown in the unit that suits the largest.
  const bytes = valueIndices.map((index) => table.columns[index]?.unit === "bytes");
  const byteIndices = bytes.flatMap((byte, index) => (byte ? [index] : []));
  let largest = 0;
  if (sharedBytePower === undefined) {
    for (const { values } of rows) {
      for (const index of byteIndices) {
        largest = Math.max(largest, Math.abs(values[index] ?? 0));
      }
    }
  }
  const power = sharedBytePower ?? bytePower(largest);
  const divisor = 1024 ** power;
  if (power > 0) {
    notes.push(`showed sizes in ${BYTE_UNITS[power]}`);
    // These value arrays were created above, so scale them without allocating another table.
    for (const { values } of rows) {
      for (const index of byteIndices) {
        const value = values[index];
        if (value !== null && value !== undefined) values[index] = value / divisor;
      }
    }
  }
  const unit = power > 0 ? ` (${BYTE_UNITS[power]})` : "";
  const names =
    spec.aggregate === "count"
      ? ["rows"]
      : valueIndices.map((index, i) =>
          bytes[i] && unit ? name(index).replace(STATED_BYTE_UNIT, "") + unit : name(index),
        );
  const max = spec.max;
  const maxima = max === undefined ? [] : names.map((_, i) => (bytes[i] ? max / divisor : max));
  return { rows, names, maxima };
}
