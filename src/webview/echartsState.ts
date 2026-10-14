// What the user changed in a shown chart, such as a legend's selection or a drill-down, carried
// over to a new layout of its option, which would otherwise start over. ECharts keeps some of it in
// the option it shows, and some only in its model.

import type * as ECharts from "echarts/core";
import { asArray, isPlainObject } from "../protocol";
import { modelOf, type SeriesModel } from "./echartsItems";
import { baseOption, type JsonObject } from "./echartsOption";

/** What the user can change in a shown chart, by component: besides the zoom ranges. */
const USER_STATE: Record<string, string[]> = {
  legend: ["selected", "scrollDataIndex"],
  timeline: ["currentIndex"],
  visualMap: ["range", "selected"],
};

/** The series that keep the center and zoom that the user pans and zooms them to in their option. */
const ROAM_SERIES = ["graph", "tree", "sankey"];

/** Carries what the user changed in the shown option, such as a legend's selection, over to a new layout of it. */
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

/** The nodes of a graph as ECharts holds them. */
interface Nodes {
  count(): number;
  getId(index: number): string;
  /** The node's option, of the model's own, with where it is placed. */
  getRawDataItem(index: number): unknown;
  /** Where the node is, which a drag moves it from where it is placed. */
  getItemLayout(index: number): unknown;
}

/**
 * Where the user dragged the nodes of a graph, by id: across and down the bounds of the nodes
 * that stay where they are placed, from 0 at their left or top to 1 at their right or bottom.
 */
type Drags = Map<string, [number, number]>;

/** The nodes dragged in the graphs that a model was handed them for, as they still are. */
const handedDrags = new WeakMap<object, Drags>();

/** Where a node is placed, if it is. */
function placedAt(item: unknown): [number, number] | undefined {
  const [x, y] = isPlainObject(item) ? [Number(item.x), Number(item.y)] : [];
  return x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y)
    ? [x, y]
    : undefined;
}

/** The bounds of where the nodes are placed but those of some ids, if any. */
function placedBounds(nodes: Nodes, skipped: (id: string) => boolean) {
  const points: [number, number][] = [];
  for (let index = 0, count = nodes.count(); index < count; index++) {
    const at = placedAt(nodes.getRawDataItem(index));
    if (at && !skipped(nodes.getId(index))) points.push(at);
  }
  if (points.length === 0) return undefined;
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const [x, y] = [Math.min(...xs), Math.min(...ys)];
  // Of a unit where the nodes are all in a line.
  return { x, y, width: Math.max(...xs) - x || 1, height: Math.max(...ys) - y || 1 };
}

/**
 * Where the user dragged the nodes of a graph of placed nodes, as the panel places those of a
 * force layout, besides those dragged before a new layout and not since. ECharts moves a dragged
 * node from where it is placed, which a new layout, as for another size, would place it again.
 */
function draggedNodes(series: SeriesModel): Drags | undefined {
  if (series.subType !== "graph" || series.get("layout") !== "none") return undefined;
  const nodes = (series as unknown as { getData(): Nodes }).getData();
  const drags: Drags = new Map(handedDrags.get(series));
  const moved: [string, number, number][] = [];
  for (let index = 0, count = nodes.count(); index < count; index++) {
    const at = nodes.getItemLayout(index);
    const placed = placedAt(nodes.getRawDataItem(index));
    const [x, y] = Array.isArray(at) ? at.map(Number) : [];
    if (placed && x !== undefined && y !== undefined && Number.isFinite(x + y)) {
      if (Math.abs(x - placed[0]) + Math.abs(y - placed[1]) > 1e-9) {
        moved.push([nodes.getId(index), x, y]);
      }
    }
  }
  const box = placedBounds(nodes, (id) => drags.has(id) || moved.some(([each]) => each === id));
  if (box) {
    for (const [id, x, y] of moved) {
      drags.set(id, [(x - box.x) / box.width, (y - box.y) / box.height]);
    }
  }
  return drags.size > 0 ? drags : undefined;
}

/**
 * Places the dragged nodes of a graph where the user dragged them, of the bounds of the others as
 * they are placed now, as for another size.
 */
function placeDragged(series: SeriesModel, drags: Drags): void {
  if (series.subType !== "graph" || series.get("layout") !== "none") return;
  const nodes = series.getRawData() as unknown as Nodes;
  const box = placedBounds(nodes, (id) => drags.has(id));
  if (!box) return;
  for (let index = 0, count = nodes.count(); index < count; index++) {
    const drag = drags.get(nodes.getId(index));
    // The model's own copy of the node, which ECharts made of the option.
    const item = nodes.getRawDataItem(index);
    if (drag && isPlainObject(item)) {
      item.x = box.x + drag[0] * box.width;
      item.y = box.y + drag[1] * box.height;
    }
  }
  handedDrags.set(series, drags);
}

/**
 * What the user changed in a shown chart that ECharts keeps in its model rather than its option,
 * and a new option would start over from: where the force layout of a graph left its nodes, which
 * it would place anew at random, where the user dragged the nodes of a graph of placed nodes, the
 * node a treemap or sunburst is drilled down to, and the nodes of a tree that are expanded.
 * Returns how to hand it to the model of the same option laid out anew, before that is laid out.
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
