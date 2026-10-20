import * as assert from "node:assert";
import { init } from "echarts";
import type * as ECharts from "echarts/core";
import { modelOf, type SeriesModel } from "../webview/echartsItems";
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

  test("preserves a dragged node when a large positioned graph is resized", () => {
    const count = 150_000;
    const nodes = Array.from({ length: count }, (_, index) => ({ x: index, y: index % 100 }));
    // Exercise the model state without allocating 150,000 SVG nodes in ECharts.
    const chart = (dragged: boolean): ECharts.ECharts => {
      const data = {
        count: () => count,
        getId: String,
        getRawDataItem: (index: number) => nodes[index],
        getItemLayout: (index: number) => {
          const node = nodes[index];
          return dragged && index === 0 ? [count, 198] : [node?.x, node?.y];
        },
      };
      const series = {
        componentIndex: 0,
        subType: "graph",
        get: () => "none",
        getRawData: () => data,
        getData: () => data,
      };
      return {
        getModel: () => ({
          eachRawSeries: (read: (series: SeriesModel) => void) =>
            read(series as unknown as SeriesModel),
        }),
      } as unknown as ECharts.ECharts;
    };
    const restore = modelState(chart(true));
    for (const node of nodes) {
      node.x *= 2;
      node.y *= 3;
    }
    restore(chart(false));
    assert.deepStrictEqual(nodes[0], { x: count * 2, y: 594 });
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

  test("keeps a dragged node of a placed graph where dragged through a layout whose legend hides it", () => {
    // A is of a category of its own, which the legend hides, and then all others but D.
    const graph = (selected: Record<string, boolean>) => ({
      animation: false,
      legend: { selected },
      series: [
        {
          type: "graph",
          layout: "force",
          draggable: true,
          categories: [{ name: "Own" }, { name: "Edge" }, { name: "Rest" }],
          data: ["A", "B", "C", "D", "E"].map((name) => ({
            name,
            category: name === "A" ? 0 : name === "D" ? 1 : 2,
          })),
          links: [
            { source: "A", target: "B" },
            { source: "B", target: "C" },
            { source: "C", target: "D" },
            { source: "D", target: "E" },
          ],
        },
      ],
    });
    const draw = (
      width: number,
      selected: Record<string, boolean>,
      from?: ECharts.ECharts,
    ): ECharts.ECharts => {
      const chart = init(null, undefined, {
        renderer: "svg",
        ssr: true,
        width,
        height: 500,
      }) as unknown as ECharts.ECharts;
      const restore = from && modelState(from);
      chart.setOption(layout(graph(selected), { width, height: 500 }), {
        notMerge: true,
        lazyUpdate: true,
      });
      restore?.(chart);
      chart.resize({ width, height: 500 });
      return chart;
    };
    // Where A is, across and down the bounds of where the others are placed.
    const placedA = (chart: ECharts.ECharts, width: number) => {
      const data = (modelOf(chart).getSeriesByIndex(0) as unknown as Option).getData();
      const index = Array.from({ length: data.count() }, (_, each) => each).find(
        (each) => data.getName(each) === "A",
      );
      assert.ok(index !== undefined);
      const [x = 0, y = 0] = data.getItemLayout(index) as number[];
      const others = layout(graph({}), { width, height: 500 })
        .series[0].data.filter(({ name }: Option) => name !== "A")
        .map(({ x, y }: Option) => [x, y]);
      const xs = others.map(([x]: number[]) => x);
      const ys = others.map(([, y]: number[]) => y);
      const [left, top] = [Math.min(...xs), Math.min(...ys)];
      return [(x - left) / (Math.max(...xs) - left), (y - top) / (Math.max(...ys) - top)].map(
        (value) => value.toFixed(6),
      );
    };
    const first = draw(800, {});
    const data = (modelOf(first).getSeriesByIndex(0) as unknown as Option).getData();
    const [x = 0, y = 0] = data.getItemLayout(0) as number[];
    data.setItemLayout(0, [x + 60, y - 45]);
    const dragged = placedA(first, 800);
    // Hidden by the legend, and shown again; and beside nodes that the legend hides, of the
    // bounds of all others still.
    const hidden = draw(600, { Own: false }, first);
    const shown = draw(700, {}, hidden);
    assert.deepStrictEqual(placedA(shown, 700), dragged);
    const beside = draw(600, { Rest: false }, shown);
    assert.deepStrictEqual(placedA(beside, 600), dragged);
    const again = draw(700, {}, beside);
    assert.deepStrictEqual(placedA(again, 700), dragged);
    for (const chart of [first, hidden, shown, beside, again]) chart.dispose();
  });
});
