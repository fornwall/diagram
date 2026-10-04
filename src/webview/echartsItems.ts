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

export const itemKey = ({ seriesIndex, dataType, dataIndex }: ItemRef) =>
  `${seriesIndex}:${dataType ?? ""}:${dataIndex}`;

export function parseItemKey(key: string): ItemRef {
  const [series, dataType, data] = key.split(":");
  return { seriesIndex: Number(series), dataType: dataType || undefined, dataIndex: Number(data) };
}

/** The repeated names, and the ids of each, reported to the extension host. */
const MAX_REPEATED_NAMES = 50;
const MAX_REPEATED_IDS = 20;

// ECharts' public API cannot list the items of a chart: `getOption()` copies the whole option and
// leaves out how datasets, encodings, categories, graph links and trees name items, and which items
// a legend or data zoom filters out. Its model knows, but its types keep `getModel` private. These
// are the parts of the model read here, which echartsItems.test.ts checks ECharts still has.
interface ItemData {
  dataType?: string;
  count(): number;
  getRawIndex(index: number): number;
  getName(index: number): string;
  getRawDataItem(index: number): unknown;
  indexOfRawIndex(rawIndex: number): number;
  /**
   * The nodes of a tree, treemap or sunburst, under a root ECharts adds above the data as data
   * index 0, named after the series.
   */
  tree?: { getNodeByDataIndex(index: number): TreeNode };
}

interface TreeNode {
  parentNode?: TreeNode;
  getRawIndex(): number;
}

interface SeriesModel {
  componentIndex: number;
  name: string;
  getRawData(): ItemData;
  /** The data of each type, such as the nodes and edges of a graph, after filtering. */
  getAllData(): { data: ItemData }[];
}

interface GlobalModel {
  getSeriesCount(): number;
  eachRawSeries(callback: (series: SeriesModel) => void): void;
}

export const modelOf = (chart: ECharts.ECharts) =>
  (chart as unknown as { getModel(): GlobalModel }).getModel();

function valueText(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  if (Array.isArray(value)) {
    return `(${value.map((item) => String(item)).join(", ")})`;
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function itemLabel(data: ItemData, index: number): string {
  // ECharts resolves names exactly, including surrounding spaces.
  const name = data.getName(index);
  const item = data.getRawDataItem(index);
  return (
    (name.trim() ? name : undefined) ??
    valueText(isPlainObject(item) ? item.value : item) ??
    `Item ${data.getRawIndex(index) + 1}`
  );
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

  constructor(chart: ECharts.ECharts) {
    const model = modelOf(chart);
    this.prefixed = model.getSeriesCount() > 1;
    const prefixes = new Set<string>();
    model.eachRawSeries((series) => {
      const index = series.componentIndex;
      // ECharts names unnamed series "series\0<index>".
      let name =
        series.name && !series.name.includes("\u0000") ? series.name : `Series ${index + 1}`;
      if (prefixes.has(name)) name = `${name} (series ${index + 1})`;
      prefixes.add(name);
      this.series[index] = new SeriesItems(index, this.prefixed ? `${name}/` : "", series);
    });
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

  /** The label of the items with this id, or the id when other items go by that label too. */
  labelOf(id: string): string | undefined {
    const refs = this.find(id);
    const [first] = refs;
    const label = first && this.series[first.seriesIndex]?.item(first)?.label;
    if (label === undefined || label === id) return label;
    const keys = (refs: ItemRef[]) => refs.map(itemKey).join();
    return keys(this.find(label)) === keys(refs) ? label : id;
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
          if ((series.counts.get(name) ?? 0) > 1) add(`${series.prefix}${name}`, id);
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
}

class SeriesItems {
  /** How many items go by each id or label. */
  readonly counts = new Map<string, number>();
  /** The ids and labels that several items go by. */
  readonly repeated = new Set<string>();
  private readonly datas: TypedData[];
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
    const raw = series.getRawData();
    // Legends and data zoom filter items out, but they can be marked once shown again.
    this.datas = series.getAllData().map(({ data }) => ({
      ...(data.dataType === raw.dataType ? { data: raw, raw: true } : { data, raw: false }),
      // Events and actions leave out the type of the one data of a tree, which ECharts calls "main".
      dataType: data.dataType === "main" ? undefined : data.dataType,
      first: data.tree ? 1 : 0,
    }));
    const count = (name: string) => {
      const count = (this.counts.get(name) ?? 0) + 1;
      this.counts.set(name, count);
      if (count === 2) this.repeated.add(name);
    };
    this.each(({ label, id }) => {
      count(id);
      if (label !== id) count(label);
    });
  }

  each(callback: (item: Item) => void): void {
    for (const data of this.datas) {
      for (let index = data.first; index < data.data.count(); index++) {
        callback(this.describe(data, index));
      }
    }
  }

  item({ dataType, dataIndex }: ItemRef): Item | undefined {
    const found = this.datas.find((data) => data.dataType === dataType);
    if (!found) return undefined;
    const index = found.raw ? dataIndex : found.data.indexOfRawIndex(dataIndex);
    return index >= found.first && index < found.data.count()
      ? this.describe(found, index)
      : undefined;
  }

  /** The item's id, told apart by its index from another item of the same name. */
  idOf({ ref, id }: Item): string {
    if ((this.counts.get(id) ?? 0) < 2) return `${this.prefix}${id}`;
    return `${this.prefix}${id} (${ref.dataType === "edge" ? "edge" : "item"} ${ref.dataIndex + 1})`;
  }

  find(name: string): ItemRef[] {
    const indexed = /^(.*) \((item|edge) ([1-9]\d*)\)$/.exec(name);
    if (indexed) {
      const [, id = "", kind, position] = indexed;
      const data = this.datas.find(({ dataType }) => (dataType === "edge") === (kind === "edge"));
      const ref = {
        seriesIndex: this.seriesIndex,
        dataType: data?.dataType,
        dataIndex: Number(position) - 1,
      };
      const item = this.item(ref);
      if (item?.id === id && (this.counts.get(id) ?? 0) > 1) return [ref];
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
