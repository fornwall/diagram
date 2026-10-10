import * as assert from "node:assert";
import { ChartNavigation } from "../webview/echartsFocus";
import { itemKey } from "../webview/echartsItems";
import { withChart } from "./echartsModel";

/**
 * The keys of the items that the keys, such as "Right Home", lead to in turn from the first item,
 * separated by spaces.
 */
function walk(option: Record<string, unknown>, keys: string): string {
  return withChart({ animation: false, ...option }, (chart) => {
    const navigation = new ChartNavigation(chart);
    let at = navigation.first();
    return keys
      .split(" ")
      .map((key) => {
        const name = /^(Up|Down|Left|Right)$/.test(key) ? `Arrow${key}` : key;
        at = (at && navigation.move(at, name)) ?? at;
        return at ? itemKey(at) : "none";
      })
      .join(" ");
  });
}

const bars = (horizontal: boolean) => {
  const category = { type: "category", data: ["Mon", "Tue", "Wed"] };
  return {
    [horizontal ? "yAxis" : "xAxis"]: category,
    [horizontal ? "xAxis" : "yAxis"]: {},
    series: [1, 2, 3].map((n) => ({ type: "bar", data: [n, n + 1, n + 2] })),
  };
};

suite("echartsFocus", () => {
  test("moves along a series, and across series to the same category", () => {
    assert.strictEqual(
      walk(bars(false), "Right Down Down Down Right Right Up Left Home End"),
      "0::1 1::1 2::1 2::1 2::2 2::2 1::2 1::1 0::0 2::2",
    );
  });

  test("moves along a series of horizontal bars with the up and down keys", () => {
    // The first category is at the bottom.
    assert.strictEqual(walk(bars(true), "Up Up Right Down"), "0::1 0::2 1::2 1::1");
  });

  test("steps round the slices of pies with every arrow key", () => {
    const pie = (center: string) => ({
      type: "pie",
      center: [center, "50%"],
      radius: "20%",
      data: [1, 2].map((value) => ({ name: `${center}${value}`, value })),
    });
    assert.strictEqual(
      walk({ series: [pie("25%"), pie("75%")] }, "Right Down Right Right Left Up"),
      "0::1 1::0 1::1 0::0 1::1 1::0",
    );
  });

  test("moves to the parent, first child and siblings in trees", () => {
    const data = [
      {
        name: "src",
        children: [
          { name: "a", children: [{ name: "a.ts", value: 2 }] },
          { name: "b", children: [{ name: "b.ts", value: 1 }] },
        ],
      },
    ];
    for (const type of ["treemap", "sunburst", "tree"]) {
      // Data index 0 is the root ECharts adds, which is no item; the nodes follow depth-first. A
      // sunburst orders children by value, as it draws them.
      assert.strictEqual(
        walk({ series: [{ type, data }] }, "Left Right Down Down Right Up Left Left"),
        "0::1 0::2 0::4 0::4 0::5 0::5 0::4 0::1",
        type,
      );
    }
  });

  test("moves to the nearest node or edge of a sankey diagram", () => {
    const sankey = {
      type: "sankey",
      data: [{ name: "a" }, { name: "b" }, { name: "c" }],
      links: [
        { source: "a", target: "b", value: 2 },
        { source: "a", target: "c", value: 1 },
      ],
    };
    // Along the flow from the node on the left, through an edge to a node on the right.
    const [edge, node, back] = walk({ series: [sankey] }, "Right Right Left").split(" ");
    assert.match(edge ?? "", /^0:edge:[01]$/);
    assert.match(node ?? "", /^0:node:[12]$/);
    assert.strictEqual(back, edge);
  });

  test("reaches every one of several points at the same place, in their order", () => {
    const scatter = {
      xAxis: {},
      yAxis: {},
      series: [
        {
          type: "scatter",
          data: [
            [1, 1],
            [1, 1],
            [1, 1],
            [2, 1],
          ],
        },
      ],
    };
    assert.strictEqual(
      walk(scatter, "Right Right Right Left Left Left Left"),
      "0::1 0::2 0::3 0::2 0::1 0::0 0::0",
    );
  });

  test("leaves out series hidden by the legend, and finds where lines without symbols are", () => {
    const option = {
      legend: { selected: { Hidden: false } },
      xAxis: { type: "category", data: ["a", "b", "c"] },
      yAxis: {},
      series: [
        { type: "line", name: "Shown", showSymbol: false, data: [1, 5, 2] },
        { type: "line", name: "Hidden", data: [1, 2, 3] },
        { type: "line", name: "Also", data: [3, 2, 1] },
      ],
    };
    assert.strictEqual(walk(option, "Right Down End"), "0::1 2::1 2::2");
    withChart({ animation: false, ...option }, (chart) => {
      const box = new ChartNavigation(chart).box({ seriesIndex: 0, dataIndex: 1 });
      assert.ok(box && box.x > 0 && box.y > 0, JSON.stringify(box));
    });
  });

  test("says what an item's value is and where it is", () => {
    withChart(bars(false), (chart) => {
      const navigation = new ChartNavigation(chart);
      assert.deepStrictEqual(navigation.about({ seriesIndex: 1, dataIndex: 2 }), {
        value: "4",
        position: 3,
        count: 3,
      });
    });
    // Categories by name rather than index, also those ECharts gives a box plot's values.
    const values = (series: Record<string, unknown>, yAxis: Record<string, unknown> = {}) =>
      withChart(
        {
          xAxis: { type: "category", data: ["Mon", "Tue"] },
          yAxis,
          visualMap: { min: 0, max: 10, show: false },
          series: [series],
        },
        (chart) => new ChartNavigation(chart).about({ seriesIndex: 0, dataIndex: 1 })?.value,
      );
    const heatmap = {
      type: "heatmap",
      data: [
        [0, 0, 5],
        [1, 1, 9],
      ],
    };
    assert.strictEqual(values(heatmap, { type: "category", data: ["AM", "PM"] }), "(PM, 9)");
    const boxplot = {
      type: "boxplot",
      data: [
        [1, 2, 3, 4, 5],
        [2, 3, 4, 5, 6],
      ],
    };
    assert.strictEqual(values(boxplot), "(2, 3, 4, 5, 6)");
    // Numbers that are categories themselves, on an axis that lists none.
    const about = (option: Record<string, unknown>) =>
      withChart(option, (chart) => {
        const navigation = new ChartNavigation(chart);
        return [0, 1].map((dataIndex) => navigation.about({ seriesIndex: 0, dataIndex })?.value);
      });
    const category = { type: "category" };
    const dataset = {
      source: [
        ["q", "v"],
        [1, 10],
        [2, 20],
      ],
    };
    const points = [
      [1, 10],
      [2, 20],
    ];
    assert.deepStrictEqual(
      [
        about({ dataset, xAxis: category, yAxis: {}, series: [{ type: "bar" }] }),
        about({ xAxis: category, yAxis: {}, series: [{ type: "line", data: points }] }),
        about({ xAxis: {}, yAxis: category, series: [{ type: "scatter", data: points }] }),
      ],
      [
        ["10", "20"],
        ["10", "20"],
        // Named by the category, "10" and "20".
        ["1", "2"],
      ],
    );
    // Of a wide dataset, whose columns the series does not use ECharts leaves out.
    const header = Array.from({ length: 40 }, (_, column) => `c${column}`);
    const row = (at: number) => header.map((_, column) => (column === 39 ? at : at * 100 + column));
    const [, wide] = about({
      dataset: { source: [header, row(0), row(1)] },
      xAxis: { type: "category", data: ["Mon", "Tue"] },
      yAxis: {},
      series: [{ type: "bar", encode: { x: "c39", y: "c5" } }],
    });
    assert.strictEqual(wide, `(${row(1).slice(0, 39).join(", ")})`);
  });
});
