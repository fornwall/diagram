// Which columns of a table a chart reads, and in which role: given in the request, or inferred.

import { dateFormat } from "./chartDates";
import { CARTESIAN_TYPES, type CartesianType, type ChartSpec, type ChartType } from "./chartSpec";
import { type Cell, type DataTable, isYear } from "./data";
import { isPlainObject } from "./protocol";
import { plural, quoteAll } from "./text";

export function columnName(table: DataTable, index: number | undefined): string {
  return index === undefined ? "" : (table.columns[index]?.name ?? "");
}

/** Finds a column by its exact name, then ignoring case and surrounding spaces. */
export function findColumn(table: DataTable, name: string, role: string): number {
  let index = table.columns.findIndex((column) => column.name === name);
  if (index < 0) {
    const wanted = name.trim().toLowerCase();
    index = table.columns.findIndex((column) => column.name.trim().toLowerCase() === wanted);
  }
  if (index < 0) {
    throw new Error(
      `Unknown ${role} column ${JSON.stringify(name)}. Available columns: ${quoteAll(table.columns.map((column) => column.name))}.`,
    );
  }
  return index;
}

/** Finds the columns that a property names, each of which it may name once. */
export function findColumns(
  table: DataTable,
  names: string[],
  key: "labelColumn" | "valueColumns",
): number[] {
  const role = key === "labelColumn" ? "label" : "value";
  const indices = names.map((name) => findColumn(table, name, role));
  const repeated = indices.find((index, i) => indices.indexOf(index) !== i);
  if (repeated !== undefined) {
    throw new Error(
      `"${key}" names the column ${JSON.stringify(columnName(table, repeated))} twice. Give each ` +
        "column once.",
    );
  }
  return indices;
}

/** Whether a chart draws a series per value column, or per label of a second label column. */
export function isCartesian(type: ChartType): type is CartesianType {
  return (CARTESIAN_TYPES as readonly ChartType[]).includes(type);
}

/** Whether a chart reads its labels as the levels of a hierarchy or the stages of a flow. */
export function readsLevels(type: ChartType): boolean {
  return type === "treemap" || type === "sunburst" || type === "sankey";
}

/** Whether a column name is like "id", "#", "rank", "pid", "user_id", "user.id" or "userId". */
function isIdName(name: string): boolean {
  return (
    /^(?:id|#|no\.?|nr|num|index|idx|rank|row|pid|ppid|tid|uid|gid)$|[_ .-]id$/i.test(name) ||
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
 * Distinct labels, excluding digit-prefixed ones and dates and times such as those of ls -l
 * ("Oct 4 14:02", "Oct 4 2025").
 */
function namesRows(table: DataTable, column: number): boolean {
  const seen = new Set<Cell | undefined>();
  for (const row of table.rows) {
    const cell = row[column];
    if (
      seen.has(cell) ||
      (typeof cell === "string" && /^\d|\d:\d\d|^\S+ \d\d? \d{4}$/.test(cell))
    ) {
      return false;
    }
    seen.add(cell);
  }
  return true;
}

/** The columns that hold text to label rows with: not numeric, and not empty. */
function textColumns(table: DataTable): number[] {
  return table.columns.flatMap((column, i) =>
    !column.numeric && table.rows.some((row) => row[i] !== null) ? [i] : [],
  );
}

/** Whether a column groups the rows, with on average at least two rows per value. */
function groupsRows(table: DataTable, column: number): boolean {
  return new Set(table.rows.map((row) => row[column])).size * 2 <= table.rows.length;
}

/**
 * Prefer distinct text labels, then any text, then a leading identifier or year column. A box
 * plot needs groups of rows instead: a box per row would summarize a single value.
 */
function defaultLabelColumn(table: DataTable, type: ChartType): number | undefined {
  const text = textColumns(table);
  const first = columnName(table, 0);
  const leading =
    text.length === 0 &&
    type !== "scatter" &&
    table.columns.length > 1 &&
    (isIdName(first) || table.rows.every((row) => isYear(row[0])))
      ? [0]
      : [];
  if (type === "boxplot") {
    return [...text, ...leading].find((i) => groupsRows(table, i));
  }
  return text.find((i) => namesRows(table, i)) ?? text[0] ?? leading[0];
}

/** The most text columns read as the levels of a hierarchy, the stages of a flow or a pivot. */
const MOST_LEVELS = 3;

/** Use a few text columns as levels; many text columns (ls -l, ps aux) suggest flat records. */
function defaultLabelColumns(table: DataTable, type: ChartType, most: number): number[] {
  const text = textColumns(table);
  if (text.length >= 2 && text.length <= MOST_LEVELS) {
    return text.slice(0, most);
  }
  const single = defaultLabelColumn(table, type);
  return single === undefined ? [] : [single];
}

/** Require a path separator in at least half the labels to avoid splitting isolated "yes/no". */
function pathSeparator(table: DataTable, column: number): string | undefined {
  let labels = 0;
  let slashes = 0;
  let backslashes = 0;
  for (const row of table.rows) {
    const cell = row[column];
    if (cell == null) continue;
    const text = String(cell);
    labels++;
    if (text.includes("/")) slashes++;
    if (text.includes("\\")) backslashes++;
  }
  const least = Math.max(1, labels / 2);
  if (slashes >= least && slashes >= backslashes) return "/";
  return backslashes >= least ? "\\" : undefined;
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

/** Prefer numeric columns with matching units, excluding labels, identifiers and row numbers. */
export function defaultValueColumns(
  table: DataTable,
  labelIndices: number[],
  needed: number,
): number[] {
  const numeric = table.columns.flatMap((column, i) =>
    column.numeric && !labelIndices.includes(i) ? [i] : [],
  );
  const nonIdentifiers = preferring(numeric, needed, (i) => !isIdName(columnName(table, i)));
  const values = preferring(nonIdentifiers, needed, (i) => !numbersRows(table, i));
  const unit = table.columns[values[0] ?? 0]?.unit;
  return preferring(values, needed, (i) => table.columns[i]?.unit === unit);
}

/** Maximum label/value columns and minimum value columns for each chart type. */
const COLUMN_COUNTS: Record<ChartType, { labels: number; values: number; needed: number }> = {
  histogram: { labels: 0, values: 1, needed: 1 },
  pie: { labels: 1, values: 1, needed: 1 },
  doughnut: { labels: 1, values: 1, needed: 1 },
  funnel: { labels: 1, values: 1, needed: 1 },
  bar: { labels: 2, values: Infinity, needed: 1 },
  horizontalBar: { labels: 2, values: Infinity, needed: 1 },
  stackedBar: { labels: 2, values: Infinity, needed: 1 },
  line: { labels: 2, values: Infinity, needed: 1 },
  area: { labels: 2, values: Infinity, needed: 1 },
  stackedArea: { labels: 2, values: Infinity, needed: 1 },
  scatter: { labels: 1, values: 2, needed: 2 },
  radar: { labels: 1, values: Infinity, needed: 2 },
  treemap: { labels: Infinity, values: 1, needed: 1 },
  sunburst: { labels: Infinity, values: 1, needed: 1 },
  sankey: { labels: Infinity, values: Infinity, needed: 1 },
  heatmap: { labels: 2, values: Infinity, needed: 1 },
  boxplot: { labels: 1, values: Infinity, needed: 1 },
  gauge: { labels: 1, values: 1, needed: 1 },
};

/** Which columns of a table a chart reads, and in which role. */
export interface Columns {
  /** The columns that name an item, outermost level first; empty when its row number names it. */
  labels: number[];
  /** The columns that give it values, at most as many as the chart shows. */
  values: number[];
  /** The separator that splits one label column into levels, as du -a prints paths. */
  separator?: string | undefined;
  /** How the dates in the label column are written, when they place each point along an axis. */
  times?: string | undefined;
  /** Whether those dates are drawn on a time axis, rather than as the categories "options" asks for. */
  timeAxis: boolean;
}

/** Whether the labels of a row already chain its levels, rather than one node per value column. */
export function chained({ labels, separator }: Columns): boolean {
  return labels.length >= 2 || separator !== undefined;
}

/** E.g. "one value column" or "two label columns", for a note about columns left out. */
function columnCount(count: number, role: string): string {
  const word = ["no", "one", "two", "three"][count] ?? String(count);
  return `${word} ${role} column${count === 1 ? "" : "s"}`;
}

/**
 * Sankey, heatmap, boxplot and Cartesian charts read one value column when labels identify each
 * flow, cell, group or series; otherwise they read one value column per target, heatmap column, box
 * or series.
 */
function shownValues(type: ChartType, labels: number, separator: boolean, times: boolean): number {
  switch (type) {
    case "scatter":
      // Dates in the label column are the x, so one column of values gives the y.
      return times ? 1 : 2;
    case "sankey":
      return labels >= 2 || separator ? 1 : Infinity;
    case "heatmap":
    case "bar":
    case "horizontalBar":
    case "stackedBar":
    case "line":
    case "area":
    case "stackedArea":
      return labels >= 2 ? 1 : Infinity;
    case "boxplot":
      return labels >= 1 ? 1 : Infinity;
    default:
      return COLUMN_COUNTS[type].values;
  }
}

/** The axis that a chart's labels lie along: the y axis of a horizontal bar chart. */
function labelAxis(type: ChartType): "xAxis" | "yAxis" {
  return type === "horizontalBar" ? "yAxis" : "xAxis";
}

/** Whether "options" asks for the label axis to be a category axis, as for dates read as labels. */
function categoryAxisOverride(spec: ChartSpec): boolean {
  const option = spec.options?.[labelAxis(spec.type)];
  const axis = Array.isArray(option) ? option[0] : option;
  return isPlainObject(axis) && axis.type === "category";
}

function readLabelColumns(spec: ChartSpec, table: DataTable, notes: string[]): number[] {
  const most = COLUMN_COUNTS[spec.type].labels;
  if (spec.labelColumn === undefined) {
    // A Cartesian chart takes a second label column for its series only when given one: two text
    // columns are as often a name and a description.
    if (most > 1 && !isCartesian(spec.type)) {
      return defaultLabelColumns(table, spec.type, most);
    }
    const single = defaultLabelColumn(table, spec.type);
    return single === undefined ? [] : [single];
  }
  const given = findColumns(table, [spec.labelColumn].flat(), "labelColumn");
  const labels = given.slice(0, most);
  if (labels.length < given.length) {
    notes.push(
      `left out ${quoteAll(given.slice(labels.length).map((i) => columnName(table, i)))}, as a ` +
        `${spec.type} chart reads ${columnCount(most, "label")}`,
    );
  }
  return labels;
}

/** Resolve explicit or inferred columns, recording omissions and inferred paths or dates. */
export function readColumns(spec: ChartSpec, table: DataTable, notes: string[]): Columns {
  const { type } = spec;
  const name = (index: number | undefined) => columnName(table, index);
  const labels = readLabelColumns(spec, table, notes);
  if (type === "sankey" && labels.length === 0) {
    throw new Error(
      "A sankey chart needs the nodes its flows run between to be named, but no column holds " +
        `text. Available columns: ${quoteAll(table.columns.map((column) => column.name))}. ` +
        'Give "labelColumn" as a source and a target column, e.g. ["from", "to"].',
    );
  }
  if (type === "boxplot" && spec.aggregate !== undefined) {
    throw new Error(
      'A box plot summarizes the raw rows of each group itself, and "aggregate" would leave it ' +
        'one number per group. Leave "aggregate" out, or chart the groups as a bar chart.',
    );
  }
  if (type === "boxplot" && spec.limit !== undefined) {
    throw new Error(
      'A box plot summarizes every row of each group, and "limit" would leave out some of ' +
        'them. Leave "limit" out, and select rows with "filters" instead.',
    );
  }
  if (isCartesian(type) && labels.length >= 2 && spec.limit !== undefined) {
    throw new Error(
      `A series per label of ${JSON.stringify(name(labels[1]))} draws every row, and ` +
        '"limit" would leave out parts of the series. Leave "limit" out, and select rows with ' +
        '"filters" instead.',
    );
  }
  const only = labels.length === 1 ? labels[0] : undefined;

  // A hierarchy and a flow read levels of their own from the paths in a single label column.
  const separator =
    only !== undefined && readsLevels(type) ? pathSeparator(table, only) : undefined;
  if (separator !== undefined) {
    notes.push(`split ${JSON.stringify(name(only))} on ${JSON.stringify(separator)} into levels`);
  }

  // Dates place points along an axis, with proportional spacing on a time axis. A scatter chart
  // given two value columns plots one against the other, and the dates name its points.
  const xy = type === "scatter" && (spec.valueColumns?.length ?? 0) >= 2;
  const axis = isCartesian(type) || (type === "scatter" && !xy) ? labels[0] : undefined;
  const times =
    axis === undefined ? undefined : dateFormat(table.rows.map((row) => String(row[axis] ?? "")));
  const timeAxis = times !== undefined && !categoryAxisOverride(spec);
  if (timeAxis) {
    notes.push(
      `read ${JSON.stringify(name(axis))} as ${times} on a time axis; ` +
        `{"${labelAxis(type)}": {"type": "category"}} in "options" reads them as labels instead`,
    );
  }

  const given = spec.valueColumns && findColumns(table, spec.valueColumns, "valueColumns");
  const needed = type === "scatter" && times !== undefined ? 1 : COLUMN_COUNTS[type].needed;
  if (spec.aggregate === "count") {
    // Counting rows gives one number per group, which a chart of two values cannot use.
    if (needed > 1) {
      throw new Error(
        `A ${type} chart needs ${columnCount(needed, "value")}, but "aggregate": "count" gives ` +
          'one count per group. Combine the values another way, e.g. with "sum".',
      );
    }
    if (given !== undefined) {
      notes.push(`left out ${quoteAll(given.map(name))}, as "count" counts the rows of a group`);
    }
    return { labels, values: [], separator, times, timeAxis };
  }
  const columns = given ?? defaultValueColumns(table, labels, needed);
  const most = shownValues(type, labels.length, separator !== undefined, times !== undefined);
  const values = columns.slice(0, most);
  if (given !== undefined && values.length < columns.length) {
    // A bar chart shows any number of value columns, but a series per label only one.
    const shows =
      isCartesian(type) && labels.length >= 2
        ? `a series per label of ${JSON.stringify(name(labels[1]))}`
        : `a ${type} chart`;
    notes.push(
      `left out ${quoteAll(columns.slice(values.length).map(name))}, as ${shows} shows ` +
        columnCount(most, "value"),
    );
  }
  if (values.length === 0) {
    throw new Error(
      `No column holds numbers to chart. Columns: ${describeColumns(table)}. If the data was not ` +
        'split into columns as intended, set "format"; otherwise use "aggregate": "count" to ' +
        "count rows per label.",
    );
  }
  for (const index of values) {
    if (!table.rows.some((row) => typeof row[index] === "number")) {
      throw new Error(
        `The value column ${JSON.stringify(name(index))} holds no numbers ` +
          `(${describeColumn(table, index)}). Choose a numeric column in "valueColumns".`,
      );
    }
  }
  if (values.length < needed) {
    const one = JSON.stringify(name(values[0]));
    throw new Error(
      type === "scatter"
        ? `A scatter chart needs two numeric columns (x and y), but there is only ${one}.`
        : `A radar chart needs two numeric columns, one axis each, but there is only ${one}.`,
    );
  }
  return { labels, values, separator, times, timeAxis };
}

const PREVIEW_ROWS = 5;
const TEXT_EXAMPLES = 3;

function describeColumn(table: DataTable, column: number): string {
  const { numeric, unit } = table.columns[column] ?? {};
  if (!table.rows.some((row) => row[column] != null)) {
    return "empty";
  }
  if (!numeric) {
    return "text";
  }
  // Sizes and durations were converted, as "Latency (ms)" to seconds, which filters compare.
  const kind = unit === undefined ? "numbers" : unit === "%" ? "percentages" : `in ${unit}`;
  // Charts leave out text cells in numeric columns.
  const texts = table.rows.flatMap((row) => (typeof row[column] === "string" ? [row[column]] : []));
  if (texts.length === 0) {
    return kind;
  }
  const examples = texts.slice(0, TEXT_EXAMPLES).map((text) => JSON.stringify(text));
  if (texts.length > TEXT_EXAMPLES) {
    examples.push("…");
  }
  return `${kind}, ${plural(texts.length, "text cell")}: ${examples.join(", ")}`;
}

/** E.g. `"dir" (text), "size" (in bytes)`. */
export function describeColumns(table: DataTable): string {
  return table.columns
    .map((column, i) => `${JSON.stringify(column.name)} (${describeColumn(table, i)})`)
    .join(", ");
}

/**
 * Which columns hold sizes in bytes or durations in seconds, as "filters" and "max" give them, e.g.
 * `"Latency (ms)" is in seconds.`, or undefined if none does.
 */
export function describeUnits({ columns }: DataTable): string | undefined {
  const clauses = (["bytes", "seconds"] as const).flatMap((unit) => {
    const names = columns.flatMap((column) => (column.unit === unit ? [column.name] : []));
    return names.length === 0
      ? []
      : [`${quoteAll(names)} ${names.length === 1 ? "is" : "are"} in ${unit}`];
  });
  return clauses.length === 0 ? undefined : `${clauses.join("; ")}.`;
}

/**
 * Summarizes a table for a language model: `42 rows; columns: "dir" (text), "size" (in bytes)`,
 * followed by the first rows as JSON arrays.
 */
export function describeTable(table: DataTable): string {
  const count = table.rows.length;
  return [
    `${plural(count, "row")}; columns: ${describeColumns(table)}`,
    ...(table.note === undefined ? [] : [table.note]),
    count > PREVIEW_ROWS ? `First ${PREVIEW_ROWS} rows:` : "Rows:",
    ...table.rows.slice(0, PREVIEW_ROWS).map((row) => JSON.stringify(row)),
  ].join("\n");
}
