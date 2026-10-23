// What the panel and a language model call the items of a chart. ECharts finds an item by name
// only up to the first match, so each item gets an id of its own, and actions refer to items by
// their data index. Charts can have hundreds of thousands of items: ids are worked out per item
// as needed, from how often each name occurs.

import type * as ECharts from "echarts/core";
import { type DiagramNode, isPlainObject, type RepeatedName } from "../protocol";

/** A data item, or a node or edge of a graph, as ECharts' actions refer to it. */
export interface ItemRef {
  seriesIndex: number;
  dataType?: string | undefined;
  dataIndex: number;
}

/**
 * The type of data as actions name it. Events and selectchanged name the one data of a tree,
 * treemap or sunburst by the type "main", which actions need not name.
 */
export const actionDataType = (dataType: string | undefined) =>
  dataType === "main" ? undefined : dataType;

export const itemKey = ({ seriesIndex, dataType, dataIndex }: ItemRef) =>
  `${seriesIndex}:${actionDataType(dataType) ?? ""}:${dataIndex}`;

export function parseItemKey(key: string): ItemRef {
  const [series, dataType, data] = key.split(":");
  return { seriesIndex: Number(series), dataType: dataType || undefined, dataIndex: Number(data) };
}

/** The repeated names, and the ids of each, reported to the extension host. */
const MAX_REPEATED_NAMES = 50;
const MAX_REPEATED_IDS = 20;
/** The positional suffix that tells repeated item names apart. */
const INDEXED_NAME = / \((item|edge) ([1-9]\d*)\)$/;

// ECharts' public API cannot list the items of a chart: `getOption()` copies the whole option and
// leaves out how datasets, encodings, categories, graph links and trees name items, and which items
// a legend or data zoom filters out. Its model knows, but its types keep `getModel` private. These
// are the parts of the model read here, which echartsItems.test.ts checks ECharts still has.
export interface ItemData {
  dataType?: string;
  count(): number;
  /** Whether every coordinate dimension has a value, rather than a gap such as null or "-". */
  hasValue(index: number): boolean;
  getRawIndex(index: number): number;
  getName(index: number): string;
  getRawDataItem(index: number): unknown;
  /** Distinguishes dataset rows from series items, which also use objects. */
  getStore(): { getSource(): { sourceFormat: string } };
  indexOfRawIndex(rawIndex: number): number;
  /** What draws the item, unless it is drawn together with others or not at all. */
  getItemGraphicEl(index: number): Graphic | null | undefined;
  /** A layout of all items, such as "points": [x, y] of each, of a line or large scatter chart. */
  getLayout(key: string): unknown;
  /** The dimensions of the values of an item that the series uses. */
  dimensions: string[];
  /** The place of a dimension's value in an array of the values of an item. */
  getDimensionIndex(dimension: string): number;
  /**
   * The categories of a dimension on a category axis, by the index that ECharts holds, and the
   * type of a dimension, "time" on a time axis.
   */
  getDimensionInfo(
    dimension: string,
  ): { type?: string; ordinalMeta?: { categories: unknown[] } } | undefined;
  /** The value of an item in a dimension as ECharts holds it: the index of its category. */
  get(dimension: string, index: number): unknown;
  /**
   * The nodes of a tree, treemap or sunburst, under a root ECharts adds above the data as data
   * index 0, named after the series.
   */
  tree?: { root: TreeNode; getNodeByDataIndex(index: number): TreeNode };
}

export interface TreeNode {
  parentNode?: TreeNode;
  children: TreeNode[];
  dataIndex: number;
  /** Whether the node of a tree series shows its children, which a click on it toggles. */
  isExpand: boolean;
  getRawIndex(): number;
  /** The layout of a treemap's node, which says whether leafDepth draws it as a leaf. */
  getLayout?(): { isLeafRoot?: boolean } | undefined;
  /** The options of the node, such as a sunburst's nodeClick, with those of its series. */
  getModel?(): { get(key: string): unknown };
}

/** A zrender element, with the bounding box of what it draws in its own coordinates. */
interface Graphic {
  getBoundingRect(): Box & { clone(): Box & { applyTransform(matrix: number[]): void } };
  getComputedTransform(): number[] | null;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SeriesModel {
  componentIndex: number;
  /** The id of the series, or one that ECharts made up, which starts with "\0". */
  id: string;
  /** The type of series, such as "tree". */
  subType: string;
  name: string;
  /** The option of the series, with ECharts' defaults. */
  get(key: string): unknown;
  getRawData(): ItemData;
  /** The axis of the categories, or of time, or else the x axis, of a series on axes. */
  getBaseAxis(): { inverse: boolean; isHorizontal?(): boolean } | undefined;
  /** The data of each type, such as the nodes and edges of a graph, after filtering. */
  getAllData(): { data: ItemData }[];
  /** Entries for individual items, such as pie slices, instead of the whole series. */
  legendVisualProvider?: { containName(name: string): boolean };
  /** Where the force layout of a graph left its nodes, by id, which a new layout goes on from. */
  preservedPoints?: Record<string, number[]> | undefined;
  /** The node that a treemap or sunburst is drilled down to, and a way to drill down. */
  getViewRoot?(): TreeNode;
  resetViewRoot?(node: TreeNode): void;
}

interface GlobalModel {
  /**
   * The option as shown, with what the user changed in it, such as a legend's selection, which
   * `getOption()` returns a deep copy of, data and all.
   */
  option: Record<string, unknown>;
  getSeriesCount(): number;
  getSeriesByIndex(index: number): SeriesModel | undefined;
  eachRawSeries(callback: (series: SeriesModel) => void): void;
  /** The series that a legend does not hide. */
  eachSeries(callback: (series: SeriesModel) => void): void;
  /** The first legend, with its options, such as selectedMode, and its entries. */
  getComponent(mainType: "legend"): LegendModel | undefined;
  /** The components of a type, such as every toolbox. */
  eachComponent(mainType: string, callback: (component: object) => void): void;
}

/** The view that draws a toolbox, with its features, such as the data view, by name. */
interface ToolboxView {
  _features?: { get(name: string): { _dom?: unknown } | undefined };
}

/**
 * The toolbox's data view, if it is open: what ECharts adds over the chart, in the element it
 * draws in, which the feature that opened it keeps until it is closed.
 */
export function openDataView(chart: ECharts.ECharts): HTMLElement | undefined {
  const views = chart as unknown as {
    getViewOfComponentModel(component: object): ToolboxView | undefined;
  };
  let open: HTMLElement | undefined;
  modelOf(chart).eachComponent("toolbox", (toolbox) => {
    const view = views.getViewOfComponentModel(toolbox)?._features?.get("dataView")?._dom;
    if (view instanceof HTMLElement && view.isConnected) open ??= view;
  });
  return open;
}

export interface LegendModel {
  get(key: string): unknown;
  getData(): { get(key: "name"): unknown }[];
  isSelected(name: string): boolean;
}

export const modelOf = (chart: ECharts.ECharts) =>
  (chart as unknown as { getModel(): GlobalModel }).getModel();

function valueText(value: unknown): string | undefined {
  // Also what ECharts takes for a missing value, and draws nothing for.
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    value === "-" ||
    Number.isNaN(value)
  ) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return `(${value.map((item) => valueText(item) ?? String(item)).join(", ")})`;
  }
  if (value instanceof Date) {
    return dateText(value);
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * A date as a time axis labels it, in local time or in UTC: its day, and its time of day unless
 * midnight.
 */
export function dateText(date: Date, utc = false): string {
  if (Number.isNaN(date.getTime())) return "Invalid Date";
  const pad = (part: number) => String(part).padStart(2, "0");
  const [year, month, dayOfMonth, ...time] = utc
    ? [
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        date.getUTCHours(),
        date.getUTCMinutes(),
        date.getUTCSeconds(),
      ]
    : [
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        date.getHours(),
        date.getMinutes(),
        date.getSeconds(),
      ];
  const day = `${year}-${pad((month ?? 0) + 1)}-${pad(dayOfMonth ?? 1)}`;
  if (time.every((part) => part === 0)) return day;
  return `${day} ${time.map(pad).join(":")}`;
}

/** A part of an item's value as shown, and whether it places the item on an axis. */
interface ValuePart {
  shown: unknown;
  /** Whether the part is a category of a category axis or a time of a time axis. */
  places: boolean;
}

/**
 * The parts of an item whose value is an array, as shown. A value on a category axis can be the
 * index of its category, as of the categories that the axis lists, or that ECharts adds to the
 * values of a box plot or candlestick: its category, which ECharts holds by index. A time on a
 * time axis is shown as written, or as the axis labels a number of milliseconds. A row of a
 * dataset has the item's name among its values. ECharts leaves out the dimensions that a series
 * does not use, of a wide dataset.
 */
function valueParts(
  data: ItemData,
  index: number,
  value: unknown[],
  objectRow: boolean,
): ValuePart[] {
  const dimensions = new Map(
    data.dimensions.map((each, at) => [objectRow ? at : data.getDimensionIndex(each), each]),
  );
  return value.map((part, at) => {
    const dimension = dimensions.get(at);
    const info = dimension === undefined ? undefined : data.getDimensionInfo(dimension);
    const categories = info?.ordinalMeta?.categories;
    if (categories && dimension !== undefined) {
      const category = categories[Number(data.get(dimension, index))];
      // An axis can list a category with its own label style, as {"value": "Mon"}.
      const shown = isPlainObject(category) ? category.value : category;
      return { shown: shown ?? part, places: true };
    }
    if (info?.type === "time") {
      const time = typeof part === "number" ? new Date(part) : part;
      return { shown: time instanceof Date ? dateText(time) : time, places: true };
    }
    return { shown: part, places: false };
  });
}

/** Whether the item has a name of its own, which ECharts names it by before its category. */
const hasOwnName = (item: unknown) =>
  isPlainObject(item) && item.name != null && String(item.name).trim() !== "";

function itemLabel(data: ItemData, index: number): string {
  // ECharts resolves names exactly, including surrounding spaces.
  const name = data.getName(index);
  const item = data.getRawDataItem(index);
  const value = isPlainObject(item) ? item.value : item;
  // ECharts names an item of an array value without a name of its own by its first category
  // alone, as the column of a heatmap's cell, and on a time axis by nothing: name it by what
  // places it, as "Mon, 10" or "2026-01-02", which a model can tell from the data.
  if (!hasOwnName(item) && Array.isArray(value)) {
    const places = valueParts(data, index, value, false).filter((part) => part.places);
    const placed = places.map(({ shown }) => String(shown ?? "")).join(", ");
    if (placed.trim()) return placed;
  }
  return (
    (name.trim() ? name : undefined) ?? valueText(value) ?? `Item ${data.getRawIndex(index) + 1}`
  );
}

/** The value of an item, unless its label says it already. */
export function itemValue(data: ItemData, index: number): string | undefined {
  const label = itemLabel(data, index);
  const item = data.getRawDataItem(index);
  const objectRow =
    isPlainObject(item) && data.getStore().getSource().sourceFormat === "objectRows";
  let value = objectRow
    ? data.dimensions.map((dimension) => item[dimension])
    : isPlainObject(item)
      ? item.value
      : item;
  if (Array.isArray(value)) {
    const parts = valueParts(data, index, value, objectRow);
    // The label says the parts that place the item, when it goes by them (see itemLabel).
    const placed = !hasOwnName(item) && parts.some((part) => part.places);
    const rest = parts
      .filter(({ shown, places }) => (placed ? !places : String(shown) !== label))
      .map(({ shown }) => shown);
    value = rest.length === 1 ? rest[0] : rest;
  }
  const text = valueText(value);
  return text === label || text === "()" ? undefined : text;
}

function ownId(item: unknown): string | undefined {
  const id = isPlainObject(item) ? item.id : undefined;
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
}

/** An item, by its label and by its own id or else its label, within its series. */
interface Item {
  ref: ItemRef;
  label: string;
  id: string;
}

/** The items of a rendered chart, and the names they go by. */
export class ChartItems {
  private readonly series: SeriesItems[] = [];
  private readonly prefixed: boolean;
  /** What a model should know about parts of the option that ECharts does not draw. */
  readonly warnings: string[] = [];

  constructor(chart: ECharts.ECharts) {
    const model = modelOf(chart);
    this.prefixed = model.getSeriesCount() > 1;
    const prefixes = new Set<string>();
    const names = new Map<string, number>();
    model.eachRawSeries(({ name }) => names.set(name, (names.get(name) ?? 0) + 1));
    model.eachRawSeries((series) => {
      const index = series.componentIndex;
      // ECharts names unnamed series "series\0<index>".
      let name =
        series.name && !series.name.includes("\u0000") ? series.name : `Series ${index + 1}`;
      // Series that share a name, such as a measure in each panel of a faceted chart, go by their
      // own ids when they have them.
      if ((names.get(series.name) ?? 0) > 1 && !series.id.startsWith("\u0000")) name = series.id;
      while (prefixes.has(name)) name += ` (series ${index + 1})`;
      prefixes.add(name);
      const items = new SeriesItems(index, this.prefixed ? `${name}/` : "", series);
      this.series[index] = items;
      if (items.trees > 1) {
        const named = name === series.name ? ` (${JSON.stringify(name)})` : "";
        this.warnings.push(
          `Tree series ${index + 1}${named} has ${items.trees} trees in its data, of which ECharts draws only the first: put them under one root node to draw them all.`,
        );
      }
    });
    if (this.series.length > 0 && this.series.every((series) => series.empty)) {
      this.warnings.push(
        'The chart has no data to draw, as every series is empty: give a series its "data", or a "dataset" with a "source" for the series to read.',
      );
    }
  }

  /**
   * Reads the items from a chart of a new layout of the same option, whose items go by the same
   * names, rather than from the chart they were worked out in, which they would keep alive.
   * Returns whether the chart has the same series, of as many items of each type, and else leaves
   * the items as they are, to be worked out anew. The caller makes sure that the items have the
   * same names: a timeline step can name as many items differently.
   */
  rebind(chart: ECharts.ECharts): boolean {
    const model = modelOf(chart);
    if (model.getSeriesCount() !== this.series.length) return false;
    const datas: TypedData[][] = [];
    let same = true;
    model.eachRawSeries((series) => {
      const index = series.componentIndex;
      const next = typedData(series);
      datas[index] = next;
      same &&= this.series[index]?.holds(next) === true;
    });
    if (!same) return false;
    datas.forEach((data, index) => {
      this.series[index]?.rebind(data);
    });
    return true;
  }

  /** The name of the series, when the chart has several. */
  seriesName(seriesIndex: number): string | undefined {
    return this.series[seriesIndex]?.prefix.slice(0, -1) || undefined;
  }

  /** The item a click hit, as the panel lists it. */
  node(key: string): DiagramNode | undefined {
    const ref = parseItemKey(key);
    const series = this.series[ref.seriesIndex];
    const item = series?.item(ref);
    return series && item && { id: series.idOf(item), label: item.label };
  }

  /** The item with this id, or all items that go by this name, which without "Series/" is in every series. */
  find(id: string): ItemRef[] {
    const refs = this.series.flatMap((series) =>
      id.startsWith(series.prefix) ? series.find(id.slice(series.prefix.length)) : [],
    );
    return refs.length > 0 || !this.prefixed
      ? refs
      : this.series.flatMap((series) => series.find(id));
  }

  /** Names that more than one item of a series goes by, which a mark must not use. */
  repeatedNames(): RepeatedName[] {
    const repeated = new Set(this.series.flatMap((series) => [...series.repeated]));
    if (repeated.size === 0) return [];
    const named = new Map<string, RepeatedName>();
    const add = (name: string, id: string) => {
      let entry = named.get(name);
      if (!entry) {
        if (named.size === MAX_REPEATED_NAMES) return;
        entry = { name, ids: [], count: 0 };
        named.set(name, entry);
      }
      entry.count++;
      if (entry.ids.length < MAX_REPEATED_IDS) entry.ids.push(id);
    };
    for (const series of this.series) {
      series.each((item) => {
        for (const name of item.label === item.id ? [item.id] : [item.id, item.label]) {
          if (!repeated.has(name)) continue;
          const id = series.idOf(item);
          if (series.repeated.has(name)) add(`${series.prefix}${name}`, id);
          // A name without the series is ambiguous once one series has it more than once.
          if (series.prefix) add(name, id);
        }
      });
    }
    return [...named.values()];
  }
}

/** The data of one type in a series, and the type that events and actions give it. */
interface TypedData {
  data: ItemData;
  dataType: string | undefined;
  /** Whether the data has every item, including those filtered out. */
  raw: boolean;
  /** The index of the first item: 1 in a tree, to leave out the root ECharts adds. */
  first: number;
  /** The index after the last item. */
  end: number;
}

/** The trees in the data of a tree series, of which ECharts lays out and draws the first. */
const treeRoots = (series: SeriesModel): TreeNode[] =>
  (series.subType === "tree" && series.getRawData().tree?.root.children) || [];

/** The data of each type in a series. */
function typedData(series: SeriesModel): TypedData[] {
  const raw = series.getRawData();
  const roots = treeRoots(series);
  // Legends and data zoom filter items out, but they can be marked once shown again.
  return series.getAllData().map((shown) => {
    const all = shown.data.dataType === raw.dataType;
    const data = all ? raw : shown.data;
    return {
      data,
      raw: all,
      dataType: actionDataType(data.dataType),
      first: data.tree ? 1 : 0,
      // The nodes of a tree come in depth-first order.
      end: roots[1]?.getRawIndex() ?? data.count(),
    };
  });
}

class SeriesItems {
  /** The ids and labels that several items go by. */
  readonly repeated = new Set<string>();
  /** Names that could collide with an id qualified by position. */
  private readonly indexedNames = new Set<string>();
  private datas: TypedData[];
  /** How many trees a tree series has in its data, of which ECharts lays out and draws the first. */
  readonly trees: number;
  /** Whether the series has no items. */
  get empty(): boolean {
    return this.datas.every(({ first, end }) => end <= first);
  }
  /** A graph's edges name their nodes by id or name, or by index. */
  private readonly nodeLabels = new Map<string, string>();
  private readonly nodeLabelsByIndex: string[] = [];
  /** The items by id and label, once an item is looked up by name. */
  private byName: Map<string, ItemRef[]> | undefined;

  constructor(
    private readonly seriesIndex: number,
    /** "Series/" when the chart has several series. */
    readonly prefix: string,
    series: SeriesModel,
  ) {
    this.trees = treeRoots(series).length;
    this.datas = typedData(series);
    // Only whether a name repeats matters. A chart can have hundreds of thousands of items, all
    // named differently: one lookup each, in a set kept only while counting, takes a fraction of
    // the time of counting each name in a map, and none of its memory afterwards.
    const seen = new Set<string>();
    const count = (name: string) => {
      const size = seen.size;
      seen.add(name);
      if (seen.size === size) this.repeated.add(name);
      if (INDEXED_NAME.test(name)) this.indexedNames.add(name);
    };
    this.each(({ label, id }) => {
      count(id);
      if (label !== id) count(label);
    });
  }

  /** Whether the data holds as many items of each type as the items were worked out from. */
  holds(datas: TypedData[]): boolean {
    return (
      datas.length === this.datas.length &&
      datas.every((data, index) => {
        const own = this.datas[index];
        return (
          own !== undefined &&
          data.dataType === own.dataType &&
          data.raw === own.raw &&
          data.first === own.first &&
          data.end === own.end
        );
      })
    );
  }

  /** Reads the items from the same series in a new layout of the option, which has their names. */
  rebind(datas: TypedData[]): void {
    this.datas = datas;
  }

  each(callback: (item: Item) => void): void {
    for (const data of this.datas) {
      for (let index = data.first; index < data.end; index++) {
        callback(this.describe(data, index));
      }
    }
  }

  item({ dataType, dataIndex }: ItemRef): Item | undefined {
    const found = this.datas.find((data) => data.dataType === dataType);
    if (!found) return undefined;
    const index = found.raw ? dataIndex : found.data.indexOfRawIndex(dataIndex);
    return index >= found.first && index < found.end ? this.describe(found, index) : undefined;
  }

  /** The item's id, told apart by its index from another item of the same name. */
  idOf({ ref, id }: Item): string {
    if (!this.repeated.has(id)) return `${this.prefix}${id}`;
    const suffix = ` (${ref.dataType === "edge" ? "edge" : "item"} ${ref.dataIndex + 1})`;
    do id += suffix;
    while (this.indexedNames.has(id));
    return `${this.prefix}${id}`;
  }

  find(name: string): ItemRef[] {
    const indexed = INDEXED_NAME.exec(name);
    if (indexed) {
      const [, kind, position] = indexed;
      const data = this.datas.find(({ dataType }) => (dataType === "edge") === (kind === "edge"));
      const ref = {
        seriesIndex: this.seriesIndex,
        dataType: data?.dataType,
        dataIndex: Number(position) - 1,
      };
      const item = this.item(ref);
      if (item && this.repeated.has(item.id) && this.idOf(item) === `${this.prefix}${name}`) {
        return [ref];
      }
    }
    if (!this.byName) {
      const byName = new Map<string, ItemRef[]>();
      const add = (key: string, ref: ItemRef) => {
        const refs = byName.get(key);
        if (refs) refs.push(ref);
        else byName.set(key, [ref]);
      };
      this.each(({ ref, label, id }) => {
        add(id, ref);
        if (label !== id) add(label, ref);
      });
      this.byName = byName;
    }
    return this.byName.get(name) ?? [];
  }

  private describe({ data, dataType }: TypedData, index: number): Item {
    const ref = { seriesIndex: this.seriesIndex, dataType, dataIndex: data.getRawIndex(index) };
    const item = data.getRawDataItem(index);
    const own = ownId(item);
    if (dataType === "edge" && isPlainObject(item)) {
      const nodeLabel = (end: unknown) =>
        (typeof end === "number"
          ? this.nodeLabelsByIndex[end]
          : this.nodeLabels.get(String(end))) ?? String(end);
      const label = `${nodeLabel(item.source)} → ${nodeLabel(item.target)}`;
      return { ref, label, id: own ?? `${String(item.source)} → ${String(item.target)}` };
    }
    const label = itemLabel(data, index);
    if (dataType === "node") {
      this.nodeLabels.set(own ?? (data.getName(index) || String(ref.dataIndex)), label);
      this.nodeLabelsByIndex[ref.dataIndex] = label;
    }
    let id = own ?? label;
    // The nodes of a tree go by their path, as names repeat in different folders and the like.
    if (own === undefined && data.tree) {
      const node = data.tree.getNodeByDataIndex(index);
      for (let parent = node.parentNode; parent?.parentNode; parent = parent.parentNode) {
        id = `${itemLabel(data, parent.getRawIndex())}/${id}`;
      }
    }
    return { ref, label, id };
  }
}
