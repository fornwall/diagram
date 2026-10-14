import * as assert from "node:assert";
import { init } from "echarts";
import type * as ECharts from "echarts/core";
import { modelOf } from "../webview/echartsItems";
import { keepUserState, modelState } from "../webview/echartsState";
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

  test("keeps the nodes of a placed graph where dragged through a new layout, all of them too", () => {
    const graph = {
      animation: false,
      series: [
        {
          type: "graph",
          layout: "force",
          draggable: true,
          data: ["A", "B", "C", "D"].map((name) => ({ name })),
          links: [
            { source: "A", target: "B" },
            { source: "B", target: "C" },
            { source: "C", target: "D" },
          ],
        },
      ],
    };
    const draw = (width: number, height: number, from?: ECharts.ECharts) => {
      const chart = init(null, undefined, {
        renderer: "svg",
        ssr: true,
        width,
        height,
      }) as unknown as ECharts.ECharts;
      const restore = from && modelState(from);
      chart.setOption(layout(graph, { width, height }), { notMerge: true, lazyUpdate: true });
      restore?.(chart);
      chart.resize({ width, height });
      return chart;
    };
    // The nodes, as ECharts holds them: where each is placed, and where it is.
    const nodes = (chart: ECharts.ECharts) => {
      const data = (modelOf(chart).getSeriesByIndex(0) as unknown as Option).getData();
      return Array.from({ length: data.count() }, (_, index) => ({
        placed: [data.getRawDataItem(index).x, data.getRawDataItem(index).y],
        at: data.getItemLayout(index) as number[],
        move: (x: number, y: number) => data.setItemLayout(index, [x, y]),
      }));
    };
    // Across and down the bounds of where the nodes are placed.
    const across = (points: number[][], bounds: number[][]) => {
      const xs = bounds.map(([x = 0]) => x);
      const ys = bounds.map(([, y = 0]) => y);
      const [left, top] = [Math.min(...xs), Math.min(...ys)];
      const [width, height] = [Math.max(...xs) - left, Math.max(...ys) - top];
      return points.map(([x = 0, y = 0]) => [(x - left) / width, (y - top) / height]);
    };
    const first = draw(800, 500);
    // Every node dragged, as ECharts moves one while dragged.
    const before = nodes(first);
    before.forEach(({ placed: [x = 0, y = 0], move }, index) => {
      move(x + (index % 2 ? 40 : -30), y + 25 * index);
    });
    const dragged = nodes(first).map(({ at }) => at);
    const placed = before.map(({ placed }) => placed);
    const second = draw(600, 500, first);
    const placedAgain = (option: Option) => option.series[0].data.map(({ x, y }: Option) => [x, y]);
    const after = nodes(second).map(({ at }) => at);
    const expected = across(dragged, placed);
    const actual = across(after, placedAgain(layout(graph, { width: 600, height: 500 })));
    actual.forEach(([x = 0, y = 0], index) => {
      const [wantX = 0, wantY = 0] = expected[index] ?? [];
      assert.ok(
        Math.abs(x - wantX) + Math.abs(y - wantY) < 1e-6,
        JSON.stringify({ actual, expected }),
      );
    });
    // And through the layout after that, without being dragged again.
    const third = draw(700, 500, second);
    const again = across(
      nodes(third).map(({ at }) => at),
      placedAgain(layout(graph, { width: 700, height: 500 })),
    );
    assert.deepStrictEqual(
      again.map((point) => point.map((value) => value.toFixed(6))),
      expected.map((point) => point.map((value) => value.toFixed(6))),
    );
    for (const chart of [first, second, third]) chart.dispose();
  });
});
