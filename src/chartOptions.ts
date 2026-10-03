// The small, editable part of a generated chart request. Data and advanced styling stay on the host.
import { type ChartSpec, validateChartSpec } from "./chartSpec";
import type { Column } from "./data";
import { isPlainObject } from "./protocol";

const CONTROL_KEYS = [
  "type",
  "labelColumn",
  "valueColumns",
  "aggregate",
  "sort",
  "limit",
  "bins",
  "facetColumn",
  "facetColumns",
  "facetScales",
  "filters",
] as const satisfies readonly (keyof ChartSpec)[];

export type ChartControls = Pick<ChartSpec, (typeof CONTROL_KEYS)[number]>;

export interface ChartOptionsState {
  revision: number;
  controls: ChartControls;
  columns: Column[];
  rowCount: number;
  edited: boolean;
  unavailable?: string;
}

export function chartControls(spec: ChartSpec): ChartControls {
  return Object.fromEntries(CONTROL_KEYS.map((key) => [key, spec[key]])) as ChartControls;
}

/** Replace all form fields together, never accepting a data source or code from the webview. */
export function withChartControls(spec: ChartSpec, input: unknown): ChartSpec {
  if (!isPlainObject(input)) {
    throw new Error("Chart options must be an object.");
  }
  if (Object.keys(input).some((key) => !CONTROL_KEYS.some((control) => control === key))) {
    throw new Error("Only chart controls, facets and filters can be changed here.");
  }
  const result: Record<string, unknown> = { ...spec };
  for (const key of CONTROL_KEYS) {
    delete result[key];
  }
  return validateChartSpec({ ...result, ...input });
}
