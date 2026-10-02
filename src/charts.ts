// Turning a table and a chart request into an Apache ECharts option.

import { dateFormat, timeValue } from "./chartDates";
import { type Aggregation, type ChartSpec, type ChartType, quoteAll } from "./chartSpec";
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

/** The columns that hold text to label rows with: not numeric, and not empty. */
function textColumns(table: DataTable): number[] {
  return table.columns.flatMap((column, i) =>
    !column.numeric && table.rows.some((row) => row[i] !== null) ? [i] : [],
  );
}

/**
 * The default label column: the first text column that names each row, else the first text
 * column. Without text, a first column of identifiers or years labels the others (except in
 * scatter charts), and otherwise none does: rows are labeled by their numbers.
 */
function defaultLabelColumn(table: DataTable, scatter: boolean): number | undefined {
  const text = textColumns(table);
  if (text.length > 0) {
    return text.find((i) => namesRows(table, i)) ?? text[0];
  }
  const first = table.columns[0]?.name ?? "";
  const labels =
    table.columns.length > 1 && (isIdName(first) || table.rows.every((row) => isYear(row[0])));
  return labels && !scatter ? 0 : undefined;
}

/** The most text columns read as the levels of a hierarchy, the stages of a flow or a pivot. */
const MOST_LEVELS = 3;

/**
 * The default label columns of a chart that reads several, outermost first: the text columns of a
 * table that has a few of them, as "region,country,sales" has two. Output with many text columns
 * (ls -l, ps aux) is no nesting, so one column labels it as in any other chart, and a hierarchy or
 * a flow then takes its levels from the paths in it (see {@link pathSeparator}).
 */
function defaultLabelColumns(table: DataTable, most: number): number[] {
  const text = textColumns(table);
  if (text.length >= 2 && text.length <= MOST_LEVELS) {
    return text.slice(0, most);
  }
  const single = defaultLabelColumn(table, false);
  return single === undefined ? [] : [single];
}

/** The separators of a path, as the labels of du -a and find output hold. */
const PATH_SEPARATORS = ["/", "\\"];

/**
 * The separator that splits labels into levels: "/" or "\", whichever at least half of them hold,
 * as the paths of `du -a` output do. A single "yes/no" among categories is no path.
 */
function pathSeparator(labels: string[]): string | undefined {
  const least = Math.max(1, labels.length / 2);
  let found: string | undefined;
  let most = 0;
  for (const separator of PATH_SEPARATORS) {
    const count = labels.filter((label) => label.includes(separator)).length;
    if (count >= least && count > most) {
      found = separator;
      most = count;
    }
  }
  return found;
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
 * than the label ones, preferably not ones that identify or number the rows, and only those with
 * the unit of the first (leaving out the Use% next to the sizes of df -h).
 */
function defaultValueColumns(table: DataTable, labelIndices: number[], needed: number): number[] {
  const numeric = table.columns.flatMap((column, i) =>
    column.numeric && !labelIndices.includes(i) ? [i] : [],
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
  const label = last?.[labelColumn];
  if (
    last === undefined ||
    table.rows.length < 3 ||
    typeof label !== "string" ||
    !/^(?:total|totals|sum|grand total)\s*:?$/i.test(label)
  ) {
    return false;
  }
  let checked = 0;
  for (const column of valueColumns) {
    const total = last[column];
    if (typeof total === "number") {
      let sum = 0;
      for (let i = 0; i < table.rows.length - 1; i++) {
        const value = table.rows[i]?.[column];
        if (typeof value === "number") {
          sum += value;
        }
      }
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
  /** What names the row: one label per label column, or the levels of a path in one of them. */
  labels: string[];
  values: (number | null)[];
}

/** A row's first label: the category, slice, group or outermost node that it names. */
function label({ labels }: Row): string {
  return labels[0] ?? "";
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

/**
 * The families of chart types, which differ in what they read from a table — how many columns name
 * an item and how many give it a value — and in how they are drawn:
 *
 * - `cartesian`: categories along one axis, one series per value column.
 * - `xy`: points at two values.
 * - `partOfWhole`: shares of a total, one value each.
 * - `profile`: one axis per value column, one shape per row.
 * - `hierarchy`: levels of labels, with the values of the rows under a level summed up into it.
 * - `flow`: values flowing from one named node to another.
 * - `matrix`: one value per row and column.
 * - `distribution`: the spread of many raw numbers per group.
 * - `singleValue`: one number on a scale.
 */
type Family =
  | "cartesian"
  | "xy"
  | "partOfWhole"
  | "profile"
  | "hierarchy"
  | "flow"
  | "matrix"
  | "distribution"
  | "singleValue";

const FAMILIES: Record<ChartType, Family> = {
  pie: "partOfWhole",
  doughnut: "partOfWhole",
  funnel: "partOfWhole",
  bar: "cartesian",
  horizontalBar: "cartesian",
  stackedBar: "cartesian",
  line: "cartesian",
  area: "cartesian",
  stackedArea: "cartesian",
  scatter: "xy",
  radar: "profile",
  treemap: "hierarchy",
  sunburst: "hierarchy",
  sankey: "flow",
  heatmap: "matrix",
  boxplot: "distribution",
  gauge: "singleValue",
};

/** As many columns as the table holds: a series, a level, an axis or a box per column. */
const MANY = Number.POSITIVE_INFINITY;

/**
 * How many columns of each role a family reads at most, and how many value columns it needs: a
 * scatter chart plots an x against a y, and a radar chart needs two axes to have a shape.
 */
const ROLES: Record<Family, { labels: number; values: number; needed: number }> = {
  cartesian: { labels: 1, values: MANY, needed: 1 },
  xy: { labels: 1, values: 2, needed: 2 },
  partOfWhole: { labels: 1, values: 1, needed: 1 },
  profile: { labels: 1, values: MANY, needed: 2 },
  hierarchy: { labels: MANY, values: 1, needed: 1 },
  flow: { labels: MANY, values: MANY, needed: 1 },
  matrix: { labels: 2, values: MANY, needed: 1 },
  distribution: { labels: 1, values: MANY, needed: 1 },
  singleValue: { labels: 1, values: 1, needed: 1 },
};

/** Which columns of a table a chart reads, and in which role. */
interface Columns {
  /** The columns that name an item, outermost level first; empty when its row number names it. */
  labels: number[];
  /** The columns that give it values, at most as many as the chart shows. */
  values: number[];
  /** The separator that splits one label column into levels, as du -a prints paths. */
  separator?: string;
  /** The shape of the dates in the label column, when the chart draws it as a time axis. */
  times?: string;
}

/** Whether the labels of a row already chain its levels, rather than one node per value column. */
function chained({ labels, separator }: Columns): boolean {
  return labels.length >= 2 || separator !== undefined;
}

/** E.g. "one value column" or "two label columns", for a note about columns left out. */
function columnCount(count: number, role: string): string {
  const word = ["no", "one", "two", "three"][count] ?? String(count);
  return `${word} ${role} column${count === 1 ? "" : "s"}`;
}

/**
 * How many value columns a chart shows once its label columns are known: a flow, a matrix or a
 * distribution reads one column of values when its labels already name every item — a source and a
 * target, a row and a column, a group — and one column per node, column or box when they do not.
 */
function shownValues(family: Family, labels: number, separator: boolean, times: boolean): number {
  switch (family) {
    case "xy":
      // On a time axis the label column is the x, so one column of values gives the y.
      return times ? 1 : ROLES.xy.values;
    case "flow":
      return labels >= 2 || separator ? 1 : MANY;
    case "matrix":
      return labels >= 2 ? 1 : MANY;
    case "distribution":
      return labels >= 1 ? 1 : MANY;
    default:
      return ROLES[family].values;
  }
}

/**
 * Which columns the chart reads, as given in the spec or inferred (see {@link defaultLabelColumn},
 * {@link defaultLabelColumns} and {@link defaultValueColumns}), noting every column that the chart
 * has no room for, the levels it split out of a path and the dates it will draw as times.
 *
 * `"aggregate": "count"` reads no value columns at all: {@link readRows} counts the rows of each
 * group instead.
 *
 * @throws Error when a column does not exist, or the table holds fewer numbers or labels than the
 *   chart needs, saying which columns it has.
 */
function readColumns(spec: ChartSpec, table: DataTable, notes: string[]): Columns {
  const family = FAMILIES[spec.type];
  const role = ROLES[family];
  const name = (index: number) => table.columns[index]?.name ?? "";
  let labels: number[];
  if (spec.labelColumn === undefined) {
    if (role.labels === 1) {
      const single = defaultLabelColumn(table, family === "xy");
      labels = single === undefined ? [] : [single];
    } else {
      labels = defaultLabelColumns(table, role.labels);
    }
  } else {
    const given = [spec.labelColumn].flat().map((column) => findColumn(table, column, "label"));
    labels = given.slice(0, role.labels);
    if (labels.length < given.length) {
      notes.push(
        `left out ${quoteAll(given.slice(labels.length).map(name))}, as a ${spec.type} chart ` +
          `reads ${columnCount(role.labels, "label")}`,
      );
    }
  }
  if (family === "flow" && labels.length === 0) {
    throw new Error(
      "A sankey chart needs the nodes its flows run between to be named, but no column holds " +
        `text. Available columns: ${quoteAll(table.columns.map((column) => column.name))}. ` +
        'Give "labelColumn" as a source and a target column, e.g. ["from", "to"].',
    );
  }
  if (family === "distribution" && spec.aggregate !== undefined) {
    throw new Error(
      'A box plot summarizes the raw rows of each group itself, and "aggregate" would leave it ' +
        'one number per group. Leave "aggregate" out, or chart the groups as a bar chart.',
    );
  }

  // A hierarchy and a flow read levels of their own from the paths in a single label column.
  const nested = family === "hierarchy" || family === "flow";
  const only = nested && labels.length === 1 ? labels[0] : undefined;
  const separator =
    only === undefined
      ? undefined
      : pathSeparator(table.rows.flatMap((row) => (row[only] == null ? [] : [String(row[only])])));
  if (only !== undefined && separator !== undefined) {
    notes.push(`split ${JSON.stringify(name(only))} on ${JSON.stringify(separator)} into levels`);
  }

  // A chart with an axis of its own reads a label column of dates as times (see {@link
  // dateFormat}), which spaces its points by when they happened.
  const dated = family === "cartesian" || family === "xy";
  const dates = dated && labels.length === 1 ? labels[0] : undefined;
  const times =
    dates === undefined ? undefined : dateFormat(table.rows.map((row) => String(row[dates] ?? "")));
  if (dates !== undefined && times !== undefined) {
    // The category axis of a horizontal bar chart is its y axis.
    const axis = spec.type === "horizontalBar" ? "yAxis" : "xAxis";
    notes.push(
      `read ${JSON.stringify(name(dates))} as ${times} on a time axis; ` +
        `{"${axis}": {"type": "category"}} in "options" reads them as labels instead`,
    );
  }

  const given = spec.valueColumns?.map((column) => findColumn(table, column, "value"));
  // On a time axis the labels supply x, so scatter needs only one numeric value.
  const needed = family === "xy" && times !== undefined ? 1 : role.needed;
  let values: number[] = [];
  if (spec.aggregate === "count") {
    // Counting rows gives one number per group, which a chart of two values cannot use.
    if (needed > 1) {
      throw new Error(
        `A ${spec.type} chart needs ${columnCount(needed, "value")}, but "aggregate": ` +
          '"count" gives one count per group. Combine the values another way, e.g. with "sum".',
      );
    }
    if (given !== undefined) {
      notes.push(`left out ${quoteAll(given.map(name))}, as "count" counts the rows of a group`);
    }
  } else {
    const columns = given ?? defaultValueColumns(table, labels, needed);
    const most = shownValues(family, labels.length, separator !== undefined, times !== undefined);
    values = columns.slice(0, most);
    if (given !== undefined && values.length < columns.length) {
      notes.push(
        `left out ${quoteAll(columns.slice(values.length).map(name))}, as a ${spec.type} chart ` +
          `shows ${columnCount(most, "value")}`,
      );
    }
    if (values.length === 0) {
      throw new Error(
        'No column holds numbers to chart. If the data was not split into columns as intended, set "format".',
      );
    }
    for (const index of values) {
      if (!table.rows.some((row) => typeof row[index] === "number")) {
        throw new Error(`The value column ${JSON.stringify(name(index))} holds no numbers.`);
      }
    }
    // Only a scatter and a radar chart need more than one column of numbers.
    if (values.length < needed) {
      const one = JSON.stringify(name(values[0] ?? 0));
      throw new Error(
        family === "xy"
          ? `A scatter chart needs two numeric columns (x and y), but there is only ${one}.`
          : `A radar chart needs two numeric columns, one axis each, but there is only ${one}.`,
      );
    }
  }
  return {
    labels,
    values,
    ...(separator === undefined ? {} : { separator }),
    ...(times === undefined ? {} : { times }),
  };
}

/**
 * The rows without those that other rows nest under: `du -a src` prints the size of a directory as
 * well as the sizes of the files in it, so counting the "src" row itself would count its files
 * twice. The values of its children total such a row instead, and the sort and the limit then
 * apply to the rows that have a value of their own.
 */
function withoutNests(rows: Row[]): Row[] {
  const prefixes = new Set<string>();
  for (const { labels } of rows) {
    for (let level = 1; level < labels.length; level++) {
      prefixes.add(levelKey(labels.slice(0, level)));
    }
  }
  return prefixes.size === 0 ? rows : rows.filter(({ labels }) => !prefixes.has(levelKey(labels)));
}

/** An unambiguous key, including when labels contain separator or control characters. */
function levelKey(labels: string[]): string {
  return JSON.stringify(labels);
}

/** What grouping did with the values of each group, for the note about it. */
const AGGREGATED: Record<Aggregation, string> = {
  sum: "summing their values",
  mean: "averaging their values",
  count: "counting the rows of each group",
  min: "taking the smallest of their values",
  max: "taking the largest of their values",
  median: "taking the median of their values",
};

interface GroupColumn {
  value: number | null;
  count: number;
  /** Only a median needs to retain all observations. */
  samples?: number[];
}

/**
 * The rows with those that share their labels collapsed into one, in the order the first of each
 * group appears: the values of a group are combined as `how` says, or, for "count", replaced by how
 * many rows the group holds, which is the chart's only value then (see {@link readColumns}).
 */
function groupRows(rows: Row[], how: Aggregation): Row[] {
  const groups = new Map<string, { labels: string[]; columns: GroupColumn[]; rows: number }>();
  for (const { labels, values } of rows) {
    const key = levelKey(labels);
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        labels,
        columns: values.map(() => ({
          value: null,
          count: 0,
          samples: how === "median" ? [] : undefined,
        })),
        rows: 0,
      };
      groups.set(key, group);
    }
    group.rows++;
    values.forEach((value, index) => {
      const column = group.columns[index];
      if (value === null || column === undefined) {
        return;
      }
      column.count++;
      if (column.samples !== undefined) {
        column.samples.push(value);
        return;
      }
      column.value =
        how === "min"
          ? Math.min(column.value ?? value, value)
          : how === "max"
            ? Math.max(column.value ?? value, value)
            : (column.value ?? 0) + value;
    });
  }
  return [...groups.values()].map(({ labels, columns, rows: count }) => ({
    labels,
    values:
      how === "count"
        ? [count]
        : columns.map(({ value, count, samples }) => {
            if (count === 0) {
              return null;
            }
            if (samples !== undefined) {
              return quantile(
                samples.sort((x, y) => x - y),
                0.5,
              );
            }
            return how === "mean" ? (value ?? 0) / count : value;
          }),
  }));
}

/** The labels of a table row: one per label column, the levels of its path, or its row number. */
function rowLabels(
  row: Cell[],
  index: number,
  { labels, separator }: Columns,
  nested: boolean,
): string[] {
  const first = labels[0];
  if (first === undefined) {
    return [String(index + 1)];
  }
  const parts =
    separator === undefined
      ? labels.map((column) => String(row[column] ?? ""))
      : String(row[first] ?? "").split(separator);
  const levels = nested ? parts.filter((part) => part !== "") : parts;
  return levels.length > 0 ? levels : [""];
}

/**
 * The rows to draw, in this order: the totals row (see {@link hasTotalsRow}) and the rows that
 * other rows nest under are left out, rows that share their labels are grouped (see
 * {@link groupRows}), the rows the chart cannot show go, and what is left is sorted and limited as
 * the spec asks. Sizes in bytes end up in the one unit that suits the largest, which the value
 * columns' names then carry; counting names its one column "rows".
 *
 * Grouping comes before the sort and the limit, so that "the 10 largest" counts the groups rather
 * than the rows.
 *
 * @throws Error when no row is left to draw.
 */
function readRows(
  spec: ChartSpec,
  table: DataTable,
  columns: Columns,
  notes: string[],
): { rows: Row[]; names: string[] } {
  const family = FAMILIES[spec.type];
  const valueIndices = columns.values;
  const name = (index: number) => table.columns[index]?.name ?? "";

  let tableRows = table.rows;
  const labelIndex = columns.labels[0];
  if (labelIndex !== undefined && hasTotalsRow(table, labelIndex, valueIndices)) {
    tableRows = tableRows.slice(0, -1);
    notes.push(
      `left out the last row, ${JSON.stringify(table.rows.at(-1)?.[labelIndex])}, a total of the others`,
    );
  }
  // A hierarchy and a flow read the labels as levels, leaving out the empty ones so that "src/"
  // and "src" nest alike; any other chart keeps an empty label as the category it is.
  const nested = family === "hierarchy" || family === "flow";
  let rows: Row[] = tableRows.map((row, i) => ({
    labels: rowLabels(row, i, columns, nested),
    values: valueIndices.map((index) => {
      const cell = row[index];
      return typeof cell === "number" ? cell : null;
    }),
  }));
  if (nested) {
    const nests = rows.length;
    rows = withoutNests(rows);
    const left = nests - rows.length;
    if (left > 0) {
      notes.push(
        `left out ${left} ${left === 1 ? "row" : "rows"} that other rows nest under, as the ` +
          "values of their children total them",
      );
    }
  }

  if (spec.aggregate !== undefined) {
    const ungrouped = rows.length;
    rows = groupRows(rows, spec.aggregate);
    const by = columns.labels.length === 0 ? "row number" : quoteAll(columns.labels.map(name));
    notes.push(
      `grouped ${ungrouped} rows into ${rows.length} by ${by}, ${AGGREGATED[spec.aggregate]}`,
    );
  }

  if (columns.times !== undefined) {
    // A row without a date has nowhere to sit on a time axis.
    const dated = rows.filter((row) => label(row) !== "");
    const left = rows.length - dated.length;
    if (left > 0) {
      notes.push(`left out ${left} ${left === 1 ? "row" : "rows"} without a date`);
    }
    rows = dated;
  }

  // A share of a total has no size without a positive value, and a point needs both an x and a y.
  // A flow with one node per value column leaves out single flows instead of whole rows.
  const positive =
    family === "partOfWhole" || family === "hierarchy" || (family === "flow" && chained(columns));
  if (positive || family === "xy") {
    const charted = rows.filter(({ values }) =>
      positive ? (values[0] ?? 0) > 0 : !values.includes(null),
    );
    const left = rows.length - charted.length;
    if (charted.length === 0) {
      const quoted = quoteAll(valueIndices.map(name));
      throw new Error(
        positive
          ? `A ${spec.type} chart needs positive numbers, but ${quoted} has none.`
          : `No row has numbers in both ${quoted}.`,
      );
    }
    if (left > 0) {
      const without = positive ? "a positive value" : "both an x and a y value";
      notes.push(`left out ${left} ${left === 1 ? "row" : "rows"} without ${without}`);
    }
    rows = charted;
  }
  rows = sortRows(rows, spec.sort);
  if (spec.sort !== undefined && columns.times !== undefined) {
    notes.push("sorted the rows by value rather than in time order, which a line runs back over");
  }
  if (spec.limit !== undefined && rows.length > spec.limit) {
    if (spec.type === "pie" || spec.type === "doughnut") {
      // A row named "Other" in the data is summed up too, rather than becoming a second slice.
      const kept: Row[] = [];
      let other = 0;
      let summed = 0;
      for (const row of rows) {
        if (kept.length < spec.limit && label(row) !== "Other") {
          kept.push(row);
        } else {
          other += row.values[0] ?? 0;
          summed++;
        }
      }
      rows = [...kept, { labels: ["Other"], values: [other] }];
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
    rows = rows.map(({ labels, values }) => ({
      labels,
      values: values.map((value, i) =>
        bytes[i] && value !== null ? value / 1024 ** power : value,
      ),
    }));
  }
  const unit = power > 0 ? ` (${BYTE_UNITS[power]})` : "";
  const names =
    spec.aggregate === "count"
      ? ["rows"]
      : valueIndices.map((index, i) => name(index) + (bytes[i] ? unit : ""));
  return { rows, names };
}

/** A table read as a chart: which columns play which role, and the rows to draw. */
interface Reading {
  spec: ChartSpec;
  family: Family;
  table: DataTable;
  columns: Columns;
  /** The value columns' names, carrying the unit that sizes in bytes are shown in. */
  names: string[];
  rows: Row[];
  /** How the data was read, as the clauses of the summary; the drawing adds to it. */
  notes: string[];
}

export interface Chart {
  /** The ECharts option, as plain JSON that leaves colors, fonts and layout to the webview. */
  option: Record<string, unknown>;
  /** Which columns and rows were charted, e.g. `Charted "size" by "dir".`, for a model. */
  summary: string;
}

/**
 * Builds an ECharts option showing the table as the requested chart, with `spec.options`
 * deep-merged into it. Which columns a chart reads, and what it makes of them, is described at
 * {@link readColumns} and {@link readRows}; the summary says it in words, so that a model whose
 * data was read differently than it meant can ask again with the columns it wants.
 *
 * @throws Error when a column does not exist, or the data holds nothing the chart can show.
 */
export function buildChart(spec: ChartSpec, table: DataTable): Chart {
  const notes: string[] = [];
  const columns = readColumns(spec, table, notes);
  const { rows, names } = readRows(spec, table, columns, notes);
  const reading: Reading = {
    spec,
    family: FAMILIES[spec.type],
    table,
    columns,
    names,
    rows,
    notes,
  };
  const option = drawChart(reading);
  return {
    option: spec.options === undefined ? option : deepMerge(option, spec.options),
    summary: `${summarize(reading)}${notes.map((note) => `; ${note}`).join("")}.`,
  };
}

/** Draws the rows as the requested chart, adding what the drawing worked out to the notes. */
function drawChart(reading: Reading): Record<string, unknown> {
  const { spec, family, table, columns, names, rows, notes } = reading;
  const name = (index: number) => table.columns[index]?.name ?? "";
  const labeled = columns.labels.length > 0;
  const valueName = names[0] ?? "";
  switch (family) {
    case "cartesian":
      return cartesianOption(spec.type as CartesianType, table.header, columns.times, names, rows);
    case "xy":
      return scatterOption(table.header, labeled, columns.times, names, rows);
    case "partOfWhole":
      return spec.type === "funnel"
        ? funnelOption(valueName, spec.sort, rows, notes)
        : pieOption(spec.type === "doughnut", valueName, rows);
    case "profile":
      return radarOption(spec.max, names, rows);
    case "hierarchy":
      return hierarchyOption(
        spec.type === "sunburst" ? "sunburst" : "treemap",
        valueName,
        rows,
        notes,
      );
    case "flow":
      return sankeyOption(chained(columns) ? undefined : names, valueName, rows, notes);
    case "matrix":
      return heatmapOption(table.header, columns.labels.map(name), names, rows, notes);
    case "distribution":
      return boxplotOption(
        table.header,
        labeled ? name(columns.labels[0] ?? 0) : undefined,
        names,
        rows,
        notes,
      );
    case "singleValue": {
      const percent = table.columns[columns.values[0] ?? 0]?.unit === "%";
      return gaugeOption(spec.max, percent, labeled, valueName, rows, notes);
    }
  }
}

/** Which column became which part of the chart, for a model that may have meant another. */
function summarize({ family, table, columns, names }: Reading): string {
  const labels = columns.labels.map((index) => JSON.stringify(table.columns[index]?.name ?? ""));
  const [first = "", second = ""] = labels;
  const values = quoteAll(names);
  const by = labels.length === 0 ? " by row number" : ` by ${labels.join(", ")}`;
  // Points and boxes that no column labels are not "by row number": nothing names them.
  const whenLabeled = labels.length === 0 ? "" : by;
  switch (family) {
    case "xy":
      return columns.times === undefined
        ? `Charted ${JSON.stringify(names[1])} against ${JSON.stringify(names[0])}${whenLabeled}`
        : `Charted ${values} against ${first}`;
    case "profile":
      return `Charted ${values} on an axis each${by}`;
    case "hierarchy":
      return chained(columns)
        ? `Charted ${values} by the levels of ${labels.join(", ")}`
        : `Charted ${values}${by}`;
    case "flow":
      if (labels.length >= 2) {
        return `Charted ${values} as flows from ${labels.join(" to ")}`;
      }
      return columns.separator === undefined
        ? `Charted ${values} as flows from ${first} to a node per value column`
        : `Charted ${values} as flows between the levels of ${first}`;
    case "matrix":
      return labels.length >= 2
        ? `Charted ${values} by ${first} (rows) and ${second} (columns)`
        : `Charted ${values} (columns)${by} (rows)`;
    case "distribution":
      return `Charted the spread of ${values}${whenLabeled}`;
    default:
      return `Charted ${values}${by}`;
  }
}

type CartesianType = Extract<
  ChartType,
  "bar" | "horizontalBar" | "stackedBar" | "line" | "area" | "stackedArea"
>;

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
        data: rows.map((row) => ({ name: label(row), value: row.values[0] })),
      },
    ],
  };
}

/** A funnel of stages, which ECharts orders by value itself, so that any table reads the same. */
function funnelOption(
  name: string,
  sort: ChartSpec["sort"],
  rows: Row[],
  notes: string[],
): Record<string, unknown> {
  if (sort === undefined) {
    notes.push("ordered the stages by value, the largest first");
  }
  return {
    series: [
      {
        type: "funnel",
        name,
        sort: sort === "ascending" ? "ascending" : "descending",
        label: { formatter: "{b}: {c}" },
        data: rows.map((row) => ({ name: label(row), value: row.values[0] })),
      },
    ],
  };
}

/**
 * A scatter chart of one value column against another, or, when the labels are read as dates, of
 * one value column against the times they happened at.
 */
function scatterOption(
  header: boolean,
  labeled: boolean,
  times: string | undefined,
  names: string[],
  rows: Row[],
): Record<string, unknown> {
  // Generated column names ("Column 2") would make poor axis names.
  const axis = (name: string) => ({ type: "value", ...(header ? { name } : {}), scale: true });
  const [xName = "", yName = ""] = names;
  if (times !== undefined) {
    return {
      // The time is the x of a point, which ECharts reads and formats itself.
      xAxis: { type: "time" },
      yAxis: axis(xName),
      series: [
        {
          type: "scatter",
          name: xName,
          data: rows.map((row) => [timeValue(label(row)), row.values[0] ?? null]),
        },
      ],
    };
  }
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

/**
 * A bar or line chart, whose tooltip and legend the webview adds. Labels read as dates become a
 * time axis, which needs each point as a [time, value] pair rather than a bare value.
 */
function cartesianOption(
  type: CartesianType,
  header: boolean,
  times: string | undefined,
  names: string[],
  rows: Row[],
): Record<string, unknown> {
  const line = type === "line" || type === "area" || type === "stackedArea";
  const horizontal = type === "horizontalBar";
  // The first row at the top.
  const inverse = horizontal ? { inverse: true } : {};
  // At the edge rather than at zero, where its labels would cover the negative values.
  const edge = rows.some(({ values }) => values.some((value) => value !== null && value < 0))
    ? { axisLine: { onZero: false } }
    : {};
  const categoryAxis =
    times === undefined
      ? {
          type: "category",
          data: rows.map(label),
          ...(line ? { boundaryGap: false } : {}),
          ...inverse,
          ...edge,
        }
      : // ECharts reads the dates itself and spaces the points by when they happened.
        { type: "time", ...inverse, ...edge };
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
      data: rows.map((row) =>
        times === undefined
          ? (row.values[column] ?? null)
          : horizontal
            ? [row.values[column] ?? null, timeValue(label(row))]
            : [timeValue(label(row)), row.values[column] ?? null],
      ),
    })),
  };
}

/**
 * A radar chart with one axis per value column and one shape per row. Each axis is scaled to its
 * own column, as the columns may be in different units, unless `max` gives them all one top.
 */
function radarOption(
  max: number | undefined,
  names: string[],
  rows: Row[],
): Record<string, unknown> {
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
    return {
      name,
      max: max ?? (high > low ? high : high + 1),
      // ECharts draws an axis from zero unless told otherwise, hiding negative values.
      ...(low < 0 ? { min: low } : {}),
    };
  });
  return {
    // A radar's legend names its shapes, which are data items rather than series.
    ...(rows.length > 1 ? { legend: { data: rows.map(label) } } : {}),
    radar: { indicator },
    series: [
      {
        type: "radar",
        data: rows.map((row) => ({
          name: label(row),
          value: row.values.map((value) => value ?? null),
        })),
      },
    ],
  };
}

/** A node of a hierarchy, before the values of the rows under it are summed up into it. */
interface Level {
  name: string;
  /** The value of the rows that named it, which a leaf alone has (see {@link withoutNests}). */
  own: number;
  children: Map<string, Level>;
}

/** A node of a hierarchy as ECharts takes it. */
interface Node {
  name: string;
  value: number;
  children?: Node[];
}

/**
 * The rows as a hierarchy of their levels, where the value of a node is the total of the rows under
 * it; the rows that other rows nest under are already left out (see {@link withoutNests}).
 *
 * @returns the top-level nodes and how deep they nest.
 */
function buildHierarchy(rows: Row[]): { nodes: Node[]; depth: number } {
  const roots = new Map<string, Level>();
  for (const { labels, values } of rows) {
    let siblings = roots;
    let node: Level | undefined;
    for (const name of labels) {
      let level = siblings.get(name);
      if (level === undefined) {
        level = { name, own: 0, children: new Map() };
        siblings.set(name, level);
      }
      node = level;
      siblings = level.children;
    }
    if (node !== undefined) {
      node.own += values[0] ?? 0;
    }
  }
  let depth = 0;
  const total = (level: Level, deep: number): Node => {
    depth = Math.max(depth, deep);
    if (level.children.size === 0) {
      return { name: level.name, value: level.own };
    }
    const children = [...level.children.values()].map((child) => total(child, deep + 1));
    return {
      name: level.name,
      value: children.reduce((sum, child) => sum + child.value, 0),
      children,
    };
  };
  return { nodes: [...roots.values()].map((root) => total(root, 1)), depth };
}

/**
 * A treemap or sunburst of the hierarchy that the rows' levels build. A single top-level node
 * would be one rectangle holding every other, which would all carry its one color, so the levels
 * that hold every row are left out, as the root directory in `du -a src` output is.
 */
function hierarchyOption(
  type: "treemap" | "sunburst",
  name: string,
  rows: Row[],
  notes: string[],
): Record<string, unknown> {
  const { nodes, depth } = buildHierarchy(rows);
  let data = nodes;
  const dropped: string[] = [];
  while (data.length === 1) {
    const children = data[0]?.children;
    if (children === undefined) {
      break;
    }
    dropped.push(data[0]?.name ?? "");
    data = children;
  }
  const levels = depth - dropped.length;
  if (levels > 1) {
    notes.push(`nested the rows ${levels} levels deep`);
  }
  if (dropped.length > 0) {
    notes.push(`showed what is inside ${quoteAll(dropped)}, which holds every row`);
  }
  return { series: [{ type, name, data }] };
}

/** A flow from one node to another, by name. */
interface Flow {
  source: string;
  target: string;
  value: number;
}

/** Sums the flows that run between the same two nodes, in the order they first appear. */
function sumFlows(flows: Flow[]): Flow[] {
  const summed = new Map<string, Flow>();
  for (const flow of flows) {
    const key = levelKey([flow.source, flow.target]);
    const found = summed.get(key);
    if (found === undefined) {
      summed.set(key, { ...flow });
    } else {
      found.value += flow.value;
    }
  }
  return [...summed.values()];
}

/** The flows of a hierarchy: one from every node to each of its children. */
function hierarchyFlows(nodes: Node[]): Flow[] {
  const flows: Flow[] = [];
  const follow = (node: Node): void => {
    for (const child of node.children ?? []) {
      flows.push({ source: node.name, target: child.name, value: child.value });
      follow(child);
    }
  };
  for (const node of nodes) {
    follow(node);
  }
  return flows;
}

/**
 * A cycle in the flows, as the nodes it runs through, or undefined when they form the directed
 * acyclic graph that a sankey needs. ECharts throws on a cycle without saying where it is.
 */
function findCycle(flows: Flow[]): string[] | undefined {
  const outgoing = new Map<string, string[]>();
  for (const { source, target } of flows) {
    const targets = outgoing.get(source);
    if (targets === undefined) {
      outgoing.set(source, [target]);
    } else {
      targets.push(target);
    }
  }
  const done = new Set<string>();
  for (const start of outgoing.keys()) {
    if (done.has(start)) {
      continue;
    }
    // The nodes of the path followed so far, and how many flows out of each it has followed.
    const path = [start];
    const followed = [0];
    const onPath = new Set([start]);
    while (path.length > 0) {
      const node = path.at(-1) ?? "";
      const targets = outgoing.get(node) ?? [];
      const next = followed.at(-1) ?? 0;
      if (next >= targets.length) {
        done.add(node);
        onPath.delete(node);
        path.pop();
        followed.pop();
        continue;
      }
      followed[followed.length - 1] = next + 1;
      const target = targets[next] ?? "";
      if (onPath.has(target)) {
        return [...path.slice(path.indexOf(target)), target];
      }
      if (!done.has(target)) {
        path.push(target);
        followed.push(0);
        onPath.add(target);
      }
    }
  }
  return undefined;
}

/**
 * A sankey of the flows between the nodes that each row's levels name — its label columns, or the
 * levels of the path in one of them — or, with `targets`, from each row's label to one node per
 * value column, as a table of what a budget comes from and goes to.
 *
 * @throws Error when nothing flows between two nodes, or the flows run in a circle.
 */
function sankeyOption(
  targets: string[] | undefined,
  name: string,
  rows: Row[],
  notes: string[],
): Record<string, unknown> {
  let empty = 0;
  const flows = sumFlows(
    targets === undefined
      ? hierarchyFlows(buildHierarchy(rows).nodes)
      : rows.flatMap((row) =>
          row.values.flatMap((value, column) => {
            if (value === null || value <= 0) {
              empty++;
              return [];
            }
            return [{ source: label(row), target: targets[column] ?? "", value }];
          }),
        ),
  );
  if (empty > 0) {
    notes.push(`left out ${empty} ${empty === 1 ? "flow" : "flows"} without a positive value`);
  }
  // ECharts draws a flow from a node to itself as a band to nowhere, and counts its value twice.
  const drawn = flows.filter((flow) => flow.source !== flow.target);
  const loops = flows.length - drawn.length;
  if (loops > 0) {
    notes.push(`left out ${loops} ${loops === 1 ? "flow" : "flows"} from a node to itself`);
  }
  if (drawn.length === 0) {
    const problem =
      loops > 0
        ? "every flow runs from a node to itself"
        : targets === undefined
          ? "every row holds one level only"
          : `${quoteAll(targets)} holds no positive value`;
    throw new Error(
      `A sankey chart needs flows between two nodes, but ${problem}. Give "labelColumn" as a ` +
        "source and a target column, or chart the values as a bar chart.",
    );
  }
  const cycle = findCycle(drawn);
  if (cycle !== undefined) {
    throw new Error(
      "A sankey chart shows flows in one direction, but these come back around: " +
        `${cycle.map((node) => JSON.stringify(node)).join(" -> ")}. Leave out the rows that flow ` +
        "back, or show the pairs as a heatmap.",
    );
  }
  const nodes: string[] = [];
  const seen = new Set<string>();
  for (const { source, target } of drawn) {
    for (const node of [source, target]) {
      if (!seen.has(node)) {
        seen.add(node);
        nodes.push(node);
      }
    }
  }
  return {
    series: [
      {
        type: "sankey",
        ...(targets === undefined && name ? { name } : {}),
        // Hovering a node dims everything that does not flow through it.
        emphasis: { focus: "adjacency" },
        data: nodes.map((node) => ({ name: node })),
        links: drawn,
      },
    ],
  };
}

/**
 * A heatmap of one value per row and column: a pivot of two label columns, which `labelNames`
 * names, or one column per value column. Rows and columns come in the order they appear in, and
 * the visual map covers the range of the values, in the colors of the panel's theme.
 *
 * @throws Error when no cell holds a number.
 */
function heatmapOption(
  header: boolean,
  labelNames: string[],
  names: string[],
  rows: Row[],
  notes: string[],
): Record<string, unknown> {
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
      const cell = cells.get(`${y} ${x}`);
      if (cell === undefined) {
        cells.set(`${y} ${x}`, [x, y, value]);
      } else {
        cell[2] += value;
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
        cells.set(`${index} ${x}`, [x, index, value]);
      }
    });
  }
  const data = [...cells.values()];
  if (data.length === 0) {
    throw new Error(`A heatmap needs numbers, but ${quoteAll(names)} holds none.`);
  }
  if (summed > 0) {
    notes.push(`summed up ${summed} ${summed === 1 ? "row" : "rows"} into cells that had a value`);
  }
  if (empty > 0) {
    notes.push(`left out ${empty} ${empty === 1 ? "cell" : "cells"} without a value`);
  }
  let min = data[0]?.[2] ?? 0;
  let max = min;
  for (const [, , value] of data) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  // Generated column names ("Column 2") would make poor axis names.
  const axis = (categories: string[], name: string | undefined) => ({
    type: "category",
    data: categories,
    ...(header && name !== undefined ? { name } : {}),
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

/** The quantile of sorted numbers, interpolating between them, as R's default quantile does. */
function quantile(sorted: number[], share: number): number {
  const at = (sorted.length - 1) * share;
  const below = Math.floor(at);
  const value = sorted[below] ?? 0;
  return value + ((sorted[below + 1] ?? value) - value) * (at - below);
}

/**
 * A box plot of the spread of raw numbers: one box per group of rows with the same label, or one
 * per value column when no column labels the rows. ECharts draws the five numbers of a box and
 * only works them out from values through its boxplot transform, which needs a dataset, so they
 * are computed here, the quartiles by interpolating between the sorted values.
 *
 * @throws Error when no group holds a number.
 */
function boxplotOption(
  header: boolean,
  labelName: string | undefined,
  names: string[],
  rows: Row[],
  notes: string[],
): Record<string, unknown> {
  const grouped = new Map<string, number[]>();
  if (labelName === undefined) {
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
    const sorted = numbers.toSorted((x, y) => x - y);
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
    `computed the min, lower quartile, median, upper quartile and max of ${boxes.length} ` +
      `${boxes.length === 1 ? "box" : "boxes"} from ${counted} ` +
      `${counted === 1 ? "value" : "values"}`,
  );
  return {
    xAxis: { type: "category", data: categories },
    // A spread reads against itself rather than against zero.
    yAxis: {
      type: "value",
      ...(header && labelName !== undefined ? { name: names[0] } : {}),
      scale: true,
    },
    series: [
      { type: "boxplot", ...(labelName === undefined ? {} : { name: names[0] }), data: boxes },
    ],
  };
}

/** The next 1, 2 or 5 of a power of ten above a value, as the top of a gauge's scale. */
function niceMax(value: number): number {
  if (!(value > 0)) {
    return 1;
  }
  const power = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 5].map((step) => step * power).find((top) => top > value) ?? 10 * power;
}

/**
 * A gauge showing one number: the first row's value, on a scale to `max` when given, to 100 for
 * percentages, to the total of the column when the other rows make up the rest of it, and
 * otherwise rounded up from the value itself.
 */
function gaugeOption(
  max: number | undefined,
  percent: boolean,
  labeled: boolean,
  name: string,
  rows: Row[],
  notes: string[],
): Record<string, unknown> {
  const shown = rows.find(({ values }) => typeof values[0] === "number");
  const value = shown?.values[0] ?? 0;
  if (rows.length > 1) {
    notes.push(
      `showed the first of ${rows.length} rows, ${JSON.stringify(shown ? label(shown) : "")}`,
    );
  }
  const total = rows.reduce((sum, { values }) => sum + (values[0] ?? 0), 0);
  const [top, reason] =
    max !== undefined
      ? [max, "as given"]
      : percent
        ? [100, "as the values are percentages"]
        : total > value
          ? [total, `the total of ${JSON.stringify(name)}`]
          : [niceMax(value), "rounded up from the value"];
  // A scale needs room: a gauge from 0 to 0 draws nothing.
  const min = Math.min(0, value);
  const scale = top > min ? top : min + 1;
  notes.push(`scaled it ${min < 0 ? `from ${min} ` : ""}to ${scale}, ${reason}`);
  return {
    series: [
      {
        type: "gauge",
        name,
        ...(min < 0 ? { min } : {}),
        max: scale,
        ...(percent ? { detail: { formatter: "{value}%" } } : {}),
        data: [{ name: labeled && shown !== undefined ? label(shown) : name, value }],
      },
    ],
  };
}

const PREVIEW_ROWS = 5;
const TEXT_EXAMPLES = 3;

function describeColumn(table: DataTable, column: number): string {
  const { numeric, unit } = table.columns[column] ?? {};
  if (!numeric) {
    return table.rows.some((row) => row[column] != null) ? "text" : "empty";
  }
  const kind = unit === "bytes" ? "bytes" : unit === "%" ? "percentages" : "numbers";
  // Charts leave out text cells in numeric columns.
  let empty = true;
  let texts = 0;
  const examples: string[] = [];
  for (const row of table.rows) {
    const cell = row[column];
    if (cell != null) {
      empty = false;
    }
    if (typeof cell === "string") {
      texts++;
      if (examples.length < TEXT_EXAMPLES) {
        examples.push(JSON.stringify(cell));
      }
    }
  }
  if (empty) {
    return "empty";
  }
  if (texts === 0) {
    return kind;
  }
  if (texts > TEXT_EXAMPLES) {
    examples.push("…");
  }
  const count = `${texts} text ${texts === 1 ? "cell" : "cells"}`;
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
