// The small, editable part of a chart request, changed in the Chart Options form or by
// diagram_updateChart. Data and advanced styling stay on the host.
import { type ChartSpec, type ChartType, FACET_TYPES, validateChartSpec } from "./chartSpec";
import type { Column } from "./data";
import { isPlainObject } from "./protocol";
import { quoteAll, unknownProperties } from "./text";

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

type ChartControls = Pick<ChartSpec, (typeof CONTROL_KEYS)[number]>;

export interface ChartOptionsState {
  revision: number;
  controls: ChartControls;
  columns: Column[];
  rowCount: number;
  edited: boolean;
  unavailable?: string | undefined;
}

export function chartControls(spec: ChartSpec): ChartControls {
  return Object.fromEntries(CONTROL_KEYS.map((key) => [key, spec[key]])) as ChartControls;
}

/** Replace all form fields together, never accepting a data source or code from the webview. */
export function withChartControls(spec: ChartSpec, input: unknown): ChartSpec {
  if (!isPlainObject(input)) {
    throw new Error("Chart options must be an object.");
  }
  const unknown = unknownProperties(input, CONTROL_KEYS);
  if (unknown !== undefined) {
    throw new Error(unknown);
  }
  const result: Record<string, unknown> = { ...spec };
  for (const key of CONTROL_KEYS) {
    delete result[key];
  }
  return validateChartSpec({ ...result, ...input });
}

/** What diagram_updateChart changes: the chart controls, title and maximum, never the source. */
const UPDATE_KEYS = [...CONTROL_KEYS, "title", "max"] as const;

type UpdateKey = (typeof UPDATE_KEYS)[number];

/** Settings to change; null clears an optional one. */
export type ChartUpdateInput = Partial<Pick<ChartSpec, "type" | "title">> & {
  [Key in Exclude<UpdateKey, "type" | "title">]?: ChartSpec[Key] | null;
} & { revision?: number };

/** A partial update; source and advanced options cannot be replaced through this tool. */
export function updatedChartSpec(spec: ChartSpec, input: unknown): ChartSpec {
  if (!isPlainObject(input)) {
    throw new Error("Chart updates must be an object.");
  }
  const unknown = Object.keys(input).filter(
    (key) => key !== "revision" && !(UPDATE_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw new Error(
      `${quoteAll(unknown)} cannot be updated; only ${quoteAll(UPDATE_KEYS)} and "revision" can. ` +
        "The data, its source and styling options are kept.",
    );
  }
  if (
    input.revision !== undefined &&
    (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0)
  ) {
    throw new Error('"revision" must be a nonnegative integer from diagram_getState.');
  }
  if (!UPDATE_KEYS.some((key) => Object.hasOwn(input, key))) {
    throw new Error(`Give at least one chart setting to change: ${quoteAll(UPDATE_KEYS)}.`);
  }
  if (input.type === null || input.title === null) {
    throw new Error('"type" and "title" cannot be cleared with null.');
  }
  const { revision: _, ...changes } = input;
  const result: Record<string, unknown> = { ...spec, ...changes };
  if (typeof changes.type === "string" && changes.type !== spec.type) {
    // As the Chart Options form does, a new type drops the settings it cannot use, unless given.
    for (const key of unusableSettings(changes.type as ChartType)) {
      if (!Object.hasOwn(changes, key)) delete result[key];
    }
  }
  return validateChartSpec(result);
}

/** The chart settings that a type of chart cannot use, which the Chart Options form clears too. */
export function unusableSettings(type: ChartType) {
  const keys =
    type === "histogram"
      ? (["labelColumn", "aggregate", "sort", "limit"] as const)
      : (["bins"] as const);
  return FACET_TYPES.includes(type)
    ? keys
    : ([...keys, "facetColumn", "facetColumns", "facetScales"] as const);
}
