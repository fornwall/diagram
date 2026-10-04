// Charts drawn on a grid of an x and a y axis: bar, line, area, scatter, heatmap and box plot.

import { columnName } from "./chartColumns";
import { timeValue } from "./chartDates";
import { addValues, label, plural, quantile, type Reading } from "./chartRows";
import { type CartesianType, quoteAll } from "./chartSpec";

const CARTESIAN_SERIES: Record<CartesianType, Record<string, unknown>> = {
  bar: { type: "bar" },
  horizontalBar: { type: "bar" },
  stackedBar: { type: "bar", stack: "total" },
  line: { type: "line" },
  area: { type: "line", areaStyle: {} },
  stackedArea: { type: "line", areaStyle: {}, stack: "total" },
};

/** Lines with more points than this are drawn without symbols. */
const FEW_POINTS = 30;

/**
 * A bar or line chart, whose tooltip and legend the webview adds. Labels read as dates become a
 * time axis, which needs each point as a [time, value] pair rather than a bare value.
 */
export function cartesianOption(
  type: CartesianType,
  { table, columns, names, rows }: Reading,
): Record<string, unknown> {
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
  const yCategories: string[] = [];
  const xCategories: string[] = pivot ? [] : [...names];
  const yIndices = new Map<string, number>();
  const xIndices = new Map<string, number>();
  const category = (categories: string[], indices: Map<string, number>, name: string) => {
    const found = indices.get(name);
    if (found !== undefined) {
      return found;
    }
    indices.set(name, categories.length);
    categories.push(name);
    return categories.length - 1;
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
      const y = category(yCategories, yIndices, label(row));
      const x = category(xCategories, xIndices, row.labels[1] ?? "");
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
    // Without a second label column every row is a row of its own, even one labeled like another.
    yCategories.push(label(row));
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
    notes.push(`summed up ${plural(summed, "row")} into cells that had a value`);
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
  let counted = 0;
  for (const [group, numbers] of grouped) {
    if (numbers.length === 0) {
      continue;
    }
    const sorted = numbers.sort((x, y) => x - y);
    counted += sorted.length;
    categories.push(group);
    boxes.push([
      sorted[0] ?? 0,
      quantile(sorted, 0.25),
      quantile(sorted, 0.5),
      quantile(sorted, 0.75),
      sorted.at(-1) ?? 0,
    ]);
  }
  if (boxes.length === 0) {
    throw new Error(`A box plot needs numbers to summarize, but ${quoteAll(names)} holds none.`);
  }
  notes.push(
    `computed the min, lower quartile, median, upper quartile and max of ` +
      `${plural(boxes.length, "box", "boxes")} from ${plural(counted, "value")}`,
  );
  return {
    xAxis: { type: "category", data: categories },
    // A spread reads against itself rather than against zero.
    yAxis: { type: "value", ...(table.header && labeled ? { name: names[0] } : {}), scale: true },
    series: [{ type: "boxplot", ...(labeled ? { name: names[0] } : {}), data: boxes }],
  };
}
