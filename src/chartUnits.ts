// The multiple of bytes or seconds that a chart shows sizes and durations in, as MiB or ms.

import { columnName } from "./chartColumns";
import type { DataTable } from "./data";
import { STATED_UNIT, scale, type Unit } from "./dataNumber";

/** The multiple of each unit that values are shown in, by its index in {@link SCALES}. */
export type Multiples = Partial<Record<Unit, number>>;

/**
 * The units whose values are shown in a multiple of them: what the values are, and the multiples
 * by name and size from the smallest.
 */
const SCALES = new Map<Unit, { what: string; multiples: [string, number][] }>([
  [
    "bytes",
    {
      what: "sizes",
      multiples: ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"].map((name, i) => [
        name,
        1024 ** i,
      ]),
    },
  ],
  [
    "seconds",
    {
      what: "durations",
      multiples: [
        ["ns", 1e-9],
        ["µs", 1e-6],
        ["ms", 1e-3],
        ["s", 1],
        ["min", 60],
        ["h", 3600],
        ["d", 86400],
      ],
    },
  ],
]);

/** The largest magnitude of the numbers at `indices` of the rows. */
function largest(rows: readonly (readonly unknown[])[], indices: number[]): number {
  let most = 0;
  for (const row of rows) {
    for (const i of indices) {
      const value = row[i];
      if (typeof value === "number") most = Math.max(most, Math.abs(value));
    }
  }
  return most;
}

/** The multiple to show values up to `max` in: the largest not above it, or the unit for none. */
function multipleFor(multiples: [string, number][], max: number): number {
  let i = multiples.findIndex(([, size]) => size === 1);
  while (i + 1 < multiples.length && max >= (multiples[i + 1]?.[1] ?? Infinity)) i++;
  while (i > 0 && max > 0 && max < (multiples[i]?.[1] ?? 0)) i--;
  return i;
}

/**
 * The multiple of `unit` at `index` of its scale: its name, its size and, unless it is the unit
 * itself, the note that values are shown in it.
 */
function multipleAt(unit: Unit, index: number): { multiple: string; size: number; note?: string } {
  const { what = "", multiples = [] } = SCALES.get(unit) ?? {};
  const [multiple = "", size = 1] = multiples[index] ?? [];
  return { multiple, size, ...(size === 1 ? {} : { note: `showed ${what} in ${multiple}` }) };
}

/** A name for values shown in a multiple, corrected where it states another ("Latency (ms)"). */
function nameIn(name: string, multiple: string, size: number): string {
  const unstated = name.replace(STATED_UNIT, "");
  return size !== 1 || unstated !== name ? `${unstated} (${multiple})` : name;
}

/**
 * How a column's values are shown alone, as a histogram bins them: in the multiple of their unit
 * that suits the largest, under a name that states it, or as they are.
 */
export function columnMultiple(
  table: DataTable,
  column: number,
): { name: string; size: number; note?: string } {
  const name = columnName(table, column);
  const unit = table.columns[column]?.unit;
  const index = unit === undefined ? undefined : tableMultiples(table, [column])[unit];
  if (unit === undefined || index === undefined) return { name, size: 1 };
  const { multiple, ...shown } = multipleAt(unit, index);
  return { name: nameIn(name, multiple, shown.size), ...shown };
}

/** The multiple of each unit for the columns of that unit among `values`, over a whole table. */
export function tableMultiples(table: DataTable, values: number[]): Multiples {
  const shared: Multiples = {};
  for (const [unit, { multiples }] of SCALES) {
    const columns = values.filter((column) => table.columns[column]?.unit === unit);
    shared[unit] = multipleFor(multiples, largest(table.rows, columns));
  }
  return shared;
}

/**
 * Shows the sizes and durations among the values of `columns` in the multiple of their unit that
 * suits the largest, or the `shared` one that facets must agree on, scaling the rows' values in
 * place. Returns the columns' names, which state the multiples, and the size of each multiple.
 */
export function showInMultiples(
  table: DataTable,
  columns: number[],
  rows: { values: (number | null)[] }[],
  notes: string[],
  shared?: Multiples,
): { names: string[]; sizes: number[] } {
  const names = columns.map((index) => columnName(table, index));
  const sizes = names.map(() => 1);
  for (const [unit, { multiples }] of SCALES) {
    const scaled = columns.flatMap((index, i) => (table.columns[index]?.unit === unit ? [i] : []));
    if (scaled.length === 0) continue;
    const index =
      shared?.[unit] ??
      multipleFor(
        multiples,
        largest(
          rows.map(({ values }) => values),
          scaled,
        ),
      );
    const { multiple, size, note } = multipleAt(unit, index);
    if (note !== undefined) {
      notes.push(note);
      for (const { values } of rows) {
        for (const i of scaled) {
          const value = values[i];
          if (value !== null && value !== undefined) values[i] = scale(value, 1 / size);
        }
      }
    }
    for (const i of scaled) {
      names[i] = nameIn(names[i] ?? "", multiple, size);
      sizes[i] = size;
    }
  }
  return { names, sizes };
}
