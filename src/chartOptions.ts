// The small, editable part of a generated chart request. Data and advanced styling stay on the host.
import { type ChartSpec, validateChartSpec } from "./chartSpec";
import type { Column } from "./data";
import { isPlainObject } from "./protocol";

export type ChartControls = Pick<
  ChartSpec,
  | "type"
  | "labelColumn"
  | "valueColumns"
  | "aggregate"
  | "sort"
  | "limit"
  | "bins"
  | "facetColumn"
  | "facetColumns"
  | "facetScales"
  | "filters"
>;

export interface ChartOptionsState {
  revision: number;
  controls: ChartControls;
  columns: Column[];
  rowCount: number;
  edited: boolean;
  unavailable?: string;
}

export function chartControls(spec: ChartSpec): ChartControls {
  const {
    type,
    labelColumn,
    valueColumns,
    aggregate,
    sort,
    limit,
    bins,
    facetColumn,
    facetColumns,
    facetScales,
    filters,
  } = spec;
  return {
    type,
    labelColumn,
    valueColumns,
    aggregate,
    sort,
    limit,
    bins,
    facetColumn,
    facetColumns,
    facetScales,
    filters,
  };
}

/** Replace all form fields together, never accepting a data source or code from the webview. */
export function withChartControls(spec: ChartSpec, input: unknown): ChartSpec {
  if (!isPlainObject(input)) {
    throw new Error("Chart options must be an object.");
  }
  const keys = Object.keys(chartControls(spec));
  if (Object.keys(input).some((key) => !keys.includes(key))) {
    throw new Error("Only chart controls, facets and filters can be changed here.");
  }
  const result = { ...spec };
  for (const key of keys) {
    delete (result as Record<string, unknown>)[key];
  }
  return validateChartSpec({ ...result, ...input });
}
