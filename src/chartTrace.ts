// Source rows behind generated chart data, collected only when an agent requests them.

import type { Row } from "./chartRows";
import type { Cell, DataTable } from "./data";
import { asArray, type DiagramNode } from "./protocol";

export class ChartTrace {
  private readonly numbers = new WeakMap<Cell[], number>();
  private readonly items = new WeakMap<unknown[], number[][]>();

  constructor(readonly table: DataTable) {
    table.rows.forEach((row, index) => {
      this.numbers.set(row, index + 1);
    });
  }

  row(row: Cell[]): number[] {
    const number = this.numbers.get(row);
    if (number === undefined)
      throw new Error("The chart lost a source row while transforming data.");
    return [number];
  }

  project(from: Cell[], to: Cell[]): Cell[] {
    const number = this.numbers.get(from);
    if (number !== undefined) this.numbers.set(to, number);
    return to;
  }

  sources(rows: readonly Row[], column?: string | readonly string[]): number[] {
    const indices =
      column === undefined
        ? undefined
        : (typeof column === "string" ? [column] : column).map((value) =>
            this.table.columns.findIndex(({ name }) => name === value),
          );
    const found = new Set<number>();
    for (const row of rows) {
      for (const number of row.sourceRows ?? []) {
        if (
          indices === undefined ||
          indices.some((index) => typeof this.table.rows[number - 1]?.[index] === "number")
        )
          found.add(number);
      }
    }
    return [...found].sort((a, b) => a - b);
  }

  record<T extends unknown[]>(data: T, sources: number[][]): T {
    this.items.set(data, sources);
    return data;
  }

  remap(from: unknown[], to: unknown[], indices: (number | undefined)[]): void {
    const sources = this.items.get(from);
    if (sources)
      this.items.set(
        to,
        indices.map((index) => (index === undefined ? [] : (sources[index] ?? []))),
      );
  }

  item(
    option: Record<string, unknown>,
    ref: NonNullable<DiagramNode["chart"]>,
  ): number[] | undefined {
    const series = asArray(option.series)[ref.seriesIndex];
    const data = ref.dataType === "edge" ? series?.links : series?.data;
    return Array.isArray(data) ? this.items.get(data)?.[ref.dataIndex] : undefined;
  }
}
