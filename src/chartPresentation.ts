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
  /** Whether the value is a title added after the generated titles of facets. */
  append?: boolean;
}

/** Identifies the component an edit belongs to across chart rebuilds. */
interface EditTarget {
  /** The component's original representation. */
  shape: "array" | "object" | "none";
  /** Match by id or name when available; otherwise require the same item count. */
  item?: { key?: "id" | "name"; value?: unknown; type?: string; count: number } | undefined;
}

/** Preserve unapplied edits, including those already satisfied by the generated chart. */
type KeptEdit = Edit & EditTarget & { shown?: boolean };

/** Serializable, data-free baseline and manual styling changes, kept with the diagram. */
export interface ChartPresentation {
  baseline: ObjectOption;
  dataHash: string;
  edits: Edit[];
  blocked?: string | undefined;
  /**
   * Original series types restrict styling transfers to compatible types. Older saved state
   * without this field matches series by name alone.
   */
  seriesTypes?: string[] | undefined;
  /**
   * Restore these when their targets return, such as switching from a pie back to a bar chart.
   */
  kept?: KeptEdit[] | undefined;
}

/** Refresh, Chart Options, diagram_updateChart and diagram_getState all show this message. */
function blocked(reason: string): string {
  return `Your chart styling can't be kept, because ${reason}. Your source is kept. Revert these source changes, or use Reset styling in Chart Options to return to the generated chart.`;
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

/** Validate persisted presentation state before applying its edits. */
export function isChartPresentation(value: unknown): value is ChartPresentation {
  return (
    isPlainObject(value) &&
    isPlainObject(value.baseline) &&
    typeof value.dataHash === "string" &&
    Array.isArray(value.edits) &&
    value.edits.every(isEdit) &&
    (value.blocked === undefined || typeof value.blocked === "string") &&
    (value.seriesTypes === undefined ||
      (Array.isArray(value.seriesTypes) &&
        value.seriesTypes.every((type) => typeof type === "string"))) &&
    (value.kept === undefined ||
      (Array.isArray(value.kept) &&
        value.kept.every(
          (edit) =>
            isEdit(edit) &&
            ["array", "object", "none"].includes(String(edit.shape)) &&
            (edit.item === undefined ||
              (isPlainObject(edit.item) &&
                typeof edit.item.count === "number" &&
                [undefined, "id", "name"].includes(edit.item.key as string | undefined) &&
                (edit.item.type === undefined || typeof edit.item.type === "string"))) &&
            (edit.shown === undefined || typeof edit.shown === "boolean"),
        )))
  );
}

/** Edit paths may contain safe property names and nonnegative array indices. */
function isEdit(edit: unknown): edit is Edit & ObjectOption {
  return (
    isPlainObject(edit) &&
    Array.isArray(edit.path) &&
    edit.path.length > 0 &&
    edit.path.every(
      (key) =>
        (typeof key === "number" && Number.isSafeInteger(key) && key >= 0) ||
        (typeof key === "string" && !UNSAFE_KEYS.has(key)),
    )
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

/**
 * Normalize primitives as JSON does, so generated options compare equal to their parsed source.
 * Object properties with undefined values are omitted separately in snapshot().
 */
function jsonLeaf(value: unknown): unknown {
  if (typeof value === "number") return Number.isFinite(value) ? value + 0 : null;
  return value === undefined ? null : value;
}

function snapshot(
  option: ObjectOption,
): Pick<ChartPresentation, "baseline" | "dataHash" | "seriesTypes"> {
  const data: Record<string, unknown> = {};
  function visit(value: unknown, path: Path): unknown {
    if (Array.isArray(value)) {
      if (path.length === 1 && path[0] === "series") data["series.length"] = value.length;
      return value.map((item, index) => visit(item, [...path, index]));
    }
    if (!isPlainObject(value)) return jsonLeaf(value);
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) => {
        // JSON leaves out undefined properties.
        if (item === undefined) return [];
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

/** Series types that can share styling without changing the meaning of their colors. */
const AXIS_SERIES = new Set(["bar", "line", "scatter", "effectScatter", "pictorialBar"]);

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
      ...after.slice(before.length).map((value) => ({ path, value, append: true })),
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

/** Facet components matched by id, with series names as a fallback. */
const PANEL_COMPONENTS = ["series", "xAxis", "yAxis", "grid", "title"];

function targetOf({ path }: Edit, presentation: ChartPresentation): EditTarget {
  const component = String(path[0]);
  const { baseline } = presentation;
  const shape = !Object.hasOwn(baseline, component)
    ? "none"
    : Array.isArray(baseline[component])
      ? "array"
      : "object";
  const index = path[1];
  if (!PANEL_COMPONENTS.includes(component) || typeof index !== "number") return { shape };
  const items = componentItems(baseline, component);
  const old = items[index];
  const key = old?.id !== undefined ? "id" : component === "series" ? "name" : undefined;
  const type = component === "series" ? presentation.seriesTypes?.[index] : undefined;
  return {
    shape,
    item: {
      count: items.length,
      ...(key !== undefined && old?.[key] !== undefined ? { key, value: old[key] } : {}),
      ...(type === undefined ? {} : { type }),
    },
  };
}

/**
 * Merge user-added components into newly generated ones. Titles append to facet titles;
 * other objects cannot replace facet arrays, since that would overlap their axes or grids.
 * Return undefined to use normal edit placement, or SKIP to preserve the edit for later.
 */
function addedComponent(
  option: ObjectOption,
  { path, value, append }: Edit,
  { shape }: EditTarget,
): unknown {
  const component = String(path[0]);
  if (path.length !== 1 || !isPlainObject(value)) return undefined;
  const generated = option[component];
  if (component === "title" && (append || shape === "none")) {
    // A title added after the titles of facets stands alone without them.
    if (generated === undefined) return structuredClone(value);
    if (Array.isArray(generated)) return [...generated, structuredClone(value)];
  }
  if (shape !== "none") return undefined;
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

/** Locate a possibly moved component, or return SKIP if its target no longer matches. */
function placed(option: ObjectOption, path: Path, { shape, item }: EditTarget): Path | typeof SKIP {
  const component = String(path[0]);
  // Type/facet changes can remove a component or switch between a single object and panels.
  // Recreating an old axis can invalidate the chart; object properties on arrays are lost.
  if (
    ["series", "xAxis", "yAxis", "grid", "title", "radar", "visualMap"].includes(component) &&
    shape !== "none" &&
    (!Object.hasOwn(option, component) || (shape === "array") !== Array.isArray(option[component]))
  ) {
    return SKIP;
  }
  if (item === undefined || typeof path[1] !== "number") return path;
  const items = componentItems(option, component);
  let index = path[1];
  const { key, value } = item;
  if (key !== undefined) {
    const matches = items.flatMap((each, i) => (isDeepStrictEqual(each[key], value) ? [i] : []));
    // A removed/renamed column must not transfer its styling to another series.
    if (matches.length !== 1) return SKIP;
    index = matches[0] as number;
  } else if (item.count !== items.length) {
    return SKIP;
  }
  // A bar's color would color every slice of a pie alike.
  if (item.type !== undefined && !drawnAlike(item.type, items[index]?.type)) return SKIP;
  return [component, index, ...path.slice(2)];
}

/**
 * Apply retained edits first, then current edits, to a generated option.
 * Keep edits that cannot apply or are already satisfied by the generated values.
 */
function applyEdits(
  option: ObjectOption,
  presentation: ChartPresentation,
): { option: ObjectOption; kept: KeptEdit[] } {
  // Copy only edited branches. The bulk of an option is data, which styling never changes.
  const result = { ...option };
  const kept: KeptEdit[] = [];
  const edits: [Edit, EditTarget][] = [
    ...(presentation.kept ?? []).map((edit): [Edit, EditTarget] => [edit, edit]),
    ...presentation.edits.map((edit): [Edit, EditTarget] => [edit, targetOf(edit, presentation)]),
  ];
  for (const [edit, target] of edits) {
    const keep = (shown = false) => {
      const { shown: _, ...rest } = edit as KeptEdit;
      kept.push({ ...rest, ...target, ...(shown ? { shown } : {}) });
    };
    const added = addedComponent(result, edit, target);
    if (added === SKIP) {
      keep();
      continue;
    }
    if (added !== undefined) {
      result[String(edit.path[0])] = added;
      continue;
    }
    const path = placed(option, edit.path, target);
    const unchanged = path === SKIP ? "waits" : changesNothing(result, path, edit);
    if (path === SKIP || unchanged) {
      keep(unchanged === "shown");
      continue;
    }
    let at: ObjectOption | unknown[] = result;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i] as string;
      const record = at as ObjectOption;
      const child = record[key];
      record[key] = Array.isArray(child)
        ? [...child]
        : isPlainObject(child)
          ? { ...child }
          : typeof path[i + 1] === "number"
            ? []
            : {};
      at = record[key] as ObjectOption;
    }
    const key = path.at(-1) as string;
    if (edit.remove) delete (at as ObjectOption)[key];
    else (at as ObjectOption)[key] = structuredClone(edit.value);
  }
  return { option: result, kept: newest(kept) };
}

/** Bound retained edits for components that may never return. */
const MOST_KEPT = 100;

/** Keep the newest edit per target and property, up to MOST_KEPT. */
function newest(kept: KeptEdit[]): KeptEdit[] {
  const seen = new Set<string>();
  const result: KeptEdit[] = [];
  for (const edit of kept.toReversed()) {
    const key = JSON.stringify([edit.path, edit.shape, edit.item]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(edit);
    if (result.length === MOST_KEPT) break;
  }
  return result.reverse();
}

/**
 * "shown": the generated value already satisfies the edit; "waits": its component is absent.
 * Both must be retained because the next baseline would otherwise lose the user's choice.
 * Return false when the edit changes the option.
 */
function changesNothing(option: ObjectOption, path: Path, edit: Edit): "shown" | "waits" | false {
  if (!edit.remove && path.length > 1 && option[String(path[0])] === undefined) return "waits";
  let value: unknown = option;
  for (const key of path) {
    if (!(isPlainObject(value) || Array.isArray(value)) || !Object.hasOwn(value, key)) {
      return edit.remove ? "shown" : false;
    }
    value = (value as ObjectOption)[key];
  }
  return !edit.remove && isDeepStrictEqual(value, edit.value) ? "shown" : false;
}

/** Build fresh data through ChartSpec.options, then apply only the user's presentation changes. */
export function rebuildChart(chart: ChartSpec, table: DataTable, presentation?: ChartPresentation) {
  assertChartPresentation(presentation);
  const built = buildChart(chart, table);
  const baseline = captureChartPresentation(built.option);
  if (!presentation?.edits.length && !presentation?.kept?.length) {
    return { ...built, presentation: baseline };
  }
  const { option, kept } = applyEdits(built.option, presentation);
  return {
    ...built,
    option,
    presentation: {
      ...captureChartPresentation(option, baseline),
      ...(kept.length > 0 ? { kept } : {}),
    },
  };
}
