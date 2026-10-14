// Charts without axes that draw each row as an item: pie, doughnut, funnel, radar and gauge.

import { label, noteRepeatedLabels, type Reading, Sum } from "./chartRows";
import { formatCount, quoteAll } from "./text";

export function pieOption(doughnut: boolean, reading: Reading): Record<string, unknown> {
  const { names, rows } = reading;
  noteRepeatedLabels(reading, "slice", "slices");
  return {
    // The series name says what the values are, e.g. "size (MiB)".
    tooltip: { formatter: "{a}<br/>{b}: {c} ({d}%)" },
    legend: {},
    series: [
      {
        type: "pie",
        name: names[0] ?? "",
        // Of a size that leaves room for the labels beside it also in a narrow panel, where the
        // panel makes a pie of no radius smaller for them, but leaves a radius of the option's own.
        ...(doughnut ? { radius: ["35%", "55%"] } : {}),
        label: { formatter: "{b}: {d}%" },
        // Labels of slices under 1% would overlap; the legend and tooltip still name them.
        minShowLabelAngle: 3.6,
        data: rows.map((row) => ({ name: label(row), value: row.values[0] })),
      },
    ],
  };
}

/** A funnel of stages, which ECharts orders by value itself, so that any table reads the same. */
export function funnelOption(reading: Reading): Record<string, unknown> {
  const { spec, names, rows, notes } = reading;
  noteRepeatedLabels(reading, "stage", "stages");
  if (spec.sort === undefined) {
    notes.push("ordered the stages by value, the largest first");
  }
  return {
    series: [
      {
        type: "funnel",
        name: names[0] ?? "",
        sort: spec.sort ?? "descending",
        label: { formatter: "{b}: {c}" },
        data: rows.map((row) => ({ name: label(row), value: row.values[0] })),
      },
    ],
  };
}

/**
 * A radar chart with one axis per value column and one shape per row. Explicit maxima take
 * precedence over each column's range.
 */
export function radarOption(reading: Reading): Record<string, unknown> {
  const { maxima, names, rows, notes } = reading;
  noteRepeatedLabels(reading, "shape", "shapes");
  const beyond: string[] = [];
  const indicator = names.map((name, column) => {
    let low = 0;
    let high = 0;
    for (const { values } of rows) {
      const value = values[column];
      if (value !== null && value !== undefined) {
        low = Math.min(low, value);
        high = Math.max(high, value);
      }
    }
    const max = maxima[column];
    if (max !== undefined && high > max) beyond.push(name);
    return {
      name,
      max: max ?? (high > low ? high : high + 1),
      // ECharts draws an axis from zero unless told otherwise, hiding negative values.
      ...(low < 0 ? { min: low } : {}),
    };
  });
  if (beyond.length > 0) {
    notes.push(`values of ${quoteAll(beyond)} are beyond "max", the edge of the radar; raise it`);
  }
  return {
    // A radar's legend names its shapes, which are data items rather than series.
    ...(rows.length > 1 ? { legend: { data: rows.map(label) } } : {}),
    radar: { indicator },
    series: [
      {
        type: "radar",
        data: rows.map((row) => ({ name: label(row), value: row.values })),
      },
    ],
  };
}

/** The next 1, 2 or 5 of a power of ten above a value, as the top of a gauge's scale. */
function niceMax(value: number): number {
  if (!(value > 0)) {
    return 1;
  }
  const power = 10 ** Math.floor(Math.log10(value));
  return Math.min(
    [1, 2, 5].map((step) => step * power).find((top) => top > value) ?? 10 * power,
    Number.MAX_VALUE,
  );
}

/**
 * A gauge showing one number: the first row's value, on a scale to `max` when given, to 100 for
 * percentages, to the total of the column when the other rows make up the rest of it, and
 * otherwise rounded up from the value itself.
 */
export function gaugeOption({
  spec,
  table,
  columns,
  names,
  maxima,
  rows,
  notes,
}: Reading): Record<string, unknown> {
  const name = names[0] ?? "";
  const max = maxima[0];
  const valueColumn = columns.values[0];
  const unit = valueColumn === undefined ? undefined : table.columns[valueColumn]?.unit;
  const percent = unit === "%";
  const shown = rows.find(({ values }) => typeof values[0] === "number");
  const value = shown?.values[0];
  if (shown === undefined || typeof value !== "number") {
    throw new Error(
      `No numeric value remains in ${JSON.stringify(name)} for the gauge. ` +
        `${spec.limit === undefined ? "Select" : 'Remove "limit" or select'} rows with a numeric value.`,
    );
  }
  if (rows.length > 1) {
    notes.push(
      `showed the first numeric value of ${formatCount(rows.length)} rows, ${JSON.stringify(label(shown))}`,
    );
  }
  const total =
    max === undefined && !percent
      ? rows.reduce((sum, { values }) => sum.add(values[0] ?? 0), new Sum()).value
      : value;
  const [top, reason] =
    max !== undefined
      ? // Of sizes and durations, "max" is in bytes or seconds, not the multiple shown.
        [max, unit === "bytes" || unit === "seconds" ? `from "max" in ${unit}` : "as given"]
      : percent
        ? [100, "as the values are percentages"]
        : total > value
          ? [total, `the total of ${JSON.stringify(name)}`]
          : value < 0
            ? [0, "rounded down from the value"]
            : [niceMax(value), "rounded up from the value"];
  // A negative value lies on a scale from a round number below it, rather than at its very start.
  const min = value < 0 ? -niceMax(-value) : 0;
  // A scale needs room: a gauge from 0 to 0 draws nothing.
  const scale = top > min ? top : min + 1;
  notes.push(`scaled it ${min < 0 ? `from ${min} ` : ""}to ${scale}, ${reason}`);
  if (value > scale) {
    // ECharts stops the pointer at the top, which would read as the value.
    notes.push(`the value is beyond the top of the scale, where the pointer stops; raise "max"`);
  }
  return {
    series: [
      {
        type: "gauge",
        name,
        ...(min < 0 ? { min } : {}),
        max: scale,
        ...(percent ? { detail: { formatter: "{value}%" } } : {}),
        data: [{ name: columns.labels.length > 0 ? label(shown) : name, value }],
      },
    ],
  };
}
