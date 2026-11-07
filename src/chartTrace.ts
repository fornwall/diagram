// Source rows behind generated chart data, collected only when an agent requests them.

import type { Row } from "./chartRows";
import type { Cell, DataTable } from "./data";
import { asArray, type DiagramNode } from "./protocol";

/** What gives a series items, which a series that "options" add has none of. */
const ADDED_DATA_KEYS = ["data", "links", "edges", "nodes", "datasetIndex", "datasetId", "encode"];

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

  /** How many series the chart generated, which "options" may add to after them. */
  generatedSeries = 0;

  /**
   * Whether every generated series draws its generated data, rather than data that "options" give
   * it or leave out: ECharts reads a graph's "edges" before its "links", and its "nodes" without
   * "data". A series that "options" add, as for a mark line, may draw no data of its own.
   */
  generated(option: Record<string, unknown>): boolean {
    const traced = (data: unknown) => Array.isArray(data) && this.items.has(data);
    const series = asArray(option.series);
    return (
      series.length >= this.generatedSeries &&
      series.every((each, index) =>
        index < this.generatedSeries
          ? traced(each.data) &&
            (each.links === undefined || traced(each.links)) &&
            each.edges === undefined &&
            each.nodes === undefined
          : ADDED_DATA_KEYS.every((key) => each[key] === undefined),
      )
    );
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
