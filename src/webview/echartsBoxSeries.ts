// Lays out the series that ECharts draws in a box of their own, clear of the components around
// the plot: funnels, sankeys, trees, treemaps, graphs and chord diagrams, with room for the labels
// beside them.

import { isPlainObject } from "../protocol";
import { fitPlacedGraph, placeForceNodes, spreadForce } from "./echartsForce";
import {
  type Area,
  BOX_KEYS,
  entryText,
  type Font,
  has,
  type Insets,
  LABEL_LINE_HEIGHT,
  lineCount,
  MAX_READ_CATEGORIES,
  pixels,
  type Size,
  styleOf,
  widestText,
} from "./echartsMeasure";
import type { JsonObject } from "./echartsOption";

/**
 * Keeps series that ECharts lays out in a box clear of the title, legend and other components.
 * The nodes of a force layout that a timeline's steps set stay ECharts' to place, as those of the
 * step shown would replace the nodes placed.
 */
export function layOutBoxSeries(
  series: JsonObject[],
  reserved: Insets,
  size: Size,
  stepped: ReadonlySet<unknown>,
): void {
  const { width, height } = size;
  for (const each of series) {
    const type = String(each.type);
    const placed =
      has(each, BOX_KEYS) ||
      (type === "graph" && (each.coordinateSystem ?? "view") !== "view") ||
      (type === "chord" && each.center !== undefined);
    if (placed || !["funnel", "sankey", "tree", "treemap", "graph", "chord"].includes(type)) {
      continue;
    }
    if (type === "graph" && (each.layout ?? "none") === "none") {
      // ECharts fits the nodes where they are into 80% of the chart, keeping their aspect: fit
      // them so into the space left instead, as a box alone would stretch them to fill it.
      const marginX = Math.round((width - reserved.left - reserved.right) * 0.1);
      const marginY = Math.round((height - reserved.top - reserved.bottom) * 0.1);
      Object.assign(each, {
        top: reserved.top + marginY,
        bottom: reserved.bottom + marginY,
        left: reserved.left + marginX,
        right: reserved.right + marginX,
      });
      each.preserveAspect ??= true;
      continue;
    }
    const area: Area = {
      left: reserved.left + 8,
      top: reserved.top + 8,
      width: width - reserved.left - reserved.right - 16,
      height: height - reserved.top - reserved.bottom - 16,
    };
    if (
      type === "graph" &&
      each.layout === "force" &&
      !stepped.has(each) &&
      placeForceNodes(each, area, size)
    ) {
      fitPlacedGraph(each, area, size);
      each.preserveAspect ??= true;
      continue;
    }
    if (type === "graph" && each.layout === "force")
      spreadForce(
        each,
        width - reserved.left - reserved.right,
        height - reserved.top - reserved.bottom,
      );
    // Trees and funnels keep ECharts' default margins, for the labels beside them.
    const side = type === "tree" ? Math.round(width * 0.12) : type === "funnel" ? 80 : 12;
    const [left, right] =
      type === "funnel"
        ? funnelSides(each, side, size, {
            width: width - reserved.left - reserved.right,
            height: height - reserved.top - reserved.bottom - 24,
          })
        : type === "tree"
          ? treeSides(each, side, size)
          : // Room for the labels right of the last column of sankey nodes.
            [side, type === "sankey" ? Math.round(Math.min(160, width * 0.18)) : side];
    // Room for the breadcrumb of a treemap.
    const breadcrumb = type === "treemap" ? breadcrumbSide(each, height) : undefined;
    Object.assign(each, {
      top: reserved.top + (breadcrumb === "top" ? 36 : 12),
      bottom: reserved.bottom + (breadcrumb === "bottom" ? 36 : 12),
      left: reserved.left + left,
      right: reserved.right + right,
    });
  }
}

/**
 * The room a funnel keeps on its left and right: the margin, and on the side of its labels, which
 * ECharts draws beside it on the right unless told otherwise, as much as they take, up to 40% of
 * the width. Its widest stage spans the box it is laid out in, and a narrower one starts its label
 * further in (see {@link funnelInward}). A label wider than the room beside its stage goes onto
 * lines in it, as ECharts breaks them between words, where the stage is tall enough for them, and
 * else is cut short; the tooltip tells it whole.
 */
function funnelSides(
  funnel: JsonObject,
  margin: number,
  size: Size,
  area: { width: number; height: number },
): [number, number] {
  const label = styleOf(funnel.label);
  const position = String(label.position ?? "outer");
  if (
    label.show === false ||
    funnel.orient === "horizontal" ||
    ["inner", "inside", "center", "insideLeft", "insideRight"].includes(position)
  ) {
    return [margin, margin];
  }
  const sides = (room: number): [number, number] =>
    position.startsWith("left") ? [room, margin] : [margin, room];
  const most = Math.round(size.width * 0.4);
  const { width, breakWidth } = size.font(label);
  // A template adds its text, and a value of about 6 characters for each other placeholder.
  const { formatter } = label;
  const added =
    typeof formatter === "string"
      ? width(
          formatter.replace(/\{[^{}]*\}/g, "") +
            "000.00".repeat(formatter.match(/\{(?!b\})[^{}]*\}/g)?.length ?? 0),
        )
      : 0;
  const line = styleOf(funnel.labelLine);
  // The label line, the gap after it, and a margin to the edge.
  const gap = (typeof line.length === "number" ? line.length : 20) + 13;
  const data: unknown[] = Array.isArray(funnel.data) ? funnel.data : [];
  const stages =
    data.length <= MAX_READ_CATEGORIES ? funnelInward(funnel, data, position) : undefined;
  if (!stages) {
    const text = widestText(funnel.data, width, most) + added;
    return sides(Math.max(margin, Math.min(most, Math.round(text + gap))));
  }
  const { inward, edge } = stages;
  // The box spans the area but for the margin and the room on the side of the labels.
  const free = area.width - margin;
  const texts = data.map((item) => width(entryText(item)) + added);
  const needed = texts.map((text, index) => {
    const share = inward[index] ?? 0;
    return (text + gap - free * share) / (1 - share);
  });
  const room = Math.max(margin, Math.min(most, Math.round(Math.max(0, ...needed))));
  const template = formatter === undefined ? "{b}" : formatter;
  if (
    label.width !== undefined ||
    label.overflow !== undefined ||
    typeof template !== "string" ||
    // Of rich text, whose styles the layout does not measure.
    template.includes("|")
  ) {
    return sides(room);
  }
  const stage = area.height / Math.max(1, data.length);
  funnel.data = data.map((item, index) => {
    // Up to a couple of pixels from the edge, rather than the margin the room keeps.
    const available = room + (free - room) * (inward[index] ?? 0) - gap + 6;
    const own: JsonObject = isPlainObject(item) ? item : { value: item };
    const itemLabel = styleOf(own.label);
    if ((texts[index] ?? 0) <= available || has(itemLabel, ["width", "overflow"])) return item;
    const name = entryText(item);
    const shown = template.replace(/\{b\}/g, () => name).replace(/\{[^{}]*\}/g, "000.00");
    const lineWidth = Math.max(40, Math.floor(available));
    const lines = lineCount(shown, lineWidth, breakWidth);
    // Centered on the corner at the funnel's top or bottom, more than a line would reach past it.
    const overflow = lines * LABEL_LINE_HEIGHT <= stage && index !== edge ? "break" : "truncate";
    return { ...own, label: { width: lineWidth, overflow, ...itemLabel } };
  });
  return sides(room);
}

/**
 * How far in from the side of its box ECharts starts the label of each stage of a funnel beside
 * it, as a share of the box's width: from the middle of the stage's side, or its corner, where the
 * stage is as wide as its value and the next stage's value make it, between its least and most
 * size; and the stage whose label is at the funnel's top or bottom, beside its corner there.
 * Undefined where the layout cannot tell, as of a funnel aligned, sorted or sized otherwise.
 */
function funnelInward(
  funnel: JsonObject,
  data: unknown[],
  position: string,
): { inward: number[]; edge: number | undefined } | undefined {
  const share = (size: unknown, fallback: number) =>
    size === undefined
      ? fallback
      : typeof size === "string" && /^\d+(?:\.\d+)?%$/.test(size.trim())
        ? Number.parseFloat(size) / 100
        : undefined;
  const [least, most] = [share(funnel.minSize, 0), share(funnel.maxSize, 1)];
  const sort = funnel.sort ?? "descending";
  if (
    least === undefined ||
    most === undefined ||
    (funnel.funnelAlign ?? "center") !== "center" ||
    !["descending", "ascending", "none"].includes(String(sort)) ||
    !["outer", "right", "left", "rightTop", "rightBottom", "leftTop", "leftBottom"].includes(
      position,
    )
  ) {
    return undefined;
  }
  const values = data.map((item) => {
    const value = Number(isPlainObject(item) ? item.value : item);
    return Number.isFinite(value) ? value : 0;
  });
  // Ascending, ECharts draws the stages from the bottom up, each beside the same next one.
  const order = values.map((_, index) => index);
  if (sort !== "none") order.sort((a, b) => (values[b] ?? 0) - (values[a] ?? 0));
  const low = typeof funnel.min === "number" ? funnel.min : Math.min(0, ...values);
  const high = typeof funnel.max === "number" ? funnel.max : Math.max(...values);
  const size = (value: number) =>
    high > low
      ? least + (most - least) * Math.min(1, Math.max(0, (value - low) / (high - low)))
      : (least + most) / 2;
  const inward = values.map(() => 0);
  order.forEach((index, at) => {
    const next = order[at + 1];
    const [own, after] = [
      size(values[index] ?? 0),
      size(next === undefined ? 0 : (values[next] ?? 0)),
    ];
    const side = position.endsWith("Top")
      ? own / 2
      : position.endsWith("Bottom")
        ? after / 2
        : (own + after) / 4;
    inward[index] = Math.max(0, 1 / 2 - side);
  });
  // The first stage starts at the top of the funnel, or ascending at its bottom, and the last
  // ends at the other.
  const edge = position.endsWith("Top")
    ? order[0]
    : position.endsWith("Bottom")
      ? order[order.length - 1]
      : undefined;
  return { inward, edge };
}

/**
 * Labels the nodes of a tree laid out from left to right, or right to left, beside them, as
 * ECharts' examples do, unless told otherwise: the nodes with children before them, toward the
 * root, and the leaves after them. ECharts centers a label on its node, where it runs over the
 * node and its lines. A label longer than the room the tree keeps beside it (see
 * {@link treeSides}) goes onto lines, if the deepest nodes are far enough apart, or is cut short.
 */
export function labelTreeNodes(series: JsonObject[], { width, height }: Size): void {
  for (const tree of series) {
    const orient = tree.orient ?? "LR";
    const label = styleOf(tree.label);
    if (
      tree.type !== "tree" ||
      (tree.layout ?? "orthogonal") !== "orthogonal" ||
      (orient !== "LR" && orient !== "RL") ||
      label.position !== undefined
    ) {
      continue;
    }
    const [before, after] = orient === "LR" ? ["left", "right"] : ["right", "left"];
    const [root] = Array.isArray(tree.data) ? tree.data : [];
    const apart = height / Math.max(1, deepestShown(root, tree).length);
    const beside = (side: string) => ({
      position: side,
      align: side === "left" ? "right" : "left",
      verticalAlign: "middle",
      width: Math.round(width * MAX_TREE_LABELS) - 12,
      overflow: apart >= 2 * LABEL_LINE_HEIGHT + 4 ? "break" : "truncate",
    });
    tree.label = { ...beside(before), ...label };
    const leaves = styleOf(tree.leaves);
    const leafLabel = styleOf(leaves.label);
    if (leafLabel.position === undefined) {
      tree.leaves = { ...leaves, label: { ...beside(after), ...leafLabel } };
    }
  }
}

/** The width of the labels beside a tree, at most, as a share of the chart's width. */
const MAX_TREE_LABELS = 0.4;

/** The nodes of the deepest level of a tree that ECharts shows, at first, below its root. */
function deepestShown(root: unknown, tree: JsonObject): unknown[] {
  // ECharts shows two levels below the root unless told otherwise.
  const depth = typeof tree.initialTreeDepth === "number" ? tree.initialTreeDepth : 2;
  let deepest: unknown[] = [root];
  for (let level = 0; depth < 0 || level < depth; level++) {
    const next = deepest.flatMap((node) =>
      isPlainObject(node) && Array.isArray(node.children) && node.collapsed !== true
        ? node.children
        : [],
    );
    if (next.length === 0) break;
    deepest = next;
  }
  return deepest;
}

/**
 * The room a tree laid out from left to right, or right to left, keeps beside it: the margin, or
 * as much as the labels at its ends take, of its root and of the nodes of the deepest level it
 * shows, beside them (see {@link labelTreeNodes}) or centered on them, up to 40% of the width.
 */
function treeSides(tree: JsonObject, margin: number, size: Size): [number, number] {
  const orient = tree.orient ?? "LR";
  const [root] = Array.isArray(tree.data) ? tree.data : [];
  if ((tree.layout ?? "orthogonal") !== "orthogonal" || (orient !== "LR" && orient !== "RL")) {
    return [margin, margin];
  }
  if (!isPlainObject(root)) return [margin, margin];
  const deepest = deepestShown(root, tree);
  const position = (label: unknown) => (isPlainObject(label) ? label.position : undefined);
  const leaves = isPlainObject(tree.leaves) ? tree.leaves.label : undefined;
  const most = Math.round(size.width * MAX_TREE_LABELS);
  // The width a label takes beyond its node on a side: all of it on that side, none on the
  // other, and half when centered on it. Past the symbol, with a gap to the edge.
  const room = (labels: unknown[], placed: unknown, side: "left" | "right", font: Font) => {
    const share = placed === side ? 1 : placed === "left" || placed === "right" ? 0 : 0.5;
    const text = widestText(labels, font.width, most) * share;
    return Math.max(margin, Math.min(most, Math.round(text + 12)));
  };
  const rootSide = orient === "LR" ? "left" : "right";
  const endSide = orient === "LR" ? "right" : "left";
  const font = size.font(styleOf(tree.label));
  const start = room([root], position(tree.label), rootSide, font);
  // The leaves are labeled as "leaves" says, and the nodes whose children are not shown yet not.
  const isLeaf = (node: unknown) => !isPlainObject(node) || !Array.isArray(node.children);
  const end = Math.max(
    room(
      deepest.filter(isLeaf),
      position(leaves) ?? position(tree.label),
      endSide,
      size.font(styleOf(leaves), styleOf(tree.label)),
    ),
    room(
      deepest.filter((node) => !isLeaf(node)),
      position(tree.label),
      endSide,
      font,
    ),
  );
  return orient === "LR" ? [start, end] : [end, start];
}

/** The side of the chart a treemap shows its breadcrumb on, which is the bottom unless moved. */
function breadcrumbSide(treemap: JsonObject, height: number): "top" | "bottom" | undefined {
  const breadcrumb = styleOf(treemap.breadcrumb);
  if (breadcrumb.show === false) {
    return undefined;
  }
  // ECharts places the breadcrumb by its top when set, and by its bottom otherwise.
  const { top } = breadcrumb;
  if (top === undefined || top === "bottom") {
    return "bottom";
  }
  if (top === "middle" || top === "center") {
    return undefined;
  }
  const offset = top === "top" ? 0 : pixels(top, height);
  return offset === undefined ? "bottom" : offset < height / 2 ? "top" : "bottom";
}
