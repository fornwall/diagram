// Reads ECharts options, the parts of them that timeline steps and media queries patch included,
// and checks them for mistakes that ECharts would silently render as nothing, with actionable
// errors.

import { isPlainObject } from "../protocol";
import { joinWords } from "../text";
import { evaluateSource, isFunctionAt } from "./optionSource";

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

type Patch = [path: string, patch: JsonObject];
const isPatch = (patch: [string, unknown]): patch is Patch => isPlainObject(patch[1]);

/** The options that a timeline's steps and media queries merge into the base option, by path. */
function optionPatches(option: JsonObject): { steps: Patch[]; media: Patch[] } {
  const steps: unknown[] = Array.isArray(option.options) ? option.options : [];
  const media: unknown[] = Array.isArray(option.media) ? option.media : [];
  return {
    steps: steps
      .map((step, index): [string, unknown] => [`options[${index}]`, step])
      .filter(isPatch),
    media: media
      .map((each, index): [string, unknown] => [
        `media[${index}].option`,
        isPlainObject(each) ? each.option : undefined,
      ])
      .filter(isPatch),
  };
}

/** The base option and the options that patch it, each of which can set e.g. series. */
export function optionVariants(option: JsonObject): JsonObject[] {
  const { steps, media } = optionPatches(option);
  return [baseOption(option), ...[...steps, ...media].map(([, patch]) => patch)];
}

/** The series of the base option and of the options that patch it. */
export const allSeries = (option: JsonObject): JsonObject[] =>
  optionVariants(option).flatMap((variant) => asArray(variant.series));

export const seriesOf = (option: JsonObject): unknown[] =>
  option.series === undefined ? [] : Array.isArray(option.series) ? option.series : [option.series];

/**
 * The place among the series of the base option that each series of a patch merges into, as
 * ECharts matches them: by "id", then by "name", and the rest to the free places in order. A null
 * is skipped rather than given a place.
 */
export function seriesPlaces(base: unknown[], patch: unknown[]): (number | undefined)[] {
  const keyed = patch.map((each) => {
    if (!isPlainObject(each)) return -1;
    const key = each.id != null ? "id" : "name";
    return each[key] == null
      ? -1
      : base.findIndex((existing) => isPlainObject(existing) && existing[key] === each[key]);
  });
  let free = 0;
  return patch.map((each, index) => {
    if (each == null) return undefined;
    const place = keyed[index] ?? -1;
    if (place >= 0) return place;
    while (keyed.includes(free)) free++;
    return free++;
  });
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
  validateSeries(option);
  findJavaScript(option, [], []);
  return option;
}

/** The series by path, once the series of a patch have merged into them. */
function patchSeries(series: [string, unknown][], patch: unknown[], path: string) {
  const merged = [...series];
  const places = seriesPlaces(
    series.map(([, each]) => each),
    patch,
  );
  places.forEach((place, index) => {
    if (place === undefined) return;
    const existing = merged[place]?.[1];
    const each = patch[index];
    merged[place] = [
      `${path}.series[${index}]`,
      isPlainObject(existing) && isPlainObject(each) ? { ...existing, ...each } : each,
    ];
  });
  return merged;
}

/** Whether ECharts shows the timeline steps in "options", which it does only with a timeline. */
const showsSteps = (option: JsonObject) =>
  asArray(baseOption(option).timeline).length > 0 || asArray(option.timeline).length > 0;

const IGNORED_STEPS =
  'The ECharts option has timeline steps in "options" but no "timeline" to show them, so ' +
  'ECharts ignores them. To show them, add one, e.g. "timeline": {"data": ["2025", "2026"]}.';

/** Tells a model which parts of its option ECharts ignores, though it draws the rest. */
export function optionWarnings(option: JsonObject): string[] {
  return optionPatches(option).steps.length > 0 && !showsSteps(option) ? [IGNORED_STEPS] : [];
}

/**
 * Checks the series that the chart draws: those of the base option, or with a timeline or media
 * queries, those of each step and query merged in, as the series may well be there alone. ECharts
 * merges each step into what the chart shows, so they are merged in one after the other, and each
 * media query into what the chart shows then: the base option, or each step.
 */
function validateSeries(option: JsonObject): void {
  const base = baseOption(option);
  const patches = optionPatches(option);
  const steps = showsSteps(option) ? patches.steps : [];
  const media = patches.media;
  const initial = {
    option: base,
    series: seriesOf(base).map((each, index): [string, unknown] => [`series[${index}]`, each]),
  };
  const merge = (from: typeof initial, [path, patch]: Patch) => ({
    option: { ...from.option, ...patch },
    series: patchSeries(from.series, seriesOf(patch), path),
  });
  let shown = initial;
  const states =
    steps.length > 0
      ? steps.map((step) => {
          shown = merge(shown, step);
          return shown;
        })
      : [initial];
  const queried = states.flatMap((state) => media.map((query) => merge(state, query)));
  // Without steps, the series may be in the media queries alone.
  const drawn = steps.length > 0 || media.length === 0 ? [...states, ...queried] : queried;
  if (drawn.every(({ series }) => series.length === 0)) {
    // The series may be in steps that ECharts ignores.
    if (patches.steps.length > steps.length) throw new Error(IGNORED_STEPS);
    throw new Error(
      'The ECharts option has no "series". Add at least one, e.g. "series": [{"type": "bar", ' +
        '"data": [5, 20, 36]}] with "xAxis": {"type": "category", "data": ["A", "B", "C"]} and ' +
        '"yAxis": {"type": "value"}.',
    );
  }
  for (const { option: merged, series } of drawn) {
    for (const [path, each] of series) {
      checkSeries(each, path, merged);
    }
    if (merged.geo !== undefined) {
      throw new Error(
        'The "geo" component is not available in the diagram panel, as it has no map data. ' +
          "Use another chart type.",
      );
    }
  }
}

/** Checks that a series has a type the panel has, and what it needs to draw anything. */
function checkSeries(each: unknown, path: string, base: JsonObject): void {
  if (!isPlainObject(each)) {
    throw new Error(
      `${path} must be an object such as {"type": "bar", "data": [5, 20, 36]}, not ${describe(each)}.`,
    );
  }
  const type = each.type;
  if (typeof type !== "string" || !type) {
    throw new Error(`${path} has no "type". Set it to one of: ${SERIES_TYPES.join(", ")}.`);
  }
  if (!SERIES_TYPES.includes(type)) {
    const sameName = SERIES_TYPES.find((known) => known.toLowerCase() === type.toLowerCase());
    const hint = sameName
      ? `types are case-sensitive: "${sameName}"`
      : TYPE_HINTS[type.toLowerCase()];
    const problem = type === "map" ? "unsupported" : "unknown";
    throw new Error(
      `${path} has the ${problem} type "${type}"${hint ? ` (${hint})` : ""}. ` +
        `Valid types: ${SERIES_TYPES.join(", ")}.`,
    );
  }
  const system = coordinateSystem(each);
  if (system === "geo" || system === "bmap") {
    throw new Error(
      `${path} (type "${type}") is drawn on a map${each.coordinateSystem ? "" : " by default"}, ` +
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
      `${path} has the unknown coordinate system "${system}". ` +
        `Use one of: ${Object.keys(COORDINATE_COMPONENTS).join(", ")}, view, none.`,
    );
  }
  const components = system === undefined ? undefined : COORDINATE_COMPONENTS[system];
  if (components?.needs.some((name) => asArray(base[name]).length === 0)) {
    const needs = joinWords(
      components.needs.map((name) => `"${name}"`),
      "and",
    );
    throw new Error(
      `${path} (type "${type}") is drawn on the ${system} coordinate system and needs ` +
        `${needs}, e.g. ${components.example}.`,
    );
  }
  if (type === "custom" && typeof each.renderItem !== "function") {
    throw new Error(
      `${path} is a "custom" series, which draws nothing without a "renderItem" ` +
        "function. Write the option as a JavaScript object literal rather than JSON, e.g. " +
        '"renderItem": (params, api) => {const [x, y] = api.coord([api.value(0), api.value(1)]); ' +
        'return {type: "circle", shape: {cx: x, cy: y, r: 6}, style: api.style()};}.',
    );
  }
  if (type === "heatmap" && asArray(base.visualMap).length === 0) {
    throw new Error(
      `${path} is a "heatmap" series and needs a "visualMap" to color its cells, e.g. ` +
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
      (node) => !isPlainObject(node) || !Number.isFinite(node.x) || !Number.isFinite(node.y),
    )
  ) {
    throw new Error(
      `${path} is a "graph" series without "layout", whose nodes need "x" and "y" to be ` +
        'drawn; set "layout": "force" or "circular" to place them automatically.',
    );
  }
}

const isObject = (value: unknown): value is object => value !== null && typeof value === "object";

/** A path such as "series[0].label", from its keys. */
const pathOf = (keys: (string | number)[]) =>
  keys
    .map((key, index) => (typeof key === "number" ? `[${key}]` : index ? `.${key}` : key))
    .join("");

/**
 * Finds callbacks written as strings, which ECharts draws as the text they are, and objects that
 * contain themselves, which a JavaScript source can build and no chart can be drawn from. A
 * function itself is fine anywhere, as the source may be JavaScript. "inside" holds the objects
 * the walk is inside, which is what a cycle leads back to, rather than every object it has seen,
 * as the same value may well be used in several places, and "keys" the way to the value. Both are
 * stacks, which are several times faster than a set or a path built for each of a million data
 * points, and the path is built only for an error.
 */
function findJavaScript(
  value: unknown,
  keys: (string | number)[],
  inside: object[],
  checkCallbacks = true,
): void {
  if (!isObject(value) || ArrayBuffer.isView(value)) {
    return;
  }
  if (inside.includes(value)) {
    throw new Error(
      `${pathOf(keys)} refers back to an object that contains it, and a chart cannot be drawn ` +
        "from a cycle. Write out the value that each place needs instead of referring back.",
    );
  }
  inside.push(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      // Primitive data points, alone or as [x, y], cannot contain callbacks.
      if (isObject(item) && !(Array.isArray(item) && !item.some(isObject))) {
        keys.push(index);
        findJavaScript(item, keys, inside, checkCallbacks);
        keys.pop();
      }
    });
  } else if (isPlainObject(value)) {
    // Layout copies inherited properties too, so validate the same values it will copy.
    for (const key in value) {
      const item = value[key];
      keys.push(key);
      if (
        checkCallbacks &&
        typeof item === "string" &&
        CALLBACK_KEYS.has(key) &&
        isFunctionAt(item)
      ) {
        throw new Error(
          `${pathOf(keys)} is JavaScript code in a string, which ECharts draws as that text. ` +
            "Write it as a function, as the option itself may be written as JavaScript, or for a " +
            'simple formatter use a string template such as "{b}: {c}" (name and value) or ' +
            '"{d}%" (pie percentage).',
        );
      }
      // Dataset columns and transform configuration hold data, not callback options.
      findJavaScript(item, keys, inside, checkCallbacks && key !== "dataset");
      keys.pop();
    }
  }
  inside.pop();
}

/** The series types of the option, e.g. "bar, line". */
export function seriesTypes(option: JsonObject): string {
  const types = allSeries(option).flatMap((each) =>
    typeof each.type === "string" ? [each.type] : [],
  );
  return Array.from(new Set(types)).join(", ");
}
