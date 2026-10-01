// A request to render data as a chart, as given to the diagram_chart tool, and its validation.

import { isPlainObject } from "./data";

export const CHART_TYPES = [
  "pie",
  "doughnut",
  "bar",
  "horizontalBar",
  "stackedBar",
  "line",
  "area",
  "scatter",
] as const;

export type ChartType = (typeof CHART_TYPES)[number];

export const DATA_FORMATS = ["auto", "csv", "tsv", "json", "whitespace"] as const;

export type DataFormat = (typeof DATA_FORMATS)[number];

const SORT_ORDERS = ["ascending", "descending"] as const;

export interface ChartSpec {
  type: ChartType;
  title?: string;
  // Exactly one of data, file and command gives the data.
  /** Inline data: CSV, TSV, JSON or whitespace-separated columns. */
  data?: string;
  /** A file with the data, absolute or relative to the first workspace folder. */
  file?: string;
  /** A shell command whose standard output is the data, run in the first workspace folder. */
  command?: string;
  /** How the data is formatted; detected when "auto" or not given. */
  format?: DataFormat;
  /** The column with the labels (categories, pie slice names, scatter point names). */
  labelColumn?: string;
  /** The columns with the values, one series each. Defaults to the numeric columns. */
  valueColumns?: string[];
  /** Sorts rows by the first value column. */
  sort?: (typeof SORT_ORDERS)[number];
  /** Keeps only the first rows (after sorting); a pie chart sums the rest up as "Other". */
  limit?: number;
  /** An ECharts option object that is deep-merged into the generated option, for fine-tuning. */
  options?: Record<string, unknown>;
}

const SPEC_KEYS = [
  "type",
  "title",
  "data",
  "file",
  "command",
  "format",
  "labelColumn",
  "valueColumns",
  "sort",
  "limit",
  "options",
] as const satisfies readonly (keyof ChartSpec)[];

export function quoteAll(values: readonly string[]): string {
  return values.map((value) => JSON.stringify(value)).join(", ");
}

/**
 * Checks a chart request from a language model and returns it as a {@link ChartSpec}.
 *
 * @throws Error listing everything that needs to be fixed.
 */
export function validateChartSpec(value: unknown): ChartSpec {
  if (!isPlainObject(value)) {
    throw new Error(
      'The chart spec must be an object, e.g. {"type": "pie", "data": "name,value\\na,1\\nb,2"}.',
    );
  }
  const problems: string[] = [];
  const optionalString = (key: "title" | "labelColumn"): void => {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      problems.push(`"${key}" must be a string.`);
    }
  };

  for (const key of Object.keys(value)) {
    if (!(SPEC_KEYS as readonly string[]).includes(key)) {
      problems.push(`Unknown property "${key}"; the properties are ${quoteAll(SPEC_KEYS)}.`);
    }
  }
  if (!(CHART_TYPES as readonly unknown[]).includes(value.type)) {
    problems.push(
      value.type === undefined
        ? `"type" is missing; it must be one of ${quoteAll(CHART_TYPES)}.`
        : `"type" is ${JSON.stringify(value.type)}; it must be one of ${quoteAll(CHART_TYPES)}.`,
    );
  }
  optionalString("title");
  const sources = (["data", "file", "command"] as const).filter((key) => value[key] !== undefined);
  if (sources.length !== 1) {
    problems.push(
      sources.length === 0
        ? 'Give the data with exactly one of "data" (inline text), "file" (a path) or "command" ' +
            "(a shell command whose output is the data)."
        : `Give only one of ${quoteAll(sources)}, not several.`,
    );
  }
  for (const key of sources) {
    if (typeof value[key] !== "string" || value[key].trim() === "") {
      problems.push(`"${key}" must be a non-empty string.`);
    }
  }
  if (value.format !== undefined && !(DATA_FORMATS as readonly unknown[]).includes(value.format)) {
    problems.push(`"format" must be one of ${quoteAll(DATA_FORMATS)}.`);
  }
  optionalString("labelColumn");
  const valueColumns = value.valueColumns;
  if (
    valueColumns !== undefined &&
    (!Array.isArray(valueColumns) ||
      valueColumns.length === 0 ||
      !valueColumns.every((column) => typeof column === "string"))
  ) {
    problems.push('"valueColumns" must be a non-empty array of column names (strings).');
  }
  if (value.sort !== undefined && !(SORT_ORDERS as readonly unknown[]).includes(value.sort)) {
    problems.push('"sort" must be "ascending" or "descending".');
  }
  if (
    value.limit !== undefined &&
    (typeof value.limit !== "number" || !Number.isInteger(value.limit) || value.limit < 1)
  ) {
    problems.push('"limit" must be a positive integer.');
  }
  if (value.options !== undefined && !isPlainObject(value.options)) {
    problems.push('"options" must be an object (an ECharts option to merge into the chart).');
  }
  if (problems.length > 0) {
    throw new Error(`Invalid chart spec:\n- ${problems.join("\n- ")}`);
  }

  const spec: Record<string, unknown> = {};
  for (const key of SPEC_KEYS) {
    if (value[key] !== undefined) {
      spec[key] = value[key];
    }
  }
  return spec as unknown as ChartSpec;
}
