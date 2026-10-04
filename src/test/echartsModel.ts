import { init as initECharts } from "echarts";
import type * as ECharts from "echarts/core";
import { ChartItems } from "../webview/echartsItems";

/** The items of an option as ECharts lays them out, without a browser. */
export function itemsOf(option: Record<string, unknown>): ChartItems {
  const chart = initECharts(null, undefined, {
    renderer: "svg",
    ssr: true,
    width: 400,
    height: 300,
  });
  try {
    chart.setOption(option);
    return new ChartItems(chart as unknown as ECharts.ECharts);
  } finally {
    chart.dispose();
  }
}
