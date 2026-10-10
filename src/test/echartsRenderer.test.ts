import * as assert from "node:assert";
import { init as initECharts } from "echarts";
import type * as ECharts from "echarts/core";
import { type ChartItems, modelOf } from "../webview/echartsItems";
import { EChartsRenderer } from "../webview/echartsRenderer";
import { afterTest } from "./afterTest";
import { item, itemsOf, withChart } from "./echartsModel";
import { testColors } from "./themeColors";

/** Exercise interaction updates without loading ECharts or constructing a browser document. */
function interactionRenderer() {
  const actions: unknown[] = [];
  let relayouts = 0;
  const renderer = Object.create(EChartsRenderer.prototype) as EChartsRenderer;
  Object.assign(renderer, {
    chart: { dispatchAction: (action: unknown) => actions.push(action) },
    chartItems: itemsOf({
      series: [{ type: "pie", data: ["A", "B", "C", "D"].map((name) => ({ name, value: 1 })) }],
    }),
    annotation: { marks: [], dim: false },
    hasHighlights: false,
    selectedKeys: new Set<string>(),
    shownSelected: [],
    selectionScheduled: false,
    relayout: () => relayouts++,
  });
  return { renderer, actions, relayouts: () => relayouts };
}

/**
 * A renderer that has drawn the option at 400 × 300 as the panel lays it out, its container, and
 * the internals that a test reaches into.
 */
function drawnRenderer(option: Record<string, unknown>) {
  const container = { clientWidth: 400, clientHeight: 300 };
  const renderer = Object.create(EChartsRenderer.prototype) as EChartsRenderer;
  Object.assign(renderer, {
    echarts: {
      init: (_: unknown, __: unknown, size: { width: number; height: number }) => {
        const chart = initECharts(null, undefined, { renderer: "svg", ssr: true, ...size });
        afterTest(() => chart.dispose());
        return chart;
      },
    },
    container,
    option,
    title: "",
    theme: { colors: testColors, echarts: {} },
    annotation: { marks: [], dim: false },
    selectedKeys: new Set(),
    reducedMotion: { matches: true },
    tabHidden: () => false,
    focus: { chartChanged: () => {}, chartDrawn: () => {} },
    laidOut: "",
  });
  const internals = renderer as unknown as {
    apply(relayout: boolean): void;
    items(): ChartItems | undefined;
    chart: ECharts.ECharts;
  };
  internals.apply(false);
  return { container, renderer, internals };
}

/**
 * Draws the option, changes the chart as a user would, and lays it out again for another width as
 * a resize of the panel does, reading the chart before and after.
 */
function relayout<T>(
  option: Record<string, unknown>,
  change: (chart: ECharts.ECharts) => void,
  read: (chart: ECharts.ECharts) => T,
): [T, T] {
  const { container, renderer, internals } = drawnRenderer(option);
  change(internals.chart);
  const before = read(internals.chart);
  container.clientWidth = 360;
  // As for a size that the chart is laid out differently for, which a resize alone cannot draw.
  Object.assign(renderer, { layout: undefined });
  internals.apply(true);
  return [before, read(internals.chart)];
}

suite("echartsRenderer", () => {
  test("indents a one-line JSON option for editing without changing its values", () => {
    const format = (source: string) => EChartsRenderer.prototype.formatForEditing(source);
    const values =
      '{"a": [], "b" :{}, "c":[1, {"d": "x\\"y, [z]: {}", "e": [true, null]}], "f": -1.5}';
    assert.strictEqual(format(values), JSON.stringify(JSON.parse(values), null, 2));
    // Parsing would round the integers beyond 2^53 and rewrite the numbers as JavaScript would.
    assert.strictEqual(
      format('{"id": 12345678901234567891, "ns": 1.50}'),
      '{\n  "id": 12345678901234567891,\n  "ns": 1.50\n}',
    );
    for (const source of ["{a: 1}", '{"a": 1}\n', "{"]) {
      assert.strictEqual(format(source), source);
    }
  });

  test("dispatches nothing when only the notes, kinds or order of the marks change", () => {
    const { renderer, actions } = interactionRenderer();
    renderer.showMarks({
      marks: [
        { id: "A", kind: "info" },
        { id: "B", kind: "info" },
      ],
      dim: false,
    });
    assert.deepStrictEqual(actions, [{ type: "highlight", batch: [item(0), item(1)] }]);
    actions.length = 0;
    renderer.showMarks({
      marks: [
        { id: "B", kind: "problem", note: "Changed note" },
        { id: "A", kind: "info" },
      ],
      dim: false,
    });
    assert.deepStrictEqual(actions, []);
  });

  test("downplays only the items no longer marked, and highlights those still marked again", () => {
    const { renderer, actions } = interactionRenderer();
    const mark = (id: string) => ({ id, kind: "info" as const });
    renderer.showMarks({ marks: [mark("A"), mark("B")], dim: false });
    actions.length = 0;
    renderer.showMarks({ marks: [mark("B"), mark("C")], dim: false });
    assert.deepStrictEqual(actions, [
      { type: "downplay", batch: [item(0)] },
      { type: "highlight", batch: [item(1), item(2)] },
    ]);
    actions.length = 0;
    renderer.showMarks({ marks: [mark("B"), mark("C"), mark("D")], dim: false });
    assert.deepStrictEqual(actions, [{ type: "highlight", batch: [item(1), item(2), item(3)] }]);
    actions.length = 0;
    renderer.showMarks({ marks: [], dim: false });
    assert.deepStrictEqual(actions, [{ type: "downplay", batch: [item(1), item(2), item(3)] }]);
  });

  test("restores every remaining highlight after downplay clears a dimmed chart's blur", () => {
    const { renderer, actions } = interactionRenderer();
    Object.assign(renderer, {
      annotation: {
        marks: [
          { id: "A", kind: "info" },
          { id: "B", kind: "info" },
        ],
        dim: true,
      },
      hasHighlights: true,
    });
    renderer.showMarks({ marks: [{ id: "B", kind: "info" }], dim: true });
    // Once more without blurring, which another mark's blur would cover.
    assert.deepStrictEqual(actions, [
      { type: "downplay", batch: [item(0)] },
      { type: "highlight", batch: [item(1), { ...item(1), notBlur: true }] },
    ]);
  });

  test("lays the chart out again when only the dimming changes", () => {
    const { renderer, relayouts } = interactionRenderer();
    const marks = [{ id: "A", kind: "info" as const }];
    renderer.showMarks({ marks, dim: false });
    renderer.showMarks({ marks, dim: true });
    assert.strictEqual(relayouts(), 1);
    renderer.showMarks({ marks, dim: false });
    assert.strictEqual(relayouts(), 2);
  });

  test("marks an item by its id, not the first item of the same name", () => {
    const { renderer, actions } = interactionRenderer();
    Object.assign(renderer, {
      chartItems: itemsOf({
        series: [
          {
            type: "sankey",
            data: [{ name: "Q" }, { id: "Yes (q1)", name: "Yes" }, { id: "Yes (q2)", name: "Yes" }],
            links: [
              { source: "Q", target: "Yes (q1)", value: 1 },
              { source: "Yes (q1)", target: "Yes (q2)", value: 1 },
            ],
          },
        ],
      }),
    });
    renderer.showMarks({ marks: [{ id: "Yes (q2)", kind: "info" }], dim: false });
    assert.deepStrictEqual(actions, [{ type: "highlight", batch: [item(2, 0, "node")] }]);
  });

  test("coalesces selection updates and selects only the latest items", async () => {
    const { renderer, actions } = interactionRenderer();
    renderer.showSelection(new Set(["0::1"]));
    renderer.showSelection(new Set(["0::2"]));
    assert.deepStrictEqual(actions, []);
    await Promise.resolve();
    assert.deepStrictEqual(actions, [{ type: "select", batch: [item(2)] }]);
    actions.length = 0;
    renderer.showSelection(new Set(["0::3"]));
    await Promise.resolve();
    assert.deepStrictEqual(actions, [{ type: "select", batch: [item(3)] }]);
  });

  test("takes a click on a treemap's root or breadcrumb, or a sunburst's root, to navigate", () => {
    const cases = [
      ["treemap", {}, true],
      ["treemap", { nodeClick: false }, false],
      ["treemap", { nodeClick: "link" }, false],
      ["sunburst", {}, true],
    ] as const;
    for (const [type, options, navigates] of cases) {
      const series = { type, ...options, data: [{ name: "A", value: 1 }] };
      withChart({ series: [series] }, (chart) => {
        const renderer = Object.create(EChartsRenderer.prototype) as EChartsRenderer;
        Object.assign(renderer, { chart });
        const call = (method: string, event: object) =>
          (renderer as unknown as Record<string, (event: object) => unknown>)[method]?.call(
            renderer,
            // ECharts calls the one data of a tree "main" in events.
            { seriesIndex: 0, seriesType: type, dataType: "main", ...event },
          );
        const what = JSON.stringify(series);
        assert.deepStrictEqual(
          call("hitFor", { dataIndex: 1 }),
          { key: "0::1", node: { id: "A", label: "A" } },
          what,
        );
        // The root ECharts adds above the data is no item, and neither is a breadcrumb, whose
        // click names its node only in `nodeData`.
        assert.strictEqual(call("hitFor", { dataIndex: 0 }), undefined, what);
        assert.strictEqual(call("navigates", { dataIndex: 0 }), navigates, what);
        if (type === "treemap") {
          const breadcrumb = {
            selfType: "breadcrumb",
            dataType: undefined,
            nodeData: { dataIndex: 0 },
          };
          assert.strictEqual(call("hitFor", breadcrumb), undefined, what);
          assert.strictEqual(call("navigates", breadcrumb), true, what);
        }
      });
    }
  });

  test("keeps a force layout, a drilled-down treemap and expanded tree nodes in a new layout", () => {
    const nodes = ["A", "B", "C", "D", "E"].map((name) => ({ name }));
    const links = [
      { source: "A", target: "B" },
      { source: "B", target: "C" },
      { source: "C", target: "D" },
    ];
    // Laid out at once rather than over frames, to read where the nodes end up.
    const graph = { type: "graph", layout: "force", force: { layoutAnimation: false } };
    const [placed, kept] = relayout(
      { series: [{ ...graph, data: nodes, links }] },
      () => {},
      (chart) => ({ ...modelOf(chart).getSeriesByIndex(0)?.preservedPoints }),
    );
    // A force layout goes on from where it left the nodes, rather than from random places.
    assert.deepStrictEqual(kept, placed);

    const tree = {
      name: "root",
      children: [
        { name: "a", children: [{ name: "a1", value: 1 }] },
        { name: "b", value: 1 },
      ],
    };
    const viewRoot = (chart: ECharts.ECharts) =>
      modelOf(chart).getSeriesByIndex(0)?.getViewRoot?.().dataIndex;
    for (const type of ["treemap", "sunburst"]) {
      const [drilled, still] = relayout(
        { series: [{ type, data: [tree] }] },
        (chart) =>
          chart.dispatchAction({ type: `${type}RootToNode`, seriesIndex: 0, targetNodeId: "a" }),
        viewRoot,
      );
      assert.strictEqual(drilled, 2, type);
      assert.strictEqual(still, drilled, type);
    }

    const expanded = (chart: ECharts.ECharts) => {
      const data = modelOf(chart).getSeriesByIndex(0)?.getRawData();
      return [1, 2].map((index) => data?.tree?.getNodeByDataIndex(index).isExpand);
    };
    const [toggled, same] = relayout(
      { series: [{ type: "tree", data: [tree] }] },
      (chart) =>
        chart.dispatchAction({ type: "treeExpandAndCollapse", seriesIndex: 0, dataIndex: 2 }),
      expanded,
    );
    assert.deepStrictEqual(toggled, [true, false]);
    assert.deepStrictEqual(same, toggled);
  });

  test("keeps the legend selection and zoom that the user changed in a new layout", () => {
    const option = {
      xAxis: { type: "category", data: ["a", "b", "c", "d"] },
      yAxis: {},
      dataZoom: [{ type: "inside", startValue: 1, endValue: 2 }],
      series: ["One", "Two"].map((name) => ({ type: "bar", name, data: [1, 2, 3, 4] })),
    };
    const [changed, kept] = relayout(
      option,
      (chart) => {
        chart.dispatchAction({ type: "legendUnSelect", name: "Two" });
        chart.dispatchAction({ type: "dataZoom", start: 25, end: 75 });
      },
      (chart) => {
        const { legend, dataZoom } = chart.getOption() as Record<string, Record<string, unknown>[]>;
        return { selected: legend?.[0]?.selected, start: dataZoom?.[0]?.start };
      },
    );
    assert.deepStrictEqual(changed, { selected: { One: true, Two: false }, start: 25 });
    assert.deepStrictEqual(kept, changed);
  });

  test("only resizes a chart for a size that it is laid out the same for", () => {
    const labels = ["Category A", "Category B", "Category C"];
    const { container, renderer, internals } = drawnRenderer({
      xAxis: { type: "category", data: labels },
      yAxis: {},
      series: [{ type: "bar", data: [1, 2, 3] }],
    });
    const { chart } = internals;
    let setOptions = 0;
    const setOption = chart.setOption.bind(chart);
    chart.setOption = ((option: ECharts.EChartsCoreOption, settings: boolean) => {
      setOptions++;
      return setOption(option, settings);
    }) as typeof chart.setOption;
    // The labels fit either way.
    container.clientWidth = 380;
    internals.apply(true);
    assert.strictEqual(setOptions, 0);
    assert.strictEqual(chart.getWidth(), 380);
    // The labels no longer fit side by side.
    container.clientWidth = 200;
    internals.apply(true);
    assert.strictEqual(setOptions, 1);
    // Dimming around marks takes a layout of its own.
    Object.assign(renderer, {
      annotation: { marks: [{ id: "Category A", kind: "info" }], dim: true },
    });
    container.clientWidth = 210;
    internals.apply(true);
    assert.strictEqual(setOptions, 2);
  });

  test("works out the items of another timeline step anew", () => {
    const slices = (...names: string[]) => [{ data: names.map((name) => ({ name, value: 1 })) }];
    /** A renderer of a chart whose timeline steps show other items, and how to find them. */
    const timelineRenderer = () => {
      const drawn = drawnRenderer({
        baseOption: { timeline: { data: ["2025", "2026"] }, series: [{ type: "pie" }] },
        options: [{ series: slices("Apples", "Pears") }, { series: slices("Kiwis", "Plums") }],
      });
      const find = (name: string) => drawn.internals.items()?.find(name);
      assert.deepStrictEqual(find("Apples"), [item(0)]);
      return { ...drawn, find };
    };
    // The user steps the timeline: its event drops the items, also when the layout stays.
    const stepped = timelineRenderer();
    stepped.internals.chart.dispatchAction({ type: "timelineChange", currentIndex: 1 });
    assert.deepStrictEqual(stepped.find("Kiwis"), [item(0)]);
    stepped.container.clientWidth = 380;
    stepped.internals.apply(true);
    assert.deepStrictEqual(stepped.find("Kiwis"), [item(0)]);
    assert.deepStrictEqual(stepped.find("Apples"), []);
    // A step shown without the event, which a new layout must not take the items of the last for.
    const shown = timelineRenderer();
    shown.internals.chart.setOption({ timeline: { currentIndex: 1 } } as ECharts.EChartsCoreOption);
    // As for a size that the chart is laid out differently for.
    Object.assign(shown.renderer, { layout: undefined });
    shown.container.clientWidth = 200;
    shown.internals.apply(true);
    assert.deepStrictEqual(shown.find("Kiwis"), [item(0)]);
    assert.deepStrictEqual(shown.find("Apples"), []);
  });
});
