// Reads ECharts options, the parts of them that timeline steps and media queries patch included,
// and checks them for mistakes that ECharts would silently render as nothing, throw on with an
// obscure error, or ignore, with actionable errors and warnings.

import { asArray, isPlainObject } from "../protocol";
import { joinWords, quoteAll } from "../text";
import { evaluateSource, isFunction } from "./optionSource";

export type JsonObject = Record<string, unknown>;

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

/** An id or name as ECharts compares them, which takes a number for the same text. */
const comparable = (key: unknown) => (typeof key === "number" ? String(key) : key);

/**
 * The place among the series of the base option that each series of a patch merges into, as
 * ECharts matches them: by "id", then those without an id by "name", and the rest to the first
 * free place, except that one with an id goes after the others, as every series has an id once
 * drawn, of its own or one that ECharts makes up. What is not an object is skipped, as ECharts
 * skips it, rather than given a place.
 */
export function seriesPlaces(base: unknown[], patch: unknown[]): (number | undefined)[] {
  const places: (number | undefined)[] = patch.map(() => undefined);
  const taken = new Set<number>();
  const take = (index: number, place: number) => {
    places[index] = place;
    taken.add(place);
  };
  const objects = patch.flatMap((each, index) =>
    typeof each === "object" && each !== null ? [{ each: each as JsonObject, index }] : [],
  );
  for (const key of ["id", "name"] as const) {
    for (const { each, index } of objects) {
      if (each[key] == null || (key === "name" && each.id != null)) continue;
      const place = base.findIndex(
        (existing, at) =>
          !taken.has(at) &&
          isPlainObject(existing) &&
          comparable(existing[key]) === comparable(each[key]),
      );
      if (place >= 0) take(index, place);
    }
  }
  let length = base.length;
  for (const { each, index } of objects) {
    if (places[index] !== undefined) continue;
    let place = each.id != null ? length : 0;
    while (taken.has(place)) place++;
    take(index, place);
    length = Math.max(length, place + 1);
  }
  return places;
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
  const series = validateSeries(option);
  // Before the components are read, which would follow a cycle around.
  findJavaScript(option, [], []);
  checkComponents(option, series);
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
  return [
    ...(optionPatches(option).steps.length > 0 && !showsSteps(option) ? [IGNORED_STEPS] : []),
    ...unknownKeys(option),
    ...ignoredReferences(option),
  ];
}

/**
 * Checks the series that the chart draws: those of the base option, or with a timeline or media
 * queries, those of each step and query merged in, as the series may well be there alone. ECharts
 * merges each step into what the chart shows, so they are merged in one after the other, and each
 * media query into what the chart shows then: the base option, or each step. Returns each series
 * drawn, by its path.
 */
function validateSeries(option: JsonObject): [string, JsonObject][] {
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
  const checked = new Map<string, JsonObject>();
  for (const { option: merged, series } of drawn) {
    for (const [path, each] of series) {
      checkSeries(each, path, merged);
      checked.set(path, each as JsonObject);
    }
    if (merged.geo !== undefined) {
      throw new Error(
        'The "geo" component is not available in the diagram panel, as it has no map data. ' +
          "Use another chart type.",
      );
    }
  }
  return [...checked];
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
    const near = closestName(type, SERIES_TYPES);
    const hint = sameName
      ? `types are case-sensitive: "${sameName}"`
      : (TYPE_HINTS[type.toLowerCase()] ?? (near && `did you mean "${near}"?`));
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
  if (NETWORK_TYPES.includes(type)) checkNodes(each, path, type);
}

/** The series types of nodes and the links between them. */
const NETWORK_TYPES = ["graph", "sankey", "chord"];

/** The nodes of a graph, sankey or chord series, and the links between them. */
const networkOf = (series: JsonObject) => {
  const nodes: unknown = series.data ?? series.nodes;
  const links: unknown = series.links ?? series.edges;
  return {
    nodes: Array.isArray(nodes) ? nodes : [],
    nodesKey: series.data != null ? "data" : "nodes",
    links: Array.isArray(links) ? links : [],
    linksKey: series.links != null ? "links" : "edges",
  };
};

/** What links name a node by: its id, or else its name. A node that is no object has none. */
function nodeKey(node: unknown): string | undefined {
  const key = isPlainObject(node) ? (node.id ?? node.name) : undefined;
  return typeof key === "string" || typeof key === "number" ? String(key) : undefined;
}

/**
 * Checks that the nodes of a graph, sankey or chord series go by names or ids of their own, which
 * ECharts throws on with "Cannot set properties of undefined", and that the links of a sankey go
 * one way, as ECharts throws on a cycle without saying where.
 */
function checkNodes(series: JsonObject, path: string, type: string): void {
  const { nodes, nodesKey, links } = networkOf(series);
  const seen = new Map<string, number>();
  nodes.forEach((node, index) => {
    const key = nodeKey(node);
    if (key === undefined) return;
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, index);
      return;
    }
    const by = isPlainObject(node) && node.id != null ? "id" : "name";
    const stages =
      type === "sankey" ? ', as "Other (2024)" and "Other (2025)" for a node in two stages' : "";
    throw new Error(
      `${path}.${nodesKey}[${first}] and [${index}] have the same ${by}, ${JSON.stringify(key)}, ` +
        `which ECharts cannot tell nodes apart without: give each node a name of its own${stages}, ` +
        'or an "id".',
    );
  });
  if (type !== "sankey") return;
  // Where each node's links go, by node key or index, and a search for a way back to a node.
  const ends = (end: unknown) =>
    typeof end === "number" ? (nodeKey(nodes[end]) ?? String(end)) : String(end);
  const next = new Map<string, string[]>();
  for (const link of links) {
    if (!isPlainObject(link)) continue;
    const from = ends(link.source);
    next.set(from, [...(next.get(from) ?? []), ends(link.target)]);
  }
  const done = new Set<string>();
  const way: string[] = [];
  const cycleFrom = (node: string): string[] | undefined => {
    const at = way.indexOf(node);
    if (at >= 0) return [...way.slice(at), node];
    if (done.has(node)) return undefined;
    way.push(node);
    for (const target of next.get(node) ?? []) {
      const cycle = cycleFrom(target);
      if (cycle) return cycle;
    }
    way.pop();
    done.add(node);
    return undefined;
  };
  for (const node of next.keys()) {
    const cycle = cycleFrom(node);
    if (cycle) {
      throw new Error(
        `${path} has links that go around in a cycle, ${cycle.map((each) => JSON.stringify(each)).join(" → ")}, ` +
          "which a sankey cannot draw, as its flows go one way: leave out a link of the cycle, or " +
          'draw a "graph" with "layout": "force" instead.',
      );
    }
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
        isFunction(item)
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

/**
 * The edit distance between two words: how many letters to add, remove or replace, or pairs of
 * them to swap, as in "titel".
 */
function distance(a: string, b: string): number {
  let before: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      let least = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        least = Math.min(least, (before[j - 2] as number) + 1);
      }
      current[j] = least;
    }
    before = previous;
    previous = current;
  }
  return previous[b.length] as number;
}

/**
 * The name that a misspelled one most likely means: the same but for case, one a letter or two
 * off, or one that it starts with or is the start of, as "scrollable" of "scroll".
 */
function closestName(name: string, names: readonly string[]): string | undefined {
  const lower = name.toLowerCase();
  const same = names.find((known) => known.toLowerCase() === lower);
  if (same !== undefined) return same;
  let closest: string | undefined;
  let least = Math.max(1, Math.floor(name.length / 4)) + 1;
  for (const known of names) {
    const off = distance(lower, known.toLowerCase());
    if (off < least) {
      closest = known;
      least = off;
    }
  }
  return (
    closest ??
    names.find((known) => {
      const word = known.toLowerCase();
      return (
        (word.length >= 4 && lower.startsWith(word)) ||
        (lower.length >= 3 && word.startsWith(lower))
      );
    })
  );
}

/** The base option and the options that patch it, each with the path that leads into it. */
function optionParts(option: JsonObject): [prefix: string, part: JsonObject][] {
  const { steps, media } = optionPatches(option);
  return [
    [isPlainObject(option.baseOption) ? "baseOption." : "", baseOption(option)],
    ...[...steps, ...media].map(([path, patch]): [string, JsonObject] => [`${path}.`, patch]),
  ];
}

/** The components of a type in the parts of an option, each by its path, as "xAxis[1]". */
function componentsOf(parts: [string, JsonObject][], key: string): [string, JsonObject][] {
  return parts.flatMap(([prefix, part]): [string, JsonObject][] => {
    const value = part[key];
    if (isPlainObject(value)) return [[`${prefix}${key}`, value]];
    if (!Array.isArray(value)) return [];
    return value.flatMap((each, index): [string, JsonObject][] =>
      isPlainObject(each) ? [[`${prefix}${key}[${index}]`, each]] : [],
    );
  });
}

const AXIS_TYPES = ["category", "value", "time", "log"];

/**
 * The kinds of the components that ECharts has several kinds of, as echartsLibrary.ts registers
 * them, which it throws on another of with "Component … is used but not imported".
 */
export const COMPONENT_TYPES: Record<string, string[]> = {
  xAxis: AXIS_TYPES,
  yAxis: AXIS_TYPES,
  radiusAxis: AXIS_TYPES,
  angleAxis: AXIS_TYPES,
  singleAxis: AXIS_TYPES,
  parallelAxis: AXIS_TYPES,
  dataZoom: ["inside", "slider", "select"],
  visualMap: ["continuous", "piecewise"],
  legend: ["plain", "scroll"],
  timeline: ["slider"],
};

/** The types of the elements of the graphic component. */
export const GRAPHIC_TYPES = [
  "group",
  "image",
  "text",
  "rect",
  "circle",
  "ellipse",
  "ring",
  "sector",
  "arc",
  "polygon",
  "polyline",
  "line",
  "bezierCurve",
];

/** What a model may call a type of graphic element that ECharts names otherwise. */
const GRAPHIC_HINTS: Record<string, string> = {
  rectangle: "rect",
  square: "rect",
  label: "text",
  path: "polyline",
};

/** An error for a type that ECharts does not have, with the one that was likely meant. */
function unknownType(path: string, type: string, types: readonly string[], near?: string): Error {
  const meant = near ?? closestName(type, types);
  return new Error(
    `${path} has the unknown type ${JSON.stringify(type)}${meant ? ` (did you mean "${meant}"?)` : ""}. ` +
      `Valid types: ${types.join(", ")}.`,
  );
}

/** The elements of the graphic component, with their paths, those in groups included. */
function graphicElements(parts: [string, JsonObject][]): [string, JsonObject][] {
  const elements: [string, JsonObject][] = [];
  const add = (path: string, element: JsonObject) => {
    elements.push([path, element]);
    if (Array.isArray(element.children)) {
      element.children.forEach((child, index) => {
        if (isPlainObject(child)) add(`${path}.children[${index}]`, child);
      });
    }
  };
  for (const [prefix, part] of parts) {
    const graphic = part.graphic;
    const path = `${prefix}graphic`;
    // Of a graphic component, or as ECharts takes it, an element alone, or a list of elements.
    const components = isPlainObject(graphic)
      ? [[path, graphic] as const]
      : Array.isArray(graphic)
        ? graphic.map((each, index) => [`${path}[${index}]`, each] as const)
        : [];
    for (const [at, component] of components) {
      if (!isPlainObject(component)) continue;
      if (component.elements === undefined) add(at, component);
      if (!Array.isArray(component.elements)) continue;
      component.elements.forEach((element, index) => {
        if (isPlainObject(element)) add(`${at}.elements[${index}]`, element);
      });
    }
  }
  return elements;
}

/**
 * The components of each type in the parts of an option, which their patches merge into by
 * place, and the ids they have: what a reference by index or id can refer to. ECharts adds a grid
 * for axes, and a parallel for parallel axes, unless the option has one.
 */
function referable(parts: [string, JsonObject][]) {
  const count = (key: string) =>
    Math.max(
      0,
      ...parts.map(([, part]) => (key === "series" ? seriesOf(part) : asArray(part[key])).length),
    );
  const ids = (key: string) =>
    componentsOf(parts, key).flatMap(([, each]) => (each.id == null ? [] : [String(each.id)]));
  return {
    count: (key: string) =>
      Math.max(
        count(key),
        (key === "grid" && count("xAxis") + count("yAxis") > 0) ||
          (key === "parallel" && count("parallelAxis") > 0)
          ? 1
          : 0,
      ),
    ids,
  };
}

/**
 * What is wrong with the references by index or id of a component or series to components of a
 * type, such as of a series to its "xAxis" by "xAxisIndex", or of a data zoom to several axes.
 */
function brokenReferences(
  holder: JsonObject,
  path: string,
  key: string,
  to: string,
  components: ReturnType<typeof referable>,
): string[] {
  const broken: string[] = [];
  const count = components.count(to);
  const indices = holder[`${key}Index`];
  for (const index of Array.isArray(indices) ? indices : [indices]) {
    if (
      typeof index !== "number" ||
      (index >= 0 && index < count) ||
      (index === 0 && count === 0)
    ) {
      continue;
    }
    const has =
      count === 0
        ? `the option has no "${to}"`
        : count === 1
          ? `the option has only one "${to}" (index 0)`
          : `the option has ${count} "${to}" (index 0 to ${count - 1})`;
    broken.push(`${path}.${key}Index is ${index}, but ${has}`);
  }
  const id = holder[`${key}Id`];
  const ids = components.ids(to);
  for (const each of Array.isArray(id) ? id : [id]) {
    if ((typeof each !== "string" && typeof each !== "number") || ids.includes(String(each))) {
      continue;
    }
    const known = ids.length > 0 ? ` (the ids are ${quoteAll(ids)})` : "";
    broken.push(`${path}.${key}Id is ${JSON.stringify(each)}, but no "${to}" has that id${known}`);
  }
  return broken;
}

/** The components that a series refers to on the coordinate system it is drawn on, which ECharts throws on a reference to one of that is missing. */
const SYSTEM_REFERENCES: Record<string, string[]> = {
  cartesian2d: ["xAxis", "yAxis"],
  polar: ["polar"],
  singleAxis: ["singleAxis"],
  calendar: ["calendar"],
  parallel: ["parallel"],
  matrix: ["matrix"],
};

/**
 * Checks that the components of an option are of types that ECharts has, and that what refers to
 * a component that ECharts would throw on the lack of, such as a series to its axis, refers to one
 * the option has, with errors that name the place and what to use.
 */
function checkComponents(option: JsonObject, series: [string, JsonObject][]): void {
  const parts = optionParts(option);
  for (const [key, types] of Object.entries(COMPONENT_TYPES)) {
    for (const [path, component] of componentsOf(parts, key)) {
      const { type } = component;
      if (typeof type === "string" && !types.includes(type)) throw unknownType(path, type, types);
    }
  }
  for (const [path, element] of graphicElements(parts)) {
    const { type } = element;
    if (typeof type === "string" && !GRAPHIC_TYPES.includes(type)) {
      throw unknownType(path, type, GRAPHIC_TYPES, GRAPHIC_HINTS[type.toLowerCase()]);
    }
  }
  const components = referable(parts);
  const broken = [
    ...series.flatMap(([path, each]) => {
      const system = coordinateSystem(each);
      return (system === undefined ? [] : (SYSTEM_REFERENCES[system] ?? [])).flatMap((to) =>
        brokenReferences(each, path, to, to, components),
      );
    }),
    ...["xAxis", "yAxis"].flatMap((key) =>
      componentsOf(parts, key).flatMap(([path, axis]) =>
        brokenReferences(axis, path, "grid", "grid", components),
      ),
    ),
    ...["angleAxis", "radiusAxis"].flatMap((key) =>
      componentsOf(parts, key).flatMap(([path, axis]) =>
        brokenReferences(axis, path, "polar", "polar", components),
      ),
    ),
    ...componentsOf(parts, "parallelAxis").flatMap(([path, axis]) =>
      brokenReferences(axis, path, "parallel", "parallel", components),
    ),
    ...componentsOf(parts, "dataset").flatMap(([path, dataset]) =>
      brokenReferences(dataset, path, "fromDataset", "dataset", components),
    ),
  ];
  if (broken.length > 0) {
    throw new Error(`${broken[0]}: refer to one that exists, or add it.`);
  }
}

/**
 * What refers to a component that it ignores the lack of, such as a data zoom to an axis, or a
 * series to its dataset, which then draws nothing.
 */
function ignoredReferences(option: JsonObject): string[] {
  const parts = optionParts(option);
  const components = referable(parts);
  const series = parts.flatMap(([prefix, part]) =>
    seriesOf(part).flatMap((each, index): [string, JsonObject][] =>
      isPlainObject(each) ? [[`${prefix}series[${index}]`, each]] : [],
    ),
  );
  const fix = "refer to one that exists, or add it";
  return [
    ...series
      .flatMap(([path, each]) => [
        ...brokenReferences(each, path, "dataset", "dataset", components),
        ...(each.type === "radar"
          ? brokenReferences(each, path, "radar", "radar", components)
          : []),
      ])
      .map((broken) => `${broken}, so ECharts draws nothing for the series: ${fix}.`),
    ...componentsOf(parts, "dataZoom")
      .flatMap(([path, zoom]) =>
        ["xAxis", "yAxis", "radiusAxis", "angleAxis", "singleAxis"].flatMap((axis) =>
          brokenReferences(zoom, path, axis, axis, components),
        ),
      )
      .map((broken) => `${broken}, which ECharts ignores, zooming no such axis: ${fix}.`),
    ...componentsOf(parts, "visualMap")
      .flatMap(([path, map]) => brokenReferences(map, path, "series", "series", components))
      .map((broken) => `${broken}, which ECharts ignores, coloring no such series: ${fix}.`),
    ...series.flatMap(([path, each]) =>
      NETWORK_TYPES.includes(String(each.type)) ? looseLinks(each, path) : [],
    ),
  ];
}

/**
 * The links of a graph, sankey or chord series to nodes that it does not have, which ECharts
 * leaves out: a link names a node by its id, or else its name, or by its index.
 */
function looseLinks(series: JsonObject, path: string): string[] {
  const { nodes, nodesKey, links, linksKey } = networkOf(series);
  const keys = new Set(nodes.map(nodeKey));
  const missing = (end: unknown) =>
    typeof end === "number" ? !(end >= 0 && end < nodes.length) : !keys.has(String(end));
  const loose = links.filter(
    (link) => isPlainObject(link) && (missing(link.source) || missing(link.target)),
  ) as JsonObject[];
  const [first] = loose;
  if (!first) return [];
  const end = missing(first.source) ? first.source : first.target;
  // A node with an id goes by its id alone.
  const named = nodes.some((node) => isPlainObject(node) && node.id != null && node.name === end);
  return [
    `${path}.${linksKey} has ${loose.length === 1 ? "a link" : `${loose.length} links`} to nodes ` +
      `that ${path}.${nodesKey} does not have, such as ${JSON.stringify(end)}, which ECharts leaves out: ` +
      (named
        ? `name a node that has an "id" by its id.`
        : `add the nodes, or name them by their "id", else their "name".`),
  ];
}

/** What an ECharts option may have at its top level: its components and global settings. */
export const TOP_LEVEL_KEYS = [
  // Components.
  "title",
  "legend",
  "grid",
  "xAxis",
  "yAxis",
  "polar",
  "radiusAxis",
  "angleAxis",
  "radar",
  "dataZoom",
  "visualMap",
  "tooltip",
  "axisPointer",
  "toolbox",
  "brush",
  "geo",
  "parallel",
  "parallelAxis",
  "singleAxis",
  "timeline",
  "graphic",
  "calendar",
  "matrix",
  "thumbnail",
  "dataset",
  "aria",
  "series",
  // Timelines and media queries.
  "baseOption",
  "options",
  "media",
  // Global settings.
  "darkMode",
  "color",
  "colorLayer",
  "backgroundColor",
  "textStyle",
  "animation",
  "animationThreshold",
  "animationDuration",
  "animationEasing",
  "animationDelay",
  "animationDurationUpdate",
  "animationEasingUpdate",
  "animationDelayUpdate",
  "stateAnimation",
  "blendMode",
  "hoverLayerThreshold",
  "progressive",
  "progressiveThreshold",
  "useUTC",
  "legacyViewCoordSysCenterBase",
  "legacyMinMaxDontInverseAxis",
];

/** Settings of each series, which a model may put at the top level of the option instead. */
const SERIES_KEYS = new Set([
  "type",
  "name",
  "data",
  "stack",
  "smooth",
  "step",
  "label",
  "labelLine",
  "endLabel",
  "itemStyle",
  "lineStyle",
  "areaStyle",
  "emphasis",
  "radius",
  "center",
  "roseType",
  "symbol",
  "symbolSize",
  "showSymbol",
  "barWidth",
  "barGap",
  "barCategoryGap",
  "encode",
  "markLine",
  "markPoint",
  "markArea",
  "links",
  "edges",
  "nodes",
  "layout",
  "roam",
  "coordinateSystem",
]);

/**
 * The keys at the top level of an option, and of its timeline steps and media queries, that
 * ECharts ignores, as misspelled, as "xaxis" or "tooltips", or as settings of each series.
 */
function unknownKeys(option: JsonObject): string[] {
  const parts: [string, JsonObject][] = isPlainObject(option.baseOption)
    ? [["", option], ...optionParts(option)]
    : optionParts(option);
  const unknown: string[] = [];
  for (const [prefix, part] of parts) {
    for (const key of Object.keys(part)) {
      if (TOP_LEVEL_KEYS.includes(key)) continue;
      const near = closestName(key, TOP_LEVEL_KEYS);
      const name = JSON.stringify(`${prefix}${key}`);
      unknown.push(
        SERIES_KEYS.has(key)
          ? `${name} (a setting of each series: set it in "series")`
          : near
            ? `${name} (did you mean "${near}"?)`
            : name,
      );
    }
  }
  if (unknown.length === 0) return [];
  return [
    `ECharts ignores what it does not know at the top level of the option: ${unknown.join(", ")}.`,
  ];
}
