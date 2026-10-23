// Fits a grid, or the panels of facets, into the space left for it, and keeps the labels of its
// axes apart and readable: category labels turned, onto lines, told apart by what follows a start
// they share, or cut short, and fewer value and time labels along a short or narrow axis.

import { asArray } from "../protocol";
import { facetPanels, layOutFacets } from "./echartsFacets";
import {
  axisType,
  BOX_KEYS,
  categoryTexts,
  compactLabel,
  type Font,
  has,
  type Insets,
  LABEL_LINE_HEIGHT,
  lineCount,
  pixels,
  type Size,
  startOf,
  styleOf,
  widestText,
} from "./echartsMeasure";
import type { JsonObject } from "./echartsOption";

/**
 * Fits a single grid, or the panels of facets, into the space left, and keeps axis labels apart.
 * Returns the height that turned category labels take below the plot beyond a row of them.
 */
export function layOutGrid(base: JsonObject, reserved: Insets, size: Size): number {
  const { width, height, compact } = size;
  const grids = asArray(base.grid);
  /** The size of the plot of each grid, with its labels, where the layout places the grids. */
  let panel: { width: number; height: number } | undefined;
  if (grids.length <= 1) {
    const grid = grids[0] ?? {};
    if (!has(grid, [...BOX_KEYS, "outerBounds", "outerBoundsMode"])) {
      Object.assign(grid, {
        left: reserved.left + 8,
        right: reserved.right + 20,
        top: reserved.top + 14,
        bottom: reserved.bottom + 8,
      });
      panel = {
        width: width - reserved.left - reserved.right - 28,
        height: height - reserved.top - reserved.bottom - 22,
      };
      // The ECharts 6 way to keep axis labels and names inside the grid rectangle.
      if (grid.containLabel === undefined) {
        grid.outerBoundsMode = "same";
      }
    }
    if (grids.length === 0) {
      // Also in place of an empty list of grids, which ECharts would replace by its default grid.
      base.grid = grid;
    }
  }
  const facets = facetPanels(base);
  const facetGrid = facets && layOutFacets(facets, reserved, size);
  panel ??= facetGrid;

  // Rotate category labels when they would overlap, and truncate very long ones.
  const labelHeights = new Map<JsonObject, number>();
  // Of a grid that the layout places, as wide as the room for it less what its vertical axes take
  // beside it; else of about as much.
  const plotWidth = Math.max(
    80,
    panel !== undefined && grids.length <= 1
      ? panel.width - besidePlot(base, size, Math.round(width * (compact ? 0.3 : 0.22)))
      : width - reserved.left - reserved.right - 80,
  );
  // Multi-grid charts need label decisions based on their own panel, not the entire canvas.
  const panelWidth = (axis: JsonObject): number => {
    if (grids.length <= 1) return plotWidth;
    const grid = grids[typeof axis.gridIndex === "number" ? axis.gridIndex : 0];
    const available =
      pixels(grid?.width, width) ??
      width - (pixels(grid?.left, width) ?? 0) - (pixels(grid?.right, width) ?? 0);
    return Math.max(40, available - 50);
  };
  for (const axis of asArray(base.xAxis)) {
    const label = styleOf(axis.axisLabel);
    const count = Array.isArray(axis.data) ? axis.data.length : 0;
    if (count === 0 || label.rotate !== undefined) {
      continue;
    }
    // The option can show every label, or every so many, which then stay shown however they are
    // turned; else ECharts leaves out those that would overlap along the slant.
    const { interval } = label;
    const chosen = typeof interval === "number" && interval >= 0;
    const slot = (panelWidth(axis) / count) * (chosen ? interval + 1 : 1);
    // Slanted labels take the height of the plot, of a facet's own in a faceted chart.
    const maxWidth =
      facetGrid === undefined
        ? Math.max(60, Math.round(height * 0.22))
        : Math.max(40, Math.round(facetGrid.height * 0.35));
    const font = size.font(label, size.themed);
    let labelWidth = widestText(axis.data, font.width, Math.max(slot * 3, maxWidth));
    // ECharts shows each label across the axis where, a third wider, it fits in the width of its
    // category, and else leaves some out: the third is the gap between them.
    const across = (width: number) => width * CATEGORY_LABEL_ROOM <= slot;
    // Labels cut short to the same start are told apart by what follows it.
    // Named below the labels, across the middle of the axis, unless the option names it elsewhere.
    const { name: own, nameLocation: location } = axis;
    const middle = location === undefined || location === "middle" || location === "center";
    const rest =
      !across(labelWidth) &&
      labelWidth > maxWidth &&
      dropSharedStart(axis, label, maxWidth, middle, font);
    if (rest) labelWidth = rest;
    if (!across(labelWidth)) {
      // ECharts keeps turned labels a third of a line apart across the slant, as it measures them
      // on one, and else leaves some out, and hides those whose lines overlap: steeper where
      // categories are too narrow for either at 30°, as of labels of several lines.
      const lineHeight = typeof label.lineHeight === "number" ? label.lineHeight : font.size;
      const lines = labelLines(axis.data, label, font);
      const tall = Math.max(font.size * CATEGORY_LABEL_ROOM, lines * lineHeight);
      const apart = (angle: number) => tall <= slot * Math.sin((angle * Math.PI) / 180);
      const rotate = labelWidth > slot * 3 || !apart(30) ? 45 : 30;
      axis.axisLabel = {
        rotate,
        ...(chosen ? {} : { hideOverlap: true }),
        ...(labelWidth > maxWidth ? { width: maxWidth, overflow: "truncate" } : {}),
        ...label,
      };
      const slanted = Math.min(labelWidth, maxWidth) * Math.sin((rotate * Math.PI) / 180);
      labelHeights.set(axis, LABEL_HEIGHT + Math.round(slanted));
    }
    // The shared start names the axis below its labels.
    if (rest && axis.name !== own) {
      axis.nameLocation ??= "middle";
      axis.nameGap ??= (labelHeights.get(axis) ?? LABEL_HEIGHT) + 8;
    }
  }
  // A short or narrow plot, as of a facet or in a small panel, has room for fewer value labels.
  if (panel !== undefined) {
    const faceted = facetGrid !== undefined;
    const xAxes = asArray(base.xAxis);
    for (const axis of xAxes) {
      // Value labels as wide as the longest bound's, beside each other.
      const digits = [axis.min, axis.max].map((bound) =>
        typeof bound === "number" ? compactLabel(bound).length : 4,
      );
      const font = size.font(styleOf(axis.axisLabel), size.themed);
      const label = font.width("0".repeat(Math.max(...digits) + 1));
      fewerTicks(axis, panel.width - 50, label + 16, faceted);
      fewerTimeTicks(axis, panel.width - 50, font);
    }
    for (const axis of asArray(base.yAxis)) {
      const xAxis = xAxes.find(({ gridIndex }) => gridIndex === axis.gridIndex);
      let plot = panel.height - (xAxis ? (labelHeights.get(xAxis) ?? LABEL_HEIGHT) : 0);
      // The name above the plot, unless a facet's plot would be too short for it.
      if (typeof axis.name === "string" && axis.name && axis.nameLocation === undefined) {
        if (faceted && plot - AXIS_NAME_HEIGHT < MIN_NAMED_FACET) axis.name = "";
        else plot -= AXIS_NAME_HEIGHT;
      }
      fewerTicks(axis, plot, MIN_TICK_GAP, faceted);
    }
  }
  for (const axis of asArray(base.yAxis)) {
    const label = styleOf(axis.axisLabel);
    const maxWidth = Math.round(
      (grids.length > 1 ? panelWidth(axis) : width) * (compact ? 0.3 : 0.22),
    );
    const font = size.font(label, size.themed);
    if (label.width !== undefined || widestText(axis.data, font.width, maxWidth) <= maxWidth) {
      continue;
    }
    // Labels too long for their width go onto as many lines as the height of each row has room
    // for, and else are told apart by what follows the start they share, if they do.
    const xAxis = asArray(base.xAxis).find(({ gridIndex }) => gridIndex === axis.gridIndex);
    const rowHeight =
      panel === undefined || !Array.isArray(axis.data)
        ? 0
        : (panel.height -
            (xAxis ? (labelHeights.get(xAxis) ?? LABEL_HEIGHT) : 0) -
            (axis.name ? AXIS_NAME_HEIGHT : 0)) /
          axis.data.length;
    const lines = Math.floor((rowHeight - 4) / LABEL_LINE_HEIGHT);
    if (lines >= 2 && wrapsInto(axis.data, maxWidth, lines, font.breakWidth)) {
      axis.axisLabel = {
        width: maxWidth,
        overflow: "break",
        lineHeight: LABEL_LINE_HEIGHT - 1,
        ...label,
      };
      continue;
    }
    const { name: own, nameLocation: location } = axis;
    const rest = dropSharedStart(axis, label, maxWidth, true, font);
    const end = location === undefined || location === "start" || location === "end";
    if (rest !== undefined && axis.name !== own && end) {
      // The name above the labels starts at the axis, rather than centered on it, beside them.
      const style = styleOf(axis.nameTextStyle);
      style.align ??= axis.position === "right" ? "right" : "left";
      axis.nameTextStyle = style;
    }
    if (rest === undefined || rest > maxWidth) {
      axis.axisLabel = { width: maxWidth, overflow: "truncate", ...label };
    }
  }
  // ECharts names an axis at its end, which an inverse axis has at the bottom or left, below
  // or beside its labels, as a heatmap's rows from the top: name it where the axis starts.
  for (const axis of [...asArray(base.xAxis), ...asArray(base.yAxis)]) {
    if (axis.inverse === true && axis.name && axis.nameLocation === undefined) {
      axis.nameLocation = "start";
    }
  }
  return Math.max(0, ...[...labelHeights.values()].map((height) => height - LABEL_HEIGHT));
}

/**
 * The width that the axes of the first grid take beside its plot, as ECharts keeps their labels
 * and names within the grid. A vertical axis takes the margin and its widest label, or half its
 * name, centered on it above or below, where wider, or its name along it beside them, on the side
 * ECharts places it: the first left and the next right, unless placed. A horizontal axis takes its
 * name, after its end or before its start, with the gap to it. The labels of a value axis are as
 * wide as the panel labels its values, compactly as "12.5K" (see {@link compactAxisLabels}), and
 * those of a category axis as its widest, but no wider than the most that the layout cuts them to.
 */
function besidePlot(base: JsonObject, size: Size, most: number): number {
  const sides = { left: 0, right: 0 };
  const onGrid = (axis: JsonObject) => Number(axis.gridIndex ?? 0) === 0;
  const used = new Set<string>();
  for (const axis of asArray(base.yAxis).filter(onGrid)) {
    const { position } = axis;
    const placed = position === "left" || position === "right";
    const side = placed ? position : used.has("left") ? "right" : "left";
    used.add(side);
    if (axis.show === false) continue;
    const label = styleOf(axis.axisLabel);
    const font = size.font(label, size.themed);
    let room = 0;
    if (label.show !== false && label.inside !== true) {
      const type = axisType(axis);
      const { formatter } = label;
      let text = UNKNOWN_LABELS;
      if (type === "category") {
        // Of a width that the option sets, the layout leaves them as wide as it makes them: as
        // wide as it, where it cuts them short or breaks them onto lines, or else whole.
        const { width, overflow } = label;
        const cut =
          width === undefined
            ? most
            : typeof width === "number" &&
                width > 0 &&
                ["truncate", "break", "breakAll"].includes(String(overflow))
              ? width
              : Infinity;
        text = Math.min(widestText(axis.data, font.width, cut), cut);
      } else if (formatter === undefined || typeof formatter === "string") {
        // As wide as the labels of its bounds, where the option sets them, or else as "-1500".
        const bounds = [axis.min, axis.max];
        const digits = bounds.every((bound) => typeof bound === "number")
          ? Math.max(...bounds.map((bound) => compactLabel(bound).length))
          : 5;
        const value = type === "time" ? "Feb 13" : "0".repeat(digits);
        text = font.width(formatter === undefined ? value : formatter.replaceAll("{value}", value));
      }
      room = text + (typeof label.margin === "number" ? label.margin : 8);
    }
    const { name, nameLocation: location } = axis;
    if (typeof name === "string" && name && axis.nameRotate === undefined) {
      const nameFont = size.font(styleOf(axis.nameTextStyle), size.themed);
      if (location === undefined || location === "end" || location === "start") {
        room = Math.max(room, nameFont.width(name) / 2);
      } else if (location === "middle" || location === "center") {
        // Along the axis, its gap from it, or past its labels where they reach further.
        const gap = typeof axis.nameGap === "number" ? axis.nameGap : 15;
        room = Math.max(room + 8, gap) + nameFont.size + 8;
      }
    }
    // Axes on the same side are drawn over each other, unless the option offsets one past another.
    const offset = typeof axis.offset === "number" ? axis.offset : 0;
    sides[side] = Math.max(sides[side], room + offset);
  }
  for (const axis of asArray(base.xAxis).filter(onGrid)) {
    const { name, nameLocation: location } = axis;
    if (axis.show === false || typeof name !== "string" || !name) continue;
    if (location !== undefined && location !== "end" && location !== "start") continue;
    const nameWidth = size.font(styleOf(axis.nameTextStyle), size.themed).width(name);
    const room = nameWidth + (typeof axis.nameGap === "number" ? axis.nameGap : 15);
    // An inverse axis starts on the right, where the layout names it unless the option does.
    const side =
      location === undefined || (location === "start") === (axis.inverse === true)
        ? "right"
        : "left";
    sides[side] = Math.max(sides[side], room);
  }
  return sides.left + sides.right;
}

/** The width of the labels of an axis that the option formats in a way the layout cannot tell. */
const UNKNOWN_LABELS = 44;

/**
 * How much wider than a category label is the room that ECharts makes sure each has, to show
 * them all.
 */
const CATEGORY_LABEL_ROOM = 1.3;

/** Whether each category's text goes onto no more than some lines of a width, in a font. */
function wrapsInto(
  data: unknown,
  room: number,
  lines: number,
  width: (text: string) => number,
): boolean {
  const texts = categoryTexts(data);
  if (texts === undefined) return false;
  return texts.every((text) => lineCount(text, room, width) <= lines);
}

/**
 * The most lines that ECharts draws a category label on: those of its own, and those it breaks
 * it onto in the width of a label that the option breaks.
 */
function labelLines(data: unknown, label: JsonObject, font: Font): number {
  const texts = categoryTexts(data) ?? [];
  const breaks = label.overflow === "break" || label.overflow === "breakAll";
  const room =
    typeof label.width === "number" && label.width > 0 && breaks ? label.width : Infinity;
  return Math.max(1, ...texts.map((text) => lineCount(text, room, font.breakWidth)));
}

/** By the start they leave out, so that a layout of the same option has the same ones. */
const sharedStartFormatters = new Map<string, (value: unknown) => string>();

/**
 * Labels the categories of an axis by what follows the start they share, when cut short to a
 * width they would read alike, as the "Northern Regional Distribution Center" of "… 0", "… 1",
 * …, and names the axis by that start instead. The start ends with a word. An axis named by the
 * option, or where such a name would not fit, keeps its name, and its labels their last words
 * instead, as many as fit, as "…Center 12", unless those read alike too: then they are what
 * follows the start all the same. Returns the width of the widest label left, if any, in the font
 * of the labels.
 */
function dropSharedStart(
  axis: JsonObject,
  label: JsonObject,
  room: number,
  nameable: boolean,
  font: Font,
): number | undefined {
  const texts = categoryTexts(axis.data);
  // Not of labels that the option hides, which the name would tell nothing of.
  if (!texts || texts.length < 2 || label.formatter !== undefined || label.show === false) {
    return undefined;
  }
  // As ECharts cuts them short, before an ellipsis.
  const cut = (text: string) => startOf(text, room - font.width("…"), font.breakWidth);
  if (new Set(texts.map(cut)).size === new Set(texts).size) return undefined;
  let shared = texts[0] ?? "";
  for (const text of texts) {
    let length = 0;
    while (length < shared.length && shared[length] === text[length]) length++;
    shared = shared.slice(0, length);
  }
  const start = /^.*[\s\-_/:.,;|]/s.exec(shared)?.[0];
  const name = start?.replace(/[\s\-_/:.,;|]+$/, "");
  if (!start || !name || texts.some((text) => text.length <= start.length)) return undefined;
  const named = !nameable || (axis.name !== undefined && axis.name !== "");
  if (named) {
    const last = lastWords(room, font);
    // Unless they read alike so too, as of labels that also end alike.
    if (new Set(texts.map(last)).size === new Set(texts).size) {
      label.formatter = last;
      axis.axisLabel = label;
      return Math.max(...texts.map((text) => font.width(last(text))));
    }
  }
  let formatter = sharedStartFormatters.get(start);
  if (!formatter) {
    formatter = (value: unknown) => {
      const text = String(value);
      return text.startsWith(start) ? text.slice(start.length) : text;
    };
    sharedStartFormatters.set(start, formatter);
  }
  label.formatter = formatter;
  axis.axisLabel = label;
  if (!named) axis.name = `${name} …`;
  return Math.max(...texts.map((text) => font.width(text.slice(start.length))));
}

/**
 * By the width and font of the labels they keep, so that a layout of the same option has the
 * same ones.
 */
const lastWordFormatters = new Map<string, (value: unknown) => string>();

/**
 * A formatter of labels wider than some pixels in a font that keeps their last words, as many as
 * fit after an ellipsis, or else the last characters.
 */
function lastWords(room: number, font: Font): (value: unknown) => string {
  const key = `${Math.round(room)} ${font.css}`;
  let formatter = lastWordFormatters.get(key);
  if (!formatter) {
    formatter = (value: unknown) => {
      const text = String(value);
      if (font.width(text) <= room) return text;
      const fits = (end: string) => font.width(`…${end}`) <= room;
      // Each word after the space before it.
      const words = text.split(/(?=\s)/);
      let kept = "";
      for (const word of words.reverse()) {
        if (!fits((word + kept).trimStart())) break;
        kept = word + kept;
      }
      if (kept.trimStart()) return `…${kept.trimStart()}`;
      let end = text.length - 1;
      while (end > 0 && fits(text.slice(end - 1))) end--;
      return `…${text.slice(end)}`;
    };
    lastWordFormatters.set(key, formatter);
  }
  return formatter;
}

/** The height of a row of axis labels, with the gap to the axis. */
export const LABEL_HEIGHT = 22;

/** The height that the name of a vertical axis takes above the plot. */
const AXIS_NAME_HEIGHT = 24;

/** The height of a facet's plot below which its axis's name would leave it too short. */
const MIN_NAMED_FACET = 60;

/** The least distance in pixels between the value labels of a vertical axis. */
const MIN_TICK_GAP = 20;

/**
 * Gives a time axis across the chart fewer labels when they would run into each other along its
 * length, as they would in a narrow plot: ECharts steps its ticks by the split number alone, and
 * draws every label. Only of an axis whose labels the panel formats (see {@link TIME_LABELS}),
 * as wide as "Feb 13" or "12:30". A least interval, as a generated chart of dates sets, is a
 * floor under the step, which fewer ticks keep above it.
 */
export function fewerTimeTicks(axis: JsonObject, length: number, font: Font): void {
  const label = styleOf(axis.axisLabel);
  if (
    axisType(axis) !== "time" ||
    label.formatter !== undefined ||
    axis.splitNumber !== undefined ||
    axis.interval !== undefined
  ) {
    return;
  }
  // ECharts rounds the step down to a whole one, which can make half as many ticks again as the
  // split number asks for, as with value axes; it asks for 6 itself.
  const asked = Math.max(2, Math.floor(length / (font.width("Feb 13") + 16) / 1.5));
  if (asked < 6) axis.splitNumber = asked;
}

/**
 * Gives a value axis fewer labels when they would pile on each other along its length, at least
 * `gap` apart. A facet's axis with the bounds and interval that the facets share gets wider ones;
 * the bounds and interval of any other axis are the option's own, which this leaves alone.
 */
function fewerTicks(axis: JsonObject, length: number, gap: number, faceted: boolean): void {
  if (axisType(axis) !== "value") return;
  const parts = Math.max(2, Math.floor(length / gap));
  const { min, max, interval } = axis;
  if (
    !faceted ||
    typeof min !== "number" ||
    typeof max !== "number" ||
    typeof interval !== "number"
  ) {
    // ECharts rounds the interval to a nice one, which can make half as many ticks again as the
    // split number asks for: 7 for 5 from 0 to 6.
    const asked = Math.max(2, Math.floor(parts / 1.5));
    if (axis.interval === undefined && axis.splitNumber === undefined && asked < 5) {
      axis.splitNumber = asked;
    }
    return;
  }
  if (!(interval > 0) || (max - min) / interval <= parts + 1e-9) return;
  // The same bounds and interval give every facet, of the same size, the same ticks. A step of
  // counts stays a whole number of them.
  const whole = typeof axis.minInterval === "number" ? axis.minInterval : 0;
  for (let step = niceAbove(interval); Number.isFinite(step); step = niceAbove(step)) {
    if (whole > 0 && !Number.isInteger(round(step / whole))) continue;
    const low = round(Math.floor(min / step + 1e-9) * step);
    const high = round(Math.ceil(max / step - 1e-9) * step);
    if ((high - low) / step <= parts + 1e-9) {
      Object.assign(axis, { min: low, max: high, interval: step });
      return;
    }
  }
}

const round = (value: number) => Number(value.toPrecision(12));

/** The smallest of 1, 2, 2.5 and 5 times a power of 10 above a step. */
function niceAbove(step: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(step));
  for (const multiple of [1, 2, 2.5, 5]) {
    const nice = round(multiple * magnitude);
    if (nice > step * (1 + 1e-9)) return nice;
  }
  return round(10 * magnitude);
}
