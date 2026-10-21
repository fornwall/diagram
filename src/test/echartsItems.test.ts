import * as assert from "node:assert";
import { itemKey, modelOf } from "../webview/echartsItems";
import { bars, item, itemsOf, withChart } from "./echartsModel";

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
      layout: "circular",
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
        methods(model, "GlobalModel", [
          "getSeriesCount",
          "getSeriesByIndex",
          "eachRawSeries",
          "eachSeries",
          "getComponent",
        ]);
        assert.ok(Array.isArray(model.option.series), "GlobalModel.option");
        model.eachRawSeries((series) => {
          methods(series, "SeriesModel", ["get", "getRawData", "getAllData", "getBaseAxis"]);
          assert.strictEqual(series.componentIndex, 0, "SeriesModel.componentIndex");
          assert.strictEqual(typeof series.name, "string", "SeriesModel.name");
          assert.ok(series.id.startsWith("\u0000"), "SeriesModel.id");
          assert.strictEqual(series.subType, option.series[0]?.type, "SeriesModel.subType");
          assert.strictEqual(model.getSeriesByIndex(0), series, "GlobalModel.getSeriesByIndex");
          const datas = series.getAllData().map(({ data }) => data);
          assert.deepStrictEqual(
            datas.map((data) => data.dataType),
            dataTypes,
            "SeriesData.dataType",
          );
          for (const data of [series.getRawData(), ...datas]) {
            const names = ["count", "getRawIndex", "getName", "getRawDataItem", "indexOfRawIndex"];
            methods(data, "SeriesData", [
              ...names,
              "getItemGraphicEl",
              "getLayout",
              "getDimensionInfo",
              "get",
              "getDimensionIndex",
            ]);
            assert.ok(Array.isArray(data.dimensions), "SeriesData.dimensions");
          }
          const graphic = datas[0]?.getItemGraphicEl(dataTypes[0] === "main" ? 1 : 0);
          methods(graphic, "Element", ["getBoundingRect", "getComputedTransform"]);
          methods(graphic?.getBoundingRect().clone(), "BoundingRect", ["applyTransform"]);
          const tree = series.getRawData().tree;
          if (dataTypes[0] === "main") {
            methods(tree, "Tree", ["getNodeByDataIndex"]);
            const node = tree?.getNodeByDataIndex(1);
            methods(node, "TreeNode", ["getRawIndex", "getLayout", "getModel"]);
            methods(series, "SeriesModel", ["getViewRoot"]);
            assert.strictEqual(node?.dataIndex, 1, "TreeNode.dataIndex");
            assert.strictEqual(node?.parentNode?.getRawIndex(), 0, "TreeNode.parentNode");
            assert.ok(!tree?.getNodeByDataIndex(0).parentNode, "the root is data index 0");
            assert.strictEqual(tree?.root.children[0], node, "Tree.root, TreeNode.children");
            assert.strictEqual(series.get("nodeClick"), "zoomToNode", "SeriesModel.get");
          }
        });
      });
    }
  });

  test("reads the data view of the toolbox where ECharts keeps it", () => {
    // If this fails, an update of ECharts changed its toolbox: adapt openDataView in echartsItems.ts.
    const option = { toolbox: { feature: { dataView: {} } }, series: [{ type: "pie", data: [1] }] };
    withChart(option, (chart) => {
      const toolboxes: object[] = [];
      modelOf(chart).eachComponent("toolbox", (toolbox) => toolboxes.push(toolbox));
      assert.strictEqual(toolboxes.length, 1, "GlobalModel.eachComponent");
      const views = chart as unknown as { getViewOfComponentModel(model: object): unknown };
      const view = views.getViewOfComponentModel(toolboxes[0] ?? {}) as {
        _features?: { get(name: string): Record<string, unknown> | undefined };
      };
      const feature = view?._features?.get("dataView");
      assert.strictEqual(typeof feature?.onclick, "function", "ToolboxView._features");
      // Closed, which it says by keeping no element.
      assert.ok(feature && !feature._dom, "DataView._dom");
    });
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
    const repeated = items.repeatedNames().map(({ name, count }) => [name, count]);
    assert.deepStrictEqual(repeated, [
      ["sales/Mon", 2],
      ["Mon", 6],
      ["Plan/Mon", 2],
      ["Plan (series 3)/Mon", 2],
    ]);
  });

  test("keeps generated item ids distinct from literal names and ids", () => {
    const names = ["A", "A", "A (item 1)", "A (item 1) (item 1)"];
    for (const key of ["name", "id"]) {
      const items = itemsOf({
        series: [
          { type: "pie", data: names.map((name, index) => ({ [key]: name, value: index + 1 })) },
        ],
      });
      const ids = names.map((_, index) => items.node(itemKey(item(index)))?.id);
      assert.deepStrictEqual(ids, [
        "A (item 1) (item 1) (item 1)",
        "A (item 2)",
        "A (item 1)",
        "A (item 1) (item 1)",
      ]);
      ids.forEach((id, index) => {
        assert.ok(id);
        assert.deepStrictEqual(items.find(id), [item(index)], key);
      });
      assert.deepStrictEqual(items.find("A"), [item(0), item(1)]);
      assert.deepStrictEqual(items.repeatedNames(), [
        { name: "A", ids: ids.slice(0, 2), count: 2 },
      ]);
    }
  });

  test("keeps generated series prefixes distinct from literal series names", () => {
    const names = ["Plan", "Plan (series 3)", "Plan", "Plan (series 3) (series 3)"];
    const items = itemsOf({
      series: names.map((name) => ({ type: "pie", name, data: [{ name: "A", value: 1 }] })),
    });
    const ids = names.map((_, series) => items.node(itemKey(item(0, series)))?.id);
    assert.strictEqual(new Set(ids).size, names.length);
    ids.forEach((id, series) => {
      assert.ok(id);
      assert.deepStrictEqual(items.find(id), [item(0, series)]);
    });
  });

  test("keeps a generated edge id distinct from a node's name", () => {
    const items = itemsOf({
      series: [
        {
          type: "graph",
          layout: "circular",
          data: ["A", "B", "A → B (edge 1)"].map((name) => ({ name })),
          links: [
            { source: "A", target: "B" },
            { source: "A", target: "B" },
          ],
        },
      ],
    });
    const edge = item(0, 0, "edge");
    const id = items.node(itemKey(edge))?.id;
    assert.strictEqual(id, "A → B (edge 1) (edge 1)");
    assert.deepStrictEqual(items.find(id), [edge]);
    assert.deepStrictEqual(items.find("A → B (edge 1)"), [item(2, 0, "node")]);
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
    }
  });

  test("leaves out the trees after the first of a tree series, which ECharts does not draw", () => {
    const data = ["A", "B", "C"].map((name) => ({ name, children: [{ name: "leaf", value: 1 }] }));
    const tree = itemsOf({ series: [{ type: "tree", name: "Org", data }] });
    assert.deepStrictEqual(tree.node("0::2"), { id: "A/leaf", label: "leaf" });
    assert.strictEqual(tree.node("0::3"), undefined);
    assert.deepStrictEqual(tree.find("leaf"), [item(2)]);
    assert.deepStrictEqual(tree.repeatedNames(), []);
    assert.deepStrictEqual(tree.warnings, [
      'Tree series 1 ("Org") has 3 trees in its data, of which ECharts draws only the first: put them under one root node to draw them all.',
    ]);
    const unnamed = itemsOf({ series: [{ type: "tree", data: data.slice(0, 2) }] });
    assert.match(unnamed.warnings.join(), /^Tree series 1 has 2 trees/);
    // A treemap and a sunburst draw them all.
    for (const type of ["treemap", "sunburst"]) {
      const items = itemsOf({ series: [{ type, data }] });
      assert.deepStrictEqual(items.find("C/leaf"), [item(6)], type);
      assert.deepStrictEqual(items.warnings, [], type);
    }
  });

  test("tells a model of a chart without data, which draws only its axes", () => {
    const warnings = (option: Record<string, unknown>) => itemsOf(option).warnings;
    assert.match(
      warnings(bars({ series: [{ type: "bar", data: [] }] })).join(),
      /^The chart has no data/,
    );
    assert.match(
      warnings({ series: [{ type: "pie" }, { type: "treemap", data: [] }] }).join(),
      /no data/,
    );
    // Nor a chart of no series at all, such as of a graphic alone.
    assert.deepStrictEqual(warnings({ title: { text: "T" }, graphic: [{ type: "text" }] }), []);
    assert.deepStrictEqual(
      warnings(
        bars({
          series: [
            { type: "bar", data: [] },
            { type: "bar", data: [1] },
          ],
        }),
      ),
      [],
    );
    assert.deepStrictEqual(
      warnings({ dataset: { source: [["a", 1]] }, ...bars({ series: [{ type: "bar" }] }) }),
      [],
    );
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
    // Dates as a time axis labels them, rather than as JavaScript writes them out.
    for (const [date, text] of [
      [new Date(2020, 0, 2), "2020-01-02"],
      [new Date(2020, 0, 2, 10, 30), "2020-01-02 10:30:00"],
    ] as const) {
      const dated = itemsOf({
        xAxis: { type: "time" },
        yAxis: {},
        series: [{ type: "line", data: [[date, 1]] }],
      });
      assert.strictEqual(dated.node("0::0")?.label, `(${text}, 1)`);
    }
  });

  test("reads the same items from a new layout of the option, without working them out again", () => {
    const option = {
      series: [
        {
          type: "graph",
          layout: "circular",
          data: [
            { id: "1", name: "a" },
            { id: "2", name: "b" },
            { id: "3", name: "a" },
          ],
          links: [{ source: 0, target: 1 }],
        },
      ],
    };
    const items = itemsOf(option);
    withChart(option, (chart) => {
      assert.ok(items.rebind(chart));
      // The items no longer read the data of the chart they were worked out in.
      const series = modelOf(chart).getSeriesByIndex(0);
      for (const data of [
        series?.getRawData(),
        ...(series?.getAllData() ?? []).map((each) => each.data),
      ]) {
        if (data) data.getName = () => assert.fail("read the new chart");
      }
      assert.throws(() => items.node(itemKey(item(1, 0, "node"))), /read the new chart/);
    });
    withChart(option, (chart) => {
      items.rebind(chart);
      assert.deepStrictEqual(items.node(itemKey(item(1, 0, "node"))), { id: "2", label: "b" });
      assert.deepStrictEqual(items.node(itemKey(item(0, 0, "edge"))), {
        id: "0 → 1",
        label: "a → b",
      });
      assert.deepStrictEqual(items.find("a"), [item(0, 0, "node"), item(2, 0, "node")]);
    });
    // Another option, with other series or as many series of other items, has items of its own.
    withChart({ series: [option.series[0], option.series[0]] }, (chart) => {
      assert.strictEqual(items.rebind(chart), false);
    });
    const [graph] = option.series;
    withChart({ series: [{ ...graph, data: graph?.data.slice(0, 2) }] }, (chart) => {
      assert.strictEqual(items.rebind(chart), false);
    });
    // Which leaves the items reading the chart they were last read from.
    assert.deepStrictEqual(items.node(itemKey(item(2, 0, "node"))), { id: "3", label: "a" });
  });
});
