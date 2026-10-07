// Charts drawn on a grid of an x and a y axis: bar, line, area, scatter, heatmap and box plot.

import { columnName } from "./chartColumns";
import { timeOrder, timeValue } from "./chartDates";
import {
  addValues,
  label,
  noteRepeatedLabels,
  quantile,
  type Reading,
  type Row,
} from "./chartRows";
import type { CartesianType } from "./chartSpec";
import { plural, quoteAll } from "./text";

const CARTESIAN_SERIES: Record<CartesianType, Record<string, unknown>> = {
  bar: { type: "bar" },
  horizontalBar: { type: "bar" },
  stackedBar: { type: "bar", stack: "total" },
  line: { type: "line" },
  area: { type: "line", areaStyle: {} },
  stackedArea: { type: "line", areaStyle: {}, stack: "total" },
};

/** Lines with more points than this are drawn without symbols, and thinned out where dense. */
const FEW_POINTS = 30;

/**
 * Series with this many bars or points are drawn as one shape each, ECharts' default
 * `largeThreshold`. The SVG renderer would otherwise create an element per bar or point.
 */
const LARGE_BARS = 400;
const LARGE_POINTS = 2000;

/** More series than this cannot be told apart by their colors, nor found in their legend. */
const MOST_SERIES = 50;

/** A series of a Cartesian chart: a value, or none, for each point along the label axis. */
interface Series {
  name: string;
  values: (number | null)[];
}

/**
 * The points along the label axis, and a series per label of the second label column: the long
 * format that a database query or a log gives, with a row per point of each series.
 */
function pivotSeries({ table, columns, rows, notes }: Reading): {
  points: string[];
  series: Series[];
} {
  const points = new Map<string, number>();
  const names = new Set<string>();
  for (const row of rows) {
    if (!points.has(label(row))) points.set(label(row), points.size);
    names.add(row.labels[1] ?? "");
  }
  if (names.size > MOST_SERIES) {
    throw new Error(
      `A series per label of ${JSON.stringify(columnName(table, columns.labels[1]))} would ` +
        `be ${names.size} series, more than the ${MOST_SERIES} that can be told apart. Select ` +
        'fewer with "filters", or give "labelColumn" as a single column.',
    );
  }
  const series = new Map(
    [...names].map((name) => [
      name,
      { name, values: Array<number | null>(points.size).fill(null) },
    ]),
  );
  let added = 0;
  for (const row of rows) {
    const value = row.values[0] ?? null;
    const values = series.get(row.labels[1] ?? "")?.values;
    const point = points.get(label(row));
    if (value === null || values === undefined || point === undefined) continue;
    const previous = values[point] ?? null;
    if (previous === null) {
      values[point] = value;
    } else {
      values[point] = addValues(previous, value);
      added++;
    }
  }
  noteAdded(notes, added, "point");
  return { points: [...points.keys()], series: [...series.values()] };
}

/** Notes how many rows were added to an earlier row's point or cell, as rows of the same labels. */
function noteAdded(notes: string[], added: number, item: string): void {
  if (added > 0) {
    notes.push(
      `added ${plural(added, "row")} to the ${item} of an earlier row with the same labels; ` +
        '"aggregate" combines them another way',
    );
  }
}

/**
 * The rows in the order of the dates of their first labels, and those dates as ECharts reads
 * them. ECharts draws a line through its points, samples them and stacks them in the order of its
 * data, which would otherwise run back and forth in time.
 */
function inTimeOrder(rows: Row[]): { rows: Row[]; times: (string | number)[] } {
  const times = rows.map((row) => timeValue(label(row)));
  const keys = times.map(timeOrder);
  const order = [...rows.keys()].sort((a, b) => (keys[a] ?? 0) - (keys[b] ?? 0));
  return {
    rows: order.map((index) => rows[index] as Row),
    times: order.map((index) => times[index] ?? ""),
  };
}

/**
 * A bar or line chart, whose tooltip and legend the webview adds. Labels read as dates become a
 * time axis, which needs each point as a [time, value] pair rather than a bare value.
 */
export function cartesianOption(type: CartesianType, read: Reading): Record<string, unknown> {
  const sorted = read.columns.timeAxis ? inTimeOrder(read.rows) : undefined;
  const reading = sorted ? { ...read, rows: sorted.rows } : read;
  const { table, columns, names, rows } = reading;
  const pivot = columns.labels.length >= 2;
  let points: string[];
  let series: Series[];
  if (pivot) {
    ({ points, series } = pivotSeries(reading));
  } else {
    if (!columns.timeAxis) {
      noteRepeatedLabels(reading, "category", "categories");
    }
    points = rows.map(label);
    series = names.map((name, column) => ({
      name,
      values: rows.map(({ values }) => values[column] ?? null),
    }));
  }
  const line = type === "line" || type === "area" || type === "stackedArea";
  const horizontal = type === "horizontalBar";
  // Every series uses the same time coordinate; parse offsets and fractions once per point.
  const times = sorted && (pivot ? points.map(timeValue) : sorted.times);
  // On a time axis, a series per label has points at its own times, and a line through them
  // rather than a gap where another series has a point. A stack needs a point at every time.
  const ownTimes = times !== undefined && pivot && CARTESIAN_SERIES[type].stack === undefined;
  const categoryAxis = {
    type: times === undefined ? "category" : "time",
    ...(times === undefined ? { data: points, ...(line ? { boundaryGap: false } : {}) } : {}),
    // Put the first row at the top of a horizontal chart.
    ...(horizontal ? { inverse: true } : {}),
    // Keep labels at the edge when an axis through zero would cover negative values.
    ...(series.some(({ values }) => values.some((value) => value !== null && value < 0))
      ? { axisLine: { onZero: false } }
      : {}),
  };
  const valueAxis = {
    type: "value",
    // With several series, the legend names them; generated names ("Column 2") name nothing.
    ...(table.header && names.length === 1 ? { name: names[0] } : {}),
    // A line shows change, which would flatten out on an axis from zero to far above it; bars
    // and areas show amounts by their length, which needs zero.
    ...(type === "line" ? { scale: true } : {}),
  };
  return {
    xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? categoryAxis : valueAxis,
    series: series.map(({ name, values }) => ({
      ...CARTESIAN_SERIES[type],
      name,
      ...(line && points.length > FEW_POINTS ? { showSymbol: false } : {}),
      // ECharts samples where points outnumber pixels. Sampling each series of a stack on its own
      // would misalign them, and it does not stack large bars.
      ...(line && points.length > FEW_POINTS && type !== "stackedArea" ? { sampling: "lttb" } : {}),
      ...(points.length >= LARGE_BARS && (type === "bar" || type === "horizontalBar")
        ? { large: true }
        : {}),
      ...(series.length > 1 ? { emphasis: { focus: "series" } } : {}),
      data: values.flatMap((value, index) => {
        if (times === undefined) return [value];
        if (value === null && ownTimes) return [];
        const time = times[index];
        return [horizontal ? [value, time] : [time, value]];
      }),
    })),
  };
}

/**
 * A scatter chart of one value column against another, or, when the labels are dates, of one
 * value column against the times they happened at.
 */
export function scatterOption({ table, columns, names, rows }: Reading): Record<string, unknown> {
  // Generated column names ("Column 2") would make poor axis names.
  const axis = (name: string) => ({
    type: "value",
    ...(table.header ? { name } : {}),
    scale: true,
  });
  const [xName = "", yName = ""] = names;
  if (columns.times !== undefined) {
    const { timeAxis } = columns;
    return {
      xAxis: timeAxis ? { type: "time" } : { type: "category", data: rows.map(label) },
      yAxis: axis(xName),
      series: [
        {
          type: "scatter",
          name: xName,
          ...(rows.length >= LARGE_POINTS ? { large: true } : {}),
          // On a category axis, a point is at its row's category, as a bar is, rather than at the
          // last of the categories named alike.
          data: rows.map((row) => {
            const value = row.values[0] ?? null;
            return timeAxis ? [timeValue(label(row)), value] : value;
          }),
        },
      ],
    };
  }
  const labeled = columns.labels.length > 0;
  return {
    tooltip: { formatter: labeled ? "{b}: ({c})" : "({c})" },
    xAxis: axis(xName),
    yAxis: axis(yName),
    series: [
      {
        type: "scatter",
        name: yName,
        ...(rows.length >= LARGE_POINTS ? { large: true } : {}),
        data: rows.map((row) => (labeled ? { name: label(row), value: row.values } : row.values)),
      },
    ],
  };
}

/** Pivot two label columns, or use one heatmap column per value column. Preserve input order. */
export function heatmapOption({
  table,
  columns,
  names,
  rows,
  notes,
}: Reading): Record<string, unknown> {
  const labelNames = columns.labels.map((index) => columnName(table, index));
  const pivot = labelNames.length >= 2;
  /** The index of each category of a pivot's axis, in the order they first appear. */
  const yIndices = new Map<string, number>();
  const xIndices = new Map<string, number>();
  const category = (indices: Map<string, number>, name: string): number => {
    let index = indices.get(name);
    if (index === undefined) {
      index = indices.size;
      indices.set(name, index);
    }
    return index;
  };
  const cells = new Map<string, [number, number, number]>();
  const data: [number, number, number][] = [];
  let empty = 0;
  let summed = 0;
  for (const [index, row] of rows.entries()) {
    if (pivot) {
      const value = row.values[0];
      if (value === null || value === undefined) {
        empty++;
        continue;
      }
      const y = category(yIndices, label(row));
      const x = category(xIndices, row.labels[1] ?? "");
      const key = `${y} ${x}`;
      const cell = cells.get(key);
      if (cell === undefined) {
        const cell: [number, number, number] = [x, y, value];
        cells.set(key, cell);
        data.push(cell);
      } else {
        cell[2] = addValues(cell[2], value);
        summed++;
      }
      continue;
    }
    row.values.forEach((value, x) => {
      if (value === null) {
        empty++;
      } else {
        data.push([x, index, value]);
      }
    });
  }
  if (data.length === 0) {
    throw new Error(`A heatmap needs numbers, but ${quoteAll(names)} holds none.`);
  }
  noteAdded(notes, summed, "cell");
  if (empty > 0) {
    notes.push(`left out ${plural(empty, "cell")} without a value`);
  }
  let min = data[0]?.[2] ?? 0;
  let max = min;
  for (const [, , value] of data) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  // Without a second label column every row is a row of its own, even one labeled like another.
  const yCategories = pivot ? [...yIndices.keys()] : rows.map(label);
  const xCategories = pivot ? [...xIndices.keys()] : names;
  const axis = (categories: string[], name: string | undefined) => ({
    type: "category",
    data: categories,
    ...(table.header && name !== undefined ? { name } : {}),
    // The cells read as a grid, in the bands that the theme draws behind them.
    splitArea: { show: true },
  });
  return {
    xAxis: axis(xCategories, pivot ? labelNames[1] : undefined),
    // The first row at the top, as in a table.
    yAxis: { ...axis(yCategories, labelNames[0]), inverse: true },
    visualMap: { min, max, calculable: true },
    series: [{ type: "heatmap", ...(pivot ? { name: names[0] ?? "" } : {}), data }],
  };
}

/** Compute box statistics per label group, or per value column when rows are unlabeled. */
export function boxplotOption({
  table,
  columns,
  names,
  rows,
  notes,
}: Reading): Record<string, unknown> {
  const labeled = columns.labels.length > 0;
  const numbers = (rows: Row[], column: number) =>
    rows.flatMap(({ values }) => {
      const value = values[column];
      return typeof value === "number" ? [value] : [];
    });
  const grouped: Map<string, number[]> = labeled
    ? new Map([...Map.groupBy(rows, label)].map(([group, members]) => [group, numbers(members, 0)]))
    : new Map(names.map((name, column) => [name, numbers(rows, column)]));
  const categories: string[] = [];
  const boxes: number[][] = [];
  const outliers: [string, number][] = [];
  let counted = 0;
  for (const [group, numbers] of grouped) {
    if (numbers.length === 0) {
      continue;
    }
    const sorted = numbers.sort((x, y) => x - y);
    counted += sorted.length;
    categories.push(group);
    const q1 = quantile(sorted, 0.25);
    const q3 = quantile(sorted, 0.75);
    // Tukey's fences, 1.5 interquartile ranges beyond the box, as most plotting tools draw them.
    // A range that overflows leaves every value inside them.
    const reach = 1.5 * (q3 - q1);
    let first = 0;
    while ((sorted[first] ?? q1) < q1 - reach) first++;
    let last = sorted.length - 1;
    while ((sorted[last] ?? q3) > q3 + reach) last--;
    for (const value of sorted.slice(0, first).concat(sorted.slice(last + 1))) {
      outliers.push([group, value]);
    }
    // With few values the furthest one inside a fence can lie within the interpolated box.
    boxes.push([
      Math.min(sorted[first] ?? q1, q1),
      q1,
      quantile(sorted, 0.5),
      q3,
      Math.max(sorted[last] ?? q3, q3),
    ]);
  }
  if (boxes.length === 0) {
    throw new Error(`A box plot needs numbers to summarize, but ${quoteAll(names)} holds none.`);
  }
  notes.push(
    `computed the quartiles of ${plural(boxes.length, "box", "boxes")} from ` +
      `${plural(counted, "value")}, with whiskers to the furthest values within 1.5 ` +
      "interquartile ranges of the box" +
      (outliers.length > 0 ? ` and ${plural(outliers.length, "outlier")} beyond them` : ""),
  );
  return {
    xAxis: { type: "category", data: categories },
    // A spread reads against itself rather than against zero.
    yAxis: { type: "value", ...(table.header && labeled ? { name: names[0] } : {}), scale: true },
    series: [
      { type: "boxplot", ...(labeled ? { name: names[0] } : {}), data: boxes },
      // The x of an outlier names its box's category, which the tooltip shows.
      ...(outliers.length > 0
        ? [
            {
              type: "scatter",
              name: "outliers",
              ...(outliers.length >= LARGE_POINTS ? { large: true } : {}),
              data: outliers,
            },
          ]
        : []),
    ],
  };
}
