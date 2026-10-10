import * as assert from "node:assert";
import { init as initECharts } from "echarts";
import type * as ECharts from "echarts/core";
import type { ChartSpec } from "../chartSpec";
import { buildChart } from "../charts";
import { type DataTable, parseTable } from "../data";
import { ChartItems } from "../webview/echartsItems";
import { type LayoutContext, layoutOption } from "../webview/echartsLayout";
import type { JsonObject } from "../webview/echartsOption";
import { testColors } from "./themeColors";

// biome-ignore lint/suspicious/noExplicitAny: tests read into the untyped options of ECharts
export type Option = Record<string, any>;

/** The option of the spec's chart of the table, which must be plain JSON, as it is saved and sent. */
export function builtOption(spec: ChartSpec, table: DataTable | string): Option {
  const { option } = buildChart(spec, typeof table === "string" ? parseTable(table) : table);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(option)), option, "the option is plain JSON");
  return option;
}

/** The data of each series of the option. */
export const seriesData = (option: Option): unknown[] =>
  option.series.map((series: Option) => series.data);

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

/** The items of an option as ECharts lays them out. */
export const itemsOf = (option: Record<string, unknown>) =>
  withChart(option, (chart) => new ChartItems(chart));

/** The option as the panel lays it out, by default at 800 × 500 in the test colors. */
export function layout(option: JsonObject, context: Partial<LayoutContext> = {}): Option {
  return layoutOption(option, {
    width: 800,
    height: 500,
    title: "",
    colors: testColors,
    reducedMotion: false,
    ...context,
  });
}

/** An item as ECharts' actions, such as highlight, name it. */
export const item = (dataIndex: number, seriesIndex = 0, dataType?: string) => ({
  seriesIndex,
  dataType,
  dataIndex,
});
