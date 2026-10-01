// Parses and checks ECharts options written as JSON, with actionable errors for mistakes that
// ECharts would silently render as nothing.

import { isPlainObject } from "../protocol";
import { describeJsonError, isFunctionAt } from "./jsonErrors";

export type JsonObject = Record<string, unknown>;

/** ECharts accepts most components as a single object or an array of them. */
export function asArray(value: unknown): JsonObject[] {
  if (Array.isArray(value)) {
    return value.filter(isPlainObject);
  }
  return isPlainObject(value) ? [value] : [];
}

/** The option that holds the components: the base option of a timeline, or the option itself. */
export function baseOption(option: JsonObject): JsonObject {
  return isPlainObject(option.baseOption) ? option.baseOption : option;
}

/** The coordinate system that each series type is drawn on, unless the series sets another. */
const DEFAULT_COORDINATE_SYSTEMS: Record<string, string> = {
  line: "cartesian2d",
  bar: "cartesian2d",
  scatter: "cartesian2d",
  effectScatter: "cartesian2d",
  pictorialBar: "cartesian2d",
  candlestick: "cartesian2d",
  boxplot: "cartesian2d",
  heatmap: "cartesian2d",
  radar: "radar",
  parallel: "parallel",
  themeRiver: "singleAxis",
  lines: "geo",
};

function coordinateSystem(series: JsonObject): string | undefined {
  return typeof series.coordinateSystem === "string"
    ? series.coordinateSystem
    : DEFAULT_COORDINATE_SYSTEMS[String(series.type)];
}

export const isCartesian = (series: JsonObject) => coordinateSystem(series) === "cartesian2d";

/** The components that each coordinate system needs, without which ECharts throws or draws nothing. */
const COORDINATE_COMPONENTS: Record<string, { needs: string[]; example: string }> = {
  cartesian2d: {
    needs: ["xAxis", "yAxis"],
    example: '"xAxis": {"type": "category", "data": ["Mon", "Tue"]}, "yAxis": {"type": "value"}',
  },
  polar: {
    needs: ["polar", "angleAxis", "radiusAxis"],
    example:
      '"polar": {}, "angleAxis": {"type": "category", "data": ["N", "E", "S", "W"]}, "radiusAxis": {}',
  },
  radar: {
    needs: ["radar"],
    example:
      '"radar": {"indicator": [{"name": "Speed", "max": 100}, {"name": "Cost", "max": 100}]}',
  },
  parallel: {
    needs: ["parallelAxis"],
    example: '"parallelAxis": [{"dim": 0, "name": "Price"}, {"dim": 1, "name": "Weight"}]',
  },
  singleAxis: { needs: ["singleAxis"], example: '"singleAxis": {"type": "time"}' },
  calendar: { needs: ["calendar"], example: '"calendar": {"range": "2026"}' },
  matrix: {
    needs: ["matrix"],
    example: '"matrix": {"x": {"data": ["A", "B"]}, "y": {"data": ["C", "D"]}}',
  },
};

/**
 * Series types that work from JSON, as registered in echartsLibrary.ts: map needs map data and
 * custom a renderItem function.
 */
export const SERIES_TYPES = [
  "line",
  "bar",
  "pie",
  "scatter",
  "effectScatter",
  "radar",
  "tree",
  "treemap",
  "sunburst",
  "graph",
  "chord",
  "gauge",
  "funnel",
  "parallel",
  "sankey",
  "boxplot",
  "candlestick",
  "lines",
  "heatmap",
  "pictorialBar",
  "themeRiver",
];

const DONUT = 'for a donut chart, use "pie" with "radius": ["45%", "72%"]';
const TYPE_HINTS: Record<string, string> = {
  donut: DONUT,
  doughnut: DONUT,
  ring: DONUT,
  area: 'for an area chart, use "line" with "areaStyle": {}',
  column: 'for a column chart, use "bar"',
  histogram: 'for a histogram, use "bar"',
  bubble: 'for a bubble chart, use "scatter" with "symbolSize"',
  spline: 'for a smooth line, use "line" with "smooth": true',
  network: 'for a network, use "graph"',
  flow: 'for flows between nodes, use "sankey"',
  map: 'geographic maps are not available in the panel, as it has no map data; use e.g. "bar" by region',
  custom:
    "custom series need a renderItem function, which JSON cannot express; use a built-in type",
};

/** Keys whose values ECharts also accepts as functions, which JSON cannot express. */
const CALLBACK_KEYS = new Set([
  "formatter",
  "valueFormatter",
  "renderItem",
  "symbol",
  "symbolSize",
  "position",
  "color",
  "sort",
  "labelLayout",
  "animationDelay",
  "animationDelayUpdate",
  "animationDuration",
  "animationDurationUpdate",
]);

function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  return Array.isArray(value) ? "an array" : `a ${typeof value}`;
}

/** Parses the source of an ECharts option, throwing an error that says how to fix it. */
export function parseOption(source: string): JsonObject {
  let option: unknown;
  try {
    option = JSON.parse(source);
  } catch (error) {
    throw new Error(describeJsonError(source, error));
  }
  if (!isPlainObject(option)) {
    throw new Error(
      `The ECharts option must be a JSON object such as {"series": [...]}, not ${describe(option)}.`,
    );
  }
  validateSeries(baseOption(option));
  findJavaScript(option, "option");
  return option;
}

/** Checks the series of the base option; timeline options only patch them. */
function validateSeries(base: JsonObject): void {
  const series: unknown[] = Array.isArray(base.series)
    ? base.series
    : base.series === undefined
      ? []
      : [base.series];
  if (series.length === 0) {
    throw new Error(
      'The ECharts option has no "series". Add at least one, e.g. "series": [{"type": "bar", ' +
        '"data": [5, 20, 36]}] with "xAxis": {"type": "category", "data": ["A", "B", "C"]} and ' +
        '"yAxis": {"type": "value"}.',
    );
  }
  series.forEach((each, index) => {
    checkSeries(each, index, base);
  });
  if (base.geo !== undefined) {
    throw new Error(
      'The "geo" component is not available in the diagram panel, as it has no map data. ' +
        "Use another chart type.",
    );
  }
}

/** Checks that a series has a type that works from JSON, and what it needs to draw anything. */
function checkSeries(each: unknown, index: number, base: JsonObject): void {
  if (!isPlainObject(each)) {
    throw new Error(
      `series[${index}] must be an object such as {"type": "bar", "data": [5, 20, 36]}, not ${describe(each)}.`,
    );
  }
  const type = each.type;
  if (typeof type !== "string" || !type) {
    throw new Error(
      `series[${index}] has no "type". Set it to one of: ${SERIES_TYPES.join(", ")}.`,
    );
  }
  if (!SERIES_TYPES.includes(type)) {
    const sameName = SERIES_TYPES.find((known) => known.toLowerCase() === type.toLowerCase());
    const hint = sameName
      ? `types are case-sensitive: "${sameName}"`
      : TYPE_HINTS[type.toLowerCase()];
    const problem = type === "map" || type === "custom" ? "unsupported" : "unknown";
    throw new Error(
      `series[${index}] has the ${problem} type "${type}"${hint ? ` (${hint})` : ""}. ` +
        `Valid types: ${SERIES_TYPES.join(", ")}.`,
    );
  }
  const system = coordinateSystem(each);
  if (system === "geo" || system === "bmap") {
    throw new Error(
      `series[${index}] (type "${type}") is drawn on a map${each.coordinateSystem ? "" : " by default"}, ` +
        'but the panel has no map data; set "coordinateSystem": "cartesian2d" and add "xAxis" and "yAxis".',
    );
  }
  const components = system === undefined ? undefined : COORDINATE_COMPONENTS[system];
  if (components?.needs.some((name) => base[name] === undefined)) {
    const needs = components.needs.map((name) => `"${name}"`);
    throw new Error(
      `series[${index}] (type "${type}") is drawn on the ${system} coordinate system and needs ` +
        `${needs.length > 1 ? `${needs.slice(0, -1).join(", ")} and ${needs.at(-1)}` : needs[0]}, ` +
        `e.g. ${components.example}.`,
    );
  }
  if (type === "heatmap" && base.visualMap === undefined) {
    throw new Error(
      `series[${index}] is a "heatmap" series and needs a "visualMap" to color its cells, e.g. ` +
        '"visualMap": {"min": 0, "max": 10}.',
    );
  }
  const nodes: unknown = each.data ?? each.nodes;
  if (
    type === "graph" &&
    (each.layout ?? "none") === "none" &&
    each.coordinateSystem === undefined &&
    Array.isArray(nodes) &&
    nodes.some(
      (node) => !isPlainObject(node) || typeof node.x !== "number" || typeof node.y !== "number",
    )
  ) {
    throw new Error(
      `series[${index}] is a "graph" series without "layout", whose nodes need "x" and "y" to be ` +
        'drawn; set "layout": "force" or "circular" to place them automatically.',
    );
  }
}

/** Finds strings with JavaScript functions where ECharts would accept a callback. */
function findJavaScript(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      findJavaScript(item, `${path}[${index}]`);
    });
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const itemPath = path === "option" ? key : `${path}.${key}`;
    if (CALLBACK_KEYS.has(key) && typeof item === "string" && isFunctionAt(item)) {
      throw new Error(
        `${itemPath} is JavaScript code, but the option is JSON and cannot contain functions. ` +
          'Use a string template instead, such as "{b}: {c}" (name and value) or "{d}%" (pie percentage).',
      );
    }
    findJavaScript(item, itemPath);
  }
}

/** The series types of the option, e.g. "bar, line". */
export function seriesTypes(option: JsonObject): string {
  const types = [baseOption(option), ...asArray(option.options)]
    .flatMap((each) => asArray(each.series))
    .flatMap((each) => (typeof each.type === "string" ? [each.type] : []));
  return Array.from(new Set(types)).join(", ");
}
