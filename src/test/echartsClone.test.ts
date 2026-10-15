import * as assert from "node:assert";
import type { JsonObject } from "../webview/echartsOption";
import { bars, layout, type Option } from "./echartsModel";
import { testColors as colors } from "./themeColors";

suite("echartsClone", () => {
  test("leaves the source option untouched", () => {
    const source = bars();
    const copy = structuredClone(source);
    layout(source);
    assert.deepStrictEqual(source, copy);
  });

  test("lays out an option that holds functions, leaving the source option untouched", () => {
    const renderItem = () => ({ type: "rect" });
    const formatter = () => "";
    const data = [1, 2];
    const source: Option = {
      xAxis: { type: "category", data: ["A", "B"] },
      yAxis: { type: "value" },
      tooltip: { formatter },
      series: [{ type: "custom", renderItem, data }],
    };
    const option = layout(source);
    assert.strictEqual(option.series[0].renderItem, renderItem);
    assert.strictEqual(option.tooltip.formatter, formatter);
    assert.strictEqual(option.grid.left, 8);
    // Data arrays are shared: the layout only ever writes to option and component objects.
    assert.strictEqual(option.series[0].data, data);
    assert.strictEqual(source.series[0].selectedMode, undefined);
    assert.strictEqual(source.tooltip.confine, undefined);
    assert.strictEqual(source.grid, undefined);
  });

  test("lays out a series with a prototype of its own, leaving the source option untouched", () => {
    // A series can be written as {__proto__: {type: "pie"}, …}, which is valid JavaScript.
    const series: Option = { data: [{ name: "a", value: 1 }] };
    Object.setPrototypeOf(series, { type: "pie" });
    const source = { series: [series], legend: {} };
    const box = ({ left, right, top, radius }: Option) => [left, right, top, radius];
    const wide = layout(source, { width: 1400, height: 900 });
    assert.deepStrictEqual(box(wide.series[0]), [8, 92, 8, "68%"]);
    assert.deepStrictEqual(Object.keys(series), ["data"]);
    // The first layout is not written to the source, so a second one is not stale.
    const narrow = layout(source, { width: 300, height: 220 });
    assert.deepStrictEqual(box(narrow.series[0]), [8, 8, 8, "90%"]);
  });

  test("lays out a series written as a class instance, leaving the source option untouched", () => {
    const node = { name: "a" };
    class Sankey {
      type = "sankey";
      data = [node];
    }
    const series = new Sankey();
    const option = layout({ series: [series] });
    assert.strictEqual(option.series[0].top, 12);
    assert.strictEqual(option.series[0].data[0].itemStyle.color, "#000000");
    assert.deepStrictEqual(Object.keys(series), ["type", "data"]);
    assert.deepStrictEqual(Object.keys(node), ["name"]);
  });

  test("copies an own __proto__ key as data, not as the prototype of the copy", () => {
    // JSON.parse does produce an own "__proto__" key, unlike an object literal.
    const legend: JsonObject = JSON.parse('{"__proto__": {"show": false}, "x": 1}');
    const option = layout(bars({ legend }));
    assert.strictEqual(Object.getPrototypeOf(option.legend), Object.prototype);
    assert.deepStrictEqual(Object.getOwnPropertyDescriptor(option.legend, "__proto__")?.value, {
      show: false,
    });
    // The legend is laid out, rather than inheriting the "show": false of the copied key.
    const { show, x, type, top } = option.legend;
    assert.deepStrictEqual([show, x, type, top], [undefined, 1, "scroll", 6]);
  });

  test("keeps a date and a typed array in chart data as they are", () => {
    const point = new Date(86_400_000);
    const time = { xAxis: { type: "time" }, series: [{ type: "line", data: [[point, 1]] }] };
    const copied = layout(time).series[0].data[0][0];
    assert.ok(copied instanceof Date && copied.getTime() === point.getTime(), String(copied));
    assert.deepStrictEqual(Object.keys(copied), []);
    // Sankey nodes are written to, but the source's date is not.
    const node = new Date(0);
    layout({ series: [{ type: "sankey", data: [node] }] });
    assert.deepStrictEqual(Object.keys(node), []);
    const data = new Float64Array([1, 2, 3]);
    assert.strictEqual(layout(bars({ series: [{ type: "bar", data }] })).series[0].data, data);
  });

  test("shares read-only points, hierarchy nodes and dataset rows across layouts", () => {
    const points = Object.freeze([Object.freeze({ value: [1, 2], name: "A" })]);
    const nodes = Object.freeze([
      Object.freeze({ name: "parent", children: Object.freeze([{ name: "child", value: 2 }]) }),
    ]);
    const rows = Object.freeze([Object.freeze({ category: "A", value: 2 })]);
    const links = Object.freeze([Object.freeze({ source: "A", target: "B" })]);
    const source = {
      dataset: { source: rows },
      baseOption: {
        series: [
          { type: "line", data: points },
          { type: "treemap", data: nodes },
          { type: "graph", nodes, links },
        ],
      },
      options: [{ series: [{ data: points }] }],
      media: [{ option: { series: [{ data: points }] } }],
    };
    for (const width of [300, 800]) {
      const option = layout(source, { width, reducedMotion: true });
      assert.strictEqual(option.dataset.source, rows);
      assert.strictEqual(option.baseOption.series[0].data, points);
      assert.strictEqual(option.baseOption.series[1].data, nodes);
      assert.strictEqual(option.baseOption.series[2].nodes, nodes);
      assert.strictEqual(option.baseOption.series[2].links, links);
      assert.strictEqual(option.options[0].series[0].data, points);
      assert.strictEqual(option.media[0].option.series[0].data, points);
      assert.strictEqual(option.options[0].series[0].animation, false);
    }
    assert.deepStrictEqual(source.options, [{ series: [{ data: points }] }]);
  });

  test("copies sankey nodes before styling, preserving source styles across themes", () => {
    const nodes = Object.freeze([
      Object.freeze({ name: "A", itemStyle: Object.freeze({ borderWidth: 2 }) }),
      Object.freeze({ name: "B", itemStyle: Object.freeze({ color: "red" }) }),
    ]);
    for (const key of ["data", "nodes"]) {
      const source = { series: [{ type: "sankey", [key]: nodes }] };
      const first = layout(source).series[0][key];
      const second = layout(source, { colors: { ...colors, palette: [colors.focus] } }).series[0][
        key
      ];
      assert.deepStrictEqual(first[0].itemStyle, { borderWidth: 2, color: "#000000" });
      assert.deepStrictEqual(second[0].itemStyle, { borderWidth: 2, color: "#0078d4" });
      assert.deepStrictEqual(first[1].itemStyle, { color: "red" });
      assert.deepStrictEqual(nodes[0]?.itemStyle, { borderWidth: 2 });
    }
  });
});
