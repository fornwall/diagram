// Places the components around the plot, and keeps room for them: titles, cut short to the width
// beside the toolbox, the toolbox's features that a new layout would not undo, zoom sliders along
// the axes they control and visual maps below the chart.

import { asArray, isPlainObject } from "../protocol";
import { BOX_KEYS, compactLabel, has, type Insets, pixels, type Size } from "./echartsMeasure";
import { type JsonObject, optionVariants } from "./echartsOption";

/** Hides a chart title that repeats the panel header, keeping its subtitle. */
export function hideRepeatedTitle(base: JsonObject, header: string): void {
  const repeated = header.trim().toLowerCase();
  for (const title of asArray(base.title)) {
    const text = typeof title.text === "string" ? title.text.trim() : "";
    if (text && text.toLowerCase() === repeated) {
      if (typeof title.subtext === "string" && title.subtext.trim()) {
        title.text = "";
      } else {
        title.show = false;
      }
    }
  }
}

/**
 * Keeps room for the titles above or below the plot, and for the row of the toolbox, giving up
 * subtitles and then titles as the squeeze says (see {@link SQUEEZES} in echartsLayout.ts). A title
 * wider than the panel, or than the room the toolbox leaves beside it, is cut short rather than cut
 * off; one that names a grid, such as a facet's, once the grid is laid out, by
 * {@link truncateGridTitles}.
 */
export function placeTitles(base: JsonObject, reserved: Insets, size: Size, squeeze: number): void {
  const tools = toolboxSize(base);
  for (const title of asArray(base.title)) {
    if (title.show === false || !(title.text || title.subtext)) {
      continue;
    }
    // A facet's title tells its panel from the others.
    const grid = gridOf(base, title);
    if (squeeze >= 4 && grid === undefined) {
      title.show = false;
      continue;
    }
    if (squeeze >= 3 && title.text) title.subtext = "";
    const { top, bottom } = title;
    const side =
      bottom !== undefined || top === "bottom"
        ? "bottom"
        : top === undefined || top === "top" || (typeof top === "number" && top < 40)
          ? "top"
          : undefined;
    if (side) {
      const height = 10 + (title.text ? 22 : 0) + (title.subtext ? 18 : 0);
      reserved[side] = Math.max(reserved[side], height);
    }
    if (grid === undefined) {
      const besideTools =
        side === "top" && tools.width > 0 ? (tools.width + 8) * (centered(title) ? 2 : 1) : 0;
      truncateTitle(title, size.width - 16 - besideTools);
    }
  }
  // The row of the toolbox, beside a title, or else above the legend and the plot, which it would
  // cover.
  reserved.top = Math.max(reserved.top, tools.height);
}

/** Cuts the titles that name a grid short to its width, once the grid is laid out. */
export function truncateGridTitles(base: JsonObject, size: Size): void {
  for (const title of asArray(base.title)) {
    const grid = gridOf(base, title);
    if (grid) truncateTitle(title, (pixels(grid.width, size.width) ?? size.width) - 16);
  }
}

/** Keeps the bottom of the chart for a timeline, where ECharts places it unless told otherwise. */
export function placeTimeline(base: JsonObject, reserved: Insets): void {
  const timeline = asArray(base.timeline).find((t) => t.show !== false);
  if (timeline && !has(timeline, [...BOX_KEYS, "orient"])) {
    // Within the room reserved for it, which ECharts 6's padding of 15 pixels would overflow.
    timeline.padding ??= 5;
    reserved.bottom = 44;
  }
}

/** The grid that a title names by having its id, such as a facet's. */
const gridOf = (base: JsonObject, title: JsonObject): JsonObject | undefined =>
  title.id === undefined ? undefined : asArray(base.grid).find((grid) => grid.id === title.id);

/** Cuts a title and its subtitle short at a width, unless the title sets one. */
function truncateTitle(title: JsonObject, width: number): void {
  for (const key of ["textStyle", "subtextStyle"]) {
    const style = isPlainObject(title[key]) ? title[key] : {};
    style.width ??= width;
    style.overflow ??= "truncate";
    title[key] = style;
  }
}

/** Whether a title is centered, which keeps it clear of a toolbox on the right on both sides. */
const centered = (title: JsonObject) => title.left === "center" || title.left === "middle";

/**
 * The toolbox features that change the chart in ways its option does not hold, such as switching
 * between bars and lines: the next layout, as on a resize, would undo them. Each comes with what
 * to use instead, if anything.
 */
const PASSING_TOOLS: Record<string, string | undefined> = {
  magicType: "render each chart type as a chart of its own",
  dataZoom: 'zoom with a "dataZoom" component of type "inside" or "slider"',
  brush: undefined,
};

/** Tells a model which toolbox features it asked for the panel leaves out, and why. */
export function toolWarnings(option: JsonObject): string[] {
  const variants = optionVariants(option);
  const features = variants.flatMap((variant) =>
    asArray(variant.toolbox).flatMap((toolbox) =>
      isPlainObject(toolbox.feature) ? [toolbox.feature] : [],
    ),
  );
  const editable = features.some((feature) => asArray(feature.dataView)[0]?.readOnly === false)
    ? [
        "The panel shows the toolbox's data view read-only, as it lays the chart out again " +
          "whenever its size changes, which would undo an edit of the data.",
      ]
    : [];
  const left = new Set(
    features.flatMap((feature) =>
      Object.keys(feature).filter((name) => Object.hasOwn(PASSING_TOOLS, name)),
    ),
  );
  // A brush component is drawn by the toolbox's brush, which ECharts adds for it.
  if (variants.some((variant) => asArray(variant.brush).length > 0)) left.add("brush");
  if (left.size === 0) return editable;
  const names = [...left].map((name) => `"${name}"`);
  const instead = [...left].flatMap((name) => PASSING_TOOLS[name] ?? []);
  return [
    ...editable,
    `The panel leaves the toolbox feature${names.length > 1 ? "s" : ""} ${names.join(", ")} out ` +
      "of the chart, as it lays the chart out again whenever its size changes, which would undo " +
      `what ${names.length > 1 ? "they change" : "it changes"}${instead.length > 0 ? `: instead, ${instead.join(", and ")}` : ""}.`,
  ];
}

/** Leaves out the toolbox features whose changes would be undone, and lets the data view only show the data. */
export function keepLastingTools(toolbox: JsonObject): void {
  if (!isPlainObject(toolbox.feature)) return;
  const feature: JsonObject = {};
  for (const [name, settings] of Object.entries(toolbox.feature)) {
    if (Object.hasOwn(PASSING_TOOLS, name)) continue;
    feature[name] =
      name === "dataView" && isPlainObject(settings) ? { ...settings, readOnly: true } : settings;
  }
  toolbox.feature = feature;
}

/**
 * The size of the toolbox that ECharts places across the top right of the chart, as it does
 * unless told otherwise, of the features that the panel keeps: 0 by 0 without one.
 */
function toolboxSize(base: JsonObject): { width: number; height: number } {
  let width = 0;
  let height = 0;
  for (const toolbox of asArray(base.toolbox)) {
    if (toolbox.show === false || toolbox.orient === "vertical" || has(toolbox, BOX_KEYS)) continue;
    const features = Object.entries(isPlainObject(toolbox.feature) ? toolbox.feature : {}).filter(
      ([name, settings]) =>
        !Object.hasOwn(PASSING_TOOLS, name) &&
        !(isPlainObject(settings) && settings.show === false),
    );
    if (features.length === 0) continue;
    // ECharts' default icon size, gap between icons and padding, which the icons are inside of
    // from the top and right.
    const size = typeof toolbox.itemSize === "number" ? toolbox.itemSize : 15;
    const gap = typeof toolbox.itemGap === "number" ? toolbox.itemGap : 10;
    const padding = typeof toolbox.padding === "number" ? toolbox.padding : 15;
    width = Math.max(width, features.length * (size + gap) - gap + padding);
    height = Math.max(height, size + padding);
  }
  return { width, height };
}

/** The height that a visual map placed below the chart takes. */
const VISUAL_MAP_HEIGHT = 52;

/**
 * Places data zoom sliders along the axis they control, and visual maps below the chart, unless
 * the squeeze gives them up (see {@link SQUEEZES}).
 */
export function placeSliders(
  base: JsonObject,
  reserved: Insets,
  { width }: Size,
  squeeze: number,
): void {
  for (const zoom of asArray(base.dataZoom)) {
    if (
      zoom.show === false ||
      (zoom.type !== undefined && zoom.type !== "slider") ||
      has(zoom, BOX_KEYS)
    ) {
      continue;
    }
    // Without an orient, ECharts orients a slider along the axis it controls.
    const vertical =
      zoom.orient === "vertical" ||
      (zoom.orient === undefined &&
        (zoom.yAxisIndex ?? zoom.yAxisId) !== undefined &&
        (zoom.xAxisIndex ?? zoom.xAxisId) === undefined);
    if (!vertical && squeeze >= 2) {
      zoom.type = "inside";
    } else if (vertical) {
      Object.assign(zoom, { right: reserved.right + 8, width: 22 });
      reserved.right += 38;
    } else {
      Object.assign(zoom, { bottom: reserved.bottom + 8, height: 22 });
      reserved.bottom += 38;
    }
  }
  for (const visualMap of asArray(base.visualMap)) {
    if (visualMap.show === false) {
      continue;
    }
    // A continuous bar shows the values of its ends only with the handles that make it
    // calculable, as diagram_chart's heatmaps have, or with a text, which it has by default.
    const { formatter, precision } = visualMap;
    if (
      visualMap.text === undefined &&
      !visualMap.calculable &&
      (formatter === undefined || typeof formatter === "string") &&
      isContinuous(visualMap)
    ) {
      // ECharts' default bounds, and the high one first, compactly, or as the handles would write
      // them in the format or precision the option sets: to its whole digits, of 0 by default, of at
      // most 20, and in the first of each placeholder.
      const digits = Math.min(20, Math.max(0, Math.trunc(Number(precision ?? 0)) || 0));
      visualMap.text = [visualMap.max ?? 200, visualMap.min ?? 0].map((bound) => {
        if (formatter === undefined && precision === undefined) return compactLabel(bound);
        const value = Number(bound).toFixed(digits);
        return formatter === undefined
          ? value
          : formatter.replace("{value}", value).replace("{value2}", value);
      });
    }
    if (!has(visualMap, [...BOX_KEYS, "orient"])) {
      if (squeeze >= 1) {
        visualMap.show = false;
        continue;
      }
      Object.assign(visualMap, {
        orient: "horizontal",
        left: "center",
        bottom: reserved.bottom + 4,
      });
      // Within the room reserved for it, which ECharts 6's padding of 15 pixels would overflow.
      visualMap.padding ??= 5;
      // The length of a continuous bar, but the size of each piece of a piecewise one.
      if (isContinuous(visualMap)) visualMap.itemHeight ??= Math.min(200, Math.round(width * 0.4));
      reserved.bottom += VISUAL_MAP_HEIGHT;
    } else if (visualMap.orient === "horizontal") {
      reserved[visualMap.top === undefined ? "bottom" : "top"] += VISUAL_MAP_HEIGHT;
    } else {
      reserved[visualMap.right === undefined ? "left" : "right"] += 80;
    }
  }
}

/** Whether a visual map is a continuous bar rather than pieces, as ECharts decides by default. */
function isContinuous(visualMap: JsonObject): boolean {
  if (visualMap.type !== undefined) {
    return visualMap.type === "continuous";
  }
  const pieces = visualMap.pieces
    ? Array.isArray(visualMap.pieces) && visualMap.pieces.length > 0
    : Number(visualMap.splitNumber) > 0;
  return !visualMap.categories && (!pieces || Boolean(visualMap.calculable));
}
