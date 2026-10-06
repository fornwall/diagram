// What the user changed in a shown chart, such as a legend's selection or a drill-down, carried
// over to a new layout of its option, which would otherwise start over. ECharts keeps some of it in
// the option it shows, and some only in its model.

import type * as ECharts from "echarts/core";
import { modelOf, type SeriesModel } from "./echartsItems";
import { asArray, baseOption, type JsonObject } from "./echartsOption";

/** What the user can change in a shown chart, by component: besides the zoom ranges. */
const USER_STATE: Record<string, string[]> = {
  legend: ["selected", "scrollDataIndex"],
  timeline: ["currentIndex"],
  visualMap: ["range", "selected"],
};

/** The series that keep the center and zoom that the user pans and zooms them to in their option. */
const ROAM_SERIES = ["graph", "tree", "sankey"];

/** Carries what the user changed in the shown option, such as a legend's selection, over to a new layout of it. */
export function keepUserState(option: JsonObject, shown: JsonObject): void {
  const base = baseOption(option);
  const shownSeries = asArray(shown.series);
  asArray(base.series).forEach((series, index) => {
    if (!series.roam || !ROAM_SERIES.includes(String(series.type))) return;
    const current = shownSeries[index];
    for (const key of ["center", "zoom"]) {
      if (current?.[key] !== undefined) series[key] = current[key];
    }
  });
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

/**
 * What the user changed in a shown chart that ECharts keeps in its model rather than its option,
 * and a new option would start over from: where the force layout of a graph left its nodes, which
 * it would place anew at random, the node a treemap or sunburst is drilled down to, and the nodes
 * of a tree that are expanded. Returns how to hand it to the model of the same option laid out
 * anew, before that is laid out.
 */
export function modelState(chart: ECharts.ECharts): (chart: ECharts.ECharts) => void {
  const restores: ((series: SeriesModel) => void)[] = [];
  modelOf(chart).eachRawSeries((series) => {
    const points = series.preservedPoints;
    const viewRoot = series.getViewRoot?.().dataIndex;
    const tree = series.subType === "tree" ? series.getRawData().tree : undefined;
    const expanded: boolean[] = [];
    if (tree) {
      for (let index = 0, count = series.getRawData().count(); index < count; index++) {
        expanded[index] = tree.getNodeByDataIndex(index).isExpand;
      }
    }
    restores[series.componentIndex] = (next) => {
      next.preservedPoints = points;
      const nextTree = next.getRawData().tree;
      if (viewRoot !== undefined && nextTree) {
        next.resetViewRoot?.(nextTree.getNodeByDataIndex(viewRoot));
      }
      expanded.forEach((isExpand, index) => {
        const node = nextTree?.getNodeByDataIndex(index);
        if (node) node.isExpand = isExpand;
      });
    };
  });
  return (next) => {
    modelOf(next).eachRawSeries((series) => restores[series.componentIndex]?.(series));
  };
}
