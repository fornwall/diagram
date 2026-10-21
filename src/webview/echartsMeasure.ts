// Panel dimensions and text measurements used by chart layout.

import { isPlainObject } from "../protocol";
import type { ThemeColors } from "./colors";
import type { JsonObject } from "./echartsOption";

export const BOX_KEYS = ["left", "right", "top", "bottom", "width", "height"];

export const has = (object: JsonObject, keys: string[]) =>
  keys.some((key) => object[key] !== undefined);

export type Side = "top" | "bottom" | "left" | "right";

/** Space in pixels taken from each side of the chart by the title, legend, sliders, … */
export type Insets = Record<Side, number>;

/** A part of the chart, in pixels. */
export interface Area {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** ECharts uses different measurements for positioning text and wrapping it. */
export interface Font {
  /** CSS font, e.g. "bold 12px sans-serif". */
  css: string;
  /** Font size in pixels. */
  size: number;
  /** Drawn width; for multiline text, the width of the widest line. */
  width(text: string): number;
  /** Wrapping width, using ECharts' per-character approximations. */
  breakWidth(text: string): number;
}

export interface Size {
  width: number;
  height: number;
  /** Too small for a legend above the grid. */
  compact: boolean;
  /** Resolve each font property from the first style that sets it, then the chart defaults. */
  font(...styles: JsonObject[]): Font;
  /** Component text defaults, which ECharts prefers over the option's global text style. */
  themed: JsonObject;
}

export function layoutSize(context: LayoutContext, base: JsonObject): Size {
  const { width, height } = context;
  const compact = width < 560 || height < 340;
  // The text style of the chart: the option's, over the theme's.
  const chartStyle: JsonObject = {
    // Match ECharts' font string: ZRender's per-font caches may use different character
    // approximations when measured under load, so equivalent CSS is not enough.
    fontStyle: "normal",
    fontWeight: "normal",
    fontFamily: context.colors.fontFamily,
    fontSize: context.colors.fontSize,
    ...styleOf(base.textStyle),
  };
  const font = (...styles: JsonObject[]): Font => {
    const part = (key: string) =>
      [...styles, chartStyle].map((style) => style[key]).find((value) => value != null);
    const specifiedSize = String(part("fontSize"));
    // Accept numeric pixels and CSS pixel lengths, e.g. 14 or "14px".
    const fontSize = /^\d+(?:\.\d+)?(?:px)?$/.test(specifiedSize.trim())
      ? Number.parseFloat(specifiedSize)
      : context.colors.fontSize;
    const css = [part("fontStyle"), part("fontWeight"), `${fontSize}px`, part("fontFamily")]
      .filter((value) => value != null && value !== "")
      .join(" ");
    return {
      css,
      size: fontSize,
      width: (text) =>
        text.includes("\n")
          ? Math.max(...text.split("\n").map((line) => context.drawnWidth(line, css)))
          : context.drawnWidth(text, css),
      breakWidth: (text) => context.textWidth(text, css),
    };
  };
  const themed = { fontFamily: context.colors.fontFamily, fontSize: context.colors.fontSize };
  return { width, height, compact, font, themed };
}

export interface LayoutContext {
  width: number;
  height: number;
  /** The title in the panel header; an identical chart title is hidden. */
  title: string;
  colors: ThemeColors;
  reducedMotion: boolean;
  /** ECharts' per-character width approximation for wrapping. */
  textWidth(text: string, font: string): number;
  /** ECharts' drawn width for positioning text. */
  drawnWidth(text: string, font: string): number;
}

/** Read a nested option such as axisLabel or label, falling back to an empty style. */
export const styleOf = (style: unknown): JsonObject => (isPlainObject(style) ? style : {});

/**
 * The text of a category or legend entry: a value, a category `{value}`, or a legend entry or
 * data item named by `{name}` (whose value is a number).
 */
export const entryText = (entry: unknown) =>
  String((isPlainObject(entry) ? (entry.name ?? entry.value) : entry) ?? "");

/** Sample category labels when their count exceeds this threshold. */
export const MAX_READ_CATEGORIES = 200;

/**
 * Estimate the widest entry. For large datasets, measure an even sample plus the longest text
 * to limit font measurements. Stop early once an entry exceeds every layout threshold.
 */
export function widestText(
  entries: unknown,
  width: (text: string) => number,
  enough = Infinity,
): number {
  if (!Array.isArray(entries)) {
    return 0;
  }
  const step = Math.ceil(entries.length / MAX_READ_CATEGORIES);
  let widest = 0;
  for (let index = 0; index < entries.length; index += step) {
    widest = Math.max(widest, width(entryText(entries[index])));
    if (widest > enough) return widest;
  }
  if (step > 1) {
    let longest = "";
    for (const entry of entries) {
      const text = entryText(entry);
      if (text.length > longest.length) longest = text;
    }
    widest = Math.max(widest, width(longest));
  }
  return widest;
}

/** A length in pixels, or a percentage of the chart's width. */
export const pixels = (value: unknown, width: number): number | undefined =>
  typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+(?:\.\d+)?%$/.test(value)
      ? (Number.parseFloat(value) * width) / 100
      : undefined;

/** The type of an axis, which ECharts makes "category" for one with data. */
export const axisType = (axis: JsonObject | undefined) =>
  axis?.type ?? (axis?.data ? "category" : "value");

const plainNumber = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 20,
  useGrouping: false,
});

const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 20,
});

/** Keep numbers below 10,000 intact (including years); abbreviate larger values, e.g. "12.5K". */
export const compactLabel = (value: unknown) =>
  typeof value !== "number"
    ? String(value)
    : (Math.abs(value) < 10_000 ? plainNumber : compactNumber).format(value);

/** Line height for wrapped axis labels, in pixels. */
export const LABEL_LINE_HEIGHT = 17;

/** Return string category labels only when they fit within the measurement limit. */
export function categoryTexts(data: unknown): string[] | undefined {
  if (!Array.isArray(data) || data.length > MAX_READ_CATEGORIES) return undefined;
  const texts = data.map((entry: unknown) => (isPlainObject(entry) ? entry.value : entry));
  return texts.every((text) => typeof text === "string") ? texts : undefined;
}

/**
 * Match ECharts' wrapping boundaries: supported alphabetic runs, then individual characters.
 * This lets scripts such as Chinese wrap between any two characters.
 */
export const WORDS =
  /[!-%'-+\-.0-:<->@-\\^-\u024f\u0370-\u10ff\u1200-\u13ff\u1e00-\u206f]+|[\s\S]/g;

/** Count wrapped lines, splitting words that exceed the available width. */
export function lineCount(text: string, room: number, width: (text: string) => number): number {
  let count = 0;
  for (const line of text.split("\n")) {
    count++;
    let used = 0;
    for (const word of line.match(WORDS) ?? []) {
      const size = width(word);
      if (used + size <= room) {
        used += size;
        continue;
      }
      if (used > 0) count++;
      count += Math.ceil(size / room) - 1;
      used = size % room || room;
    }
  }
  return count;
}

/** Return the prefix that fits, keeping at least one character for nonempty text. */
export function startOf(text: string, room: number, width: (text: string) => number): string {
  let used = 0;
  for (let end = 0; end < text.length; end++) {
    // ECharts measures a text as wide as its characters.
    used += width(text.charAt(end));
    if (used > room) return text.slice(0, Math.max(1, end));
  }
  return text;
}
