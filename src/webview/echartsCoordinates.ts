// Fits the coordinate systems other than a grid into the space left for them: a calendar, parallel
// coordinates, a radar and a single axis, with room for their labels and names.

import { asArray, isPlainObject } from "../protocol";
import { fewerTimeTicks, LABEL_HEIGHT } from "./echartsGrid";
import {
  BOX_KEYS,
  has,
  type Insets,
  LABEL_LINE_HEIGHT,
  type Size,
  styleOf,
  widestText,
} from "./echartsMeasure";
import type { JsonObject } from "./echartsOption";

/** The days of a calendar's range, from its first to its last, as UTC dates. */
function calendarDays(range: unknown): [Date, Date] | undefined {
  const ends = Array.isArray(range) ? range : [range, range];
  const day = (end: unknown, last: boolean) => {
    const match = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(String(end ?? "").trim());
    if (!match) return undefined;
    const [, year, month, date] = match.map(Number);
    if (year === undefined) return undefined;
    // The first or last day of a year or month that a range names.
    if (month === undefined || Number.isNaN(month)) {
      return new Date(Date.UTC(year, last ? 11 : 0, last ? 31 : 1));
    }
    if (date === undefined || Number.isNaN(date)) {
      return new Date(Date.UTC(year, last ? month : month - 1, last ? 0 : 1));
    }
    return new Date(Date.UTC(year, month - 1, date));
  };
  const first = day(ends[0], false);
  const last = day(ends[ends.length - 1], true);
  return first && last && first <= last ? [first, last] : undefined;
}

/** The size of a calendar's cells below which its labels run into each other. */
const MIN_CALENDAR_CELL = 12;

/**
 * Fits a calendar into the space left, as a grid is: ECharts places it 80 pixels in from the
 * left and 60 down from the top, its cells 20 pixels square, so that a year runs past the right
 * of a narrow chart and leaves a wide one mostly empty. Its cells, square across the chart, as
 * large as there is room for, or down it, a week a row, in a chart too narrow for those to read.
 */
export function layOutCalendar(base: JsonObject, reserved: Insets, { width, height }: Size): void {
  const calendars = asArray(base.calendar);
  const calendar = calendars.length === 1 ? calendars[0] : undefined;
  if (!calendar || has(calendar, [...BOX_KEYS, "cellSize", "orient"]) || calendar.show === false) {
    return;
  }
  const days = calendarDays(calendar.range);
  if (!days) return;
  const [first, last] = days;
  const dayLabel = styleOf(calendar.dayLabel);
  const firstDay = typeof dayLabel.firstDay === "number" ? dayLabel.firstDay : 0;
  const count = Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1;
  const weeks = Math.ceil((((first.getUTCDay() - firstDay + 7) % 7) + count) / 7);
  const boxWidth = width - reserved.left - reserved.right;
  const boxHeight = height - reserved.top - reserved.bottom;
  // Across, the year and the days are labeled on the left and the months above; down, the year
  // and the days above and the months on the left.
  const across = Math.min(30, Math.floor(Math.min((boxWidth - 80) / weeks, (boxHeight - 38) / 7)));
  const tall = Math.floor((boxHeight - 66) / weeks);
  const wide = Math.min(60, Math.floor((boxWidth - 56) / 7));
  if (across >= MIN_CALENDAR_CELL || across >= Math.min(tall, wide)) {
    Object.assign(calendar, {
      left: reserved.left + 64,
      top: reserved.top + 30,
      cellSize: [Math.max(1, across), Math.max(1, across)],
    });
    // Rows too close for a label each name every other day, as Monday, Wednesday and Friday.
    if (across < MIN_CALENDAR_CELL && dayLabel.show !== false && dayLabel.nameMap === undefined) {
      calendar.dayLabel = { ...dayLabel, nameMap: ["", "M", "", "W", "", "F", ""] };
    }
    return;
  }
  Object.assign(calendar, {
    orient: "vertical",
    // Centered across the chart, which a week takes only a few pixels of.
    left: reserved.left + 40 + Math.round((boxWidth - 56 - 7 * wide) / 2),
    top: reserved.top + 58,
    cellSize: [wide, Math.min(wide, tall)],
  });
}

/**
 * Fits parallel coordinates into the space left, with room for the names above their axes.
 * ECharts places them 80 pixels in from each side and 60 from the top and bottom, which leaves the
 * axes of a narrow chart too close for their names, which it cuts short to the room between two
 * axes, as "Horsep…": names that do not fit go on two rows instead, every other one raised, each
 * as wide as the room between three axes. Only of axes across the chart that the option names and
 * places as ECharts does.
 */
export function layOutParallel(base: JsonObject, reserved: Insets, size: Size): void {
  const { width } = size;
  const parallels = asArray(base.parallel);
  if (parallels.length > 1 || asArray(base.parallelAxis).length < 2) return;
  const parallel = parallels[0] ?? {};
  const axes = asArray(base.parallelAxis);
  const shared = styleOf(parallel.parallelAxisDefault);
  const nameKeys = ["nameLocation", "nameGap", "nameRotate", "nameTruncate"];
  if (
    has(parallel, BOX_KEYS) ||
    (parallel.layout ?? "horizontal") !== "horizontal" ||
    parallel.axisExpandable === true ||
    has(shared, nameKeys) ||
    axes.some((axis) => has(axis, nameKeys) || Number(axis.parallelIndex ?? 0) !== 0)
  ) {
    return;
  }
  // The width of each axis's name, in the font of its own or of all.
  const names = axes.map((axis) =>
    typeof axis.name === "string"
      ? size
          .font(styleOf(axis.nameTextStyle), styleOf(shared.nameTextStyle), size.themed)
          .width(axis.name)
      : 0,
  );
  const half = (index: number) => (names[index] ?? 0) / 2;
  // The first name centered above the first axis, and the labels of the last right of it.
  const left = Math.round(Math.max(24, half(0) + 8));
  const right = Math.round(Math.max(48, half(axes.length - 1) + 8));
  const step = (width - reserved.left - reserved.right - left - right) / (axes.length - 1);
  const longest = Math.max(...names);
  const rows = longest + 8 > step ? 2 : 1;
  if (rows === 2) {
    axes.forEach((axis, index) => {
      // ECharts' gap from the axis to its name, and a line more for every other one.
      axis.nameGap = 15 + (index % 2) * LABEL_LINE_HEIGHT;
      axis.nameTruncate = { maxWidth: Math.max(40, Math.round(2 * step - 8)) };
    });
  }
  Object.assign(parallel, {
    left: reserved.left + left,
    right: reserved.right + right,
    top: reserved.top + 15 + rows * LABEL_LINE_HEIGHT + 8,
    bottom: reserved.bottom + 24,
  });
  if (parallels.length === 0) base.parallel = parallel;
}

export function layOutRadar(base: JsonObject, reserved: Insets, size: Size): void {
  const radars = asArray(base.radar);
  const radar = radars.length === 1 ? radars[0] : undefined;
  if (!radar || radar.center !== undefined || radar.radius !== undefined) {
    return;
  }
  const boxWidth = size.width - reserved.left - reserved.right;
  const boxHeight = size.height - reserved.top - reserved.bottom;
  radar.center = [reserved.left + boxWidth / 2, reserved.top + boxHeight / 2];
  // Leave room beside the radar for the names of its indicators, of up to a fourth of the width.
  const font = size.font(styleOf(radar.axisName), size.themed);
  const nameWidth = Math.min(widestText(radar.indicator, font.width, boxWidth / 4), boxWidth / 4);
  radar.radius = Math.max(40, Math.min(boxWidth - 2 * nameWidth - 40, boxHeight - 56) / 2);
}

/** Whether a series is drawn along a single axis, as a theme river is unless told otherwise. */
export const onSingleAxis = (series: JsonObject) =>
  (series.coordinateSystem ?? (series.type === "themeRiver" ? "singleAxis" : undefined)) ===
  "singleAxis";

/** The width of a theme river's layer names beside it, at most, as a share of the chart's width. */
const MAX_LAYER_NAMES = 0.25;

/**
 * Fits a single axis into the space left, as a grid is, with room for its labels. ECharts places
 * it 5% in from each side, under a legend or title, and starts the name of each layer of a theme
 * river where the layer starts, on top of it: the panel ends the names there instead, in room
 * that it keeps beside the river for them.
 */
export function layOutSingleAxis(
  base: JsonObject,
  series: JsonObject[],
  reserved: Insets,
  size: Size,
): void {
  const { width, height } = size;
  const axes = asArray(base.singleAxis);
  const axis = axes.length === 1 ? axes[0] : undefined;
  if (!axis || has(axis, BOX_KEYS) || axis.orient === "vertical") return;
  // The labels of the axis, below it unless placed above.
  const labels = isPlainObject(axis.axisLabel) && axis.axisLabel.show === false ? 0 : LABEL_HEIGHT;
  const above = axis.position === "top";
  const top = reserved.top + 14 + (above ? labels : 0);
  const bottom = reserved.bottom + 8 + (above ? 0 : labels);
  let left = 24;
  for (const river of series) {
    const label = styleOf(river.label);
    if (river.type !== "themeRiver" || label.show === false) continue;
    label.align ??= "right";
    river.label = label;
    // The names of the layers, in the data's third field, as in ["2026-01-05", 12, "Docs"].
    const names = Array.isArray(river.data)
      ? river.data.map((item: unknown) => (Array.isArray(item) ? item[2] : undefined))
      : [];
    // ECharts' default size of the names.
    const fontSize = typeof label.fontSize === "number" ? label.fontSize : 11;
    // The names of layers that start thin, close together, apart, where they all fit below the
    // top of where the river starts, around the middle of its axis, as ECharts moves them down
    // from there, and else onto its axis labels or legend: else as many as there is room for. The
    // legend and tooltip name the others. Each name is as tall as its font is large.
    const layers = new Set(names.filter((name: unknown) => name != null).map(String)).size;
    const room = height - top - bottom;
    // ECharts draws the river across the axis but for 10% at each side.
    const start = Array.isArray(river.data) ? riverStart(river.data) * 0.8 * room : 0;
    river.labelLayout ??=
      layers * fontSize <= (room + start + fontSize) / 2
        ? { moveOverlap: "shiftY", hideOverlap: true }
        : { hideOverlap: true };
    if (label.align !== "right") continue;
    // ECharts' default margin of the names.
    const margin = (typeof label.margin === "number" ? label.margin : 4) + 8;
    const most = Math.round(width * MAX_LAYER_NAMES);
    const text = widestText(names, size.font(label, { fontSize }).width, most);
    if (text + margin > most && label.width === undefined) {
      Object.assign(label, { width: most - margin, overflow: label.overflow ?? "truncate" });
    }
    left = Math.max(left, Math.round(Math.min(text + margin, most)));
  }
  Object.assign(axis, { left: reserved.left + left, right: reserved.right + 24, top, bottom });
  const length = width - reserved.left - left - reserved.right - 24;
  fewerTimeTicks(axis, length, size.font(styleOf(axis.axisLabel), size.themed));
}

/**
 * How thick a theme river is where it starts, at its first time, as a share of where it is
 * thickest, of data as ["2026-01-05", 12, "Docs"]: 0 where its times do not tell which is first.
 */
function riverStart(data: unknown[]): number {
  const sums = new Map<string, number>();
  let first: { at: number; key: string } | undefined;
  for (const item of data) {
    if (!Array.isArray(item)) continue;
    const key = String(item[0]);
    const value = Number(item[1]);
    sums.set(key, (sums.get(key) ?? 0) + (Number.isFinite(value) && value > 0 ? value : 0));
    const at = typeof item[0] === "number" ? item[0] : Date.parse(key);
    if (Number.isFinite(at) && (first === undefined || at < first.at)) first = { at, key };
  }
  let most = 0;
  for (const sum of sums.values()) most = Math.max(most, sum);
  return first && most > 0 ? (sums.get(first.key) ?? 0) / most : 0;
}
