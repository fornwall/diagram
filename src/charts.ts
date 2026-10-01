// Turning a table and a chart request into an Apache ECharts option.

import { type ChartSpec, type ChartType, quoteAll } from "./chartSpec";
import { type Cell, type DataTable, isYear } from "./data";
import { isPlainObject } from "./protocol";

/** Finds a column by name, exactly or else ignoring case and surrounding spaces. */
function findColumn(table: DataTable, name: string, role: string): number {
  const names = table.columns.map((column) => column.name);
  let index = names.indexOf(name);
  if (index === -1) {
    const wanted = name.trim().toLowerCase();
    index = names.findIndex((column) => column.toLowerCase() === wanted);
  }
  if (index === -1) {
    throw new Error(
      `Unknown ${role} column ${JSON.stringify(name)}. Available columns: ${quoteAll(names)}.`,
    );
  }
  return index;
}

/** Whether a column name is like "id", "#", "index", "rank", "pid", "user_id" or "userId". */
function isIdName(name: string): boolean {
  return (
    /^(?:id|#|no\.?|nr|num|index|idx|rank|row|pid|ppid|tid|uid|gid)$|[_ -]id$/i.test(name) ||
    /[a-z]I[dD]$/.test(name)
  );
}

/** Whether a column numbers the rows 1, 2, 3, … or 0, 1, 2, …. */
function numbersRows(table: DataTable, column: number): boolean {
  const first = table.rows[0]?.[column];
  return (
    table.rows.length >= 3 &&
    (first === 0 || first === 1) &&
    table.rows.every((row, i) => row[column] === first + i)
  );
}

/**
 * Whether a column names each row: its values are distinct, and not times or dates (which start
 * with a digit), unlike the permissions and times in ls -l output.
 */
function namesRows(table: DataTable, column: number): boolean {
  const seen = new Set<Cell | undefined>();
  for (const row of table.rows) {
    const cell = row[column];
    if (seen.has(cell) || (typeof cell === "string" && /^\d/.test(cell))) {
      return false;
    }
    seen.add(cell);
  }
  return true;
}

/**
 * The default label column: the first text column that names each row, else the first text
 * column. Without text, a first column of identifiers or years labels the others (except in
 * scatter charts), and otherwise none does: rows are labeled by their numbers.
 */
function defaultLabelColumn(table: DataTable, scatter: boolean): number | undefined {
  const text = table.columns.flatMap((column, i) =>
    !column.numeric && table.rows.some((row) => row[i] !== null) ? [i] : [],
  );
  if (text.length > 0) {
    return text.find((i) => namesRows(table, i)) ?? text[0];
  }
  const first = table.columns[0]?.name ?? "";
  const labels =
    table.columns.length > 1 && (isIdName(first) || table.rows.every((row) => isYear(row[0])));
  return labels && !scatter ? 0 : undefined;
}

/** The columns that `keep` is true for, unless fewer than the `needed` ones are. */
function preferring(
  columns: number[],
  needed: number,
  keep: (column: number) => boolean,
): number[] {
  const kept = columns.filter(keep);
  return kept.length >= needed ? kept : columns;
}

/**
 * The default value columns, of which the chart needs at least `needed`: the numeric columns other
 * than the label column, preferably not ones that identify or number the rows, and only those with
 * the unit of the first (leaving out the Use% next to the sizes of df -h).
 */
function defaultValueColumns(
  table: DataTable,
  labelIndex: number | undefined,
  needed: number,
): number[] {
  const numeric = table.columns.flatMap((column, i) =>
    column.numeric && i !== labelIndex ? [i] : [],
  );
  const values = preferring(
    preferring(numeric, needed, (i) => !isIdName(table.columns[i]?.name ?? "")),
    needed,
    (i) => !numbersRows(table, i),
  );
  const unit = table.columns[values[0] ?? 0]?.unit;
  return preferring(values, needed, (i) => table.columns[i]?.unit === unit);
}

/**
 * Whether the last row sums up at least two others, as the "total" row of wc -l or du -c and the
 * "SUM:" row of cloc do: it is labeled so, and where it has numbers, they are within 1% of the
 * sums of the others.
 */
function hasTotalsRow(table: DataTable, labelColumn: number, valueColumns: number[]): boolean {
  const last = table.rows.at(-1);
  const others = table.rows.slice(0, -1);
  const label = last?.[labelColumn];
  if (
    last === undefined ||
    others.length < 2 ||
    typeof label !== "string" ||
    !/^(?:total|totals|sum|grand total)\s*:?$/i.test(label)
  ) {
    return false;
  }
  let checked = 0;
  for (const column of valueColumns) {
    const total = last[column];
    if (typeof total === "number") {
      const sum = others.reduce(
        (acc, row) => acc + (typeof row[column] === "number" ? row[column] : 0),
        0,
      );
      if (Math.abs(total - sum) > Math.abs(total) * 0.01) {
        return false;
      }
      checked++;
    }
  }
  return checked > 0;
}

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];

/** The power of 1024 to show sizes up to `max` bytes in. */
function bytePower(max: number): number {
  let power = 0;
  while (power < BYTE_UNITS.length - 1 && max >= 1024 ** (power + 1)) {
    power++;
  }
  return power;
}

interface Row {
  label: string;
  values: (number | null)[];
}

/** Sorts rows by their first value, empty values last. */
function sortRows(rows: Row[], sort: ChartSpec["sort"]): Row[] {
  if (sort === undefined) {
    return rows;
  }
  const direction = sort === "ascending" ? 1 : -1;
  return rows.toSorted(({ values: [x = null] }, { values: [y = null] }) => {
    if (x === null || y === null) {
      return x === y ? 0 : x === null ? 1 : -1;
    }
    return (x - y) * direction;
  });
}

type CartesianType = Exclude<ChartType, "pie" | "doughnut" | "scatter">;

const CARTESIAN_SERIES: Record<CartesianType, Record<string, unknown>> = {
  bar: { type: "bar" },
  horizontalBar: { type: "bar" },
  stackedBar: { type: "bar", stack: "total" },
  line: { type: "line" },
  area: { type: "line", areaStyle: {} },
};

/** Lines with more points than this are drawn without symbols. */
const FEW_POINTS = 30;

export interface Chart {
  /** The ECharts option, as plain JSON that leaves colors, fonts and layout to the webview. */
  option: Record<string, unknown>;
  /** Which columns and rows were charted, e.g. `Charted "size" by "dir".`, for a model. */
  summary: string;
}

/**
 * Builds an ECharts option showing the table as the requested chart, with `spec.options`
 * deep-merged into it. Columns default as described at {@link defaultLabelColumn} and
 * {@link defaultValueColumns}, and a totals row (see {@link hasTotalsRow}) is left out.
 *
 * @throws Error when a column does not exist or there are no numbers to chart.
 */
export function buildChart(spec: ChartSpec, table: DataTable): Chart {
  const scatter = spec.type === "scatter";
  const pie = spec.type === "pie" || spec.type === "doughnut";
  const labelIndex =
    spec.labelColumn === undefined
      ? defaultLabelColumn(table, scatter)
      : findColumn(table, spec.labelColumn, "label");
  const columns =
    spec.valueColumns?.map((name) => findColumn(table, name, "value")) ??
    defaultValueColumns(table, labelIndex, scatter ? 2 : 1);
  const valueIndices = columns.slice(0, pie ? 1 : scatter ? 2 : undefined);
  const name = (index: number) => table.columns[index]?.name ?? "";
  const notes: string[] = [];
  if (spec.valueColumns !== undefined && valueIndices.length < columns.length) {
    const left = columns.slice(valueIndices.length).map(name);
    notes.push(
      `left out ${quoteAll(left)}, as a ${spec.type} chart shows ${pie ? "one value column" : "two value columns"}`,
    );
  }
  if (valueIndices.length === 0) {
    throw new Error(
      'No column holds numbers to chart. If the data was not split into columns as intended, set "format".',
    );
  }
  for (const index of valueIndices) {
    if (!table.rows.some((row) => typeof row[index] === "number")) {
      throw new Error(`The value column ${JSON.stringify(name(index))} holds no numbers.`);
    }
  }
  if (scatter && valueIndices.length < 2) {
    throw new Error(
      "A scatter chart needs two numeric columns (x and y), but there is only " +
        `${JSON.stringify(name(valueIndices[0] ?? 0))}.`,
    );
  }

  let tableRows = table.rows;
  if (labelIndex !== undefined && hasTotalsRow(table, labelIndex, valueIndices)) {
    tableRows = tableRows.slice(0, -1);
    notes.push(
      `left out the last row, ${JSON.stringify(table.rows.at(-1)?.[labelIndex])}, a total of the others`,
    );
  }
  let rows: Row[] = tableRows.map((row, i) => ({
    label: labelIndex === undefined ? String(i + 1) : String(row[labelIndex] ?? ""),
    values: valueIndices.map((index) => {
      const cell = row[index];
      return typeof cell === "number" ? cell : null;
    }),
  }));
  if (pie || scatter) {
    // ECharts leaves out negative pie slices, and zero ones would only add overlapping labels.
    const charted = rows.filter(({ values }) =>
      pie ? (values[0] ?? 0) > 0 : !values.includes(null),
    );
    const left = rows.length - charted.length;
    if (charted.length === 0) {
      const quoted = quoteAll(valueIndices.map(name));
      throw new Error(
        pie
          ? `A pie chart needs positive numbers, but ${quoted} has none.`
          : `No row has numbers in both ${quoted}.`,
      );
    }
    if (left > 0) {
      const without = pie ? "a positive value" : "both an x and a y value";
      notes.push(`left out ${left} ${left === 1 ? "row" : "rows"} without ${without}`);
    }
    rows = charted;
  }
  rows = sortRows(rows, spec.sort);
  if (spec.limit !== undefined && rows.length > spec.limit) {
    if (pie) {
      // A row named "Other" in the data is summed up too, rather than becoming a second slice.
      const kept: Row[] = [];
      let other = 0;
      let summed = 0;
      for (const row of rows) {
        if (kept.length < spec.limit && row.label !== "Other") {
          kept.push(row);
        } else {
          other += row.values[0] ?? 0;
          summed++;
        }
      }
      rows = [...kept, { label: "Other", values: [other] }];
      notes.push(`kept the first ${spec.limit} rows and summed up the other ${summed} as "Other"`);
    } else {
      notes.push(`kept the first ${spec.limit} of ${rows.length} rows`);
      rows = rows.slice(0, spec.limit);
    }
  }

  // Sizes in bytes are shown in the unit that suits the largest.
  const bytes = valueIndices.map((index) => table.columns[index]?.unit === "bytes");
  let largest = 0;
  for (const { values } of rows) {
    values.forEach((value, i) => {
      if (bytes[i] && value !== null) {
        largest = Math.max(largest, Math.abs(value));
      }
    });
  }
  const power = bytePower(largest);
  if (power > 0) {
    notes.push(`showed sizes in ${BYTE_UNITS[power]}`);
    rows = rows.map(({ label, values }) => ({
      label,
      values: values.map((value, i) =>
        bytes[i] && value !== null ? Math.round((value / 1024 ** power) * 100) / 100 : value,
      ),
    }));
  }
  const unit = power > 0 ? ` (${BYTE_UNITS[power]})` : "";
  const names = valueIndices.map((index, i) => name(index) + (bytes[i] ? unit : ""));

  const option = pie
    ? pieOption(spec.type === "doughnut", names[0] ?? "", rows)
    : scatter
      ? scatterOption(table.header, labelIndex !== undefined, names, rows)
      : cartesianOption(spec.type as CartesianType, table.header, names, rows);
  const values = scatter
    ? `${JSON.stringify(names[1])} against ${JSON.stringify(names[0])}`
    : quoteAll(names);
  const by =
    labelIndex !== undefined
      ? ` by ${JSON.stringify(name(labelIndex))}`
      : scatter
        ? ""
        : " by row number";
  return {
    option: spec.options === undefined ? option : deepMerge(option, spec.options),
    summary: `Charted ${values}${by}${notes.map((note) => `; ${note}`).join("")}.`,
  };
}

function pieOption(doughnut: boolean, name: string, rows: Row[]): Record<string, unknown> {
  return {
    // The series name says what the values are, e.g. "size (MiB)".
    tooltip: { formatter: "{a}<br/>{b}: {c} ({d}%)" },
    legend: {},
    series: [
      {
        type: "pie",
        name,
        ...(doughnut ? { radius: ["45%", "72%"] } : {}),
        label: { formatter: "{b}: {d}%" },
        // Labels of slices under 1% would overlap; the legend and tooltip still name them.
        minShowLabelAngle: 3.6,
        data: rows.map(({ label, values: [value] }) => ({ name: label, value })),
      },
    ],
  };
}

function scatterOption(
  header: boolean,
  labeled: boolean,
  [xName = "", yName = ""]: string[],
  rows: Row[],
): Record<string, unknown> {
  // Generated column names ("Column 2") would make poor axis names.
  const axis = (name: string) => ({ type: "value", ...(header ? { name } : {}), scale: true });
  return {
    tooltip: { formatter: labeled ? "{b}: ({c})" : "({c})" },
    xAxis: axis(xName),
    yAxis: axis(yName),
    series: [
      {
        type: "scatter",
        name: yName,
        data: rows.map(({ label, values }) => (labeled ? { name: label, value: values } : values)),
      },
    ],
  };
}

/** A bar or line chart, whose tooltip and legend the webview adds. */
function cartesianOption(
  type: CartesianType,
  header: boolean,
  names: string[],
  rows: Row[],
): Record<string, unknown> {
  const line = type === "line" || type === "area";
  const horizontal = type === "horizontalBar";
  const categoryAxis = {
    type: "category",
    data: rows.map((row) => row.label),
    ...(line ? { boundaryGap: false } : {}),
    // The first row at the top.
    ...(horizontal ? { inverse: true } : {}),
    // At the edge rather than at zero, where its labels would cover the negative values.
    ...(rows.some(({ values }) => values.some((value) => value !== null && value < 0))
      ? { axisLine: { onZero: false } }
      : {}),
  };
  const valueAxis = {
    type: "value",
    // With several series, the legend names them.
    ...(header && names.length === 1 ? { name: names[0] } : {}),
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
      data: rows.map((row) => row.values[column] ?? null),
    })),
  };
}

const PREVIEW_ROWS = 5;
const TEXT_EXAMPLES = 3;

function describeColumn(table: DataTable, column: number): string {
  const cells = table.rows.map((row) => row[column] ?? null);
  if (cells.every((cell) => cell === null)) {
    return "empty";
  }
  const { numeric, unit } = table.columns[column] ?? {};
  if (!numeric) {
    return "text";
  }
  const kind = unit === "bytes" ? "bytes" : unit === "%" ? "percentages" : "numbers";
  // Charts leave out text cells in numeric columns.
  const texts = cells.filter((cell) => typeof cell === "string");
  if (texts.length === 0) {
    return kind;
  }
  const examples = texts.slice(0, TEXT_EXAMPLES).map((text) => JSON.stringify(text));
  if (texts.length > TEXT_EXAMPLES) {
    examples.push("…");
  }
  const count = `${texts.length} text ${texts.length === 1 ? "cell" : "cells"}`;
  return `${kind}, ${count}: ${examples.join(", ")}`;
}

/**
 * Summarizes a table for a language model: `42 rows; columns: "dir" (text), "size" (bytes)`,
 * followed by the first rows as JSON arrays.
 */
export function describeTable(table: DataTable): string {
  const columns = table.columns.map(
    (column, i) => `${JSON.stringify(column.name)} (${describeColumn(table, i)})`,
  );
  const count = table.rows.length;
  return [
    `${count} ${count === 1 ? "row" : "rows"}; columns: ${columns.join(", ")}`,
    count > PREVIEW_ROWS ? `First ${PREVIEW_ROWS} rows:` : "Rows:",
    ...table.rows.slice(0, PREVIEW_ROWS).map((row) => JSON.stringify(row)),
  ].join("\n");
}

function mergeValue(target: unknown, source: unknown): unknown {
  if (isPlainObject(source)) {
    if (Array.isArray(target) && target.length > 0 && target.every(isPlainObject)) {
      // {"series": {...}} adjusts every series.
      return target.map((item) => deepMerge(item, source));
    }
    return deepMerge(isPlainObject(target) ? target : {}, source);
  }
  if (
    Array.isArray(source) &&
    Array.isArray(target) &&
    source.length > 0 &&
    source.every(isPlainObject)
  ) {
    // {"series": [{...}]} adjusts the first series, and so on.
    return Array.from({ length: Math.max(target.length, source.length) }, (_, i) =>
      i < source.length ? mergeValue(target[i], source[i]) : target[i],
    );
  }
  return structuredClone(source);
}

/**
 * Returns a deep merge of source into target, without changing either, as a JSON Merge Patch
 * (RFC 7396) does: plain objects merge recursively, null removes a key, and other values replace
 * the target's. Unlike a merge patch, an array of objects merges element by element into an
 * array, and an object merges into each object of an array.
 */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value === null) {
      delete result[key];
    } else if (key !== "__proto__") {
      // Assigning "__proto__" would change the result's prototype.
      result[key] = mergeValue(target[key], value);
    }
  }
  return result;
}
