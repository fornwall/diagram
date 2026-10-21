// Preserve chart interactions across relayouts. ECharts keeps some state in its current option
// and the rest, such as dragged nodes and drill-down roots, in its internal model.

import type * as ECharts from "echarts/core";
import { asArray, isPlainObject } from "../protocol";
import { modelOf, type SeriesModel } from "./echartsItems";
import { baseOption, type JsonObject } from "./echartsOption";

/** Option fields changed by user interaction. Zoom ranges are handled separately. */
const USER_STATE: Record<string, string[]> = {
  legend: ["selected", "scrollDataIndex"],
  timeline: ["currentIndex"],
  visualMap: ["range", "selected"],
};

/** Series whose pan and zoom state is stored in their options. */
const ROAM_SERIES = ["graph", "tree", "sankey"];

/** Restore option state after laying out the same chart at a new size. */
export function keepUserState(option: JsonObject, shown: JsonObject): void {
  const base = baseOption(option);
  const shownSeries = asArray(shown.series);
  asArray(base.series).forEach((series, index) => {
    if (!series.roam || !ROAM_SERIES.includes(String(series.type))) return;
    const current = shownSeries[index];
    for (const key of ["center", "zoom"]) {
      if (current?.[key] !== undefined) series[key] = current[key];
    }
  });
  for (const [component, keys] of Object.entries(USER_STATE)) {
    const shownComponents = asArray(shown[component]);
    asArray(base[component]).forEach((each, index) => {
      const current = shownComponents[index];
      for (const key of keys) {
        if (current?.[key] !== undefined) {
          each[key] = current[key];
        }
      }
    });
  }
  const shownZooms = asArray(shown.dataZoom);
  asArray(base.dataZoom).forEach((zoom, index) => {
    const current = shownZooms[index];
    if (typeof current?.start === "number" && typeof current.end === "number") {
      Object.assign(zoom, { start: current.start, end: current.end });
      delete zoom.startValue;
      delete zoom.endValue;
    }
  });
}

/** The part of ECharts' node data used to preserve drag positions. */
interface Nodes {
  count(): number;
  getId(index: number): string;
  /** The model's copy of the node option, including its original position. */
  getRawDataItem(index: number): unknown;
  /** The current position, including user drags. */
  getItemLayout(index: number): unknown;
}

/**
 * Drag positions by node id, normalized against the bounds of undragged nodes (or all nodes
 * when every node was dragged). Coordinates run from 0 at the top/left to 1 at the bottom/right.
 */
type Drags = Map<string, [number, number]>;

/** Node bounds; a zero width or height becomes one to avoid division by zero. */
interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * State restored into each model. Keep the original bounds because restoring a drag overwrites
 * its node's coordinates; the next relayout still needs the original reference frame.
 */
const handedDrags = new WeakMap<object, { drags: Drags; bounds: Bounds }>();

/** Read finite coordinates from a node option. */
function placedAt(item: unknown): [number, number] | undefined {
  const [x, y] = isPlainObject(item) ? [Number(item.x), Number(item.y)] : [];
  return x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y)
    ? [x, y]
    : undefined;
}

/** Bounds of node options, excluding any ids matched by skipped. */
function placedBounds(nodes: Nodes, skipped: (id: string) => boolean = () => false) {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (let index = 0, count = nodes.count(); index < count; index++) {
    const at = placedAt(nodes.getRawDataItem(index));
    if (!at || skipped(nodes.getId(index))) continue;
    left = Math.min(left, at[0]);
    top = Math.min(top, at[1]);
    right = Math.max(right, at[0]);
    bottom = Math.max(bottom, at[1]);
  }
  return left === Infinity
    ? undefined
    : { x: left, y: top, width: right - left || 1, height: bottom - top || 1 };
}

/**
 * Capture drags in positioned graphs, including force graphs positioned by the panel. Compare
 * each node's current layout with its option coordinates, retaining previously restored drags.
 */
function draggedNodes(series: SeriesModel): Drags | undefined {
  if (series.subType !== "graph" || series.get("layout") !== "none") return undefined;
  // Raw data includes legend-hidden nodes; only visible nodes have current layout coordinates.
  const nodes = series.getRawData() as unknown as Nodes;
  const drawn = (series as unknown as { getData(): Nodes }).getData();
  const where = new Map<string, unknown>();
  for (let index = 0, count = drawn.count(); index < count; index++) {
    where.set(drawn.getId(index), drawn.getItemLayout(index));
  }
  const handed = handedDrags.get(series);
  const ids = new Set(handed?.drags.keys());
  const points = new Map<string, [number, number]>();
  for (let index = 0, count = nodes.count(); index < count; index++) {
    const id = nodes.getId(index);
    const placed = placedAt(nodes.getRawDataItem(index));
    // A node that the legend hides stays where it is placed.
    const at = where.has(id) ? where.get(id) : placed;
    const [x, y] = Array.isArray(at) ? at.map(Number) : [];
    if (!placed || x === undefined || y === undefined || !Number.isFinite(x + y)) continue;
    if (Math.abs(x - placed[0]) + Math.abs(y - placed[1]) > 1e-9) ids.add(id);
    if (ids.has(id)) points.set(id, [x, y]);
  }
  if (ids.size === 0) return undefined;
  // Undragged nodes define the frame. If none remain, use the bounds saved before restoration.
  const box = placedBounds(nodes, (id) => ids.has(id)) ?? handed?.bounds ?? placedBounds(nodes);
  if (!box) return undefined;
  const drags: Drags = new Map();
  for (const id of ids) {
    const [x, y] = points.get(id) ?? [];
    if (x !== undefined && y !== undefined) {
      drags.set(id, [(x - box.x) / box.width, (y - box.y) / box.height]);
    }
  }
  return drags;
}

/**
 * Restore normalized drags relative to the new positions of undragged nodes, or all nodes if
 * every node was dragged.
 */
function placeDragged(series: SeriesModel, drags: Drags): void {
  if (series.subType !== "graph" || series.get("layout") !== "none") return;
  const nodes = series.getRawData() as unknown as Nodes;
  const bounds = placedBounds(nodes);
  const box = placedBounds(nodes, (id) => drags.has(id)) ?? bounds;
  if (!box || !bounds) return;
  for (let index = 0, count = nodes.count(); index < count; index++) {
    const drag = drags.get(nodes.getId(index));
    // Mutate ECharts' model copy, leaving the source option untouched.
    const item = nodes.getRawDataItem(index);
    if (drag && isPlainObject(item)) {
      item.x = box.x + drag[0] * box.width;
      item.y = box.y + drag[1] * box.height;
    }
  }
  handedDrags.set(series, { drags, bounds });
}

/**
 * Capture model-only state: force positions, dragged nodes, drill-down roots and expanded tree
 * nodes. Call the returned function on the new model before ECharts lays it out.
 */
export function modelState(chart: ECharts.ECharts): (chart: ECharts.ECharts) => void {
  const restores: ((series: SeriesModel) => void)[] = [];
  modelOf(chart).eachRawSeries((series) => {
    const points = series.preservedPoints;
    const drags = draggedNodes(series);
    const viewRoot = series.getViewRoot?.().dataIndex;
    const tree = series.subType === "tree" ? series.getRawData().tree : undefined;
    const expanded: boolean[] = [];
    if (tree) {
      for (let index = 0, count = series.getRawData().count(); index < count; index++) {
        expanded[index] = tree.getNodeByDataIndex(index).isExpand;
      }
    }
    restores[series.componentIndex] = (next) => {
      next.preservedPoints = points;
      if (drags) placeDragged(next, drags);
      const nextTree = next.getRawData().tree;
      if (viewRoot !== undefined && nextTree) {
        next.resetViewRoot?.(nextTree.getNodeByDataIndex(viewRoot));
      }
      expanded.forEach((isExpand, index) => {
        const node = nextTree?.getNodeByDataIndex(index);
        if (node) node.isExpand = isExpand;
      });
    };
  });
  return (next) => {
    modelOf(next).eachRawSeries((series) => restores[series.componentIndex]?.(series));
  };
}
