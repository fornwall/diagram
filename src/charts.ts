// Turning a table and a chart request into an Apache ECharts option.

import { type ChartSpec, type ChartType, quoteAll } from "./chartSpec";
import { type Cell, type DataTable, hasTotalsRow, isNumericColumn, isPlainObject } from "./data";

/** Finds a column by name, exactly or else ignoring case and surrounding spaces. */
function findColumn(table: DataTable, name: string, role: string): number {
  const exact = table.columns.indexOf(name);
  if (exact !== -1) {
    return exact;
  }
  const wanted = name.trim().toLowerCase();
  const loose = table.columns.findIndex((column) => column.trim().toLowerCase() === wanted);
  if (loose !== -1) {
    return loose;
  }
  throw new Error(
    `Unknown ${role} column ${JSON.stringify(name)}. Available columns: ${quoteAll(table.columns)}.`,
  );
}

function describeColumns(table: DataTable): string {
  return table.columns
    .map((name, i) => `${JSON.stringify(name)} (${isNumericColumn(table, i) ? "number" : "text"})`)
    .join(", ");
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
  const name = (table.columns[column] ?? "").trim();
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
 * The default value columns: the numeric columns other than the label column, leaving out
 * identifier columns (see {@link isIdColumn}) unless nothing else is left.
 */
function defaultValueColumns(
  table: DataTable,
  numeric: boolean[],
  labelIndex: number | undefined,
): number[] {
  const candidates = table.columns.flatMap((_, i) => (numeric[i] && i !== labelIndex ? [i] : []));
  const named = candidates.filter((i) => !isIdColumn(table, i, false));
  const kept = named.length > 0 ? named : candidates;
  const unnumbered = kept.filter((i) => !isIdColumn(table, i, true));
  return unnumbered.length > 0 ? unnumbered : kept;
}

interface Row {
  label: string;
  values: (number | null)[];
}

function labelOf(cell: Cell | undefined): string {
  return cell === null || cell === undefined ? "" : String(cell);
}

/** The rows to chart: sorted by the first value, and limited (pie charts get an "Other" slice). */
function selectRows(spec: ChartSpec, rows: Row[], pie: boolean): Row[] {
  let selected = rows;
  if (spec.sort !== undefined) {
    const direction = spec.sort === "ascending" ? 1 : -1;
    selected = [...rows].sort((a, b) => {
      const x = a.values[0] ?? null;
      const y = b.values[0] ?? null;
      if (x === null || y === null) {
        return x === y ? 0 : x === null ? 1 : -1;
      }
      return (x - y) * direction;
    });
  }
  if (spec.limit !== undefined && selected.length > spec.limit) {
    const rest = selected.slice(spec.limit);
    selected = selected.slice(0, spec.limit);
    if (pie) {
      const other = rest.reduce((sum, row) => sum + (row.values[0] ?? 0), 0);
      selected.push({ label: "Other", values: [other] });
    }
  }
  return selected;
}

const FEW_POINTS = 30;

const CARTESIAN_SERIES: Record<
  Exclude<ChartType, "pie" | "doughnut" | "scatter">,
  Record<string, unknown>
> = {
  bar: { type: "bar" },
  horizontalBar: { type: "bar" },
  stackedBar: { type: "bar", stack: "total" },
  line: { type: "line", smooth: false },
  area: { type: "line", smooth: false, areaStyle: { opacity: 0.3 } },
};

/**
 * Builds an Apache ECharts option that shows the table as the requested chart, with
 * `spec.options` deep-merged into it. The option is plain JSON and leaves colors, fonts, layout
 * and title to the webview.
 *
 * The label column defaults to the first column that is mostly non-numeric (else the first
 * column), and the value columns to all other numeric columns, one series each, except identifier
 * columns such as "id" or a column numbering the rows 1, 2, 3, …. A last row that totals the others,
 * such as the "total" row of wc -l, is left out. Pie and doughnut
 * charts show the first value column only; scatter charts plot the first value column against the
 * second, naming each point by its label. Every data item carries a `name`, so that clicks report
 * the label.
 *
 * @throws Error when a column does not exist, there are no numeric values to chart, or there are
 *   no rows.
 */
export function buildChartOption(spec: ChartSpec, table: DataTable): Record<string, unknown> {
  if (table.rows.length === 0) {
    throw new Error("The data has no rows to chart.");
  }
  const scatter = spec.type === "scatter";
  const pie = spec.type === "pie" || spec.type === "doughnut";
  const numeric = table.columns.map((_, i) => isNumericColumn(table, i));

  let labelIndex: number | undefined;
  if (spec.labelColumn !== undefined) {
    labelIndex = findColumn(table, spec.labelColumn, "label");
  } else {
    const firstText = numeric.indexOf(false);
    // A scatter chart of numbers alone needs no label column; other charts use the first column.
    labelIndex = firstText !== -1 ? firstText : scatter ? undefined : 0;
  }

  const valueIndices =
    spec.valueColumns !== undefined
      ? spec.valueColumns.map((name) => findColumn(table, name, "value"))
      : defaultValueColumns(table, numeric, labelIndex);
  if (valueIndices.length === 0) {
    throw new Error(
      `No numeric value columns to chart. The columns are ${describeColumns(table)}; ` +
        'set "valueColumns" (and "labelColumn") to columns that hold numbers.',
    );
  }
  for (const index of valueIndices) {
    if (!table.rows.some((row) => typeof row[index] === "number")) {
      throw new Error(
        `The value column ${JSON.stringify(table.columns[index])} holds no numbers. ` +
          `The columns are ${describeColumns(table)}.`,
      );
    }
  }
  if (scatter && valueIndices.length < 2) {
    throw new Error(
      "A scatter chart needs two numeric columns (x and y), but there is only " +
        `${JSON.stringify(table.columns[valueIndices[0] ?? 0])}. The columns are ` +
        `${describeColumns(table)}.`,
    );
  }

  const totals = labelIndex !== undefined && hasTotalsRow(table, labelIndex, valueIndices);
  const rows = selectRows(
    spec,
    (totals ? table.rows.slice(0, -1) : table.rows).map((row) => ({
      label: labelIndex === undefined ? "" : labelOf(row[labelIndex]),
      values: valueIndices.map((index) => {
        const cell = row[index];
        return typeof cell === "number" ? cell : null;
      }),
    })),
    pie,
  );
  const names = valueIndices.map((index) => table.columns[index] ?? "");

  let option: Record<string, unknown>;
  if (pie) {
    option = pieOption(spec.type === "doughnut", names[0] ?? "", rows);
  } else if (scatter) {
    option = scatterOption(names, rows);
  } else {
    option = cartesianOption(spec.type as keyof typeof CARTESIAN_SERIES, names, rows);
  }
  return spec.options === undefined ? option : deepMerge(option, spec.options);
}

/** Names an axis after its column, unless the data had no header to name the column. */
function axisName(column: string | undefined): { name?: string } {
  return column === undefined || /^Column \d+$/.test(column) ? {} : { name: column };
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
        avoidLabelOverlap: true,
        label: { formatter: "{b}: {d}%" },
        data: rows
          .filter((row) => row.values[0] !== null && row.values[0] !== undefined)
          .map((row) => ({ name: row.label, value: row.values[0] })),
      },
    ],
  };
}

function scatterOption(names: string[], rows: Row[]): Record<string, unknown> {
  const [xName = "", yName = ""] = names;
  const data = rows.flatMap((row) => {
    const [x, y] = row.values;
    if (x === null || x === undefined || y === null || y === undefined) {
      return [];
    }
    return [{ name: row.label === "" ? `(${x}, ${y})` : row.label, value: [x, y] }];
  });
  return {
    tooltip: { trigger: "item", formatter: "{b}: ({c})" },
    xAxis: { type: "value", ...axisName(xName), scale: true },
    yAxis: { type: "value", ...axisName(yName), scale: true },
    series: [{ type: "scatter", name: yName, data }],
  };
}

function cartesianOption(
  type: keyof typeof CARTESIAN_SERIES,
  names: string[],
  rows: Row[],
): Record<string, unknown> {
  const several = names.length > 1;
  const labels = rows.map((row) => row.label);
  const isLine = type === "line" || type === "area";
  const categoryAxis: Record<string, unknown> = {
    type: "category",
    data: labels,
    axisLabel: { hideOverlap: true },
    ...(isLine ? { boundaryGap: false } : {}),
    ...(type === "horizontalBar" ? { inverse: true } : {}),
  };
  const valueAxis: Record<string, unknown> = {
    type: "value",
    ...(several ? {} : axisName(names[0])),
  };
  const series = names.map((name, column) => ({
    ...structuredClone(CARTESIAN_SERIES[type]),
    name,
    ...(isLine ? { showSymbol: rows.length <= FEW_POINTS } : {}),
    ...(several ? { emphasis: { focus: "series" } } : {}),
    data: rows.map((row) => ({ name: row.label, value: row.values[column] ?? null })),
  }));
  const horizontal = type === "horizontalBar";
  return {
    tooltip: { trigger: "axis", axisPointer: { type: isLine ? "line" : "shadow" } },
    ...(several ? { legend: { type: "scroll" } } : {}),
    xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? categoryAxis : valueAxis,
    series,
  };
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
 * Returns a deep merge of source into target, without changing either. Plain objects are merged
 * recursively, and other values replace the target's. Arrays replace the target's too, except that
 * an array of objects merges element-wise into an array (so `{"series": [{"label": {...}}]}`
 * adjusts the first series), and an object merges into each object of an array (so
 * `{"series": {"label": {...}}}` adjusts every series).
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
