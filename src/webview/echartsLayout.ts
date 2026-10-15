// Adapts an ECharts option written by a model to the panel: responsive layout, selection styles
// and defaults. Only fills in what the option leaves unset, so explicit choices always win.

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
import { type Insets, type LayoutContext, layoutSize, type Size } from "./echartsMeasure";
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
 * Gives the base option the series that the chart starts with but that only the current timeline
 * step or the default media option defines, as copies, for the layout to place, style and keep
 * them as any other: what the step or query sets is still merged in over them. Series that only
 * later steps add stay there, so as not to be shown from the start, as do series with an "id",
 * which the series of other steps, with ids of their own, would no longer merge into. Likewise
 * the titles they set, as a step's year often is, for the layout to make room for.
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
 * How far a chart too short for its plot to be read gives up what is around the plot, step by
 * step, each giving up what the one before did as well: a visual map below the chart, which then
 * only colors the items, whose values the tooltip gives; a zoom slider below it, for zooming
 * with the wheel and panning with the pointer inside the plot instead; a subtitle; and a title,
 * which the panel's header goes with. A legend stays, which tells the series apart.
 */
const SQUEEZES = 4;

export function layoutOption(source: JsonObject, context: LayoutContext): JsonObject {
  for (let squeeze = 0; ; squeeze++) {
    const option = layOutAround(source, context, squeeze);
    if (option) return option;
  }
}

/**
 * The option laid out for the context, giving up as much as the squeeze says around the plot,
 * unless that leaves the plot too short to read and a further squeeze could help.
 */
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
  // A legend that the layout did not wrap into rows pages through its entries, if they take more.
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
 * Makes a highlighted item fade the rest of the chart, which is how an agent's marks stand out with
 * everything else receding: ECharts blurs a chart around a highlighted item only when its series
 * focuses on it. Replaces a focus of the option's own for as long as the marks dim the chart.
 */
export function focusHighlighted(option: JsonObject): void {
  for (const series of allSeries(option)) {
    const emphasis = isPlainObject(series.emphasis) ? series.emphasis : {};
    emphasis.focus = "self";
    series.emphasis = emphasis;
  }
}

/**
 * Places the components around the plot, giving up as much as the squeeze says (see
 * {@link SQUEEZES}), and fits the grid and series into the space left, whose height it returns.
 */
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
  // A chart along a single axis, as a theme river, has its legend where a grid's would be.
  placeLegend(base, series, cartesian || series.some(onSingleAxis), reserved, size);
  placeSliders(base, reserved, size, squeeze);
  // Turned category labels take the plot's height, as a row of them is counted on already.
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

/** The series of the base option that the steps of a timeline set something of, merged over it. */
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

/** The height in pixels below which a plot, with the labels of its axes, can hardly be read. */
const MIN_PLOT_HEIGHT = 140;
