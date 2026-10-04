// Keyboard access to the items of a chart. Like a Mermaid diagram, a chart is one tab stop: arrow
// keys move the focus between its items, Home and End to the first and the last, and Enter or Space
// act on the focused item as a click does. ECharts draws items without elements of their own, and
// charts can have hundreds of thousands, so one ring is placed over the focused item, a live region
// names it, and the item an arrow key leads to is worked out when the key is pressed.

import type * as ECharts from "echarts/core";
import { type ThemeColors, toCss } from "./colors";
import {
  type Box,
  type ChartItems,
  type ItemData,
  type ItemRef,
  itemKey,
  itemValue,
  modelOf,
  parseItemKey,
  type TreeNode,
} from "./echartsItems";
import { arrowDirection, nearestInDirection, type Point } from "./navigation";

/** Series of a hierarchy: arrow keys lead to the parent, the first child and the siblings. */
const TREES = new Set(["tree", "treemap", "sunburst"]);
/** Series of slices: every arrow key steps through them, on to the next series and round. */
const CYCLES = new Set(["pie", "funnel"]);
/** Series whose items lie anywhere, by their values or a layout: arrow keys lead to the nearest. */
const SCATTERED = new Set(["scatter", "effectScatter", "graph", "sankey", "heatmap", "chord"]);

/** The shown items of one type in a series, such as a graph's nodes or its edges. */
interface Track {
  seriesIndex: number;
  type: string;
  data: ItemData;
  dataType: string | undefined;
  /** The index of the first item: 1 in a tree, to leave out the root ECharts adds. */
  first: number;
  /** The direction from an item to the next on the axis of the categories, or to the right. */
  along: Point;
}

/** A shown item, by its index in the data of its track. */
interface Spot {
  track: Track;
  index: number;
}

const center = ({ x, y, width, height }: Box): Point => [x + width / 2, y + height / 2];

/**
 * Where the keyboard leads from one item of a chart to another: in a chart along categories, such
 * as of bars or lines, along a series in the direction its items go, and across series the other
 * way; in a tree to the parent, a child or a sibling; elsewhere to the nearest item.
 */
export class ChartNavigation {
  private readonly tracks: Track[] = [];

  constructor(chart: ECharts.ECharts) {
    // Series hidden by the legend, and items filtered out by data zoom, are not shown.
    modelOf(chart).eachSeries((series) => {
      for (const { data } of series.getAllData()) {
        const dataType = data.dataType === "main" ? undefined : data.dataType;
        const first = data.tree ? 1 : 0;
        // Categories run up a vertical axis, and the other way along an inverse one.
        const axis = series.getBaseAxis();
        const forward = axis?.inverse ? -1 : 1;
        const along: Point = axis?.isHorizontal?.() === false ? [0, -forward] : [forward, 0];
        this.tracks.push({
          seriesIndex: series.componentIndex,
          type: series.subType,
          data,
          dataType,
          first,
          along,
        });
      }
    });
  }

  first(): ItemRef | undefined {
    for (const track of this.tracks) {
      for (let index = track.first; index < track.data.count(); index++) {
        if (this.has(track, index)) return this.ref({ track, index });
      }
    }
    return undefined;
  }

  last(): ItemRef | undefined {
    for (const track of this.tracks.toReversed()) {
      for (let index = track.data.count() - 1; index >= track.first; index--) {
        if (this.has(track, index)) return this.ref({ track, index });
      }
    }
    return undefined;
  }

  /** Whether the chart shows the item. */
  shows(ref: ItemRef): boolean {
    return this.spot(ref) !== undefined;
  }

  /** The item a key leads to from the given one: an arrow key, Home or End. */
  move(from: ItemRef, key: string): ItemRef | undefined {
    if (key === "Home") return this.first();
    if (key === "End") return this.last();
    const spot = this.spot(from);
    const direction = arrowDirection(key);
    if (!spot || !direction) return undefined;
    const { type } = spot.track;
    const to = TREES.has(type)
      ? this.inTree(spot, key)
      : CYCLES.has(type)
        ? this.step(spot, direction[0] + direction[1])
        : SCATTERED.has(type)
          ? this.nearest(spot, direction)
          : this.inSeries(spot, direction);
    return to && this.ref(to);
  }

  /** Where the item is drawn, in pixels from the top left of the chart, if it is drawn alone. */
  box(ref: ItemRef): Box | undefined {
    const spot = this.spot(ref);
    return spot && this.boxOf(spot);
  }

  /** The value of the item, and its position among its siblings or in its series. */
  about(ref: ItemRef): { value: string | undefined; position: number; count: number } | undefined {
    const spot = this.spot(ref);
    if (!spot) return undefined;
    const { track, index } = spot;
    const value = itemValue(track.data, index);
    const tree = track.data.tree;
    if (tree) {
      const node = tree.getNodeByDataIndex(index);
      const siblings = this.drawnSiblings(track, node);
      return { value, position: siblings.indexOf(node) + 1, count: siblings.length };
    }
    return { value, position: index + 1, count: track.data.count() };
  }

  private spot({ seriesIndex, dataType, dataIndex }: ItemRef): Spot | undefined {
    const track = this.tracks.find(
      (each) => each.seriesIndex === seriesIndex && each.dataType === dataType,
    );
    const index = track?.data.indexOfRawIndex(dataIndex) ?? -1;
    return track && this.has(track, index) ? { track, index } : undefined;
  }

  private ref({ track, index }: Spot): ItemRef {
    const { seriesIndex, dataType, data } = track;
    return { seriesIndex, dataType, dataIndex: data.getRawIndex(index) };
  }

  /** Whether the item is shown: a tree shows only the nodes that are expanded and in view. */
  private has(track: Track, index: number): boolean {
    return (
      index >= track.first &&
      index < track.data.count() &&
      (!track.data.tree || Boolean(track.data.getItemGraphicEl(index)))
    );
  }

  private at(track: Track, index: number): Spot | undefined {
    return this.has(track, index) ? { track, index } : undefined;
  }

  private boxOf({ track, index }: Spot): Box | undefined {
    const graphic = track.data.getItemGraphicEl(index);
    if (graphic) {
      const box = graphic.getBoundingRect().clone();
      const transform = graphic.getComputedTransform();
      if (transform) box.applyTransform(transform);
      return box;
    }
    // The points of a line without symbols, or of a large scatter chart, are laid out together.
    const points = track.data.getLayout("points");
    const [x = Number.NaN, y = Number.NaN] =
      points instanceof Float32Array && points.length === 2 * track.data.count()
        ? points.subarray(2 * index, 2 * index + 2)
        : [];
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y, width: 0, height: 0 };
    return undefined;
  }

  private drawnSiblings(track: Track, node: TreeNode): TreeNode[] {
    return (node.parentNode?.children ?? [node]).filter(({ dataIndex }) =>
      this.has(track, dataIndex),
    );
  }

  private inTree(spot: Spot, key: string): Spot | undefined {
    const { track } = spot;
    const tree = track.data.tree;
    if (!tree) return undefined;
    const node = tree.getNodeByDataIndex(spot.index);
    let to: TreeNode | undefined;
    if (key === "ArrowLeft") {
      to = node.parentNode;
    } else if (key === "ArrowRight") {
      to = node.children.find(({ dataIndex }) => this.has(track, dataIndex));
    } else {
      const siblings = this.drawnSiblings(track, node);
      to = siblings[siblings.indexOf(node) + (key === "ArrowDown" ? 1 : -1)];
    }
    return to && this.at(track, to.dataIndex);
  }

  /** The next or previous item in the order of the chart, round from the last to the first. */
  private step(spot: Spot, delta: number): Spot | undefined {
    const tracks = this.tracks;
    const start = tracks.indexOf(spot.track);
    // Every track from this one round to it again, from where the item is to its other end.
    for (let turn = 0; turn <= tracks.length; turn++) {
      const track = tracks[(start + turn * delta + tracks.length * 2) % tracks.length];
      if (!track) break;
      const from =
        turn === 0 ? spot.index + delta : delta > 0 ? track.first : track.data.count() - 1;
      for (let index = from; index >= track.first && index < track.data.count(); index += delta) {
        if (this.has(track, index)) return { track, index };
      }
    }
    return undefined;
  }

  /**
   * Along the series for the arrow keys in the direction its categories go, and to the item at the
   * same position in the next or previous series for the others.
   */
  private inSeries({ track, index }: Spot, [dx, dy]: Point): Spot | undefined {
    const steps = dx * track.along[0] + dy * track.along[1];
    if (steps !== 0) return this.at(track, index + steps);
    // Right and down lead to the next series, left and up to the previous one.
    const delta = dx + dy;
    for (let t = this.tracks.indexOf(track) + delta; t >= 0 && t < this.tracks.length; t += delta) {
      const other = this.tracks[t];
      if (!other || other.seriesIndex === track.seriesIndex) continue;
      const to = this.at(other, Math.min(index, other.data.count() - 1));
      if (to) return to;
    }
    return undefined;
  }

  private nearest(spot: Spot, direction: Point): Spot | undefined {
    const centerOf = (candidate: Spot) => {
      const box = this.boxOf(candidate);
      return box && center(box);
    };
    const same = (a: Spot, b: Spot) => a.track === b.track && a.index === b.index;
    return nearestInDirection(spot, direction, this.untreed(), centerOf, same);
  }

  /** Every shown item outside of trees. */
  private *untreed(): Generator<Spot> {
    for (const track of this.tracks) {
      if (track.data.tree) continue;
      for (let index = 0; index < track.data.count(); index++) yield { track, index };
    }
  }
}

/**
 * The keyboard focus in a chart: the item it is on, a ring around that item, its tooltip, and a
 * live region for screen readers that names it.
 */
export class ChartFocus {
  private readonly ring = document.createElement("div");
  private readonly status = document.createElement("div");
  /** The focused item, by key and id, so that the focus stays on it in another rendering. */
  private focused: { key: string; id: string } | undefined;
  /** Whether the focus came from the keyboard rather than a click, which shows no ring. */
  private keyboard = false;
  /** Whether the ring and tooltip are shown for the focused item. */
  private shown = false;
  /** Whether the shown focus is to be shown again once the chart is drawn anew. */
  private stale = false;

  constructor(
    element: HTMLElement,
    private readonly chart: () => { chart: ECharts.ECharts; items: ChartItems } | undefined,
    private readonly colors: () => ThemeColors | undefined,
    activate: (key: string, event: KeyboardEvent) => void,
  ) {
    element.tabIndex = 0;
    element.setAttribute("role", "application");
    element.setAttribute("aria-roledescription", "chart");
    this.ring.id = "chart-focus";
    this.status.id = "chart-status";
    // Drawn over the chart, out of the way of the pointer, and not part of an exported image.
    Object.assign(this.ring.style, {
      position: "absolute",
      pointerEvents: "none",
      boxSizing: "border-box",
      borderRadius: "3px",
    });
    this.ring.hidden = true;
    this.status.setAttribute("role", "status");
    Object.assign(this.status.style, {
      position: "absolute",
      width: "1px",
      height: "1px",
      overflow: "hidden",
      clipPath: "inset(50%)",
      whiteSpace: "nowrap",
    });
    element.append(this.ring, this.status);
    element.addEventListener("keydown", (event) => {
      if (event.target !== element) return;
      const { key } = event;
      const activates = key === "Enter" || key === " ";
      const moves = key === "Home" || key === "End" || arrowDirection(key) !== undefined;
      if (!(activates || (moves && !event.altKey && !event.ctrlKey && !event.metaKey))) return;
      const navigation = this.navigationOf();
      const current = this.current();
      if (!navigation || !current) return;
      event.preventDefault();
      this.keyboard = true;
      const to = activates ? current : (navigation.move(current, key) ?? current);
      this.show(to);
      if (activates) activate(itemKey(to), event);
    });
    element.addEventListener("focus", () => {
      this.keyboard ||= element.matches(":focus-visible");
      if (this.keyboard) {
        const current = this.current();
        if (current) this.show(current);
      }
    });
    element.addEventListener("blur", () => this.hide());
    element.addEventListener("pointerdown", () => {
      this.keyboard = false;
      this.hide();
    });
  }

  /** Moves the focus to a clicked item, without showing it: the pointer is there. */
  clicked(key: string): void {
    const node = this.chart()?.items.node(key);
    if (node) this.focused = { key, id: node.id };
  }

  /** Shows the focus again in a new layout of the chart, or a new chart. */
  chartChanged(): void {
    this.stale = this.shown;
  }

  /**
   * Shows the focus in a chart drawn anew, or places the ring where the item is drawn now, such as
   * after an animation. Until ECharts has drawn a new option, which it can postpone, the tooltip
   * would show where items were.
   */
  chartDrawn(): void {
    if (!this.stale) {
      this.place();
      return;
    }
    this.stale = false;
    const current = this.current();
    if (current) this.show(current);
    else this.hide();
  }

  private place(): void {
    const ref = this.shown && this.focused ? parseItemKey(this.focused.key) : undefined;
    const box = ref && this.navigationOf()?.box(ref);
    const colors = this.colors();
    this.ring.hidden = !box || !colors;
    if (!box || !colors) return;
    // Around the item, and around a small one as around an item of a reasonable size.
    const padX = Math.max(3, (10 - box.width) / 2);
    const padY = Math.max(3, (10 - box.height) / 2);
    const background = toCss(colors.background);
    Object.assign(this.ring.style, {
      left: `${box.x - padX}px`,
      top: `${box.y - padY}px`,
      width: `${box.width + 2 * padX}px`,
      height: `${box.height + 2 * padY}px`,
      // Lined by the background, to stand out on the item and on whatever is around it.
      border: `2px solid ${toCss(colors.focus)}`,
      boxShadow: `0 0 0 1px ${background}, inset 0 0 0 1px ${background}`,
    });
  }

  /** Hides the ring and tooltip, keeping the item to show when the chart gets the focus again. */
  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.ring.hidden = true;
    this.chart()?.chart.dispatchAction({ type: "hideTip" });
  }

  /** Where the keyboard leads in the chart as shown now, after legend or zoom changes. */
  private navigationOf(): ChartNavigation | undefined {
    const chart = this.chart()?.chart;
    return chart && new ChartNavigation(chart);
  }

  /** The focused item if the chart still shows it, the first item otherwise. */
  private current(): ItemRef | undefined {
    const navigation = this.navigationOf();
    const items = this.chart()?.items;
    if (!navigation || !items) return undefined;
    if (this.focused) {
      const { key, id } = this.focused;
      const ref = parseItemKey(key);
      if (navigation.shows(ref) && items.node(key)?.id === id) return ref;
      const same = items.find(id).find((each) => navigation.shows(each));
      if (same) return same;
    }
    return navigation.first();
  }

  private show(ref: ItemRef): void {
    const found = this.chart();
    const node = found?.items.node(itemKey(ref));
    const about = this.navigationOf()?.about(ref);
    if (!found || !node || !about) return;
    const focused = { key: itemKey(ref), id: node.id };
    const changed =
      !this.shown || this.focused?.key !== focused.key || this.focused.id !== focused.id;
    this.focused = focused;
    this.shown = true;
    this.place();
    const { seriesIndex, dataType, dataIndex } = ref;
    // A tooltip shows a node of a graph for an edge's index.
    found.chart.dispatchAction(
      dataType === "edge" ? { type: "hideTip" } : { type: "showTip", seriesIndex, dataIndex },
    );
    if (changed) {
      const series = found.items.seriesName(seriesIndex);
      this.status.textContent = [
        about.value === undefined ? node.label : `${node.label}: ${about.value}`,
        series && `series ${series}`,
        `${about.position} of ${about.count}`,
      ]
        .filter(Boolean)
        .join(", ");
    }
  }
}
