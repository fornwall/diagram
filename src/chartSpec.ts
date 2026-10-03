// A request to render data as a chart, as given to the diagram_chart tool, and its validation.

import { isPlainObject } from "./protocol";

export const CHART_TYPES = [
  "pie",
  "doughnut",
  "bar",
  "horizontalBar",
  "stackedBar",
  "line",
  "area",
  "stackedArea",
  "scatter",
  "histogram",
  "treemap",
  "sunburst",
  "sankey",
  "heatmap",
  "radar",
  "boxplot",
  "gauge",
  "funnel",
] as const;

export type ChartType = (typeof CHART_TYPES)[number];

export const DATA_FORMATS = ["auto", "csv", "tsv", "json", "whitespace"] as const;

export type DataFormat = (typeof DATA_FORMATS)[number];

const SORT_ORDERS = ["ascending", "descending"] as const;

/** How the rows of a group combine into one row; see {@link ChartSpec.aggregate}. */
export const AGGREGATIONS = ["sum", "mean", "count", "min", "max", "median"] as const;

export type Aggregation = (typeof AGGREGATIONS)[number];

export const FILTER_OPERATORS = ["eq", "neq", "lt", "lte", "gt", "gte", "contains"] as const;

/** A predicate on parsed cells; all predicates must match before other chart transforms. */
export interface ChartFilter {
  column: string;
  op: (typeof FILTER_OPERATORS)[number];
  value: string | number | null;
}

/**
 * Where a chart's data comes from: inline, a file (absolute or relative to the first workspace
 * folder), or a shell command whose standard output is the data, run in the first workspace folder.
 */
type ChartData =
  | { data: string; file?: undefined; command?: undefined }
  | { data?: undefined; file: string; command?: undefined }
  | { data?: undefined; file?: undefined; command: string };

export type ChartSpec = ChartData & {
  type: ChartType;
  title?: string;
  /** How the data is formatted; detected when "auto" or not given. */
  format?: DataFormat;
  /**
   * The column with the labels (categories, pie slice names, scatter point names), or several
   * columns for the levels of a treemap or sunburst, the source and target of a sankey, or the
   * rows and columns of a heatmap.
   */
  labelColumn?: string | string[];
  /** The columns with the values, one series each. */
  valueColumns?: string[];
  /** The top of a gauge's or radar chart's scale, in input units (bytes for sizes). */
  max?: number;
  /**
   * Collapses the rows that share a label (or, with several label columns, the same labels) into
   * one, combining the values of each group this way. "count" counts the rows of a group, with no
   * value column needed.
   */
  aggregate?: Aggregation;
  /** Sorts rows by the first value column. */
  sort?: (typeof SORT_ORDERS)[number];
  /** Keeps only the first rows (after sorting); a pie chart sums the rest up as "Other". */
  limit?: number;
  /** Equal-width histogram bins; inferred when omitted. */
  bins?: number;
  /** Partition a Cartesian chart into one panel per distinct value of this column. */
  facetColumn?: string;
  /** Number of panels per row; inferred when omitted. */
  facetColumns?: number;
  /** Share axis domains across panels by default. */
  facetScales?: "shared" | "independent";
  /** Keep rows matching every predicate before grouping, binning, sorting or limiting. */
  filters?: ChartFilter[];
  /** An ECharts option object that is deep-merged into the generated option, for fine-tuning. */
  options?: Record<string, unknown>;
};

const SPEC_KEYS = [
  "type",
  "title",
  "data",
  "file",
  "command",
  "format",
  "labelColumn",
  "valueColumns",
  "max",
  "aggregate",
  "sort",
  "limit",
  "bins",
  "facetColumn",
  "facetColumns",
  "facetScales",
  "filters",
  "options",
] as const satisfies readonly (keyof ChartSpec)[];

/** Where a chart's data comes from, e.g. "file sales.csv", "command `du -s *`" or "inline data". */
export function dataOrigin({ file, command }: ChartSpec): string {
  if (file !== undefined) {
    return `file ${file}`;
  }
  return command !== undefined ? `command \`${command}\`` : "inline data";
}

export function quoteAll(values: readonly string[]): string {
  return values.map((value) => JSON.stringify(value)).join(", ");
}

function isOneOf(values: readonly string[], value: unknown): boolean {
  return (values as readonly unknown[]).includes(value);
}

/** Whether a value names columns: a non-empty array of strings, as the column properties take. */
function isColumnNames(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every((n) => typeof n === "string");
}

/**
 * Checks a chart request from a language model, the input of the chart tool, and returns it as a
 * {@link ChartSpec}. Its "clickPrompt" is left out, as the panel handles it for any diagram.
 *
 * @throws Error listing everything that needs to be fixed.
 */
export function validateChartSpec(value: unknown): ChartSpec {
  if (!isPlainObject(value)) {
    throw new Error(
      'The chart spec must be an object, e.g. {"type": "pie", "data": "name,value\\na,1\\nb,2"}.',
    );
  }
  // Some models send null for the properties they leave out.
  const { clickPrompt: _, ...input } = Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== null && item !== undefined),
  );
  // And JSON data as JSON rather than as text, which reads the same.
  if (Array.isArray(input.data) || isPlainObject(input.data)) {
    input.data = JSON.stringify(input.data);
  }
  const problems: string[] = [];
  const expect = (key: keyof ChartSpec, valid: boolean, what: string): void => {
    if (input[key] !== undefined && !valid) {
      problems.push(`"${key}" is ${brief(input[key])}; it must be ${what}.`);
    }
  };

  const unknown = Object.keys(input).filter((key) => !isOneOf(SPEC_KEYS, key));
  if (unknown.length > 0) {
    problems.push(
      `Unknown ${unknown.length === 1 ? "property" : "properties"} ${quoteAll(unknown)}; ` +
        `the properties are ${quoteAll([...SPEC_KEYS, "clickPrompt"])}.`,
    );
  }
  if (input.type === undefined) {
    problems.push(`"type" is missing; it must be one of ${quoteAll(CHART_TYPES)}.`);
  }
  expect("type", isOneOf(CHART_TYPES, input.type), `one of ${quoteAll(CHART_TYPES)}`);
  expect("title", typeof input.title === "string", "a string");
  const sources = (["data", "file", "command"] as const).filter((key) => input[key] !== undefined);
  if (sources.length !== 1) {
    problems.push(
      sources.length === 0
        ? 'Give the data with exactly one of "data" (inline text), "file" (a path) or "command" ' +
            "(a shell command whose output is the data)."
        : `Give only one of ${quoteAll(sources)}, not several.`,
    );
  }
  for (const key of sources) {
    const text = input[key];
    expect(key, typeof text === "string" && text.trim() !== "", "a non-empty string");
  }
  expect("format", isOneOf(DATA_FORMATS, input.format), `one of ${quoteAll(DATA_FORMATS)}`);
  expect(
    "labelColumn",
    typeof input.labelColumn === "string" || isColumnNames(input.labelColumn),
    "a column name, or an array of them for the levels of a hierarchy, a source and a target, " +
      'or rows and columns, e.g. ["from", "to"]',
  );
  expect(
    "valueColumns",
    isColumnNames(input.valueColumns),
    'a non-empty array of column names, e.g. ["size"]',
  );
  const max = input.max;
  expect(
    "max",
    typeof max === "number" && Number.isFinite(max),
    "a number (the top of a gauge's or a radar chart's scale)",
  );
  expect(
    "aggregate",
    isOneOf(AGGREGATIONS, input.aggregate),
    `one of ${quoteAll(AGGREGATIONS)} (how the rows of a group combine)`,
  );
  expect("sort", isOneOf(SORT_ORDERS, input.sort), `one of ${quoteAll(SORT_ORDERS)}`);
  const limit = input.limit;
  expect(
    "limit",
    typeof limit === "number" && Number.isInteger(limit) && limit >= 1,
    "a positive integer",
  );
  expect(
    "options",
    isPlainObject(input.options),
    "an object (an ECharts option to merge into the chart)",
  );
  for (const [key, upper] of [
    ["bins", 200],
    ["facetColumns", 4],
  ] as const) {
    const count = input[key];
    expect(
      key,
      typeof count === "number" && Number.isInteger(count) && count >= 1 && count <= upper,
      `an integer from 1 to ${upper}`,
    );
  }
  expect(
    "facetColumn",
    typeof input.facetColumn === "string" && input.facetColumn.trim() !== "",
    "a non-empty column name",
  );
  expect(
    "facetScales",
    isOneOf(["shared", "independent"], input.facetScales),
    '"shared" or "independent"',
  );
  expect(
    "filters",
    Array.isArray(input.filters) && input.filters.length <= 50,
    "an array of at most 50 filters",
  );
  if (Array.isArray(input.filters) && input.filters.length <= 50) {
    for (const [index, filter] of input.filters.entries()) {
      if (
        !isPlainObject(filter) ||
        Object.keys(filter).some((key) => !["column", "op", "value"].includes(key)) ||
        typeof filter.column !== "string" ||
        !filter.column.trim() ||
        !isOneOf(FILTER_OPERATORS, filter.op) ||
        !(
          filter.value === null ||
          typeof filter.value === "string" ||
          (typeof filter.value === "number" && Number.isFinite(filter.value))
        )
      ) {
        problems.push(
          `filters[${index}] must contain column, op (${FILTER_OPERATORS.join(", ")}) and a string, finite number or null value.`,
        );
        continue;
      }
      if (
        ["lt", "lte", "gt", "gte"].includes(String(filter.op)) &&
        typeof filter.value !== "number"
      ) {
        problems.push(`filters[${index}]: numeric comparisons require a number value.`);
      }
      if (filter.op === "contains" && typeof filter.value !== "string") {
        problems.push(`filters[${index}]: contains requires a string value.`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`Invalid chart spec:\n- ${problems.join("\n- ")}`);
  }
  return input as ChartSpec;
}

/** A value as quoted in an error message: JSON, shortened. */
function brief(value: unknown): string {
  if (Array.isArray(value)) {
    return "an array";
  }
  if (isPlainObject(value)) {
    return "an object";
  }
  const json = JSON.stringify(value);
  return json.length > 40 ? `${json.slice(0, 40)}…` : json;
}
