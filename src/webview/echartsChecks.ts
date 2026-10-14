// Checks a chart as ECharts laid it out for what it draws other than its option meant, without a
// word: values it cannot read or draws past the end of an axis, data that does not line up with
// its categories or dataset, and labels and legends that the panel's size leaves hidden,
// overlapping or cut off. A model is told what is wrong, where in its option, and how to fix it.

import type * as ECharts from "echarts/core";
import { isPlainObject } from "../protocol";
import { brief, plural, quote, quoteAll } from "../text";
import { type Box, modelOf } from "./echartsItems";
import { baseOption, type JsonObject } from "./echartsOption";

// The parts of ECharts' private model read here, which echartsChecks.test.ts checks it still has.

interface DimensionInfo {
  /** "ordinal" for categories, "time" for dates, "float" or "int" for numbers. */
  type?: string;
  /** The axis or role that the dimension is for, such as "x", "y" or "value". */
  coordDim?: string;
  /** A dimension that the series reads but draws nothing by, such as a dataset's other columns. */
  isExtraCoord?: boolean;
}

interface Data {
  dimensions: string[];
  count(): number;
  getRawDataItem(index: number): unknown;
  getDimensionInfo(dimension: string): DimensionInfo | undefined;
  getDimensionIndex(dimension: string): number;
  /** The value of an item in a dimension as ECharts reads it: NaN for one it cannot. */
  get(dimension: string, index: number): unknown;
  getStore(): {
    getSource(): { sourceFormat: string };
    /** The key of a dimension in the objects of a dataset of objects. */
    getDimensionProperty(index: number): string | null | undefined;
  };
  /** The dimensions that ECharts draws on an axis or as a role, such as "y" or "value". */
  mapDimensionsAll(coordDim: string): string[];
  /** The least and greatest value of a dimension, of the items shown. */
  getDataExtent(dimension: string): [number, number];
  /** Of a stacked series: the dimension it stacks, and where it holds the values stacked. */
  getCalculationInfo(key: "stackedDimension" | "stackResultDimension"): string | undefined;
  getName(index: number): string;
  /** What draws the item, unless it is drawn together with others or not at all. */
  getItemGraphicEl(index: number): Element | null | undefined;
}

interface ComponentModel {
  mainType: string;
  componentIndex: number;
  /** The option of the component, with ECharts' defaults and what the panel's layout set. */
  option: JsonObject;
  get(key: string | string[]): unknown;
}

interface AxisModel extends ComponentModel {
  axis?: Axis;
  /** The categories of a category axis, as text. */
  getCategories(): string[];
}

interface Axis {
  /** "x", "y", "radius", "angle", … */
  dim: string;
  /** "category", "value", "time" or "log". */
  type: string;
  model: AxisModel;
  scale: { getExtent(): [number, number] };
  isHorizontal?(): boolean;
}

interface Series {
  componentIndex: number;
  subType: string;
  option: JsonObject;
  get(key: string): unknown;
  /** Every item of the series, also those that a legend or a data zoom filters out. */
  getRawData(): Data;
  /** The items shown. */
  getData(): Data;
  /** The coordinate system the series is drawn on, if any. */
  coordinateSystem?: { type?: string; getAxis?(dim: string): Axis | undefined } | undefined;
  getBaseAxis?(): Axis | undefined;
  /** The dataset or data the series reads, with the names of its dimensions, if it names them. */
  getSource(): { dimensionsDefine?: { name: string }[] | undefined };
}

interface Model {
  eachRawSeries(callback: (series: Series) => void): void;
  eachComponent(mainType: string, callback: (component: ComponentModel) => void): void;
}

/** What a model should know about the data that the chart draws other than its option meant. */
export function dataWarnings(chart: ECharts.ECharts, option: JsonObject): string[] {
  const model = modelOf(chart) as unknown as Model;
  const base = baseOption(option);
  const given = Array.isArray(base.series) ? base.series : [base.series];
  const warnings: string[] = [];
  model.eachRawSeries((series) => {
    const path = seriesPath(base, series.componentIndex);
    const own = given[series.componentIndex];
    warnings.push(
      ...unreadableValues(series, path),
      ...unpairedValues(series, path, base),
      ...missingDimensions(series, path),
      ...valuesOffScale(series, path, base, isPlainObject(own) ? own : {}),
    );
  });
  return warnings;
}

/** How many items the series of a chart have, which a layout takes the longer to check. */
export function itemCount(chart: ECharts.ECharts): number {
  let count = 0;
  (modelOf(chart) as unknown as Model).eachRawSeries((series) => {
    count += series.getRawData().count();
  });
  return count;
}

/** The path of a series in the option, as "series" for its only one, or "series[1]". */
const seriesPath = (base: JsonObject, index: number) =>
  Array.isArray(base.series) || index > 0 ? `series[${index}]` : "series";

/** The path of a component in the option, as "xAxis" for its only one, or "xAxis[1]". */
const componentPath = (base: JsonObject, mainType: string, index: number) =>
  Array.isArray(base[mainType]) || index > 0 ? `${mainType}[${index}]` : mainType;

/** How a value goes missing on purpose, which ECharts draws nothing for. */
const isMissing = (value: unknown) =>
  value == null || value === "" || value === "-" || Number.isNaN(value);

/** At most this many items of a series are read for values, for a chart of millions to be checked quickly. */
const MAX_READ_ITEMS = 100_000;

/** The series types that draw an item only by its value, which an object of one must have. */
const VALUED_TYPES = new Set([
  "line",
  "bar",
  "scatter",
  "effectScatter",
  "pictorialBar",
  "pie",
  "funnel",
  "gauge",
  "radar",
  "heatmap",
  "boxplot",
  "candlestick",
]);

/** The years from which a whole number on a time axis is likely to be a year rather than a time. */
const YEARS = { from: 1000, to: 3000 };

/**
 * The values that ECharts cannot read, which it draws nothing for: text that is no number, such as
 * "12%", dates that it cannot parse on a time axis, and items without a value, such as objects of
 * "x" and "y"; and years written as numbers on a time axis, which it reads as milliseconds.
 */
function unreadableValues(series: Series, path: string): string[] {
  const data = series.getRawData();
  const store = data.getStore();
  const format = store.getSource().sourceFormat;
  if (
    !["original", "arrayRows", "objectRows"].includes(format) ||
    series.get("seriesLayoutBy") === "row"
  ) {
    return [];
  }
  // The dimensions that place or size an item, not the categories nor what the series only reads.
  const dimensions = data.dimensions.flatMap((dimension) => {
    const info = data.getDimensionInfo(dimension);
    if (!info || info.isExtraCoord || info.type === "ordinal" || info.coordDim === undefined) {
      return [];
    }
    const index = data.getDimensionIndex(dimension);
    const time = info.type === "time";
    return [{ dimension, index, key: store.getDimensionProperty(index), time }];
  });
  const found = {
    numbers: { count: 0, example: undefined as unknown },
    dates: { count: 0, example: undefined as unknown },
    years: { count: 0, example: undefined as unknown },
    valueless: { count: 0, example: undefined as unknown },
  };
  const note = (kind: keyof typeof found, example: unknown) => {
    found[kind].count++;
    found[kind].example ??= example;
  };
  const valued = VALUED_TYPES.has(series.subType);
  const count = Math.min(data.count(), MAX_READ_ITEMS);
  for (let index = 0; index < count; index++) {
    const item = data.getRawDataItem(index);
    const value = isPlainObject(item) && !(item instanceof Date) ? item.value : item;
    if (format === "original" && valued && isPlainObject(item) && !("value" in item)) {
      if (dimensions.some(({ dimension }) => Number.isNaN(data.get(dimension, index)))) {
        note("valueless", item);
      }
      continue;
    }
    // A row of a dataset, or the value of an item: the values of each dimension, or the one value.
    const values = format === "arrayRows" ? item : value;
    for (const { dimension, index: at, key, time } of dimensions) {
      const raw =
        format === "objectRows"
          ? isPlainObject(item) && key != null
            ? item[key]
            : undefined
          : Array.isArray(values)
            ? values[at]
            : values;
      if (Number.isNaN(data.get(dimension, index))) {
        if (!isMissing(raw)) note(time ? "dates" : "numbers", raw);
      } else if (
        time &&
        Number.isInteger(raw) &&
        Number(raw) >= YEARS.from &&
        Number(raw) <= YEARS.to
      ) {
        note("years", raw);
      }
    }
  }
  const where =
    series.option.data == null ? `The dataset that ${path} reads has` : `${path}.data has`;
  const { numbers, dates, years, valueless } = found;
  const warnings: string[] = [];
  if (numbers.count > 0) {
    warnings.push(
      `${where} ${plural(numbers.count, "value")} that ECharts cannot read as a number, such as ` +
        `${brief(numbers.example)}, and draws nothing for: write plain numbers, without units, "%" ` +
        "or thousands separators.",
    );
  }
  if (dates.count > 0) {
    warnings.push(
      `${where} ${plural(dates.count, "date")} that the time axis cannot read, such as ` +
        `${brief(dates.example)}, and draws nothing for: write dates as "2024-03-31" or ` +
        '"2024-03-31 14:30", or put labels such as quarters on a "category" axis.',
    );
  }
  if (years.count > 0) {
    warnings.push(
      `${where} years as numbers on a time axis, such as ${brief(years.example)}, which it reads ` +
        'as milliseconds since 1970: write them as text, as "2024", or use a "category" axis.',
    );
  }
  if (valueless.count > 0) {
    const shape = ["pie", "funnel", "gauge"].includes(series.subType)
      ? '{"name": "A", "value": 3}'
      : '{"value": [x, y]} or [x, y]';
    warnings.push(
      `${where} ${plural(valueless.count, "item")} without a "value", such as ` +
        `${brief(valueless.example)}, which ECharts draws nothing for: write each as ${shape}.`,
    );
  }
  return warnings;
}

/**
 * A series of values alone, which ECharts pairs with the categories of its axis by position, of
 * other than as many values as the axis has categories: those past the last category are drawn
 * beyond the end of the axis, and with one left out, every value after it at the wrong category.
 */
function unpairedValues(series: Series, path: string, base: JsonObject): string[] {
  const axis = series.getBaseAxis?.();
  const categories = axis?.type === "category" ? axis.model.option.data : undefined;
  const data = series.option.data;
  if (
    !axis ||
    !Array.isArray(categories) ||
    !Array.isArray(data) ||
    // Values that name their category, as [category, value] does.
    data.some((item) => Array.isArray(isPlainObject(item) ? item.value : item))
  ) {
    return [];
  }
  const values = data.length;
  const axisPath = componentPath(base, axis.model.mainType, axis.model.componentIndex);
  const pairs =
    `${path}.data has ${plural(values, "value")} for the ` +
    `${plural(categories.length, "category", "categories")} of ${axisPath}.data, which ECharts ` +
    "pairs by position";
  if (values > categories.length) {
    const extra = values - categories.length;
    return [
      `${pairs}: the last ${extra === 1 ? "value is" : `${extra} are`} drawn past the end of the ` +
        "axis. Add the categories, or remove the values.",
    ];
  }
  if (values < categories.length) {
    const short = categories.length - values;
    return [
      `${pairs}, so the last ${short === 1 ? "category has" : `${short} have`} no value from ` +
        "it, and with a value left out, every value after it is drawn at the wrong category: give " +
        "a value for each category, null where one is missing on purpose.",
    ];
  }
  return [];
}

/**
 * The dimensions of a dataset that the encode of a series names but that the dataset does not have,
 * where ECharts silently draws another dimension instead.
 */
function missingDimensions(series: Series, path: string): string[] {
  const encode = series.get("encode");
  if (!isPlainObject(encode)) return [];
  const names = series.getSource().dimensionsDefine?.map(({ name }) => name) ?? [];
  const warnings: string[] = [];
  for (const [role, value] of Object.entries(encode)) {
    for (const dimension of Array.isArray(value) ? value : [value]) {
      if (typeof dimension !== "string" || names.includes(dimension)) continue;
      const named = `${path}.encode.${role} names the dimension ${JSON.stringify(dimension)}`;
      warnings.push(
        names.length > 0
          ? `${named}, which its dataset does not have, so ECharts draws another in its place: ` +
              `use one of ${quoteAll(names)}.`
          : `${named}, but its dataset names none, as it has no first row of names or ` +
              '"dimensions": name them, or give the position of the dimension, from 0.',
      );
    }
  }
  return warnings;
}

/** A number as a message gives it, without the leftovers of floating point. */
const number = (value: number) => String(Number(value.toPrecision(12)));

/**
 * The values of a series beyond the bounds that its axes or its own scale are given, which ECharts
 * draws at the edge, or past it, as if they were the bound: values beyond the "min" or "max" of an
 * axis, of a gauge or of a radar's indicator, and values of 0 or less on a log axis.
 */
function valuesOffScale(series: Series, path: string, base: JsonObject, own: JsonObject): string[] {
  if (series.subType === "gauge") return gaugeOffScale(series, path, own);
  if (series.subType === "radar") return radarOffScale(series, path, base);
  const system = series.coordinateSystem;
  // A data zoom shows part of the data on purpose.
  if (system?.type !== "cartesian2d" || base.dataZoom !== undefined) return [];
  const data = series.getData();
  const stacked = data.getCalculationInfo("stackedDimension");
  const result = data.getCalculationInfo("stackResultDimension");
  const warnings: string[] = [];
  for (const dim of ["x", "y"]) {
    const axis = system.getAxis?.(dim);
    if (!axis || axis.type === "category") continue;
    const axisPath = componentPath(base, axis.model.mainType, axis.model.componentIndex);
    const [low, high] = axis.scale.getExtent();
    const slack = (high - low) * 1e-9;
    const { min, max } = axis.model.option;
    const dimensions = data
      .mapDimensionsAll(dim)
      .filter((dimension) => !data.getDimensionInfo(dimension)?.isExtraCoord);
    for (const dimension of dimensions) {
      // A stacked series draws its values on top of those before it, up to where the stack ends,
      // which those before it reach where it adds nothing.
      let [least, most] = [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
      if (dimension === stacked && result) {
        for (let index = 0; index < data.count(); index++) {
          const own = Number(data.get(dimension, index));
          const end = Number(data.get(result, index));
          if (!own || Number.isNaN(end)) continue;
          least = Math.min(least, end);
          most = Math.max(most, end);
        }
      } else {
        [least, most] = data.getDataExtent(dimension);
      }
      if (!(least <= most)) continue;
      const has = dimension === stacked ? "stacks" : "has values";
      if (axis.type === "log" && least <= 0) {
        warnings.push(
          `${path} has values of 0 or less on the log axis ${axisPath}, which ECharts cannot ` +
            'draw: use a "value" axis, or leave those values out.',
        );
      } else if (typeof max === "number" || (typeof max === "string" && max !== "dataMax")) {
        if (most > high + slack) {
          warnings.push(
            `${path} ${has} up to ${number(most)}, above the "max" of ${axisPath}, ${brief(max)}, ` +
              'which ECharts cuts off at the edge of the plot: raise "max", or leave it out.',
          );
        }
      }
      if (
        axis.type !== "log" &&
        (typeof min === "number" || (typeof min === "string" && min !== "dataMin")) &&
        least < low - slack
      ) {
        warnings.push(
          `${path} ${has} down to ${number(least)}, below the "min" of ${axisPath}, ${brief(min)}, ` +
            'which ECharts cuts off at the edge of the plot: lower "min", or leave it out.',
        );
      }
    }
  }
  return warnings;
}

/** The values of a gauge beyond its scale, of 0 to 100 unless it says, where its pointer stops. */
function gaugeOffScale(series: Series, path: string, own: JsonObject): string[] {
  const data = series.getData();
  const [dimension] = data.mapDimensionsAll("value");
  if (dimension === undefined) return [];
  const [least, most] = data.getDataExtent(dimension);
  const min = Number(series.get("min"));
  const max = Number(series.get("max"));
  if (!(least <= most) || (least >= min && most <= max)) return [];
  const scale = own.min === undefined && own.max === undefined ? "the default scale" : "its scale";
  return [
    `${path} is a gauge of ${number(min)} to ${number(max)}, ${scale}, whose pointer stops at ` +
      `the end for the value ${number(most > max ? most : least)}: set "min" and "max" to the ` +
      "range of the value.",
  ];
}

/** The values of a radar's series beyond the max of their indicator, drawn outside the radar. */
function radarOffScale(series: Series, path: string, base: JsonObject): string[] {
  const radars = Array.isArray(base.radar) ? base.radar : [base.radar];
  const radar = radars[Number(series.get("radarIndex") ?? 0)];
  const indicators = isPlainObject(radar) && Array.isArray(radar.indicator) ? radar.indicator : [];
  const data = series.getData();
  const warnings: string[] = [];
  indicators.forEach((indicator, index) => {
    const dimension = data.dimensions[index];
    if (!isPlainObject(indicator) || typeof indicator.max !== "number" || !dimension) return;
    const [, most] = data.getDataExtent(dimension);
    if (most > indicator.max * (1 + 1e-9)) {
      const name = typeof indicator.name === "string" ? ` (${JSON.stringify(indicator.name)})` : "";
      warnings.push(
        `${path} has values up to ${number(most)} for indicator ${index + 1}${name}, above its ` +
          `"max" of ${number(indicator.max)}, which ECharts draws outside the radar: raise "max", ` +
          "or leave it out for ECharts to fit the data.",
      );
    }
  });
  return warnings;
}

/** A zrender element, as read here. */
interface Element {
  type?: string;
  parent?: Element | null;
  ignore?: boolean;
  invisible?: boolean;
  /** The id that ECharts animates an element by, such as "label_3" for an axis's fourth label. */
  anid?: string;
  /** Whether a text is cut short, with an ellipsis. */
  isTruncated?: boolean;
  style?: { text?: unknown; opacity?: number };
  /** The element that a label belongs to. */
  __hostTarget?: Element | null;
  /** The series or component that the group of a view draws. */
  __ecComponentInfo?: { mainType: string; index: number } | null;
  getBoundingRect(): Box & { clone(): Box & { applyTransform(matrix: number[] | null): void } };
  getComputedTransform(): number[] | null;
  /** What the element and what it contains are drawn within, if anything. */
  getClipPath?(): unknown;
  /** The label of an element, such as of the slice of a pie. */
  getTextContent?(): Element | null | undefined;
  /** The lines of a text, as drawn. */
  childrenRef?(): Element[];
  traverse?(callback: (element: Element) => void): void;
}

/** A text as drawn: of what series or component, where in the chart, and what it says. */
interface Text {
  owner: { mainType: string; index: number } | undefined;
  box: Box;
  text: string;
  /** Whether it is drawn within a clip, as the entries of a legend that pages them are. */
  clipped: boolean;
}

interface Views {
  getViewOfComponentModel(component: object): { group: Element } | undefined;
  getZr(): { storage: { getDisplayList(update: boolean): Element[] } };
}

/**
 * What the size of the panel leaves the chart unable to show as the option means: category labels
 * hidden or cut short alike, texts cut off at the edge of the chart, labels and legends on top of
 * each other, and a legend paged. Of a chart drawn without animation, as an animation starts what
 * it moves where it moves it from, such as the nodes of a tree from its root.
 */
export function layoutWarnings(chart: ECharts.ECharts, option: JsonObject): string[] {
  const model = modelOf(chart) as unknown as Model;
  const base = baseOption(option);
  const views = chart as unknown as Views;
  const size = { width: chart.getWidth(), height: chart.getHeight() };
  const texts = drawnTexts(views);
  return [
    ...categoryLabels(views, model, base, size),
    ...cutOff(texts, model, base, size),
    ...hiddenLabels(model, base),
    ...legends(views, model, base, texts),
  ];
}

/** The texts that the chart draws. */
function drawnTexts(views: Views): Text[] {
  const texts: Text[] = [];
  const seen = new Set<Element>();
  // Updates what changed since the chart was drawn, as the next frame would.
  for (const line of views.getZr().storage.getDisplayList(true)) {
    const element = line.type === "tspan" ? line.parent : undefined;
    if (element?.type !== "text" || seen.has(element)) continue;
    seen.add(element);
    if (element.invisible || element.style?.opacity === 0) continue;
    const box = element.getBoundingRect().clone();
    box.applyTransform(element.getComputedTransform());
    if (box.width <= 0 || box.height <= 0) continue;
    let owner: Text["owner"];
    let clipped = false;
    // Up to the group of the view that draws it, from a label through the item it labels.
    for (
      let at: Element | null | undefined = element;
      at && !owner;
      at = at.__hostTarget ?? at.parent
    ) {
      owner = at.__ecComponentInfo ?? undefined;
      clipped ||= at.getClipPath?.() != null;
    }
    texts.push({ owner, box, text: String(element.style?.text ?? ""), clipped });
  }
  return texts;
}

/** The path of what draws a text, such as "series[1]" or "xAxis". */
const ownerPath = (base: JsonObject, owner: NonNullable<Text["owner"]>) =>
  owner.mainType === "series"
    ? seriesPath(base, owner.index)
    : componentPath(base, owner.mainType, owner.index);

/**
 * Category labels that read as names, which a reader needs every one of: not as a sequence, such
 * as years, dates, months or numbers, whose labels in between a reader can tell.
 */
function namesCategories(categories: string[]): boolean {
  const sequence =
    /^(?:[\d\s.,:/\-–_'+%()#]|\b(?:q[1-4]|h[12]|w\d+|fy|cw|kw|wk|week|day|month|year|quarter|am|pm|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b)*$/i;
  return categories.some((category) => !sequence.test(category));
}

/**
 * Category labels that ECharts leaves out, as they would overlap, of an axis whose categories are
 * names, and labels cut short so that several read alike.
 */
function categoryLabels(
  views: Views,
  model: Model,
  base: JsonObject,
  size: { width: number; height: number },
): string[] {
  const warnings: string[] = [];
  for (const mainType of ["xAxis", "yAxis"]) {
    model.eachComponent(mainType, (component) => {
      const axisModel = component as AxisModel;
      const axis = axisModel.axis;
      const interval = axisModel.get(["axisLabel", "interval"]);
      if (axis?.type !== "category" || axisModel.get(["axisLabel", "show"]) === false) return;
      const labels: Element[] = [];
      views.getViewOfComponentModel(axisModel)?.group.traverse?.((element) => {
        if (element.type === "text" && element.anid?.startsWith("label_")) labels.push(element);
      });
      if (labels.length === 0) return;
      const shown = labels.filter((label) => !label.ignore);
      const [start, end] = axis.scale.getExtent();
      const categories = axisModel.getCategories().slice(start, end + 1);
      const path = componentPath(base, mainType, axisModel.componentIndex);
      const horizontal = axis.isHorizontal?.() ?? mainType === "xAxis";
      if (
        (interval === undefined || interval === "auto") &&
        shown.length < categories.length &&
        namesCategories(categories)
      ) {
        const room = horizontal ? `width of ${size.width}` : `height of ${size.height}`;
        const remedy = horizontal
          ? `put the categories on ${mainType === "xAxis" ? "yAxis" : "xAxis"} as a horizontal bar chart, shorten the names, or add a "dataZoom" to show fewer at a time`
          : `show fewer categories, such as the largest and an "Other", or add a "dataZoom" on ${path} to show fewer at a time`;
        warnings.push(
          `${path} shows only ${shown.length} of its ${categories.length} category labels at ` +
            `the panel's ${room} pixels, leaving out the others for lack of room: ${remedy}.`,
        );
      }
      // Labels cut short alike, which the reader cannot tell apart.
      const cut = new Map<string, Set<string>>();
      for (const label of shown) {
        if (!label.isTruncated) continue;
        const text = (label.childrenRef?.() ?? []).map((line) => line.style?.text).join("");
        const alike = cut.get(text) ?? new Set();
        alike.add(String(label.style?.text));
        cut.set(text, alike);
      }
      const alike = [...cut.entries()].filter(([, full]) => full.size > 1);
      if (alike.length > 0) {
        const [text = ""] = alike[0] ?? [];
        const count = alike.reduce((sum, [, full]) => sum + full.size, 0);
        warnings.push(
          `${path} cuts its category labels short to fit, leaving ${count} of them alike, such ` +
            `as ${quote(text)}: use shorter names that differ at the start${horizontal ? ", or a horizontal bar chart" : ""}.`,
        );
      }
    });
  }
  return warnings;
}

/** How far in pixels a text may reach past the edge of the chart, as by antialiasing. */
const EDGE_SLACK = 1;

/** Texts that reach past the edge of the chart, where they are cut off. */
function cutOff(
  texts: Text[],
  model: Model,
  base: JsonObject,
  { width, height }: { width: number; height: number },
): string[] {
  const byOwner = new Map<string, { sides: Set<string>; texts: string[]; remedy: string }>();
  const moving = new Set<number>();
  const onGrid = new Set<number>();
  model.eachRawSeries((series) => {
    // The nodes of a force layout move into place over the frames to come.
    if (series.subType === "graph" && series.get("layout") === "force") {
      moving.add(series.componentIndex);
    }
    if (series.coordinateSystem?.type === "cartesian2d") onGrid.add(series.componentIndex);
  });
  for (const { owner, box, text, clipped } of texts) {
    if (!owner || clipped || (owner.mainType === "series" && moving.has(owner.index))) continue;
    const sides = [
      box.x < -EDGE_SLACK && "left",
      box.x + box.width > width + EDGE_SLACK && "right",
      box.y < -EDGE_SLACK && "top",
      box.y + box.height > height + EDGE_SLACK && "bottom",
    ].filter((side): side is string => typeof side === "string");
    if (sides.length === 0) continue;
    const path = ownerPath(base, owner);
    const remedy =
      owner.mainType !== "series"
        ? /^(?:x|y)Axis$/.test(owner.mainType)
          ? 'leave the placement of the "grid" to the panel, which keeps the labels inside, or shorten them'
          : 'place it within the chart with its "left", "right", "top" or "bottom", or shorten it'
        : onGrid.has(owner.index)
          ? 'leave room for them with the "grid", or move them inside, as with "position": "inside"'
          : 'leave room for them with the series\' "left", "right", "top" or "bottom", or shorten them';
    const entry = byOwner.get(path) ?? { sides: new Set(), texts: [], remedy };
    for (const side of sides) entry.sides.add(side);
    entry.texts.push(text);
    byOwner.set(path, entry);
  }
  return [...byOwner.entries()].map(([path, { sides, texts, remedy }]) => {
    const what =
      texts.length === 1
        ? `the text ${quote(texts[0] ?? "")}`
        : `${texts.length} texts, such as ${quote(texts[0] ?? "")},`;
    return `${path} has ${what} cut off at the ${[...sides].join(" and ")} edge of the chart: ${remedy}.`;
  });
}

/** Whether two boxes overlap by more than a pixel or two each way. */
const overlap = (a: Box, b: Box) =>
  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 2 &&
  Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 2;

/**
 * The slices of a pie or funnel whose labels ECharts leaves out for lack of room, as it does for
 * labels that would overlap, which no legend names instead.
 */
function hiddenLabels(model: Model, base: JsonObject): string[] {
  let legend = false;
  model.eachComponent("legend", (component) => {
    legend ||= component.get("show") !== false;
  });
  const warnings: string[] = [];
  model.eachRawSeries((series) => {
    if (legend || (series.subType !== "pie" && series.subType !== "funnel")) return;
    const data = series.getData();
    let labelled = 0;
    let hidden = 0;
    let example: string | undefined;
    for (let index = 0; index < data.count(); index++) {
      const label = data.getItemGraphicEl(index)?.getTextContent?.();
      if (!label) continue;
      labelled++;
      if (label.ignore) {
        hidden++;
        example ??= data.getName(index);
      }
    }
    if (hidden === 0) return;
    const parts = series.subType === "pie" ? "slices" : "parts";
    warnings.push(
      `${seriesPath(base, series.componentIndex)} labels only ${labelled - hidden} of its ` +
        `${labelled} ${parts}, leaving out the labels of the others, such as ${quote(example ?? "")}, ` +
        `for lack of room: show fewer ${parts}, as the largest and an "Other" that sums up the rest.`,
    );
  });
  return warnings;
}

/** A legend that pages its entries, or that is drawn on top of the texts of other components. */
function legends(views: Views, model: Model, base: JsonObject, texts: Text[]): string[] {
  const warnings: string[] = [];
  const types = new Set<string>();
  model.eachRawSeries((series) => types.add(series.subType));
  // What the entries of a legend name: the slices of a pie or funnel, or else the series.
  const remedy =
    types.has("pie") || types.has("funnel")
      ? 'show fewer slices, as the largest and an "Other" that sums up the rest'
      : [...types].every((type) => type === "line")
        ? 'show fewer series, or name each line at its end with "endLabel": {"show": true, ' +
          '"formatter": "{a}"} instead of a legend'
        : "show fewer series, or give them shorter names";
  model.eachComponent("legend", (legend) => {
    if (legend.get("show") === false) return;
    const path = componentPath(base, "legend", legend.componentIndex);
    const view = views.getViewOfComponentModel(legend) as
      | { _getPageInfo?(legend: object): { pageCount: number }; _backgroundEl?: Element }
      | undefined;
    const pages = view?._getPageInfo?.(legend).pageCount ?? 1;
    if (pages > 1) {
      warnings.push(
        `${path} has more entries than fit the panel, which it pages through, ${pages} pages of ` +
          `them, so that a reader sees only some at a time: ${remedy}.`,
      );
    }
    const background = view?._backgroundEl;
    if (!background) return;
    const box = background.getBoundingRect().clone();
    box.applyTransform(background.getComputedTransform());
    const covered = texts.find(
      ({ owner, box: other }) =>
        owner && owner.mainType !== "legend" && owner.mainType !== "series" && overlap(box, other),
    );
    if (covered?.owner) {
      warnings.push(
        `${path} is drawn on top of ${ownerPath(base, covered.owner)} (${quote(covered.text)}): ` +
          'place them apart with their "left", "right", "top" or "bottom", or leave those out of ' +
          "the legend for the panel to place it.",
      );
    }
  });
  return warnings;
}
