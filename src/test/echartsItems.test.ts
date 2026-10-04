import * as assert from "node:assert";
import { modelOf } from "../webview/echartsItems";
import { itemsOf, withChart } from "./echartsModel";

const item = (dataIndex: number, seriesIndex = 0, dataType?: string) => ({
  seriesIndex,
  dataType,
  dataIndex,
});

suite("echartsItems", () => {
  test("reads the parts of ECharts' private model that it relies on", () => {
    // If this fails, an update of ECharts changed its model: adapt the interfaces in echartsItems.ts.
    const methods = (object: unknown, where: string, names: string[]) => {
      for (const name of names) {
        const member = (object as Record<string, unknown> | undefined)?.[name];
        assert.strictEqual(typeof member, "function", `ECharts no longer has ${where}.${name}()`);
      }
    };
    const graph = {
      type: "graph",
      data: [{ name: "a" }, { name: "b" }],
      links: [{ source: 0, target: 1 }],
    };
    const options = [
      [{ xAxis: {}, yAxis: {}, series: [{ type: "line", data: [[1, 2]] }] }, [undefined]],
      [{ series: [graph] }, ["node", "edge"]],
      [{ series: [{ type: "treemap", data: [{ name: "a", value: 1 }] }] }, ["main"]],
    ] as const;
    for (const [option, dataTypes] of options) {
      withChart(option, (chart) => {
        const model = modelOf(chart);
        methods(model, "GlobalModel", ["getSeriesCount", "getSeriesByIndex", "eachRawSeries"]);
        model.eachRawSeries((series) => {
          methods(series, "SeriesModel", ["get", "getRawData", "getAllData"]);
          assert.strictEqual(series.componentIndex, 0, "SeriesModel.componentIndex");
          assert.strictEqual(typeof series.name, "string", "SeriesModel.name");
          assert.strictEqual(model.getSeriesByIndex(0), series, "GlobalModel.getSeriesByIndex");
          const datas = series.getAllData().map(({ data }) => data);
          assert.deepStrictEqual(
            datas.map((data) => data.dataType),
            dataTypes,
            "SeriesData.dataType",
          );
          for (const data of [series.getRawData(), ...datas]) {
            const names = ["count", "getRawIndex", "getName", "getRawDataItem", "indexOfRawIndex"];
            methods(data, "SeriesData", names);
          }
          const tree = series.getRawData().tree;
          if (dataTypes[0] === "main") {
            methods(tree, "Tree", ["getNodeByDataIndex"]);
            const node = tree?.getNodeByDataIndex(1);
            methods(node, "TreeNode", ["getRawIndex"]);
            assert.strictEqual(node?.parentNode?.getRawIndex(), 0, "TreeNode.parentNode");
            assert.ok(!tree?.getNodeByDataIndex(0).parentNode, "the root is data index 0");
            assert.strictEqual(series.get("nodeClick"), "zoomToNode", "SeriesModel.get");
          }
        });
      });
    }
  });

  test("names sankey nodes by their ids and labels them by name", () => {
    const items = itemsOf({
      series: [
        {
          type: "sankey",
          data: [{ name: "Q1" }, { id: "Yes (q1)", name: "Yes" }, { id: "Yes (q2)", name: "Yes" }],
          links: [
            { source: "Q1", target: "Yes (q1)", value: 2 },
            { source: "Yes (q1)", target: "Yes (q2)", value: 1 },
          ],
        },
      ],
    });
    assert.deepStrictEqual(items.node("0:node:2"), { id: "Yes (q2)", label: "Yes" });
    assert.deepStrictEqual(items.node("0:edge:1"), {
      id: "Yes (q1) → Yes (q2)",
      label: "Yes → Yes",
    });
    // ECharts would highlight only the first "Yes": the id finds the second.
    assert.deepStrictEqual(items.find("Yes (q2)"), [item(2, 0, "node")]);
    assert.deepStrictEqual(items.find("Yes"), [item(1, 0, "node"), item(2, 0, "node")]);
    assert.deepStrictEqual(items.find("Q1"), [item(0, 0, "node")]);
    assert.deepStrictEqual(items.repeatedNames(), [
      { name: "Yes", ids: ["Yes (q1)", "Yes (q2)"], count: 2 },
    ]);
    // Notes name an item by its label, unless other items go by it too.
    assert.strictEqual(items.labelOf("Yes (q2)"), "Yes (q2)");
    assert.strictEqual(items.labelOf("Yes (q1) → Yes (q2)"), "Yes → Yes");
    assert.strictEqual(items.labelOf("Q1"), "Q1");
    assert.strictEqual(items.labelOf("No"), undefined);
  });

  test("tells apart repeated names without ids by their position", () => {
    const items = itemsOf({
      legend: { selected: { B: false } },
      series: [
        {
          type: "pie",
          data: [
            { name: "A", value: 1 },
            { name: "B", value: 2 },
            { name: "A", value: 3 },
          ],
        },
      ],
    });
    assert.deepStrictEqual(items.node("0::2"), { id: "A (item 3)", label: "A" });
    // A slice hidden by the legend can still be marked once shown again.
    assert.deepStrictEqual(items.node("0::1"), { id: "B", label: "B" });
    assert.deepStrictEqual(items.find("A (item 3)"), [item(2)]);
    assert.deepStrictEqual(items.repeatedNames(), [
      { name: "A", ids: ["A (item 1)", "A (item 3)"], count: 2 },
    ]);
  });

  test("prefixes items of several series with the series name", () => {
    const items = itemsOf({
      dataset: {
        source: [
          ["day", "sales", "costs"],
          ["Mon", 1, 2],
          ["Tue", 3, 4],
          ["Mon", 5, 6],
        ],
      },
      xAxis: { type: "category" },
      yAxis: {},
      series: [{ type: "bar" }, { type: "line", name: "Plan" }, { type: "line", name: "Plan" }],
    });
    assert.deepStrictEqual(items.node("0::1"), { id: "sales/Tue", label: "Tue" });
    assert.deepStrictEqual(items.node("1::2"), { id: "Plan/Mon (item 3)", label: "Mon" });
    // A series of the same name as another is told apart by its index.
    assert.deepStrictEqual(items.node("2::2"), {
      id: "Plan (series 3)/Mon (item 3)",
      label: "Mon",
    });
    // A name without a series marks the item in every series, as ECharts does.
    assert.deepStrictEqual(items.find("Tue"), [item(1), item(1, 1), item(1, 2)]);
    assert.deepStrictEqual(items.find("sales/Tue"), [item(1)]);
    assert.deepStrictEqual(items.find("Plan (series 3)/Mon (item 3)"), [item(2, 2)]);
    assert.deepStrictEqual(items.find("Mon (item 3)"), [item(2), item(2, 1), item(2, 2)]);
    assert.strictEqual(items.labelOf("sales/Tue"), "sales/Tue");
    assert.strictEqual(items.labelOf("Tue"), "Tue");
    const repeated = items.repeatedNames().map(({ name, count }) => [name, count]);
    assert.deepStrictEqual(repeated, [
      ["sales/Mon", 2],
      ["Mon", 6],
      ["Plan/Mon", 2],
      ["Plan (series 3)/Mon", 2],
    ]);
  });

  test("names the nodes of a tree by their path", () => {
    const tree = [
      {
        name: "src",
        children: [
          { name: "a", children: [{ name: "index.ts", value: 1 }] },
          { name: "b", children: [{ name: "index.ts", value: 2 }] },
          { name: "b", children: [{ name: "index.ts", value: 3 }] },
        ],
      },
    ];
    for (const type of ["treemap", "sunburst", "tree"]) {
      // The series shares its name with the top node, and its value with no other.
      const items = itemsOf({ series: [{ type, name: "src", data: tree }] });
      // Index 0 is the root ECharts adds above the data, which is no item of its own.
      assert.strictEqual(items.node("0::0"), undefined, type);
      assert.deepStrictEqual(items.node("0::1"), { id: "src", label: "src" }, type);
      assert.deepStrictEqual(items.find("src"), [item(1)], type);
      assert.deepStrictEqual(items.node("0::3"), { id: "src/a/index.ts", label: "index.ts" }, type);
      assert.deepStrictEqual(items.find("src/a/index.ts"), [item(3)], type);
      // Paths that repeat are told apart by position.
      assert.deepStrictEqual(items.node("0::7"), {
        id: "src/b/index.ts (item 8)",
        label: "index.ts",
      });
      assert.deepStrictEqual(
        items.repeatedNames().map(({ name, ids }) => [name, ids]),
        [
          ["index.ts", ["src/a/index.ts", "src/b/index.ts (item 6)", "src/b/index.ts (item 8)"]],
          ["src/b", ["src/b (item 5)", "src/b (item 7)"]],
          ["b", ["src/b (item 5)", "src/b (item 7)"]],
          ["src/b/index.ts", ["src/b/index.ts (item 6)", "src/b/index.ts (item 8)"]],
        ],
        type,
      );
      assert.strictEqual(items.labelOf("src/a/index.ts"), "src/a/index.ts");
      assert.strictEqual(items.labelOf("src/a"), "a");
    }
  });

  test("labels unnamed items by value, and lists only the first ids of a repeated name", () => {
    const items = itemsOf({
      xAxis: {},
      yAxis: {},
      series: [{ type: "scatter", data: Array.from({ length: 30 }, () => [1, 2]) }],
    });
    assert.deepStrictEqual(items.node("0::29"), { id: "(1, 2) (item 30)", label: "(1, 2)" });
    const [repeated] = items.repeatedNames();
    assert.strictEqual(repeated?.ids.length, 20);
    assert.strictEqual(repeated?.count, 30);
  });
});
