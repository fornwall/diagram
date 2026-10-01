import * as assert from "node:assert";
import type { Rgba, ThemeColors } from "../webview/colors";
import { keepUserState, type LayoutContext, layoutOption } from "../webview/echartsLayout";
import type { JsonObject } from "../webview/echartsOption";

// biome-ignore lint/suspicious/noExplicitAny: test access to the untyped option
type Option = Record<string, any>;

const gray: Rgba = { r: 128, g: 128, b: 128, a: 1 };
const colors: ThemeColors = {
  dark: true,
  background: { r: 31, g: 31, b: 31, a: 1 },
  foreground: { r: 204, g: 204, b: 204, a: 1 },
  muted: gray,
  gridLine: gray,
  axisLine: gray,
  focus: { r: 0, g: 120, b: 212, a: 1 },
  hoverBackground: gray,
  hoverBorder: gray,
  hoverForeground: gray,
  palette: Array.from({ length: 16 }, (_, index) => ({ r: index, g: 0, b: 0, a: 1 })),
  blue: gray,
  green: gray,
  red: gray,
  fontFamily: "sans-serif",
  fontSize: 12,
};

function layout(option: JsonObject, context: Partial<LayoutContext> = {}): Option {
  return layoutOption(option, {
    width: 800,
    height: 500,
    title: "",
    colors,
    reducedMotion: false,
    ...context,
  });
}

const bars = (extra: Option = {}): Option => ({
  xAxis: { type: "category", data: ["A", "B"] },
  yAxis: { type: "value" },
  series: [{ type: "bar", data: [1, 2] }],
  ...extra,
});

suite("echartsLayout", () => {
  test("leaves the source option untouched", () => {
    const source = bars();
    const copy = structuredClone(source);
    layout(source);
    assert.deepStrictEqual(source, copy);
  });

  test("hides a chart title that repeats the panel title", () => {
    assert.strictEqual(
      layout(bars({ title: { text: "Sales" } }), { title: "sales" }).title.show,
      false,
    );
    const subtitled = layout(bars({ title: { text: "Sales", subtext: "2026" } }), {
      title: "Sales",
    });
    assert.deepStrictEqual(subtitled.title, { text: "", subtext: "2026" });
  });

  test("adds a legend for several named series, beside non-grid charts when there is room", () => {
    const named = bars({
      series: [
        { type: "bar", name: "One", data: [1, 2] },
        { type: "bar", name: "Two", data: [3, 4] },
      ],
    });
    assert.strictEqual(layout(named).legend.top, 6);
    assert.strictEqual(layout(named, { width: 400 }).legend.bottom, 6);
    const pie = {
      series: [
        { type: "pie", name: "A" },
        { type: "pie", name: "B" },
      ],
    };
    assert.strictEqual(layout(pie).legend.orient, "vertical");
  });

  test("keeps explicit choices", () => {
    const option = layout(
      bars({ legend: { left: 0 }, grid: { left: 1 }, tooltip: { trigger: "item" }, aria: {} }),
    );
    assert.deepStrictEqual(option.legend, { left: 0, type: "scroll" });
    assert.deepStrictEqual(option.grid, { left: 1 });
    assert.deepStrictEqual(option.tooltip, { trigger: "item", confine: true });
    assert.deepStrictEqual(option.aria, {});
  });

  test("reserves room for a placed legend on the side ECharts shows it", () => {
    const bottom = layout(bars({ legend: { left: 0 } })).grid;
    assert.deepStrictEqual([bottom.top, bottom.bottom], [14, 40]);
    const top = layout(bars({ legend: { top: 0 } })).grid;
    assert.deepStrictEqual([top.top, top.bottom], [44, 8]);
  });

  test("places sliders along the axis they control", () => {
    const option = layout(bars({ dataZoom: [{ type: "slider" }, { yAxisIndex: 0 }] }));
    assert.deepStrictEqual(option.dataZoom, [
      { type: "slider", bottom: 8, height: 22 },
      { yAxisIndex: 0, right: 8, width: 22 },
    ]);
    assert.strictEqual(option.grid.bottom, 46);
    assert.strictEqual(option.grid.right, 58);
  });

  test("rotates category labels that would overlap", () => {
    const labels = Array.from({ length: 20 }, (_, index) => `Category ${index}`);
    const option = layout(bars({ xAxis: { type: "category", data: labels } }));
    assert.strictEqual(option.xAxis.axisLabel.rotate, 30);
    assert.strictEqual(layout(bars()).xAxis.axisLabel, undefined);
  });

  test("measures labels of charts with very many categories", () => {
    const labels = Array.from({ length: 200_000 }, (_, index) => `Category ${index}`);
    const axis = { type: "category", data: labels };
    const option = layout(bars({ xAxis: axis, yAxis: axis, legend: { data: labels } }));
    assert.strictEqual(option.xAxis.axisLabel.rotate, 45);
  });

  test("gives sankey nodes their own palette colors, also beyond eight", () => {
    const nodes = Array.from({ length: 10 }, (_, index) => ({ name: `N${index}` }));
    const option = layout({ series: [{ type: "sankey", data: nodes }] });
    assert.strictEqual(option.series[0].data[9].itemStyle.color, "#090000");
  });

  test("defaults tooltips, selection and screen reader support", () => {
    const option = layout(bars());
    assert.deepStrictEqual(option.tooltip, {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      confine: true,
    });
    assert.strictEqual(option.series[0].selectedMode, "multiple");
    assert.strictEqual(option.series[0].select.itemStyle.borderColor, "#0078d4");
    assert.deepStrictEqual(option.aria, { enabled: true });
  });

  test("lays out the base option of a timeline", () => {
    const option = layout({ baseOption: bars(), options: [{ series: [{ data: [3, 4] }] }] });
    assert.strictEqual(option.baseOption.tooltip.trigger, "axis");
    assert.strictEqual(option.tooltip, undefined);
  });

  test("keepUserState carries legend selection and zoom ranges over", () => {
    const option: Option = layout(
      bars({ legend: {}, dataZoom: [{ type: "inside", startValue: 2, endValue: 5 }] }),
    );
    keepUserState(option, {
      legend: [{ selected: { One: false }, scrollDataIndex: 3 }],
      dataZoom: [{ start: 10, end: 40, startValue: 1, endValue: 4 }],
    });
    assert.deepStrictEqual(option.legend.selected, { One: false });
    assert.strictEqual(option.legend.scrollDataIndex, 3);
    assert.deepStrictEqual(option.dataZoom, [{ type: "inside", start: 10, end: 40 }]);
  });

  test("keepUserState carries the timeline position and visual map range over", () => {
    const option: Option = layout({
      baseOption: { ...bars(), timeline: { data: ["2025", "2026"] }, visualMap: {} },
      options: [{}, {}],
    });
    keepUserState(option, { timeline: [{ currentIndex: 1 }], visualMap: [{ range: [2, 5] }] });
    assert.strictEqual(option.baseOption.timeline.currentIndex, 1);
    assert.deepStrictEqual(option.baseOption.visualMap.range, [2, 5]);
    assert.strictEqual(option.baseOption.visualMap.selected, undefined);
  });
});
