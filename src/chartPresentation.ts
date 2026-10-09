// Capture source styling separately from generated data. Only JSON is inspected on the host.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ChartSpec } from "./chartSpec";
import { buildChart } from "./charts";
import type { DataTable } from "./data";
import { errorMessage, isPlainObject } from "./protocol";

type ObjectOption = Record<string, unknown>;
type Path = (string | number)[];
interface Edit {
  path: Path;
  value?: unknown;
  remove?: boolean;
}

/** Serializable, data-free baseline and manual styling changes, kept with the diagram. */
export interface ChartPresentation {
  baseline: ObjectOption;
  dataHash: string;
  edits: Edit[];
  blocked?: string | undefined;
  /**
   * The type of each series of the baseline, which its styling may follow to a series of another
   * type only if that is drawn alike. Styling saved without them follows any series of its name.
   */
  seriesTypes?: string[] | undefined;
}

/** Refresh, Chart Options, diagram_updateChart and diagram_getState all show this message. */
function blocked(reason: string): string {
  return `Your chart styling can't be kept, because ${reason}. Your source is kept. Revert these source changes, or use Reset Styling in Chart Options to return to the generated chart.`;
}

const DATA_KEYS = new Set([
  "data",
  "dataset",
  "nodes",
  "links",
  "edges",
  "indicator",
  "dimensions",
  "encode",
]);
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Whether a saved value is a presentation whose edits name properties, by keys that capturing one
 * allows, and array items.
 */
export function isChartPresentation(value: unknown): value is ChartPresentation {
  return (
    isPlainObject(value) &&
    isPlainObject(value.baseline) &&
    typeof value.dataHash === "string" &&
    Array.isArray(value.edits) &&
    value.edits.every(
      (edit) =>
        isPlainObject(edit) &&
        Array.isArray(edit.path) &&
        edit.path.length > 0 &&
        edit.path.every(
          (key) =>
            (typeof key === "number" && Number.isSafeInteger(key) && key >= 0) ||
            (typeof key === "string" && !UNSAFE_KEYS.has(key)),
        ),
    ) &&
    (value.blocked === undefined || typeof value.blocked === "string") &&
    (value.seriesTypes === undefined ||
      (Array.isArray(value.seriesTypes) &&
        value.seriesTypes.every((type) => typeof type === "string")))
  );
}

/** Stable key order makes formatting and reordered JSON properties equivalent. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) {
    // Numeric series and category arrays already have canonical order. Keep them intact;
    // only allocate a copy when normalizing a nested object.
    return value.some((item) => item !== null && typeof item === "object")
      ? value.map(sorted)
      : value;
  }
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted(value[key])]),
  );
}

function snapshot(option: ObjectOption): { baseline: ObjectOption; dataHash: string } {
  const data: Record<string, unknown> = {};
  function visit(value: unknown, path: Path): unknown {
    if (Array.isArray(value)) {
      if (path.length === 1 && path[0] === "series") data["series.length"] = value.length;
      return value.map((item, index) => visit(item, [...path, index]));
    }
    if (!isPlainObject(value)) return value;
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) => {
        if (UNSAFE_KEYS.has(key)) {
          const where = path.map((part) => (typeof part === "number" ? `[${part}]` : `.${part}`));
          throw new Error(
            `the source has the key ${JSON.stringify(key)}${where.length ? ` in ${where.join("").slice(1)}` : ""}, which is not a chart option. Remove it`,
          );
        }
        const location = [...path, key];
        const component = path[0];
        const structural =
          (key === "type" ||
            key === "coordinateSystem" ||
            key === "gridIndex" ||
            /AxisIndex$/.test(key)) &&
          (component === "series" || /Axis$/.test(String(component))) &&
          path.length <= 2;
        if (DATA_KEYS.has(key) || structural) {
          data[JSON.stringify(location)] = item;
          return [];
        }
        return [[key, visit(item, location)]];
      }),
    );
  }
  const baseline = visit(option, []) as ObjectOption;
  return {
    baseline,
    dataHash: createHash("sha256")
      .update(JSON.stringify(sorted(data)))
      .digest("hex"),
    ...(option.series === undefined
      ? {}
      : {
          seriesTypes: componentItems(option, "series").map(({ type }) =>
            typeof type === "string" ? type : "",
          ),
        }),
  };
}

/** The series types drawn as one color each along axes, whose styling suits one another. */
const AXIS_SERIES = new Set(["bar", "line", "scatter", "effectScatter", "pictorialBar"]);

/** Whether styling of a series of one type suits a series of another, as a bar's color a line. */
function drawnAlike(before: string, after: unknown): boolean {
  return before === after || (AXIS_SERIES.has(before) && AXIS_SERIES.has(String(after)));
}

function differences(before: unknown, after: unknown, path: Path = []): Edit[] {
  if (isDeepStrictEqual(before, after)) return [];
  if (isPlainObject(before) && isPlainObject(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) => {
      const next = [...path, key];
      if (!Object.hasOwn(after, key)) return [{ path: next, remove: true }];
      if (!Object.hasOwn(before, key)) return [{ path: next, value: after[key] }];
      return differences(before[key], after[key], next);
    });
  }
  if (
    Array.isArray(before) &&
    Array.isArray(after) &&
    before.length === after.length &&
    before.every(isPlainObject) &&
    after.every(isPlainObject)
  ) {
    return before.flatMap((item, index) => differences(item, after[index], [...path, index]));
  }
  if (
    path.length === 1 &&
    path[0] === "title" &&
    Array.isArray(before) &&
    Array.isArray(after) &&
    after.length > before.length &&
    before.every(isPlainObject) &&
    after.every(isPlainObject)
  ) {
    // Titles added after the generated ones of facets, which a refresh may change, add to them.
    return [
      ...before.flatMap((item, index) => differences(item, after[index], [...path, index])),
      ...after.slice(before.length).map((value) => ({ path, value })),
    ];
  }
  return [{ path, value: after }];
}

/** Capture JSON source or a generated JSON option, keeping only its data-free styling baseline. */
export function captureChartPresentation(
  source: string | ObjectOption,
  previous?: ChartPresentation,
): ChartPresentation {
  try {
    // Generated options are already JSON objects. Serializing and reparsing them here would
    // duplicate every data point just to discard the data from the styling baseline.
    const option: unknown = typeof source === "string" ? parseJson(source) : source;
    if (!isPlainObject(option)) {
      const kind =
        option === null ? "null" : Array.isArray(option) ? "an array" : `a ${typeof option}`;
      throw new Error(`the source is ${kind}, not one JSON object of chart options`);
    }
    const current = snapshot(option);
    if (!previous) return { ...current, edits: [] };
    if (current.dataHash !== previous.dataHash) {
      return {
        ...previous,
        blocked: blocked("the source changes the chart's data or structure"),
      };
    }
    return {
      ...previous,
      edits: differences(previous.baseline, current.baseline),
      blocked: undefined,
    };
  } catch (error) {
    return {
      ...(previous ?? { baseline: {}, dataHash: "", edits: [] }),
      blocked: blocked(errorMessage(error)),
    };
  }
}

function parseJson(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(
      "the source is not JSON, and JavaScript callbacks or invalid JSON cannot be safely rebuilt",
    );
  }
}

export function assertChartPresentation(presentation: ChartPresentation | undefined): void {
  if (presentation?.blocked) throw new Error(presentation.blocked);
}

function componentItems(option: ObjectOption, component: string): ObjectOption[] {
  const items = option[component];
  return Array.isArray(items) ? items.filter(isPlainObject) : [];
}

const SKIP = Symbol("skip");

/**
 * A component as a user's object of it, which the baseline did not generate, joins what the chart
 * now generates: its properties add to a generated object, a title adds to the titles of facets,
 * and other panels are left as they are, as a single grid or axis would lay them over each other.
 * Undefined if the edit is to be applied as any other.
 */
function addedComponent(
  option: ObjectOption,
  baseline: ObjectOption,
  component: string,
  value: ObjectOption,
): unknown {
  const generated = option[component];
  if (component === "title") {
    // A title added after the titles of facets stands alone without them.
    if (generated === undefined) return structuredClone(value);
    if (Array.isArray(generated)) return [...generated, structuredClone(value)];
  }
  if (Object.hasOwn(baseline, component)) return undefined;
  if (isPlainObject(generated)) return merged(generated, value);
  return Array.isArray(generated) ? SKIP : undefined;
}

/** `value` merged into `target`, keeping null as an option value, unlike a merge patch. */
function merged(target: ObjectOption, value: ObjectOption): ObjectOption {
  const result = { ...target };
  for (const [key, item] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key)) continue;
    const before = result[key];
    result[key] =
      isPlainObject(before) && isPlainObject(item) ? merged(before, item) : structuredClone(item);
  }
  return result;
}

function applyEdits(option: ObjectOption, presentation: ChartPresentation): ObjectOption {
  // Copy only edited branches. The bulk of an option is data, which styling never changes.
  const result = { ...option };
  for (const edit of presentation.edits) {
    const path = [...edit.path];
    const component = path[0];
    if (typeof component === "string" && path.length === 1 && isPlainObject(edit.value)) {
      const added = addedComponent(result, presentation.baseline, component, edit.value);
      if (added !== undefined) {
        if (added !== SKIP) result[component] = added;
        continue;
      }
    }
    // Type/facet changes can remove a component or switch between a single object and panels.
    // Recreating an old axis can invalidate the chart; object properties on arrays are lost.
    if (
      typeof component === "string" &&
      ["series", "xAxis", "yAxis", "grid", "title", "radar", "visualMap"].includes(component) &&
      Object.hasOwn(presentation.baseline, component) &&
      (!Object.hasOwn(option, component) ||
        Array.isArray(presentation.baseline[component]) !== Array.isArray(option[component]))
    ) {
      continue;
    }
    if (
      typeof component === "string" &&
      ["series", "xAxis", "yAxis", "grid", "title"].includes(component) &&
      typeof path[1] === "number"
    ) {
      const oldItems = componentItems(presentation.baseline, component);
      const newItems = componentItems(option, component);
      const index = path[1];
      const old = oldItems[index];
      const key = old?.id !== undefined ? "id" : component === "series" ? "name" : undefined;
      if (key !== undefined && old?.[key] !== undefined) {
        const matches = newItems.flatMap((item, index) =>
          isDeepStrictEqual(item[key], old[key]) ? [index] : [],
        );
        // A removed/renamed column must not transfer its styling to another series.
        if (matches.length !== 1) continue;
        path[1] = matches[0] as number;
      } else if (oldItems.length !== newItems.length) {
        continue;
      }
      // A bar's color would color every slice of a pie alike.
      const type = component === "series" ? presentation.seriesTypes?.[index] : undefined;
      if (type !== undefined && !drawnAlike(type, newItems[path[1]]?.type)) continue;
    }
    let target: ObjectOption | unknown[] = result;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i] as string;
      const record = target as ObjectOption;
      const child = record[key];
      record[key] = Array.isArray(child)
        ? [...child]
        : isPlainObject(child)
          ? { ...child }
          : typeof path[i + 1] === "number"
            ? []
            : {};
      target = record[key] as ObjectOption;
    }
    const key = path.at(-1) as string;
    if (edit.remove) delete (target as ObjectOption)[key];
    else (target as ObjectOption)[key] = structuredClone(edit.value);
  }
  return result;
}

/** Build fresh data through ChartSpec.options, then apply only the user's presentation changes. */
export function rebuildChart(chart: ChartSpec, table: DataTable, presentation?: ChartPresentation) {
  assertChartPresentation(presentation);
  const built = buildChart(chart, table);
  const baseline = captureChartPresentation(built.option);
  if (!presentation?.edits.length) return { ...built, presentation: baseline };
  const option = applyEdits(built.option, presentation);
  return {
    ...built,
    option,
    presentation: captureChartPresentation(option, baseline),
  };
}
