// Adapts an ECharts option written by a model to the panel: responsive layout, selection styles
// and defaults. Only fills in what the option leaves unset, so explicit choices always win.

import { isPlainObject } from "../protocol";
import { type ThemeColors, toCss } from "./colors";
import { asArray, baseOption, isCartesian, type JsonObject } from "./echartsOption";

const BOX_KEYS = ["left", "right", "top", "bottom", "width", "height"];
const has = (object: JsonObject, keys: string[]) => keys.some((key) => object[key] !== undefined);

/** Space in pixels taken from each side of the chart by the title, legend, sliders, … */
type Insets = Record<"top" | "bottom" | "left" | "right", number>;

/** The length of the longest category or legend entry; each is a value or `{value}`/`{name}`. */
function longestText(entries: unknown): number {
  if (!Array.isArray(entries)) {
    return 0;
  }
  const text = (entry: unknown) =>
    String((isPlainObject(entry) ? (entry.value ?? entry.name) : entry) ?? "");
  // Not Math.max(...entries), which overflows the stack with very many entries.
  return entries.reduce((longest: number, entry) => Math.max(longest, text(entry).length), 0);
}

function seriesName(series: JsonObject): string | undefined {
  return typeof series.name === "string" && series.name ? series.name : undefined;
}

function hasNegativeValues(data: unknown): boolean {
  if (!Array.isArray(data)) {
    return false;
  }
  return data.some((item) => {
    const value = isPlainObject(item) ? item.value : item;
    return Array.isArray(value)
      ? value.some((v) => typeof v === "number" && v < 0)
      : typeof value === "number" && value < 0;
  });
}

export interface LayoutContext {
  width: number;
  height: number;
  /** The title in the panel header; an identical chart title is hidden. */
  title: string;
  colors: ThemeColors;
  reducedMotion: boolean;
}

export function layoutOption(source: JsonObject, context: LayoutContext): JsonObject {
  const option = structuredClone(source);
  const { colors } = context;
  // Before the panel is laid out, assume a typical editor size; a resize corrects it.
  const width = context.width > 0 ? context.width : 800;
  const height = context.height > 0 ? context.height : 500;
  const compact = width < 560 || height < 340;
  const charWidth = colors.fontSize * 0.6;

  if (context.reducedMotion) {
    option.animation = false;
  }
  const base = baseOption(option);
  // Options with media queries handle their own responsiveness.
  const responsive = option.media === undefined;

  const series = asArray(base.series);
  const cartesian = series.some(isCartesian);

  // Titles: hide one that repeats the panel header.
  const header = context.title.trim().toLowerCase();
  let titleHeight = 0;
  for (const title of asArray(base.title)) {
    const text = typeof title.text === "string" ? title.text.trim() : "";
    if (text && text.toLowerCase() === header) {
      if (typeof title.subtext === "string" && title.subtext.trim()) {
        title.text = "";
      } else {
        title.show = false;
      }
    }
    const atTop = title.bottom === undefined && (typeof title.top !== "number" || title.top < 40);
    if (title.show !== false && atTop && (title.text || title.subtext)) {
      titleHeight = Math.max(titleHeight, 10 + (title.text ? 22 : 0) + (title.subtext ? 18 : 0));
    }
  }

  // A timeline takes the bottom of the chart, where ECharts places it unless told otherwise.
  const timeline = asArray(base.timeline).find((t) => t.show !== false);
  const timelineHeight = timeline && !has(timeline, [...BOX_KEYS, "orient"]) && responsive ? 44 : 0;

  // Legend: always there for several named series; the identity of a series is never only color.
  const pies = series.filter((s) => s.type === "pie");
  const pie = pies.length === 1 ? pies[0] : undefined;
  if (base.legend === undefined && responsive) {
    const named = series.length >= 2 && series.every((s) => seriesName(s) !== undefined);
    // A small pie has no room for labels, so its slices are named by a legend instead.
    const smallPie =
      pie !== undefined && !isPlainObject(pie.label) && (width < 420 || height - titleHeight < 260);
    if (named || smallPie) {
      base.legend = {};
    }
  }
  const legend = asArray(base.legend).find((l) => l.show !== false);
  let legendSide: "top" | "bottom" | "left" | "right" | undefined;
  let legendWidth = 0;
  if (legend) {
    const names = Array.isArray(legend.data)
      ? legend.data
      : pies.length > 0 || series.some((s) => s.type === "funnel")
        ? series.flatMap((s) => (Array.isArray(s.data) ? s.data : []))
        : series.map(seriesName);
    // The icon, the gap after it and the padding around the legend.
    const extra = 12 + 5 + 24;
    legendWidth = Math.round(
      Math.min(width * 0.32, Math.max(4, longestText(names)) * charWidth + extra),
    );
    legend.type ??= "scroll";
    if (!has(legend, [...BOX_KEYS, "orient"]) && responsive) {
      // Beside a pie or other non-grid chart when there is room, as it then uses the height.
      legendSide = cartesian ? (compact ? "bottom" : "top") : width >= 560 ? "right" : "bottom";
      if (legendSide === "right") {
        Object.assign(legend, { orient: "vertical", right: 8, top: "middle" });
      } else if (legendSide === "top") {
        Object.assign(legend, { top: titleHeight > 0 ? titleHeight : 6, left: "center" });
      } else {
        Object.assign(legend, { bottom: timelineHeight + 6, left: "center" });
      }
    } else if (legend.orient === "vertical") {
      legendSide = legend.left !== undefined && legend.right === undefined ? "left" : "right";
    } else {
      // ECharts places a horizontal legend at the bottom unless told otherwise.
      legendSide = legend.top !== undefined && legend.bottom === undefined ? "top" : "bottom";
    }
  }

  const reserved: Insets = {
    top: titleHeight + (legendSide === "top" ? 30 : 0),
    bottom: timelineHeight + (legendSide === "bottom" ? 32 : 0),
    left: legendSide === "left" ? legendWidth + 16 : 0,
    right: legendSide === "right" ? legendWidth + 16 : 0,
  };

  if (responsive) {
    for (const zoom of asArray(base.dataZoom)) {
      if ((zoom.type !== undefined && zoom.type !== "slider") || has(zoom, BOX_KEYS)) {
        continue;
      }
      // Without an orient, ECharts orients a slider along the axis it controls.
      const vertical =
        zoom.orient === "vertical" ||
        (zoom.orient === undefined &&
          (zoom.yAxisIndex ?? zoom.yAxisId) !== undefined &&
          (zoom.xAxisIndex ?? zoom.xAxisId) === undefined);
      if (vertical) {
        Object.assign(zoom, { right: reserved.right + 8, width: 22 });
        reserved.right += 38;
      } else {
        Object.assign(zoom, { bottom: reserved.bottom + 8, height: 22 });
        reserved.bottom += 38;
      }
    }
    // Visual maps: a horizontal bar below the chart, unless placed explicitly.
    for (const visualMap of asArray(base.visualMap)) {
      if (visualMap.show === false) {
        continue;
      }
      if (!has(visualMap, [...BOX_KEYS, "orient"])) {
        Object.assign(visualMap, {
          orient: "horizontal",
          left: "center",
          bottom: reserved.bottom + 4,
          itemHeight: Math.min(200, Math.round(width * 0.4)),
        });
        reserved.bottom += 52;
      } else if (visualMap.orient === "horizontal") {
        if (visualMap.top === undefined) {
          reserved.bottom += 52;
        } else {
          reserved.top += 52;
        }
      } else if (visualMap.right !== undefined) {
        reserved.right += 80;
      } else {
        reserved.left += 80;
      }
    }
  }

  const xAxes = asArray(base.xAxis);
  const yAxes = asArray(base.yAxis);

  if (cartesian && responsive) {
    const grids = asArray(base.grid);
    if (grids.length <= 1) {
      const grid = grids[0] ?? {};
      if (!has(grid, [...BOX_KEYS, "outerBounds", "outerBoundsMode"])) {
        Object.assign(grid, {
          left: reserved.left + 8,
          right: reserved.right + 20,
          top: reserved.top + 14,
          bottom: reserved.bottom + 8,
        });
        // The ECharts 6 way to keep axis labels and names inside the grid rectangle.
        if (grid.containLabel === undefined) {
          Object.assign(grid, { outerBoundsMode: "same", outerBoundsContain: "all" });
        }
      }
      if (base.grid === undefined) {
        base.grid = grid;
      }
    }

    // Category labels: rotate them when they would overlap, and truncate very long ones.
    const plotWidth = Math.max(80, width - reserved.left - reserved.right - 80);
    for (const axis of xAxes) {
      const label = isPlainObject(axis.axisLabel) ? axis.axisLabel : {};
      const count = Array.isArray(axis.data) ? axis.data.length : 0;
      if (count === 0 || label.rotate !== undefined || label.interval !== undefined) {
        continue;
      }
      const labelWidth = longestText(axis.data) * charWidth;
      const slot = plotWidth / count;
      if (labelWidth > slot - 8) {
        const rotate = labelWidth > slot * 3 ? 45 : 30;
        const maxWidth = Math.max(60, Math.round(height * 0.22));
        axis.axisLabel = {
          rotate,
          hideOverlap: true,
          ...(labelWidth > maxWidth ? { width: maxWidth, overflow: "truncate" } : {}),
          ...label,
        };
      }
    }
    for (const axis of yAxes) {
      const label = isPlainObject(axis.axisLabel) ? axis.axisLabel : {};
      const maxWidth = Math.round(width * (compact ? 0.3 : 0.22));
      if (label.width === undefined && longestText(axis.data) * charWidth > maxWidth) {
        axis.axisLabel = { width: maxWidth, overflow: "truncate", ...label };
      }
    }
  }

  const background = toCss(colors.background);
  for (const each of series) {
    if (each.type === "bar") {
      const itemStyle = isPlainObject(each.itemStyle) ? each.itemStyle : {};
      if (each.stack !== undefined) {
        // A thin gap in the background color separates stacked segments.
        if (itemStyle.borderColor === undefined && itemStyle.borderWidth === undefined) {
          Object.assign(itemStyle, { borderColor: background, borderWidth: 1 });
        }
      } else if (itemStyle.borderRadius === undefined && !hasNegativeValues(each.data)) {
        // Rounded data ends, square at the baseline.
        const axis = yAxes[typeof each.yAxisIndex === "number" ? each.yAxisIndex : 0];
        const horizontal = axis?.type === "category";
        itemStyle.borderRadius = horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0];
      }
      each.itemStyle = itemStyle;
    }
    if (each.type === "sankey" && each.color === undefined) {
      // ECharts colors sankey nodes by value along the palette, mixing hues; give each node its
      // own categorical color instead.
      const nodes: unknown = each.data ?? each.nodes;
      (Array.isArray(nodes) ? nodes : []).forEach((node: unknown, index) => {
        if (isPlainObject(node)) {
          const itemStyle = isPlainObject(node.itemStyle) ? node.itemStyle : {};
          itemStyle.color ??= toCss(colors.palette[index % colors.palette.length] ?? colors.blue);
          node.itemStyle = itemStyle;
        }
      });
    }
    if (each.type === "line" && isPlainObject(each.areaStyle)) {
      const area = each.areaStyle;
      if (area.opacity === undefined && area.color === undefined) {
        // A wash rather than a block, unless stacked areas need to read as bands.
        area.opacity = each.stack !== undefined ? 0.55 : 0.15;
      }
    }
  }

  if (responsive) {
    layOutPie(pie, legend !== undefined, reserved, width, height);
    layOutBoxSeries(series, reserved, width);
    layOutRadar(base, reserved, width, height);
  }

  // Tooltips by default: an axis crosshair for line and bar charts, per item otherwise.
  if (base.tooltip === undefined) {
    const axisTrigger = cartesian && series.some((s) => s.type === "line" || s.type === "bar");
    const onlyBars = series.every((s) => s.type === "bar");
    base.tooltip = axisTrigger
      ? { trigger: "axis", axisPointer: { type: onlyBars ? "shadow" : "line" } }
      : { trigger: "item" };
  }
  for (const tooltip of asArray(base.tooltip)) {
    tooltip.confine ??= true;
  }

  // Selection: let every series show selected items, in the VS Code focus color.
  const focus = toCss(colors.focus);
  const glow = toCss({ ...colors.focus, a: 0.7 });
  for (const each of series) {
    each.selectedMode ??= "multiple";
    if (each.select === undefined) {
      each.select = {
        itemStyle: { borderColor: focus, borderWidth: 2.5, shadowBlur: 14, shadowColor: glow },
        label: { fontWeight: "bold" },
      };
    }
  }

  // Describes the chart to screen readers.
  base.aria ??= { enabled: true };
  return option;
}

function layOutPie(
  pie: JsonObject | undefined,
  hasLegend: boolean,
  reserved: Insets,
  width: number,
  height: number,
): void {
  if (!pie || has(pie, [...BOX_KEYS, "center"])) {
    return;
  }
  // ECharts 6 lays out pies in a box; the radius percentage is relative to the box.
  Object.assign(pie, {
    left: reserved.left + 8,
    right: reserved.right + 8,
    top: reserved.top + 8,
    bottom: reserved.bottom + 8,
  });
  const boxWidth = width - reserved.left - reserved.right - 16;
  const boxHeight = height - reserved.top - reserved.bottom - 16;
  let label = isPlainObject(pie.label) ? pie.label : {};
  const small = boxWidth < 380 || boxHeight < 220;
  if (label.show === undefined && label.position === undefined && hasLegend && small) {
    // Too small for labels around the pie: the legend and tooltip name the slices.
    label = pie.label = { ...label, show: false };
    pie.labelLine = { ...(isPlainObject(pie.labelLine) ? pie.labelLine : {}), show: false };
  }
  if (pie.radius === undefined) {
    const outsideLabels =
      label.show !== false &&
      !["inside", "inner", "center"].includes(String(label.position ?? "outside"));
    // In a wide box, the labels fit beside the pie, which can then take more of the height.
    const ratio = boxWidth / Math.max(1, boxHeight);
    const radius = !outsideLabels
      ? 90
      : ratio >= 1.6
        ? 76
        : ratio >= 1.2
          ? 68
          : ratio >= 0.9
            ? 58
            : 50;
    pie.radius = `${radius}%`;
  }
}

/** Keeps series that ECharts lays out in a box clear of the title, legend and other components. */
function layOutBoxSeries(series: JsonObject[], reserved: Insets, width: number): void {
  for (const each of series) {
    const type = String(each.type);
    const placed = has(each, BOX_KEYS) || (type === "graph" && (each.layout ?? "none") === "none");
    if (placed || !["funnel", "sankey", "tree", "treemap", "graph"].includes(type)) {
      continue;
    }
    const side = type === "funnel" ? Math.round(width * 0.1) : 12;
    Object.assign(each, {
      top: reserved.top + 12,
      // Room for the breadcrumb below a treemap.
      bottom: reserved.bottom + (type === "treemap" ? 36 : 12),
      left: reserved.left + side,
      // Room for the labels right of the last column of sankey nodes.
      right: reserved.right + (type === "sankey" ? Math.round(Math.min(160, width * 0.18)) : side),
    });
  }
}

function layOutRadar(base: JsonObject, reserved: Insets, width: number, height: number): void {
  const radars = asArray(base.radar);
  const radar = radars.length === 1 ? radars[0] : undefined;
  if (!radar || radar.center !== undefined || radar.radius !== undefined) {
    return;
  }
  const boxWidth = width - reserved.left - reserved.right;
  const boxHeight = height - reserved.top - reserved.bottom;
  radar.center = [reserved.left + boxWidth / 2, reserved.top + boxHeight / 2];
  // Leave room around the radar for the indicator names.
  radar.radius = Math.max(40, Math.min(boxWidth - 140, boxHeight - 56) / 2);
}

/** What the user can change in a shown chart, by component: besides the zoom ranges. */
const USER_STATE: Record<string, string[]> = {
  legend: ["selected", "scrollDataIndex"],
  timeline: ["currentIndex"],
  visualMap: ["range", "selected"],
};

/**
 * Carries what the user changed in the shown chart over to a new layout of its option: the
 * legend selection and scroll position, the timeline position, the visual map ranges and the zoom
 * ranges.
 */
export function keepUserState(option: JsonObject, shown: JsonObject): void {
  const base = baseOption(option);
  for (const [component, keys] of Object.entries(USER_STATE)) {
    const shownComponents = asArray(shown[component]);
    asArray(base[component]).forEach((each, index) => {
      const current = shownComponents[index];
      for (const key of keys) {
        if (current?.[key] !== undefined) {
          each[key] = current[key];
        }
      }
    });
  }
  const shownZooms = asArray(shown.dataZoom);
  asArray(base.dataZoom).forEach((zoom, index) => {
    const current = shownZooms[index];
    if (typeof current?.start === "number" && typeof current.end === "number") {
      Object.assign(zoom, { start: current.start, end: current.end });
      delete zoom.startValue;
      delete zoom.endValue;
    }
  });
}
