// Places the nodes of a graph's force layout where ECharts' own would bring them to rest, and fits
// them into the chart, so that a graph is drawn whole and the same each time.

import { isPlainObject } from "../protocol";
import { type Area, LABEL_LINE_HEIGHT, type Size, styleOf } from "./echartsMeasure";
import type { JsonObject } from "./echartsOption";

/**
 * The width of the room for a graph's nodes in an area as a share of its height, less what their
 * symbols and labels take around them on average, of 0.4 to 2.5.
 */
function nodesAspect(graph: JsonObject, nodes: JsonObject[], area: Area, size: Size): number {
  const extents = nodes.map((node) => nodeExtent(node, graph, size));
  const average = (side: number) =>
    extents.reduce((sum, extent) => sum + (extent[side] ?? 0), 0) / Math.max(1, extents.length);
  const width = area.width - average(0) - average(1);
  const height = area.height - average(2) - average(3);
  return Math.min(2.5, Math.max(0.4, width / Math.max(1, height)));
}

/** The most nodes of a force layout that the panel places itself, quickly enough on a resize. */
const MAX_PLACED_NODES = 200;

/** The length of an edge that the panel places the nodes of a force layout at, unless told. */
const FORCE_EDGE = 100;

/** The length in pixels of an edge of a force layout that the panel draws, at most. */
const MAX_EDGE = 200;

/** The nodes of force layouts as placed, by the nodes and links that they were placed from. */
const placedNodes = new WeakMap<object, { links: unknown; force: string; nodes: unknown[] }>();

/**
 * Places the nodes of a force layout where ECharts' force layout brings them to rest, as a layout
 * of placed nodes for ECharts to fit into the space there is. ECharts places them at random around
 * the middle of the chart and pushes them apart without bound, by how far depending on the shape
 * of the graph and where they started: of random graphs, half of those in a narrow panel and of
 * those in a wide one had nodes or labels past its edges. Placed so, a graph is drawn whole, and
 * the same each time; a node dragged moves alone, rather than pulling the others along. Not one
 * whose nodes the option places or fixes, or whose layout it starts or animates otherwise, nor
 * one of more nodes than the panel places quickly.
 */
export function placeForceNodes(graph: JsonObject, area: Area, size: Size): boolean {
  const key = graph.data != null ? "data" : "nodes";
  const nodes: unknown = graph[key];
  const links: unknown = graph.links ?? graph.edges;
  const force = styleOf(graph.force);
  if (
    !Array.isArray(nodes) ||
    nodes.length === 0 ||
    nodes.length > MAX_PLACED_NODES ||
    ["initLayout", "friction", "layoutAnimation"].some((name) => force[name] !== undefined) ||
    !nodes.every((node) => isPlainObject(node) && node.x == null && node.y == null && !node.fixed)
  ) {
    return false;
  }
  // The edge length and repulsion that the option gives, or else ECharts' proportions of them.
  const edgeLength = force.edgeLength ?? (force.repulsion === undefined ? FORCE_EDGE : 30);
  const repulsion =
    force.repulsion ?? (force.edgeLength === undefined ? 50 * (FORCE_EDGE / 30) ** 2 : [0, 50]);
  const gravity = typeof force.gravity === "number" ? force.gravity : 0.1;
  // As wide as the area for them is, apart from their labels, in steps of a fourth of a doubling.
  const stretch = 2 ** (Math.round(4 * Math.log2(nodesAspect(graph, nodes, area, size))) / 4);
  const settings = JSON.stringify([edgeLength, repulsion, gravity, stretch]);
  const cached = placedNodes.get(nodes);
  let placed =
    cached && cached.links === links && cached.force === settings ? cached.nodes : undefined;
  if (!placed) {
    const points = restingPoints(nodes, Array.isArray(links) ? links : [], {
      edgeLength,
      repulsion,
      gravity,
      stretch,
    });
    if (!points) return false;
    placed = nodes.map((node: JsonObject, index) => ({ ...node, ...points[index] }));
    placedNodes.set(nodes, { links, force: settings, nodes: placed });
  }
  graph[key] = placed;
  graph.layout = "none";
  return true;
}

/** A setting of a range by value, as a repulsion or edge length, as its least and most. */
function settingRange(setting: unknown): [number, number] | undefined {
  const [low, high] = Array.isArray(setting) ? setting : [setting, setting];
  return typeof low === "number" && typeof high === "number" ? [low, high] : undefined;
}

/**
 * ECharts' maps of the values of items onto a range, from the least to the most of them: to the
 * middle of the range for an item without one, or items of one value.
 */
function mapValues(items: unknown[], [low, high]: [number, number]): number[] {
  const values = items.map((item) =>
    isPlainObject(item) && typeof item.value === "number" ? item.value : Number.NaN,
  );
  const finite = values.filter(Number.isFinite);
  const [least, most] = [Math.min(...finite), Math.max(...finite)];
  return values.map((value) =>
    Number.isFinite(value) && most > least
      ? low + ((value - least) / (most - least)) * (high - low)
      : (low + high) / 2,
  );
}

/** A node of a force layout as it moves: where it is and was, and how hard it pushes the others. */
interface Moving {
  x: number;
  y: number;
  /** Where it was, less the push of the others, which moves it on the next step. */
  px: number;
  py: number;
  repulsion: number;
}

/**
 * Where ECharts' force layout brings nodes to rest, as its forceHelper.js moves them, from places
 * that a seeded random number generator gives, but pulled toward the middle of where they are
 * rather than of the chart, which is what ECharts takes for the middle of nodes placed for it.
 * Each node pushes the others away by its repulsion, by its value of a range, and each link pulls
 * its ends toward its length, by its value of a range, the longest for the smallest. Undefined for
 * settings of kinds that ECharts would not lay out by.
 */
function restingPoints(
  nodes: JsonObject[],
  links: unknown[],
  force: { edgeLength: unknown; repulsion: unknown; gravity: number; stretch: number },
): { x: number; y: number }[] | undefined {
  const repulsions = settingRange(force.repulsion);
  const lengths = settingRange(force.edgeLength);
  if (!repulsions || !lengths) return undefined;
  let seed = 1;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  // At first within a square as wide as the nodes take apart, around 0.
  const span = (FORCE_EDGE * Math.sqrt(nodes.length)) / 2;
  const moving: Moving[] = mapValues(nodes, repulsions).map((repulsion) => {
    const [x, y] = [(random() - 0.5) * span, (random() - 0.5) * span];
    return { x, y, px: x, py: y, repulsion };
  });
  // Links name their ends by id, name or index.
  const indices = new Map(nodes.map((node, index) => [String(node.id ?? node.name), index]));
  const end = (value: unknown) =>
    moving[typeof value === "number" ? value : (indices.get(String(value)) ?? -1)];
  const pulled = links.filter((link) => isPlainObject(link) && link.ignoreForceLayout !== true);
  const edgeLengths = mapValues(pulled, [lengths[1], lengths[0]]);
  const edges = pulled.flatMap((link, index) => {
    const [n1, n2] = isPlainObject(link) ? [end(link.source), end(link.target)] : [];
    return n1 && n2 ? [{ n1, n2, length: edgeLengths[index] ?? 0 }] : [];
  });
  // Pulled toward the middle harder up and down than across, nodes take a width of about the
  // square of that times their height.
  const pull = Math.sqrt(force.stretch);
  for (let friction = 0.6; friction >= 0.01; friction *= 0.992) {
    for (const { n1, n2, length } of edges) {
      const distance = Math.hypot(n2.x - n1.x, n2.y - n1.y);
      const [ux, uy] = distance > 0 ? [(n2.x - n1.x) / distance, (n2.y - n1.y) / distance] : [0, 0];
      const pull = (distance - length) * friction;
      const share = n2.repulsion / (n1.repulsion + n2.repulsion) || 0;
      n1.x += ux * share * pull;
      n1.y += uy * share * pull;
      n2.x -= ux * (1 - share) * pull;
      n2.y -= uy * (1 - share) * pull;
    }
    let [left, right, top, bottom] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const { x, y } of moving) {
      [left, right, top, bottom] = [
        Math.min(left, x),
        Math.max(right, x),
        Math.min(top, y),
        Math.max(bottom, y),
      ];
    }
    for (const node of moving) {
      node.x += ((left + right) / 2 - node.x) * (force.gravity / pull) * friction;
      node.y += ((top + bottom) / 2 - node.y) * force.gravity * pull * friction;
    }
    for (let i = 0; i < moving.length; i++) {
      const n1 = moving[i] as Moving;
      for (let j = i + 1; j < moving.length; j++) {
        const n2 = moving[j] as Moving;
        let vx = n2.x - n1.x;
        let vy = n2.y - n1.y;
        let squared = vx * vx + vy * vy;
        if (squared === 0) [vx, vy, squared] = [random() - 0.5, random() - 0.5, 1];
        const push = (n1.repulsion + n2.repulsion) / squared;
        n1.px += vx * push;
        n1.py += vy * push;
        n2.px -= vx * push;
        n2.py -= vy * push;
      }
    }
    for (const node of moving) {
      node.x += (node.x - node.px) * friction;
      node.y += (node.y - node.py) * friction;
      node.px = node.x;
      node.py = node.y;
    }
  }
  return moving.map(({ x, y }) => ({ x, y }));
}

/**
 * How far a node of a graph takes room from where it is, to the left, right, top and bottom: half
 * its symbol, and its label, which the theme places right of the node unless told otherwise, 5
 * pixels from it.
 */
function nodeExtent(
  node: JsonObject,
  graph: JsonObject,
  size: Size,
): [number, number, number, number] {
  const symbol = (value: unknown): number[] | undefined =>
    typeof value === "number"
      ? [value, value]
      : Array.isArray(value) && value.every((each) => typeof each === "number")
        ? [value[0] ?? 0, value[1] ?? value[0] ?? 0]
        : undefined;
  const [width = 10, height = 10] = symbol(node.symbolSize) ?? symbol(graph.symbolSize) ?? [];
  const [x, y] = [width / 2, height / 2];
  const own = styleOf(node.label);
  const label = { ...styleOf(graph.label), ...own };
  if (label.show !== true) return [x, x, y, y];
  const text = size.font(label).width(String(node.name ?? ""));
  // A line of text, half above and below the middle of the node beside it.
  const line = LABEL_LINE_HEIGHT / 2;
  switch (label.position ?? "right") {
    case "left":
      return [x + 5 + text, x, Math.max(y, line), Math.max(y, line)];
    case "right":
      return [x, x + 5 + text, Math.max(y, line), Math.max(y, line)];
    case "top":
      return [Math.max(x, text / 2), Math.max(x, text / 2), y + 5 + 2 * line, y];
    case "bottom":
      return [Math.max(x, text / 2), Math.max(x, text / 2), y, y + 5 + 2 * line];
    default:
      return [Math.max(x, text / 2), Math.max(x, text / 2), Math.max(y, line), Math.max(y, line)];
  }
}

/**
 * The most pixels a unit of a graph's placed nodes can take along an axis for them to fit into a
 * length, with what each takes beyond where it is before and after it: no two of them too far
 * apart for what they take between them. Infinite for nodes all in one place.
 */
function mostScale(at: number[], before: number[], after: number[], length: number): number {
  let most = Number.POSITIVE_INFINITY;
  at.forEach((first, i) => {
    at.forEach((second, j) => {
      if (second > first) {
        most = Math.min(most, (length - (after[j] ?? 0) - (before[i] ?? 0)) / (second - first));
      }
    });
  });
  return most;
}

/**
 * Fits a graph's placed nodes into an area of the chart, as large as there is room for and in the
 * middle of it, with the room each takes around it for its symbol and label: the box that ECharts
 * fits them into, keeping their aspect, is where their bounds go, as much bigger than the area as
 * labels may take beyond them, which are not as long as the longest at every edge.
 */
export function fitPlacedGraph(graph: JsonObject, area: Area, size: Size): void {
  const data: unknown = graph.data ?? graph.nodes;
  const nodes = (Array.isArray(data) ? data : []).filter(isPlainObject);
  const xs = nodes.map((node) => Number(node.x));
  const ys = nodes.map((node) => Number(node.y));
  const extents = nodes.map((node) => nodeExtent(node, graph, size));
  const side = (index: number) => extents.map((extent) => extent[index] ?? 0);
  const [left, right, top, bottom] = [side(0), side(1), side(2), side(3)];
  const fit = (before: number[][], after: number[][]) =>
    Math.min(
      mostScale(xs, before[0] ?? [], after[0] ?? [], area.width),
      mostScale(ys, before[1] ?? [], after[1] ?? [], area.height),
    );
  // Where labels take more than the area, the nodes alone fill it.
  const none = nodes.map(() => 0);
  let scale = fit([left, top], [right, bottom]);
  if (!(scale > 0)) scale = fit([none, none], [none, none]);
  // No longer edges than a force layout spread over the panel had, of a few nodes in a large one.
  const [shortest = FORCE_EDGE, longest = FORCE_EDGE] =
    settingRange(isPlainObject(graph.force) ? graph.force.edgeLength : undefined) ?? [];
  scale = Math.min(scale, MAX_EDGE / ((shortest + longest) / 2));
  // ECharts widens bounds of no width or height by a unit each way.
  const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
  const [minY, maxY] = [Math.min(...ys), Math.max(...ys)];
  const [fromX, toX] = maxX > minX ? [minX, maxX] : [minX - 1, maxX + 1];
  const [fromY, toY] = maxY > minY ? [minY, maxY] : [minY - 1, maxY + 1];
  const units = Number.isFinite(scale) && scale > 0 ? scale : 1;
  // Where the nodes and what they take reach, from where the bounds start, and so where they
  // start in the middle of the area.
  const reach = (
    at: number[],
    before: number[],
    after: number[],
    from: number,
  ): [number, number] => {
    const starts = at.map((each, index) => (each - from) * units - (before[index] ?? 0));
    const ends = at.map((each, index) => (each - from) * units + (after[index] ?? 0));
    return [Math.min(...starts), Math.max(...ends)];
  };
  const [startX, endX] = reach(xs, left, right, fromX);
  const [startY, endY] = reach(ys, top, bottom, fromY);
  Object.assign(graph, {
    left: Math.round(area.left + (area.width - (endX - startX)) / 2 - startX),
    top: Math.round(area.top + (area.height - (endY - startY)) / 2 - startY),
    width: (toX - fromX) * units,
    height: (toY - fromY) * units,
  });
}

/**
 * Spreads the nodes of a force layout over the space there is for them, unless the option says how
 * far. ECharts' defaults are for no size, and huddle a few nodes in the middle of a chart: edges as
 * long as half the room each node has, with the repulsion that ECharts' defaults have to them.
 */
export function spreadForce(graph: JsonObject, width: number, height: number): void {
  const force = styleOf(graph.force);
  if (force.edgeLength !== undefined || force.repulsion !== undefined) return;
  const nodes: unknown = graph.data ?? graph.nodes;
  const count = Array.isArray(nodes) ? Math.max(1, nodes.length) : 1;
  const edgeLength = Math.round(
    Math.min(MAX_EDGE, Math.max(10, 0.5 * Math.sqrt((width * height) / count))),
  );
  // ECharts' defaults: an edge length of 30 and a repulsion of 50.
  graph.force = { ...force, edgeLength, repulsion: Math.round(50 * (edgeLength / 30) ** 2) };
}
