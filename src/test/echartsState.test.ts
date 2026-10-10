import * as assert from "node:assert";
import { keepUserState } from "../webview/echartsState";
import { bars, layout, type Option } from "./echartsModel";

suite("echartsState", () => {
  test("carries a legend's selection and scroll, and the zoom range, over to a new layout", () => {
    const option: Option = layout({
      ...bars(),
      legend: {},
      dataZoom: [{ type: "inside", startValue: 2, endValue: 5 }],
    });
    keepUserState(option, {
      legend: [{ selected: { One: false }, scrollDataIndex: 3 }],
      dataZoom: [{ start: 10, end: 40, startValue: 1, endValue: 4 }],
    });
    assert.deepStrictEqual(option.legend.selected, { One: false });
    assert.strictEqual(option.legend.scrollDataIndex, 3);
    assert.deepStrictEqual(option.dataZoom, [{ type: "inside", start: 10, end: 40 }]);
  });

  test("carries the timeline step and the visual map's range over to a new layout", () => {
    const option: Option = layout({
      baseOption: { ...bars(), timeline: { data: ["2025", "2026"] }, visualMap: {} },
      options: [{}, {}],
    });
    keepUserState(option, {
      timeline: [{ currentIndex: 1 }],
      visualMap: [{ range: [2, 5] }],
    });
    assert.strictEqual(option.baseOption.timeline.currentIndex, 1);
    assert.deepStrictEqual(option.baseOption.visualMap.range, [2, 5]);
    assert.strictEqual(option.baseOption.visualMap.selected, undefined);
  });

  test("keeps the pan and zoom of roaming graphs and trees, but not other series' centers", () => {
    const option: Option = layout({
      series: [
        { type: "pie", center: ["25%", "50%"], data: [1] },
        { type: "graph", roam: true, layout: "circular", data: [{ name: "A" }] },
        { type: "graph", roam: false, layout: "circular", data: [{ name: "B" }] },
        { type: "tree", roam: true, data: [{ name: "C" }] },
      ],
    });
    keepUserState(option, {
      series: [
        { center: [100, 100] },
        { center: [40, 60], zoom: 2.5 },
        { center: [20, 30], zoom: 3 },
        { center: [10, 10], zoom: 4 },
      ],
    });
    assert.strictEqual(option.series[3].zoom, 4);
    assert.deepStrictEqual(option.series[0].center, ["25%", "50%"]);
    assert.deepStrictEqual(option.series[1].center, [40, 60]);
    assert.strictEqual(option.series[1].zoom, 2.5);
    assert.strictEqual(option.series[2].center, undefined);
    assert.strictEqual(option.series[2].zoom, undefined);
  });
});
