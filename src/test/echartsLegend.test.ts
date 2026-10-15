import * as assert from "node:assert";
import { bars, layout, type Option } from "./echartsModel";

suite("echartsLegend", () => {
  test("wraps a legend that the panel places into a few rows, rather than page through it", () => {
    const named = (count: number, extra: Option = {}) =>
      layout({
        xAxis: { type: "category", data: ["a"] },
        yAxis: {},
        series: Array.from({ length: count }, (_, index) => ({
          name: `Product line ${index + 1}`,
          type: "line",
          data: [index],
        })),
        ...extra,
      });
    const top = (option: Option) => [option.legend.type, option.grid.top];
    assert.deepStrictEqual(top(named(5)), ["scroll", 44]);
    assert.deepStrictEqual(top(named(12)), ["plain", 68]);
    assert.deepStrictEqual(top(named(16)), ["plain", 92]);
    // Too many to wrap into a few rows, or a legend that says its kind or place.
    assert.deepStrictEqual(top(named(30)), ["scroll", 44]);
    assert.deepStrictEqual(top(named(12, { legend: { type: "scroll" } })), ["scroll", 44]);
    assert.strictEqual(named(12, { legend: { bottom: 0 } }).legend.type, "scroll");
    // As many rows as a fifth of the height takes, as for the slices of a pie in a tall panel.
    const slices = (height: number) =>
      layout(
        {
          series: [
            {
              type: "pie",
              data: Array.from({ length: 8 }, (_, index) => ({
                name: `Browser ${index}`,
                value: 1,
              })),
            },
          ],
        },
        { width: 260, height },
      ).legend.type;
    assert.strictEqual(slices(600), "plain");
    assert.strictEqual(slices(300), "scroll");
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
    // A legend told only which way to go goes that way beside the chart.
    assert.strictEqual(layout({ ...pie, legend: { orient: "horizontal" } }).legend.bottom, 6);
    const vertical = layout(bars({ legend: { orient: "vertical" } }));
    assert.deepStrictEqual([vertical.legend.right, vertical.legend.top], [8, "middle"]);
    assert.ok(vertical.grid.right > 60, String(vertical.grid.right));
    // One placed only up and down goes on the right too, where ECharts would center it.
    const top = layout(bars({ legend: { orient: "vertical", top: 0 } }));
    assert.deepStrictEqual([top.legend.right, top.legend.top], [8, 0]);
    assert.strictEqual(top.grid.right, vertical.grid.right);
    const left = layout(bars({ legend: { orient: "vertical", left: 0 } }));
    assert.deepStrictEqual([left.legend.right, left.grid.left > 60], [undefined, true]);
  });

  test("makes room for a pie's legend by the names of its slices", () => {
    const pie = (name: string, value: number) => ({
      legend: {},
      series: [{ type: "pie", data: [{ name, value }] }],
    });
    const long = layout(pie("A rather long name for a slice", 1)).series[0].right;
    assert.ok(long > layout(pie("A", 123_456_789)).series[0].right, String(long));
  });

  test("reserves room for a placed legend on the side ECharts shows it", () => {
    const bottom = layout(bars({ legend: { left: 0 } })).grid;
    assert.deepStrictEqual([bottom.top, bottom.bottom], [14, 40]);
    const top = layout(bars({ legend: { top: 0 } })).grid;
    assert.deepStrictEqual([top.top, top.bottom], [44, 8]);
  });

  test("caps a pie legend without flattening or measuring every slice", () => {
    let reads = 0;
    const slice = {
      get name() {
        reads++;
        return "A very long slice name ".repeat(10);
      },
      value: 1,
    };
    const option = layout({
      legend: {},
      series: [{ type: "pie", data: Array(200_000).fill(slice) }],
    });
    assert.strictEqual(option.series[0].right, 280);
    assert.strictEqual(reads, 1);
  });
});
