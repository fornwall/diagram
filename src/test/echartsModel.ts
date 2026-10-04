import { init as initECharts } from "echarts";
import type * as ECharts from "echarts/core";
import { ChartItems } from "../webview/echartsItems";

/** Reads a chart of the option as ECharts lays it out, without a browser. */
export function withChart<T>(
  option: Record<string, unknown>,
  read: (chart: ECharts.ECharts) => T,
): T {
  const chart = initECharts(null, undefined, {
    renderer: "svg",
    ssr: true,
    width: 400,
    height: 300,
  });
  try {
    chart.setOption(option);
    return read(chart as unknown as ECharts.ECharts);
  } finally {
    chart.dispose();
  }
}

/** The items of an option as ECharts lays them out. */
export const itemsOf = (option: Record<string, unknown>) =>
  withChart(option, (chart) => new ChartItems(chart));
