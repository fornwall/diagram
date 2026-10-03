// Capture source styling separately from generated data. Only JSON is inspected on the host.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ChartSpec } from "./chartSpec";
import { buildChart } from "./charts";
import type { DataTable } from "./data";
import { isPlainObject } from "./protocol";

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
  blocked?: string;
}

const RECOVERY =
  "Your source is kept. Revert these source changes, or use Reset Styling in Chart Options to return to the generated chart.";
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

/** Stable key order makes formatting and reordered JSON properties equivalent. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
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
        if (UNSAFE_KEYS.has(key)) throw new Error("This source contains unsupported option keys.");
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
  };
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
  return [{ path, value: after }];
}

/** Recompute changes against the generated baseline so reverting an edit restores automatic defaults. */
export function captureChartPresentation(
  source: string,
  previous?: ChartPresentation,
): ChartPresentation {
  try {
    const option: unknown = JSON.parse(source);
    if (!isPlainObject(option)) throw new Error("The chart source must be a JSON option object.");
    const current = snapshot(option);
    if (!previous) return { ...current, edits: [] };
    if (current.dataHash !== previous.dataHash) {
      return {
        ...previous,
        blocked: `Refresh cannot preserve changes to chart data or structure. ${RECOVERY}`,
      };
    }
    return {
      ...previous,
      edits: differences(previous.baseline, current.baseline),
      blocked: undefined,
    };
  } catch {
    return {
      ...(previous ?? { baseline: {}, dataHash: "", edits: [] }),
      blocked: `Refresh can preserve styling only in JSON source; JavaScript callbacks and invalid JSON cannot be safely rebuilt. ${RECOVERY}`,
    };
  }
}

export function assertChartPresentation(presentation: ChartPresentation | undefined): void {
  if (presentation?.blocked) throw new Error(presentation.blocked);
}

function componentItems(option: ObjectOption, component: string): ObjectOption[] {
  const items = option[component];
  return Array.isArray(items) ? items.filter(isPlainObject) : [];
}

function applyEdits(option: ObjectOption, presentation: ChartPresentation): ObjectOption {
  const result = structuredClone(option);
  for (const edit of presentation.edits) {
    const path = [...edit.path];
    if (
      typeof path[0] === "string" &&
      ["series", "xAxis", "yAxis", "grid", "title"].includes(path[0]) &&
      typeof path[1] === "number"
    ) {
      const component = path[0];
      const oldItems = componentItems(presentation.baseline, component);
      const newItems = componentItems(option, component);
      const old = oldItems[path[1]];
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
    }
    let target: ObjectOption | unknown[] = result;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i] as string;
      const record = target as ObjectOption;
      if (!isPlainObject(record[key]) && !Array.isArray(record[key])) {
        record[key] = typeof path[i + 1] === "number" ? [] : {};
      }
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
  const baseline = captureChartPresentation(JSON.stringify(built.option));
  if (!presentation?.edits.length) return { ...built, presentation: baseline };
  const option = applyEdits(built.option, presentation);
  return {
    ...built,
    option,
    presentation: captureChartPresentation(JSON.stringify(option), baseline),
  };
}
