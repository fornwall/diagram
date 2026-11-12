import { init as initECharts } from "echarts";
import type * as ECharts from "echarts/core";
import { ChartItems } from "../webview/echartsItems";

// biome-ignore lint/suspicious/noExplicitAny: tests read into the untyped options of ECharts
export type Option = Record<string, any>;

/** A bar chart of two categories, with any other properties. */
export const bars = (extra: Option = {}): Option => ({
  xAxis: { type: "category", data: ["A", "B"] },
  yAxis: { type: "value" },
  series: [{ type: "bar", data: [1, 2] }],
  ...extra,
});

/** Reads a chart of the option as ECharts lays it out, without a browser. */
export function withChart<T>(
  option: Record<string, unknown>,
  read: (chart: ECharts.ECharts) => T,
  { width = 400, height = 300 } = {},
): T {
  const chart = initECharts(null, undefined, { renderer: "svg", ssr: true, width, height });
  try {
    chart.setOption(option);
    return read(chart as unknown as ECharts.ECharts);
  } finally {
    chart.dispose();
  }
}

/** The SVG of a chart of the option, by default at 400 × 300. */
export const svgOf = (option: Record<string, unknown>, size?: { width: number; height: number }) =>
  withChart(option, (chart) => chart.renderToSVGString(), size);

/** The items of an option as ECharts lays them out. */
export const itemsOf = (option: Record<string, unknown>) =>
  withChart(option, (chart) => new ChartItems(chart));

/** An item as ECharts' actions, such as highlight, name it. */
export const item = (dataIndex: number, seriesIndex = 0, dataType?: string) => ({
  seriesIndex,
  dataType,
  dataIndex,
});
