// A request to render data as a chart, as given to the diagram_chart tool or in a ```chart block.

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

export interface ChartSpec {
  type: ChartType;
  title?: string;
  /** Exactly one of data, file and command gives the data. */
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
  /** The columns with the values, one series each. Defaults to all numeric columns. */
  valueColumns?: string[];
  /** Sorts rows by the first value column. */
  sort?: "ascending" | "descending";
  /** Keeps only the first rows (after sorting); a pie chart sums the rest up as "Other". */
  limit?: number;
  /** An ECharts option object that is deep-merged into the generated option, for fine-tuning. */
  options?: Record<string, unknown>;
}
