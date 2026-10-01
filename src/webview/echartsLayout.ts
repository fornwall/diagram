// Adapts an ECharts option written by a model to the panel: responsive layout, selection styles
// and defaults. Only fills in what the option leaves unset, so explicit choices always win.

import { type ThemeColors, toCss } from "./colors";
import { asArray, baseOption, isCartesian, isObject, type JsonObject } from "./echartsOption";

const BOX_KEYS = ["left", "right", "top", "bottom", "width", "height"];
const has = (object: JsonObject, keys: string[]) => keys.some((key) => object[key] !== undefined);

/** Space in pixels taken from each side of the chart by the title, legend, sliders, … */
type Insets = Record<"top" | "bottom" | "left" | "right", number>;

/** The text of a category or legend entry, which may be a plain value or `{value}`/`{name}`. */
function entryText(entry: unknown): string {
  if (isObject(entry)) {
    return String(entry.value ?? entry.name ?? "");
  }
  return entry === null || entry === undefined ? "" : String(entry);
}

function seriesName(series: JsonObject): string | undefined {
  return typeof series.name === "string" && series.name ? series.name : undefined;
}

function hasNegativeValues(data: unknown): boolean {
  if (!Array.isArray(data)) {
    return false;
  }
  return data.some((item) => {
    const value = isObject(item) ? item.value : item;
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
  const fontSize = Math.max(11, colors.fontSize - 1);
  const charWidth = fontSize * 0.6;

  if (context.reducedMotion) {
    option.animation = false;
  }
  const base = baseOption(option);
  // Options with media queries handle their own responsiveness.
  const responsive = option.media === undefined;

  const series = asArray(base.series);
  if (isObject(base.series)) {
    base.series = series;
  }
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
    if (title.show !== false && atTop) {
      const lines = (title.text ? 22 : 0) + (title.subtext ? 18 : 0);
      if (lines > 0) {
        titleHeight = Math.max(titleHeight, lines + 10);
      }
    }
  }

  // Legend: always there for several named series; the identity of a series is never only color.
  const pies = series.filter((s) => s.type === "pie");
  let legends = asArray(base.legend);
  if (legends.length === 0 && base.legend === undefined && responsive) {
    const named = series.length >= 2 && series.every((s) => seriesName(s) !== undefined);
    // A small pie has no room for labels, so its slices are named by a legend instead.
    const smallPie =
      pies.length === 1 && !isObject(pies[0]?.label) && (width < 420 || height - titleHeight < 260);
    if (named || smallPie) {
      base.legend = {};
      legends = asArray(base.legend);
    }
  }
  const legend = legends.find((l) => l.show !== false);
  let legendSide: "top" | "bottom" | "left" | "right" | undefined;
  let legendWidth = 0;
  if (legend) {
    const names = Array.isArray(legend.data)
      ? legend.data.map(entryText)
      : pies.length > 0 || series.some((s) => s.type === "funnel")
        ? series.flatMap((s) => (Array.isArray(s.data) ? s.data.map(entryText) : []))
        : series.map((s) => seriesName(s) ?? "");
    const longest = Math.max(4, ...names.map((name) => name.length));
    legendWidth = Math.round(Math.min(width * 0.32, longest * charWidth + 12 + 5 + 24));
    legend.type ??= "scroll";
    if (!has(legend, [...BOX_KEYS, "orient"]) && responsive) {
      // Beside a pie or other non-grid chart when there is room, as it then uses the height.
      legendSide = cartesian ? (compact ? "bottom" : "top") : width >= 560 ? "right" : "bottom";
      if (legendSide === "right") {
        Object.assign(legend, { orient: "vertical", right: 8, top: "middle" });
      } else if (legendSide === "top") {
        Object.assign(legend, { top: titleHeight > 0 ? titleHeight : 6, left: "center" });
      } else {
        Object.assign(legend, { bottom: 6, left: "center" });
      }
    } else if (legend.bottom !== undefined) {
      legendSide = "bottom";
    } else if (legend.orient === "vertical") {
      legendSide = legend.left !== undefined && legend.right === undefined ? "left" : "right";
    } else {
      legendSide = "top";
    }
  }

  const reserved: Insets = {
    top: titleHeight + (legendSide === "top" ? 30 : 0),
    bottom: legendSide === "bottom" ? 32 : 0,
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
  const plotWidth = Math.max(80, width - reserved.left - reserved.right - 80);

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
    for (const axis of xAxes) {
      const labels = Array.isArray(axis.data) ? axis.data.map(entryText) : [];
      const label = isObject(axis.axisLabel) ? axis.axisLabel : {};
      if (labels.length === 0 || label.rotate !== undefined || label.interval !== undefined) {
        continue;
      }
      const labelWidth = Math.max(...labels.map((text) => text.length)) * charWidth;
      const slot = plotWidth / labels.length;
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
      const labels = Array.isArray(axis.data) ? axis.data.map(entryText) : [];
      const label = isObject(axis.axisLabel) ? axis.axisLabel : {};
      if (labels.length === 0 || label.width !== undefined) {
        continue;
      }
      const labelWidth = Math.max(...labels.map((text) => text.length)) * charWidth;
      const maxWidth = Math.round(width * (compact ? 0.3 : 0.22));
      if (labelWidth > maxWidth) {
        axis.axisLabel = { width: maxWidth, overflow: "truncate", ...label };
      }
    }
  }

  const background = toCss(colors.background);
  for (const each of series) {
    if (each.type === "bar") {
      const itemStyle = isObject(each.itemStyle) ? each.itemStyle : {};
      const axis = yAxes[typeof each.yAxisIndex === "number" ? each.yAxisIndex : 0];
      const horizontal = axis?.type === "category";
      if (each.stack !== undefined) {
        // A thin gap in the background color separates stacked segments.
        if (itemStyle.borderColor === undefined && itemStyle.borderWidth === undefined) {
          Object.assign(itemStyle, { borderColor: background, borderWidth: 1 });
        }
      } else if (itemStyle.borderRadius === undefined && !hasNegativeValues(each.data)) {
        // Rounded data ends, square at the baseline.
        itemStyle.borderRadius = horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0];
      }
      each.itemStyle = itemStyle;
    }
    if (each.type === "sankey" && each.color === undefined) {
      // ECharts colors sankey nodes by value along the palette, mixing hues; give each node its
      // own categorical color instead.
      const nodes = Array.isArray(each.data)
        ? each.data
        : Array.isArray(each.nodes)
          ? each.nodes
          : [];
      nodes.forEach((node: unknown, index) => {
        if (isObject(node)) {
          const itemStyle = isObject(node.itemStyle) ? node.itemStyle : {};
          itemStyle.color ??= toCss(colors.palette[index % colors.palette.length] ?? colors.blue);
          node.itemStyle = itemStyle;
        }
      });
    }
    if (each.type === "line" && isObject(each.areaStyle)) {
      const area = each.areaStyle;
      if (area.opacity === undefined && area.color === undefined) {
        // A wash rather than a block, unless stacked areas need to read as bands.
        area.opacity = each.stack !== undefined ? 0.55 : 0.15;
      }
    }
  }

  if (responsive) {
    layOutPie(pies, legend !== undefined, reserved, width, height);
    layOutBoxSeries(series, reserved, width);
    layOutRadar(base, reserved, width, height);
  }

  // Tooltips by default: an axis crosshair for line and bar charts, per item otherwise.
  if (base.tooltip === undefined) {
    const axisTrigger =
      cartesian && series.some((s) => s.type === "line" || s.type === "bar") && xAxes.length > 0;
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
  pies: JsonObject[],
  hasLegend: boolean,
  reserved: Insets,
  width: number,
  height: number,
): void {
  const pie = pies[0];
  if (pies.length !== 1 || !pie || has(pie, [...BOX_KEYS, "center"])) {
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
  const label = isObject(pie.label) ? pie.label : undefined;
  let outsideLabels =
    label?.show !== false &&
    !["inside", "inner", "center"].includes(String(label?.position ?? "outside"));
  if (
    outsideLabels &&
    label?.show === undefined &&
    label?.position === undefined &&
    hasLegend &&
    (boxWidth < 380 || boxHeight < 220)
  ) {
    // Too small for labels around the pie: the legend and tooltip name the slices.
    pie.label = { ...label, show: false };
    pie.labelLine = { ...(isObject(pie.labelLine) ? pie.labelLine : {}), show: false };
    outsideLabels = false;
  }
  if (pie.radius === undefined) {
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

function layOutBoxSeries(series: JsonObject[], reserved: Insets, width: number): void {
  for (const each of series) {
    if (has(each, BOX_KEYS)) {
      continue;
    }
    switch (each.type) {
      case "funnel":
        Object.assign(each, {
          top: reserved.top + 12,
          bottom: reserved.bottom + 12,
          left: reserved.left + Math.round(width * 0.1),
          right: reserved.right + Math.round(width * 0.1),
        });
        break;
      case "sankey":
        Object.assign(each, {
          top: reserved.top + 12,
          bottom: reserved.bottom + 12,
          left: reserved.left + 12,
          // Room for the labels right of the last column of nodes.
          right: reserved.right + Math.round(Math.min(160, width * 0.18)),
        });
        break;
      case "tree":
      case "treemap":
      case "graph":
        if (each.type === "graph" && (each.layout === undefined || each.layout === "none")) {
          break;
        }
        Object.assign(each, {
          top: reserved.top + 12,
          bottom: reserved.bottom + (each.type === "treemap" ? 36 : 12),
          left: reserved.left + 12,
          right: reserved.right + 12,
        });
        break;
    }
  }
}

function layOutRadar(base: JsonObject, reserved: Insets, width: number, height: number): void {
  const radars = asArray(base.radar);
  const radar = radars[0];
  if (radars.length !== 1 || !radar || radar.center !== undefined || radar.radius !== undefined) {
    return;
  }
  const boxWidth = width - reserved.left - reserved.right;
  const boxHeight = height - reserved.top - reserved.bottom;
  radar.center = [reserved.left + boxWidth / 2, reserved.top + boxHeight / 2];
  // Leave room around the radar for the indicator names.
  radar.radius = Math.max(40, Math.min(boxWidth - 140, boxHeight - 56) / 2);
}

/**
 * Carries what the user changed in the shown chart over to a new layout of its option: the
 * legend selection and scroll position, and the zoom ranges.
 */
export function keepUserState(option: JsonObject, shown: JsonObject): void {
  const base = baseOption(option);
  const shownLegends = asArray(shown.legend);
  asArray(base.legend).forEach((legend, index) => {
    const current = shownLegends[index];
    if (current) {
      legend.selected = current.selected;
      legend.scrollDataIndex = current.scrollDataIndex;
    }
  });
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
