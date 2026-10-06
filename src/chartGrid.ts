// Charts drawn on a grid of an x and a y axis: bar, line, area, scatter, heatmap and box plot.

import { columnName } from "./chartColumns";
import { timeValue } from "./chartDates";
import { addValues, label, noteRepeatedLabels, quantile, type Reading } from "./chartRows";
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

/**
 * A bar or line chart, whose tooltip and legend the webview adds. Labels read as dates become a
 * time axis, which needs each point as a [time, value] pair rather than a bare value.
 */
export function cartesianOption(type: CartesianType, reading: Reading): Record<string, unknown> {
  const { table, columns, names, rows } = reading;
  if (!columns.timeAxis) {
    noteRepeatedLabels(reading, "category", "categories");
  }
  const line = type === "line" || type === "area" || type === "stackedArea";
  const horizontal = type === "horizontalBar";
  // Every value series uses the same time coordinate; parse offsets and fractions once per row.
  const times = columns.timeAxis ? rows.map((row) => timeValue(label(row))) : undefined;
  const categoryAxis = {
    type: times === undefined ? "category" : "time",
    ...(times === undefined
      ? { data: rows.map(label), ...(line ? { boundaryGap: false } : {}) }
      : {}),
    // Put the first row at the top of a horizontal chart.
    ...(horizontal ? { inverse: true } : {}),
    // Keep labels at the edge when an axis through zero would cover negative values.
    ...(rows.some(({ values }) => values.some((value) => value !== null && value < 0))
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
    series: names.map((name, column) => ({
      ...CARTESIAN_SERIES[type],
      name,
      ...(line && rows.length > FEW_POINTS ? { showSymbol: false } : {}),
      // ECharts samples where points outnumber pixels. Sampling each series of a stack on its own
      // would misalign them, and it does not stack large bars.
      ...(line && rows.length > FEW_POINTS && type !== "stackedArea" ? { sampling: "lttb" } : {}),
      ...(rows.length >= LARGE_BARS && (type === "bar" || type === "horizontalBar")
        ? { large: true }
        : {}),
      ...(names.length > 1 ? { emphasis: { focus: "series" } } : {}),
      data: rows.map((row, index) => {
        const value = row.values[column] ?? null;
        if (times === undefined) return value;
        const time = times[index];
        return horizontal ? [value, time] : [time, value];
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
          data: rows.map((row) => [
            timeAxis ? timeValue(label(row)) : label(row),
            row.values[0] ?? null,
          ]),
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
  if (summed > 0) {
    notes.push(
      `added ${plural(summed, "row")} to the cell of an earlier row with the same labels; ` +
        '"aggregate" combines them another way',
    );
  }
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
  const grouped = new Map<string, number[]>();
  if (!labeled) {
    names.forEach((name, column) => {
      grouped.set(
        name,
        rows.flatMap(({ values }) => {
          const value = values[column];
          return typeof value === "number" ? [value] : [];
        }),
      );
    });
  } else {
    for (const row of rows) {
      const value = row.values[0];
      if (typeof value === "number") {
        const numbers = grouped.get(label(row));
        if (numbers === undefined) {
          grouped.set(label(row), [value]);
        } else {
          numbers.push(value);
        }
      }
    }
  }
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
      ...(outliers.length > 0 ? [{ type: "scatter", name: "outliers", data: outliers }] : []),
    ],
  };
}
