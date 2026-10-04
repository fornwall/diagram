import * as assert from "node:assert";
import { ChartNavigation } from "../webview/echartsFocus";
import { itemKey } from "../webview/echartsItems";
import { withChart } from "./echartsModel";

/** The keys of the items that the keys lead to in turn, from the first item. */
function walk(option: Record<string, unknown>, keys: string[]): (string | undefined)[] {
  return withChart({ animation: false, ...option }, (chart) => {
    const navigation = new ChartNavigation(chart);
    let at = navigation.first();
    return keys.map((key) => {
      at = (at && navigation.move(at, key)) ?? at;
      return at && itemKey(at);
    });
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
    const keys = ["ArrowRight", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowRight", "ArrowRight"];
    assert.deepStrictEqual(walk(bars(false), [...keys, "ArrowUp", "ArrowLeft", "Home", "End"]), [
      "0::1",
      "1::1",
      "2::1",
      "2::1",
      "2::2",
      "2::2",
      "1::2",
      "1::1",
      "0::0",
      "2::2",
    ]);
  });

  test("moves along a series of horizontal bars with the up and down keys", () => {
    // The first category is at the bottom.
    assert.deepStrictEqual(walk(bars(true), ["ArrowUp", "ArrowUp", "ArrowRight", "ArrowDown"]), [
      "0::1",
      "0::2",
      "1::2",
      "1::1",
    ]);
  });

  test("steps round the slices of pies with every arrow key", () => {
    const pie = (center: string) => ({
      type: "pie",
      center: [center, "50%"],
      radius: "20%",
      data: [1, 2].map((value) => ({ name: `${center}${value}`, value })),
    });
    assert.deepStrictEqual(
      walk({ series: [pie("25%"), pie("75%")] }, [
        "ArrowRight",
        "ArrowDown",
        "ArrowRight",
        "ArrowRight",
        "ArrowLeft",
        "ArrowUp",
      ]),
      ["0::1", "1::0", "1::1", "0::0", "1::1", "1::0"],
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
      assert.deepStrictEqual(
        walk({ series: [{ type, data }] }, [
          "ArrowLeft",
          "ArrowRight",
          "ArrowDown",
          "ArrowDown",
          "ArrowRight",
          "ArrowUp",
          "ArrowLeft",
          "ArrowLeft",
        ]),
        ["0::1", "0::2", "0::4", "0::4", "0::5", "0::5", "0::4", "0::1"],
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
    const [edge, node, back] = walk({ series: [sankey] }, [
      "ArrowRight",
      "ArrowRight",
      "ArrowLeft",
    ]);
    assert.match(edge ?? "", /^0:edge:[01]$/);
    assert.match(node ?? "", /^0:node:[12]$/);
    assert.strictEqual(back, edge);
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
    assert.deepStrictEqual(walk(option, ["ArrowRight", "ArrowDown", "End"]), [
      "0::1",
      "2::1",
      "2::2",
    ]);
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
  });
});
