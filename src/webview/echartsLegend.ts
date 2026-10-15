// Adds a legend where a chart needs one, and places it beside the plot: above or below a plot
// along axes, wrapped into a few rows, and beside one of another kind where there is room.

import { asArray } from "../protocol";
import {
  BOX_KEYS,
  entryText,
  has,
  type Insets,
  MAX_READ_CATEGORIES,
  type Side,
  type Size,
  styleOf,
  widestText,
} from "./echartsMeasure";
import type { JsonObject } from "./echartsOption";
import { hidePieLabels, labelsSet, pieLabelsFit } from "./echartsPie";
import { LEGEND_ITEM_GAP, LEGEND_ITEM_WIDTH } from "./echartsTheme";

function seriesName(series: JsonObject): string | undefined {
  return typeof series.name === "string" && series.name ? series.name : undefined;
}

/**
 * Adds a legend where the chart needs one, and places it beside the plot: above or below one
 * along axes, and beside one of another kind when there is room.
 */
export function placeLegend(
  base: JsonObject,
  series: JsonObject[],
  alongAxes: boolean,
  reserved: Insets,
  size: Size,
): void {
  const { width, height, compact } = size;
  const pies = series.filter((s) => s.type === "pie");
  if (base.legend === undefined) {
    // Several named series: the identity of a series is never only color.
    const named = series.length >= 2 && series.every((s) => seriesName(s) !== undefined);
    // A small pie has no room for labels, so its slices are named by a legend instead, unless
    // the option sets how to label them.
    const [pie] = pies;
    const smallPie =
      pie !== undefined &&
      pies.length === 1 &&
      !labelsSet(pie) &&
      (height - reserved.top < 260 ||
        !pieLabelsFit(pie, width - 16, height - reserved.top - 16, size));
    if (named || smallPie) {
      base.legend = {};
    }
    // Only by the legend, as the room it takes below the pie would make them seem to fit beside a
    // smaller one.
    if (smallPie) hidePieLabels(pie);
  }
  const legend = asArray(base.legend).find((l) => l.show !== false);
  if (!legend) {
    return;
  }
  let side: Side;
  const placed = has(legend, BOX_KEYS);
  const { width: textWidth } = size.font(styleOf(legend.textStyle), size.themed);
  if (
    legend.orient === "vertical" ||
    (legend.orient === undefined && !placed && !alongAxes && width >= 560)
  ) {
    // Beside a pie or other non-grid chart when there is room, as it then uses the height, and
    // beside any chart when it goes down, on the right unless told the side, where ECharts would
    // center it.
    if (!placed) Object.assign(legend, { orient: "vertical", right: 8, top: "middle" });
    else if (!has(legend, ["left", "right"])) legend.right = 8;
    side = legend.right === undefined ? "left" : "right";
  } else if (!placed) {
    side = alongAxes && !compact ? "top" : "bottom";
    Object.assign(
      legend,
      side === "top"
        ? { top: reserved.top > 0 ? reserved.top : 6, left: "center" }
        : { bottom: reserved.bottom + 6, left: "center" },
    );
  } else {
    // ECharts places a horizontal legend at the bottom unless told otherwise.
    side = legend.top !== undefined && legend.bottom === undefined ? "top" : "bottom";
  }
  if (side === "top" || side === "bottom") {
    // A legend that the panel places wraps into a few rows rather than page through its entries,
    // unless the option says what kind of legend it is: as many as take a fifth of the height.
    const most = Math.max(2, Math.floor((height * 0.2) / LEGEND_ROW));
    const rows =
      !placed && legend.type === undefined
        ? legendRows(legend, series, width - 20, textWidth, most)
        : 1;
    if (rows > 1) legend.type = "plain";
    reserved[side] += (side === "top" ? 30 : 32) + (rows - 1) * LEGEND_ROW;
    return;
  }
  // The icon, the gap after it and the padding around the legend.
  const extra = 12 + 5 + 24;
  const enough = width * 0.32 - extra;
  let widest = 0;
  if (Array.isArray(legend.data)) {
    widest = widestText(legend.data, textWidth, enough);
  } else if (pies.length > 0 || series.some((s) => s.type === "funnel")) {
    // Read each series in place rather than allocating an array of every slice on each resize.
    for (const each of series) {
      widest = Math.max(widest, widestText(each.data, textWidth, enough));
      if (widest > enough) break;
    }
  } else {
    widest = widestText(seriesEntries(series, MAX_READ_CATEGORIES), textWidth, enough);
  }
  // At least as wide as a few characters.
  const legendWidth = Math.min(width * 0.32, Math.max(textWidth("0000"), widest) + extra);
  reserved[side] += Math.round(legendWidth) + 16;
}

/**
 * The entries of a legend of series other than pies and funnels: their names, but the names of
 * the layers of a theme river, in the third field of its data, as ECharts names them: as many as
 * there are, or else a few more than the most that the layout takes.
 */
function seriesEntries(series: JsonObject[], most: number): string[] {
  const entries = new Set<string>();
  for (const each of series) {
    if (each.type !== "themeRiver") {
      const name = seriesName(each);
      if (name !== undefined) entries.add(name);
    } else if (Array.isArray(each.data)) {
      for (const item of each.data) {
        if (Array.isArray(item) && item[2] != null) entries.add(String(item[2]));
        if (entries.size > most) break;
      }
    }
    if (entries.size > most) break;
  }
  return [...entries];
}

/** The height of a row of a legend's entries. */
const LEGEND_ROW = 24;

/** The entries of a legend beyond which it pages through them, however short. */
const MAX_WRAPPED_ENTRIES = 40;

/**
 * The rows that a horizontal legend wraps its entries into in a width, if it takes several and
 * no more than the most there is room for; else 1, for a legend that pages through them instead.
 * The entries name the slices of pies and funnels, or else the series.
 */
function legendRows(
  legend: JsonObject,
  series: JsonObject[],
  width: number,
  textWidth: (text: string) => number,
  most: number,
): number {
  const sliced = series.filter((each) => each.type === "pie" || each.type === "funnel");
  const entries: unknown[] = Array.isArray(legend.data)
    ? legend.data
    : sliced.length > 0
      ? sliced.flatMap((each) =>
          Array.isArray(each.data) ? each.data.slice(0, MAX_WRAPPED_ENTRIES + 1) : [],
        )
      : seriesEntries(series, MAX_WRAPPED_ENTRIES);
  if (entries.length > MAX_WRAPPED_ENTRIES) return 1;
  // As far apart as the theme's, or the option's, entries.
  const gap = typeof legend.itemGap === "number" ? legend.itemGap : LEGEND_ITEM_GAP;
  const icon = typeof legend.itemWidth === "number" ? legend.itemWidth : LEGEND_ITEM_WIDTH;
  let rows = 1;
  let used = 0;
  for (const entry of entries) {
    // The icon and the gap after it, and the gap before the entry after another.
    const size = icon + 5 + textWidth(entryText(entry));
    if (used > 0 && used + gap + size > width) {
      rows++;
      used = size;
    } else {
      used += (used > 0 ? gap : 0) + size;
    }
  }
  return rows <= most ? rows : 1;
}
