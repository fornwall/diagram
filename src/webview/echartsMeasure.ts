// What a chart's layout measures with: the size of the panel and the fonts of the chart's texts,
// as ECharts measures them, and how the texts of an option are read.

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

/** A font of chart text, and how wide it draws a text, as ECharts measures it. */
export interface Font {
  /** As CSS, as "bold 12px sans-serif". */
  css: string;
  /** Its size in pixels, as tall as ECharts measures a line of it. */
  size: number;
  /**
   * The width of a text as drawn, as ECharts measures it to place it, to tell whether labels fit
   * across an axis or a text within a width.
   */
  width(text: string): number;
  /**
   * The width of a text as ECharts measures it to break it onto lines, or to tell where to cut it
   * short: character by character, any but ASCII as wide as one of Chinese.
   */
  breakWidth(text: string): number;
}

export interface Size {
  width: number;
  height: number;
  /** Too small for a legend above the grid. */
  compact: boolean;
  /**
   * The font of the first of some text styles that sets each part of it, as its size and weight,
   * or else of the chart's text, as ECharts makes the font of a text.
   */
  font(...styles: JsonObject[]): Font;
  /**
   * The text style that the theme gives axis labels and names, legends and a radar's names, which
   * ECharts takes over the option's text style: of the theme's font.
   */
  themed: JsonObject;
}

/** The size of the panel and the fonts of the chart's texts, for a layout to measure with. */
export function layoutSize(context: LayoutContext, base: JsonObject): Size {
  const { width, height } = context;
  const compact = width < 560 || height < 340;
  // The text style of the chart: the option's, over the theme's.
  const chartStyle: JsonObject = {
    fontFamily: context.colors.fontFamily,
    fontSize: context.colors.fontSize,
    ...(isPlainObject(base.textStyle) ? base.textStyle : {}),
  };
  const font = (...styles: JsonObject[]): Font => {
    const part = (key: string) =>
      [...styles, chartStyle].map((style) => style[key]).find((value) => value != null);
    // Of pixels, as a number or as "14px".
    const fontSize = /^\d+(?:\.\d+)?(?:px)?$/.test(String(part("fontSize")).trim())
      ? Number.parseFloat(String(part("fontSize")))
      : context.colors.fontSize;
    const css = [part("fontStyle"), part("fontWeight"), `${fontSize}px`, part("fontFamily")]
      .filter((value) => value != null && value !== "")
      .join(" ");
    return {
      css,
      size: fontSize,
      // A text of several lines as wide as its widest, as ECharts draws it.
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
  /**
   * The width of a text in a CSS font as ECharts measures it to break it onto lines, of the
   * library that draws the chart.
   */
  textWidth(text: string, font: string): number;
  /** The width of a text in a CSS font as drawn, as the library that draws the chart measures it. */
  drawnWidth(text: string, font: string): number;
}

/** The text style of an option's setting, as its "axisLabel", if it is one. */
export const styleOf = (style: unknown): JsonObject => (isPlainObject(style) ? style : {});

/**
 * The text of a category or legend entry: a value, a category `{value}`, or a legend entry or
 * data item named by `{name}` (whose value is a number).
 */
export const entryText = (entry: unknown) =>
  String((isPlainObject(entry) ? (entry.name ?? entry.value) : entry) ?? "");

/** The categories of an axis beyond which the layout reads only as many as it must. */
export const MAX_READ_CATEGORIES = 200;

/**
 * The width of the widest category or legend entry (see {@link entryText}): of more than a few
 * hundred, the widest of an even sample of them, as ECharts reads the labels of a dense axis, and
 * of the longest, as measuring each would take long.
 */
export function widestText(
  entries: unknown,
  width: (text: string) => number,
  enough = Infinity,
): number {
  if (!Array.isArray(entries)) {
    return 0;
  }
  // Once the label exceeds every layout threshold, further entries cannot change the result.
  // Dense axes and long legends often reach that point with their very first entry.
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

export const plainNumber = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 20,
  useGrouping: false,
});

export const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 20,
});

/**
 * A number in full below 10,000, so that a year reads as "2015", and exactly in thousands,
 * millions, … from there, as "12.5K".
 */
export const compactLabel = (value: unknown) =>
  typeof value !== "number"
    ? String(value)
    : (Math.abs(value) < 10_000 ? plainNumber : compactNumber).format(value);

/** The height of a line of an axis label that goes onto several. */
export const LABEL_LINE_HEIGHT = 17;

/** The texts of the categories of an axis, if strings and no more than a few hundred. */
export function categoryTexts(data: unknown): string[] | undefined {
  if (!Array.isArray(data) || data.length > MAX_READ_CATEGORIES) return undefined;
  const texts = data.map((entry: unknown) => (isPlainObject(entry) ? entry.value : entry));
  return texts.every((text) => typeof text === "string") ? texts : undefined;
}

/**
 * The words of a text as ECharts breaks it onto lines between them: runs of letters of alphabets,
 * which end at a space and at some punctuation, and each other character on its own, as one of
 * Chinese, which it breaks between any two.
 */
export const WORDS =
  /[!-%'-+\-.0-:<->@-\\^-\u024f\u0370-\u10ff\u1200-\u13ff\u1e00-\u206f]+|[\s\S]/g;

/**
 * The lines that ECharts breaks a text onto in a width, in a font: those it starts, and within
 * each, word by word, a word wider than a line across lines.
 */
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

/** As much of the start of a text as fits in a width, in a font, but at least a character. */
export function startOf(text: string, room: number, width: (text: string) => number): string {
  let used = 0;
  for (let end = 0; end < text.length; end++) {
    // ECharts measures a text as wide as its characters.
    used += width(text.charAt(end));
    if (used > room) return text.slice(0, Math.max(1, end));
  }
  return text;
}
