// Turning a table and a chart request into an Apache ECharts option.

import { type ChartSpec, type ChartType, quoteAll } from "./chartSpec";
import { type Cell, type DataTable, isPlainObject } from "./data";

/** Finds a column by name, exactly or else ignoring case and surrounding spaces. */
function findColumn(table: DataTable, name: string, role: string): number {
  const names = table.columns.map((column) => column.name);
  const exact = names.indexOf(name);
  if (exact !== -1) {
    return exact;
  }
  const wanted = name.trim().toLowerCase();
  const loose = names.findIndex((column) => column.trim().toLowerCase() === wanted);
  if (loose !== -1) {
    return loose;
  }
  throw new Error(
    `Unknown ${role} column ${JSON.stringify(name)}. Available columns: ${quoteAll(names)}.`,
  );
}

const ID_NAME = /^(?:id|#|no\.?|nr|num|index|idx|rank|row|pid|ppid|tid|uid|gid)$|[_ -]id$/i;
/** A camel-case identifier name, as "userId". */
const CAMEL_ID_NAME = /[a-z]I[dD]$/;

/**
 * Whether a numeric column identifies rows rather than measuring something: it is named like
 * "id", "#", "index", "rank", "pid" or "user_id", or (when `sequenceToo`) it numbers the rows
 * 1, 2, 3, … or 0, 1, 2, ….
 */
function isIdColumn(table: DataTable, column: number, sequenceToo: boolean): boolean {
  const name = (table.columns[column]?.name ?? "").trim();
  if (ID_NAME.test(name) || CAMEL_ID_NAME.test(name)) {
    return true;
  }
  if (!sequenceToo || table.rows.length < 3) {
    return false;
  }
  const first = table.rows[0]?.[column];
  return (first === 0 || first === 1) && table.rows.every((row, i) => row[column] === first + i);
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
 * column, else (except for scatter charts, which need none) the first column.
 */
function defaultLabelColumn(table: DataTable, scatter: boolean): number | undefined {
  const text = table.columns.flatMap((column, i) =>
    !column.numeric && table.rows.some((row) => row[i] !== null) ? [i] : [],
  );
  return text.find((i) => namesRows(table, i)) ?? text[0] ?? (scatter ? undefined : 0);
}

/**
 * The default value columns: the numeric columns other than the label column, leaving out
 * identifier columns (see {@link isIdColumn}) unless nothing else is left, and columns of another
 * unit than the first (as the Use% next to the sizes of df -h).
 */
function defaultValueColumns(table: DataTable, labelIndex: number | undefined): number[] {
  const candidates = table.columns.flatMap((column, i) =>
    column.numeric && i !== labelIndex ? [i] : [],
  );
  const named = candidates.filter((i) => !isIdColumn(table, i, false));
  const kept = named.length > 0 ? named : candidates;
  const unnumbered = kept.filter((i) => !isIdColumn(table, i, true));
  const values = unnumbered.length > 0 ? unnumbered : kept;
  const unit = table.columns[values[0] ?? 0]?.unit;
  return values.filter((i) => table.columns[i]?.unit === unit);
}

const TOTAL_LABEL = /^(?:total|totals|sum|grand total)\s*:?$/i;

/** How far a totals row's value may be from the sum of the other rows, relative to the value. */
const TOTAL_TOLERANCE = 0.01;

/**
 * Whether the last row sums up the others, as the "total" row of wc -l or du -c and the "SUM:" row
 * of cloc do: it is labeled "total", "totals" or "sum" (ignoring case and a trailing colon), and in
 * every value column where it has a number, that number is within 1% of the sum of the other rows.
 * At least two other rows are needed.
 */
function hasTotalsRow(table: DataTable, labelColumn: number, valueColumns: number[]): boolean {
  const last = table.rows.at(-1);
  const others = table.rows.slice(0, -1);
  const label = last?.[labelColumn];
  if (last === undefined || others.length < 2 || typeof label !== "string") {
    return false;
  }
  if (!TOTAL_LABEL.test(label.trim())) {
    return false;
  }
  let checked = 0;
  for (const column of valueColumns) {
    const total = last[column];
    if (typeof total !== "number") {
      continue;
    }
    const sum = others.reduce<number>((acc, row) => {
      const cell = row[column];
      return typeof cell === "number" ? acc + cell : acc;
    }, 0);
    if (Math.abs(total - sum) > Math.abs(total) * TOTAL_TOLERANCE) {
      return false;
    }
    checked++;
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

function labelOf(cell: Cell | undefined): string {
  return cell === null || cell === undefined ? "" : String(cell);
}

/** Sorts rows by their first value, empty values last. */
function sortRows(rows: Row[], sort: ChartSpec["sort"]): Row[] {
  if (sort === undefined) {
    return rows;
  }
  const direction = sort === "ascending" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a.values[0] ?? null;
    const y = b.values[0] ?? null;
    if (x === null || y === null) {
      return x === y ? 0 : x === null ? 1 : -1;
    }
    return (x - y) * direction;
  });
}

const FEW_POINTS = 30;

const CARTESIAN_SERIES: Record<
  Exclude<ChartType, "pie" | "doughnut" | "scatter">,
  Record<string, unknown>
> = {
  bar: { type: "bar" },
  horizontalBar: { type: "bar" },
  stackedBar: { type: "bar", stack: "total" },
  line: { type: "line" },
  area: { type: "line", areaStyle: { opacity: 0.3 } },
};

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
  const valueIndices = (
    spec.valueColumns?.map((name) => findColumn(table, name, "value")) ??
    defaultValueColumns(table, labelIndex)
  ).slice(0, pie ? 1 : scatter ? 2 : undefined);
  if (valueIndices.length === 0) {
    throw new Error(
      'No column holds numbers to chart. If the data was not split into columns as intended, set "format".',
    );
  }
  const columnName = (index: number | undefined) => table.columns[index ?? -1]?.name ?? "";
  for (const index of valueIndices) {
    if (!table.rows.some((row) => typeof row[index] === "number")) {
      throw new Error(`The value column ${JSON.stringify(columnName(index))} holds no numbers.`);
    }
  }
  if (scatter && valueIndices.length < 2) {
    throw new Error(
      "A scatter chart needs two numeric columns (x and y), but there is only " +
        `${JSON.stringify(columnName(valueIndices[0]))}.`,
    );
  }

  const notes: string[] = [];
  let tableRows = table.rows;
  if (labelIndex !== undefined && hasTotalsRow(table, labelIndex, valueIndices)) {
    tableRows = tableRows.slice(0, -1);
    notes.push(
      `left out the last row, ${JSON.stringify(table.rows.at(-1)?.[labelIndex])}, a total of the others`,
    );
  }

  // Sizes in bytes are shown in the unit that suits the largest.
  const bytes = valueIndices.map((index) => table.columns[index]?.unit === "bytes");
  let largest = 0;
  for (const row of tableRows) {
    valueIndices.forEach((index, i) => {
      const cell = row[index];
      if (bytes[i] && typeof cell === "number") {
        largest = Math.max(largest, Math.abs(cell));
      }
    });
  }
  const power = bytePower(largest);
  const sizeUnit = BYTE_UNITS[power];
  if (bytes.includes(true) && power > 0) {
    notes.push(`showed sizes in ${sizeUnit}`);
  }
  const scaled = (value: number, i: number) =>
    bytes[i] ? Math.round((value / 1024 ** power) * 100) / 100 : value;

  let rows = sortRows(
    tableRows.map((row) => ({
      label: labelIndex === undefined ? "" : labelOf(row[labelIndex]),
      values: valueIndices.map((index, i) => {
        const cell = row[index];
        return typeof cell === "number" ? scaled(cell, i) : null;
      }),
    })),
    spec.sort,
  );
  if (spec.limit !== undefined && rows.length > spec.limit) {
    const rest = rows.slice(spec.limit);
    rows = rows.slice(0, spec.limit);
    if (pie) {
      rows.push({
        label: "Other",
        values: [rest.reduce((sum, row) => sum + (row.values[0] ?? 0), 0)],
      });
      notes.push(`summed up the ${rest.length} rows after the first ${spec.limit} as "Other"`);
    } else {
      notes.push(`kept the first ${spec.limit} of ${rows.length + rest.length} rows`);
    }
  }
  const empty = pie || scatter ? rows.filter((row) => row.values.includes(null)).length : 0;
  if (empty > 0) {
    notes.push(`left out ${empty} ${empty === 1 ? "row" : "rows"} without a value`);
  }

  const names = valueIndices.map(
    (index, i) => `${columnName(index)}${bytes[i] && power > 0 ? ` (${sizeUnit})` : ""}`,
  );
  let option: Record<string, unknown>;
  if (pie) {
    option = pieOption(spec.type === "doughnut", names[0] ?? "", rows);
  } else if (scatter) {
    option = scatterOption(table.header, names, rows);
  } else {
    option = cartesianOption(spec.type as keyof typeof CARTESIAN_SERIES, table.header, names, rows);
  }
  const values = scatter
    ? `${JSON.stringify(names[1])} against ${JSON.stringify(names[0])}`
    : quoteAll(names);
  const by = labelIndex === undefined ? "" : ` by ${JSON.stringify(columnName(labelIndex))}`;
  return {
    option: spec.options === undefined ? option : deepMerge(option, spec.options),
    summary: `Charted ${values}${by}${notes.map((note) => `; ${note}`).join("")}.`,
  };
}

/** The ECharts option for {@link buildChart}'s chart, for callers that need no summary. */
export function buildChartOption(spec: ChartSpec, table: DataTable): Record<string, unknown> {
  return buildChart(spec, table).option;
}

function pieOption(doughnut: boolean, name: string, rows: Row[]): Record<string, unknown> {
  return {
    tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
    legend: { type: "scroll" },
    series: [
      {
        type: "pie",
        name,
        ...(doughnut ? { radius: ["45%", "72%"] } : {}),
        label: { formatter: "{b}: {d}%" },
        data: rows
          .filter((row) => row.values[0] !== null)
          .map((row) => ({ name: row.label, value: row.values[0] })),
      },
    ],
  };
}

function scatterOption(header: boolean, names: string[], rows: Row[]): Record<string, unknown> {
  const [xName = "", yName = ""] = names;
  const data = rows.flatMap((row) => {
    const [x, y] = row.values;
    if (x === null || x === undefined || y === null || y === undefined) {
      return [];
    }
    return [{ name: row.label === "" ? `(${x}, ${y})` : row.label, value: [x, y] }];
  });
  // Generated column names ("Column 2") would make poor axis names.
  return {
    tooltip: { trigger: "item", formatter: "{b}: ({c})" },
    xAxis: { type: "value", ...(header ? { name: xName } : {}), scale: true },
    yAxis: { type: "value", ...(header ? { name: yName } : {}), scale: true },
    series: [{ type: "scatter", name: yName, data }],
  };
}

function cartesianOption(
  type: keyof typeof CARTESIAN_SERIES,
  header: boolean,
  names: string[],
  rows: Row[],
): Record<string, unknown> {
  const several = names.length > 1;
  const isLine = type === "line" || type === "area";
  const horizontal = type === "horizontalBar";
  const categoryAxis = {
    type: "category",
    data: rows.map((row) => row.label),
    axisLabel: { hideOverlap: true },
    ...(isLine ? { boundaryGap: false } : {}),
    ...(horizontal ? { inverse: true } : {}),
  };
  // With several series, the legend names them.
  const valueAxis = { type: "value", ...(header && !several ? { name: names[0] } : {}) };
  const series = names.map((name, column) => ({
    ...CARTESIAN_SERIES[type],
    name,
    ...(isLine ? { showSymbol: rows.length <= FEW_POINTS } : {}),
    ...(several ? { emphasis: { focus: "series" } } : {}),
    data: rows.map((row) => ({ name: row.label, value: row.values[column] ?? null })),
  }));
  return {
    tooltip: { trigger: "axis", axisPointer: { type: isLine ? "line" : "shadow" } },
    ...(several ? { legend: { type: "scroll" } } : {}),
    xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? categoryAxis : valueAxis,
    series,
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
  const texts = cells.filter((cell): cell is string => typeof cell === "string");
  if (texts.length === 0) {
    return kind;
  }
  // Charts leave such cells out.
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
  const lines = [`${count} ${count === 1 ? "row" : "rows"}; columns: ${columns.join(", ")}`];
  lines.push(count > PREVIEW_ROWS ? `First ${PREVIEW_ROWS} rows:` : "Rows:");
  for (const row of table.rows.slice(0, PREVIEW_ROWS)) {
    lines.push(JSON.stringify(row));
  }
  return lines.join("\n");
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function mergeValue(target: unknown, source: unknown): unknown {
  if (isPlainObject(source)) {
    if (isPlainObject(target)) {
      return deepMerge(target, source);
    }
    if (Array.isArray(target) && target.length > 0 && target.every(isPlainObject)) {
      // {"series": {...}} adjusts every series.
      return target.map((item) => deepMerge(item, source));
    }
    return deepMerge({}, source);
  }
  if (Array.isArray(source)) {
    if (Array.isArray(target) && source.length > 0 && source.every(isPlainObject)) {
      // {"series": [{...}]} adjusts the first series, and so on.
      const merged = target.map((item, i) =>
        i < source.length ? mergeValue(item, source[i]) : item,
      );
      return [...merged, ...source.slice(target.length).map((item) => mergeValue(undefined, item))];
    }
    return source.map((item) => mergeValue(undefined, item));
  }
  return source;
}

/**
 * Returns a deep merge of source into target, without changing either. Plain objects merge
 * recursively and other values replace the target's, except that an array of objects merges
 * element-wise into an array, and an object merges into each object of an array.
 */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (!UNSAFE_KEYS.has(key)) {
      result[key] = mergeValue(target[key], value);
    }
  }
  return result;
}
