// Fit charts to the panel: reserve space for surrounding controls, lay out the plot, then apply
// display and interaction defaults. Hide optional controls and titles when space is too limited.

import { asArray, isPlainObject } from "../protocol";
import {
  hideRepeatedTitle,
  keepLastingTools,
  placeSliders,
  placeTimeline,
  placeTitles,
  truncateGridTitles,
} from "./echartsAround";
import { labelTreeNodes, layOutBoxSeries } from "./echartsBoxSeries";
import { cloneOption } from "./echartsClone";
import {
  layOutCalendar,
  layOutParallel,
  layOutRadar,
  layOutSingleAxis,
  onSingleAxis,
} from "./echartsCoordinates";
import {
  addInteraction,
  compactAxisLabels,
  drawLargeSeries,
  formatTemplateValues,
  nameTreemapRoot,
  showAxisLines,
  styleSeries,
} from "./echartsDefaults";
import { layOutGrid } from "./echartsGrid";
import { placeLegend } from "./echartsLegend";
import { type Insets, type LayoutContext, layoutSize, type Size, styleOf } from "./echartsMeasure";
import {
  allSeries,
  baseOption,
  isCartesian,
  type JsonObject,
  optionVariants,
  seriesOf,
  seriesPlaces,
} from "./echartsOption";
import { layOutPie } from "./echartsPie";
import { colorLabelsOnItems } from "./echartsTheme";

/**
 * Copy initial-step and default-media series into the base so layout can place and style them.
 * Leave later-step series alone. Also leave series with explicit ids in their patches: adopting
 * them would change how subsequent steps merge. Include initial titles to reserve their space.
 */
function adoptStartingStep(option: JsonObject, base: JsonObject): void {
  const steps: unknown[] = Array.isArray(option.options) ? option.options : [];
  const step = steps[Number(asArray(base.timeline)[0]?.currentIndex ?? 0)];
  const media = asArray(option.media).find((each) => each.query === undefined)?.option;
  const series = [...seriesOf(base)];
  const titles = asArray(base.title);
  let titled = false;
  for (const patch of [step, media]) {
    if (!isPlainObject(patch)) continue;
    const own = seriesOf(patch);
    seriesPlaces(series, own).forEach((place, index) => {
      const each = own[index];
      if (place === series.length && isPlainObject(each) && each.id == null) {
        series.push({ ...each });
      }
    });
    asArray(patch.title).forEach((title, index) => {
      titles[index] = { ...titles[index], ...title };
      titled = true;
    });
  }
  if (series.length > seriesOf(base).length) base.series = series;
  if (titled) base.title = titles;
}

/**
 * If the plot is too short, progressively hide the visual map, zoom slider, subtitle and title.
 * Tooltips, wheel zoom and the panel header retain their functions; keep the legend visible.
 */
const SQUEEZES = 4;

export function layoutOption(source: JsonObject, context: LayoutContext): JsonObject {
  for (let squeeze = 0; ; squeeze++) {
    const option = layOutAround(source, context, squeeze);
    if (option) return option;
  }
}

/** Return a laid-out copy, or undefined when another squeeze could make the plot tall enough. */
function layOutAround(
  source: JsonObject,
  context: LayoutContext,
  squeeze: number,
): JsonObject | undefined {
  const option = cloneOption(source);
  const base = baseOption(option);
  adoptStartingStep(option, base);
  const series = asArray(base.series);
  const cartesian = series.some(isCartesian);
  if (context.reducedMotion) {
    disableAnimation(option);
  }
  hideRepeatedTitle(base, context.title);
  // Options with media queries handle their own responsiveness.
  if (option.media === undefined) {
    const size = layoutSize(context, base);
    const room = layOut(base, series, cartesian, size, squeeze, steppedSeries(option, base));
    if (room < MIN_PLOT_HEIGHT && squeeze < SQUEEZES) return undefined;
  }
  // Scroll legends that layout has not already wrapped into rows.
  for (const legend of asArray(base.legend)) {
    if (legend.show !== false) {
      legend.type ??= "scroll";
    }
  }
  styleSeries(base, series, context.colors);
  colorLabelsOnItems(base, series, context.colors);
  nameTreemapRoot(series);
  drawLargeSeries(option, series);
  showAxisLines(base);
  compactAxisLabels(base);
  formatTemplateValues(option);
  addInteraction(base, series, cartesian, context.colors);
  // A timeline step or media query can set a toolbox of its own too.
  for (const toolbox of optionVariants(option).flatMap((variant) => asArray(variant.toolbox))) {
    keepLastingTools(toolbox);
  }
  return option;
}

export function disableAnimation(option: JsonObject): void {
  // Timeline and media options can override both global and per-series animation settings.
  for (const variant of optionVariants(option)) variant.animation = false;
  for (const series of allSeries(option)) series.animation = false;
}

/**
 * ECharts needs emphasis.focus to dim other items around a highlight. Override the option's
 * focus setting while agent annotations are active.
 */
export function focusHighlighted(option: JsonObject): void {
  for (const series of allSeries(option)) {
    const emphasis = styleOf(series.emphasis);
    emphasis.focus = "self";
    series.emphasis = emphasis;
  }
}

/** Reserve space for components, fit the plot into what remains, and return its height. */
function layOut(
  base: JsonObject,
  series: JsonObject[],
  cartesian: boolean,
  size: Size,
  squeeze: number,
  stepped: ReadonlySet<unknown>,
): number {
  const reserved: Insets = { top: 0, bottom: 0, left: 0, right: 0 };
  placeTitles(base, reserved, size, squeeze);
  placeTimeline(base, reserved);
  // Single-axis charts such as theme rivers use the same legend placement as grids.
  placeLegend(base, series, cartesian || series.some(onSingleAxis), reserved, size);
  placeSliders(base, reserved, size, squeeze);
  // Rotated category labels need extra height beyond the reserved label row.
  const turned = cartesian ? layOutGrid(base, reserved, size) : 0;
  layOutSingleAxis(base, series, reserved, size);
  layOutCalendar(base, reserved, size);
  layOutParallel(base, reserved, size);
  truncateGridTitles(base, size);
  layOutPie(base, series, reserved, size);
  labelTreeNodes(series, size);
  layOutBoxSeries(series, reserved, size, stepped);
  layOutRadar(base, reserved, size);
  return size.height - reserved.top - reserved.bottom - turned;
}

/** Base series overridden by at least one timeline step. */
function steppedSeries(option: JsonObject, base: JsonObject): Set<unknown> {
  const series = seriesOf(base);
  const stepped = new Set<unknown>();
  for (const step of Array.isArray(option.options) ? option.options : []) {
    if (!isPlainObject(step)) continue;
    for (const place of seriesPlaces(series, seriesOf(step))) {
      if (place !== undefined) stepped.add(series[place]);
    }
  }
  return stepped;
}

/** Minimum readable plot height, including axis labels, in pixels. */
const MIN_PLOT_HEIGHT = 140;
