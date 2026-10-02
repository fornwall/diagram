// Parses and checks ECharts options written as JSON, or as a JavaScript object literal when a
// callback needs a function, with actionable errors for mistakes that ECharts would silently
// render as nothing.

import { isPlainObject } from "../protocol";
import { describeSourceError, isFunctionAt } from "./jsonErrors";

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
  custom: "cartesian2d",
  radar: "radar",
  parallel: "parallel",
  themeRiver: "singleAxis",
  lines: "geo",
};

function coordinateSystem(series: JsonObject): string | undefined {
  // Custom series can draw directly in pixels, without any coordinate system.
  if (series.coordinateSystem === null) {
    return undefined;
  }
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
 * The series types registered in echartsLibrary.ts, which leaves out map as the panel has no map
 * data.
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
  "custom",
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
};

/** Keys whose values ECharts also accepts as functions, where a function in a string is wrong. */
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
  if (value === null || value === undefined) {
    return String(value);
  }
  return Array.isArray(value) ? "an array" : `a ${typeof value}`;
}

/** Parses the source of an ECharts option, throwing an error that says how to fix it. */
export function parseOption(source: string): JsonObject {
  const option = evaluateSource(source);
  if (!isPlainObject(option)) {
    throw new Error(
      'The ECharts option must be an object such as {"series": [...]}, written as JSON or as a ' +
        `JavaScript object literal, not ${describe(option)}.`,
    );
  }
  validateSeries(baseOption(option));
  findJavaScript(option, "option", new WeakSet());
  return option;
}

/**
 * The source as a value: JSON when it parses, otherwise evaluated as a JavaScript expression, as a
 * custom series' renderItem and other callbacks need. The brackets make a leading "{" an object
 * literal rather than a block, and a top-level "," a list of values rather than a sequence
 * expression that would throw all but the last of them away; the line breaks keep a trailing "//"
 * comment from swallowing the closing bracket.
 */
function evaluateSource(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch (jsonError) {
    const values = evaluateExpressions(source, jsonError);
    if (values.length === 1) {
      return values[0];
    }
    throw new Error(
      values.length === 0
        ? 'The ECharts option is empty. Write the option object, e.g. {"series": [{"type": ' +
            '"bar", "data": [5, 20, 36]}], "xAxis": {"type": "category", "data": ["A", "B", "C"]}, ' +
            '"yAxis": {"type": "value"}}.'
        : `The ECharts option source holds ${values.length} top-level values separated by ",": ` +
            'only one top-level object is allowed, so check for a "}" that closes it too early.',
    );
  }
}

/**
 * The values the source evaluates to as a JavaScript expression, which a top-level "," makes more
 * than one. Only the webview evaluates a source, inside its sandboxed iframe.
 */
function evaluateExpressions(source: string, jsonError: unknown): unknown[] {
  try {
    const evaluate = new Function(`"use strict"; return ([\n${source}\n]);`) as () => unknown[];
    return evaluate();
  } catch (scriptError) {
    throw new Error(describeSourceError(source, jsonError, scriptError));
  }
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

/** Checks that a series has a type the panel has, and what it needs to draw anything. */
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
    const problem = type === "map" ? "unsupported" : "unknown";
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
  if (
    system !== undefined &&
    system !== "none" &&
    system !== "view" &&
    !Object.hasOwn(COORDINATE_COMPONENTS, system)
  ) {
    throw new Error(
      `series[${index}] has the unknown coordinate system "${system}". ` +
        `Use one of: ${Object.keys(COORDINATE_COMPONENTS).join(", ")}, view, none.`,
    );
  }
  const components = system === undefined ? undefined : COORDINATE_COMPONENTS[system];
  if (components?.needs.some((name) => asArray(base[name]).length === 0)) {
    const needs = components.needs.map((name) => `"${name}"`);
    throw new Error(
      `series[${index}] (type "${type}") is drawn on the ${system} coordinate system and needs ` +
        `${needs.length > 1 ? `${needs.slice(0, -1).join(", ")} and ${needs.at(-1)}` : needs[0]}, ` +
        `e.g. ${components.example}.`,
    );
  }
  if (type === "custom" && typeof each.renderItem !== "function") {
    throw new Error(
      `series[${index}] is a "custom" series, which draws nothing without a "renderItem" ` +
        "function. Write the option as a JavaScript object literal rather than JSON, e.g. " +
        '"renderItem": (params, api) => {const [x, y] = api.coord([api.value(0), api.value(1)]); ' +
        'return {type: "circle", shape: {cx: x, cy: y, r: 6}, style: api.style()};}.',
    );
  }
  if (type === "heatmap" && asArray(base.visualMap).length === 0) {
    throw new Error(
      `series[${index}] is a "heatmap" series and needs a "visualMap" to color its cells, e.g. ` +
        '"visualMap": {"min": 0, "max": 10}.',
    );
  }
  const nodes: unknown = each.data ?? each.nodes;
  if (
    type === "graph" &&
    (each.layout ?? "none") === "none" &&
    (each.coordinateSystem === undefined || each.coordinateSystem === "view") &&
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

/**
 * Finds callbacks written as strings, which ECharts draws as the text they are, and objects that
 * contain themselves, which a JavaScript source can build and no chart can be drawn from. A
 * function itself is fine anywhere, as the source may be JavaScript. "inside" holds the objects
 * the walk is inside, which is what a cycle leads back to, rather than every object it has seen,
 * as the same value may well be used in several places.
 */
function findJavaScript(value: unknown, path: string, inside: WeakSet<object>): void {
  if (value === null || typeof value !== "object" || ArrayBuffer.isView(value)) {
    return;
  }
  if (inside.has(value)) {
    throw new Error(
      `${path} refers back to an object that contains it, and a chart cannot be drawn from a ` +
        "cycle. Write out the value that each place needs instead of referring back.",
    );
  }
  inside.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      // Primitive data points cannot contain callbacks; avoid building paths for large datasets.
      if (item !== null && typeof item === "object") {
        findJavaScript(item, `${path}[${index}]`, inside);
      }
    });
    inside.delete(value);
    return;
  }
  if (!isPlainObject(value)) {
    inside.delete(value);
    return;
  }
  // Layout copies inherited properties too, so validate the same values it will copy.
  for (const key in value) {
    const item = value[key];
    const callback = typeof item === "string" && CALLBACK_KEYS.has(key) && isFunctionAt(item);
    if (!callback && (item === null || typeof item !== "object")) {
      continue;
    }
    const itemPath = path === "option" ? key : `${path}.${key}`;
    if (callback) {
      throw new Error(
        `${itemPath} is JavaScript code in a string, which ECharts draws as that text. Write it ` +
          "as a function, as the option itself may be written as JavaScript, or for a simple " +
          'formatter use a string template such as "{b}: {c}" (name and value) or "{d}%" ' +
          "(pie percentage).",
      );
    }
    findJavaScript(item, itemPath, inside);
  }
  inside.delete(value);
}

/** The series types of the option, e.g. "bar, line". */
export function seriesTypes(option: JsonObject): string {
  const types = [baseOption(option), ...asArray(option.options)]
    .flatMap((each) => asArray(each.series))
    .flatMap((each) => (typeof each.type === "string" ? [each.type] : []));
  return Array.from(new Set(types)).join(", ");
}
