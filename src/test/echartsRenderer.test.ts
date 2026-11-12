import * as assert from "node:assert";
import { init as initECharts, registerAction } from "echarts";
import type * as ECharts from "echarts/core";
import { type ChartItems, modelOf } from "../webview/echartsItems";
import { parseOption } from "../webview/echartsOption";
import { EChartsRenderer } from "../webview/echartsRenderer";
import { afterTest } from "./afterTest";
import { item, itemsOf, withChart } from "./echartsModel";
import { testColors } from "./themeColors";

/** An item as marks that do not dim the chart highlight it, blurring nothing. */
const marked = (dataIndex: number) => ({ ...item(dataIndex), notBlur: true });

/** Exercise interaction updates without loading ECharts or constructing a browser document. */
function interactionRenderer() {
  const actions: unknown[] = [];
  let redraws = 0;
  const renderer = Object.create(EChartsRenderer.prototype) as EChartsRenderer;
  Object.assign(renderer, {
    chart: {
      dispatchAction: (action: unknown) => actions.push(action),
      // Of a pie, whose items ECharts finds by their own indices.
      getModel: () => ({ getSeriesByIndex: () => ({ subType: "pie" }) }),
    },
    chartItems: itemsOf({
      series: [{ type: "pie", data: ["A", "B", "C", "D"].map((name) => ({ name, value: 1 })) }],
    }),
    annotation: { marks: [], dim: false },
    hasHighlights: false,
    selectedKeys: new Set<string>(),
    shownSelected: [],
    selectionScheduled: false,
    redraw: () => redraws++,
  });
  return { renderer, actions, redraws: () => redraws };
}

/** A renderer that has drawn the option at 400 × 300, its container, and the internals that a test reaches into. */
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
    theme: { colors: testColors, echarts: {} },
    annotation: { marks: [], dim: false },
    selectedKeys: new Set(),
    reducedMotion: { matches: true },
    tabHidden: () => false,
    focus: { chartChanged: () => {}, chartDrawn: () => {}, hide: () => {} },
  });
  const internals = renderer as unknown as {
    apply(): void;
    resize(): void;
    items(): ChartItems | undefined;
    chart: ECharts.ECharts;
  };
  internals.apply();
  return { container, renderer, internals };
}

suite("echartsRenderer", () => {
  test("indents a one-line JSON option for editing without changing its values", () => {
    const format = (source: string) => EChartsRenderer.prototype.formatForEditing(source);
    const values = '{"a": [], "b" :{}, "c":[1, {"d": "x\\"y, [z]: {}", "e": {}}], "f": -1.5}';
    assert.strictEqual(format(values), JSON.stringify(JSON.parse(values), null, 2));
    // Arrays of values alone on as few lines as fit, as of the points of a large chart.
    const points = Array.from({ length: 1000 }, (_, x) => [x, null, "a,]"]);
    const formatted = format(JSON.stringify({ data: points, e: [true, [[]]] }));
    assert.deepStrictEqual(JSON.parse(formatted), { data: points, e: [true, [[]]] });
    const lines = formatted.split("\n");
    assert.match(lines[1] ?? "", /^ {2}"data": \[\[0, null, "a,\]"\], \[1, null, .*\],$/);
    assert.match(lines[2] ?? "", /^ {4}\[\d+, null, "a,\]"\], \[\d+, null, .*\],$/);
    assert.ok(lines.length < 250, String(lines.length));
    assert.ok(lines.every((line) => line.length < 130));
    assert.strictEqual(lines.at(-2), '  "e": [true, [[]]]');
    // Also the values of an array inside one, as of a dataset's row, once the line is long.
    const rows = [[Array.from({ length: 1000 }, (_, x) => [x, x])]];
    const nested = format(JSON.stringify({ rows })).split("\n");
    assert.deepStrictEqual(JSON.parse(nested.join("\n")), { rows });
    assert.ok(
      nested.length > 20 && nested.every((line) => line.length < 330),
      String(nested.length),
    );
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
    assert.deepStrictEqual(actions, [{ type: "highlight", batch: [marked(0), marked(1)] }]);
    actions.length = 0;
    renderer.showMarks({
      marks: [
        { id: "B", kind: "problem" },
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
      { type: "highlight", batch: [marked(1), marked(2)] },
    ]);
    actions.length = 0;
    renderer.showMarks({ marks: [mark("B"), mark("C"), mark("D")], dim: false });
    assert.deepStrictEqual(actions, [
      { type: "highlight", batch: [marked(1), marked(2), marked(3)] },
    ]);
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

  test("blurs nothing around marks that do not dim, as the option's emphasis.focus would", () => {
    const { renderer, internals } = drawnRenderer({
      animation: false,
      legend: {},
      tooltip: { trigger: "axis" },
      xAxis: { type: "category", data: ["A", "B"] },
      yAxis: {},
      series: ["S1", "S2"].map((name) => ({
        name,
        type: "bar",
        data: [1, 2],
        emphasis: { focus: "series" },
      })),
    });
    const chart = internals.chart;
    /** The states of the items of each series. */
    const states = () => {
      chart.getZr().animation.trigger("frame");
      return [0, 1].map((series) => {
        const data = modelOf(chart).getSeriesByIndex(series)?.getData();
        return [0, 1].map((index) => {
          const graphic = data?.getItemGraphicEl(index) as { currentStates?: string[] } | null;
          return graphic?.currentStates?.join("+") || "normal";
        });
      });
    };
    renderer.showMarks({ marks: [{ id: "S1/A", kind: "info" }], dim: false });
    const marked = [
      ["emphasis", "normal"],
      ["normal", "normal"],
    ];
    assert.deepStrictEqual(states(), marked);
    // The pointer over S2's legend entry, and off it again.
    chart.dispatchAction({ type: "highlight", seriesName: "S2" });
    chart.dispatchAction({ type: "downplay", seriesName: "S2" });
    assert.deepStrictEqual(states(), marked);
  });

  test("draws the chart anew when only the dimming changes", () => {
    const { renderer, redraws } = interactionRenderer();
    const marks = [{ id: "A", kind: "info" as const }];
    renderer.showMarks({ marks, dim: false });
    renderer.showMarks({ marks, dim: true });
    assert.strictEqual(redraws(), 1);
    renderer.showMarks({ marks, dim: false });
    assert.strictEqual(redraws(), 2);
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
    assert.deepStrictEqual(actions, [
      { type: "highlight", batch: [{ ...item(2, 0, "node"), notBlur: true }] },
    ]);
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

  test("names the callback of the option that throws, as the chart is drawn or used", async () => {
    const { renderer, container } = drawnRenderer({
      series: [{ type: "pie", data: [{ name: "A", value: 1 }] }],
    });
    Object.assign(container, { hidden: true, scrollTop: 0, setAttribute: () => {} });
    let changes = 0;
    Object.assign(renderer, {
      canvas: { classList: { add: () => {} }, dispatchEvent: () => ++changes },
      resizeObserver: { observe: () => {}, unobserve: () => {} },
    });
    // A failed render disposes of the chart, which cancels the frame of a resize. ECharts and the
    // guard log what is thrown.
    const { cancelAnimationFrame } = globalThis;
    const { error } = console;
    globalThis.cancelAnimationFrame ??= () => {};
    console.error = () => {};
    afterTest(() => {
      globalThis.cancelAnimationFrame = cancelAnimationFrame;
      console.error = error;
    });
    const bars = (series: string) =>
      `{\n  xAxis: {type: "category", data: ["A"]},\n  yAxis: {},\n  series: [${series}],\n}`;
    const labeled = '{type: "bar", data: [1], label: {show: true, formatter: (p) => p.data.x.y}}';
    await assert.rejects(renderer.render(bars(labeled), ""), {
      message:
        'The ECharts option\'s "formatter" threw while the chart was drawn: Cannot read ' +
        "properties of undefined (reading 'y') (line 4, column 84). Check what it reads of its " +
        `arguments, or leave it out.\n4 |   series: [${labeled}],\n  | ${" ".repeat(83)}^`,
    });
    // An error of ECharts' own is reported as such.
    await assert.rejects(
      renderer.render(
        '{series: [{type: "treemap", levels: 5, data: [{name: "a", value: 1}]}]}',
        "",
      ),
      { message: /^ECharts could not render this option: Cannot create property '0' on number/ },
    );
    // What a callback throws once the chart is drawn, as in the handler of the tooltip, is a
    // warning of the chart, told once.
    const source = bars('{type: "bar", data: [1]}').replace(
      "yAxis: {},",
      "yAxis: {},\n  tooltip: {formatter: (p) => p.nope.x},",
    );
    await renderer.render(source, "");
    const guard = (action: () => void) =>
      (renderer as unknown as { guard(action: () => void): void }).guard(action);
    const { formatter } = parseOption(source).tooltip as { formatter(p: unknown): unknown };
    for (let repeat = 0; repeat < 2; repeat++) guard(() => formatter({}));
    guard(() => {
      throw new Error("Thrown by the chart");
    });
    assert.strictEqual(changes, 1);
    assert.deepStrictEqual(
      renderer.warnings().filter((warning) => warning.includes("threw")),
      [
        'The ECharts option\'s "formatter" threw while the chart was used: Cannot read properties ' +
          "of undefined (reading 'x') (line 4, column 38). Check what it reads of its arguments, " +
          `or leave it out.\n4 |   tooltip: {formatter: (p) => p.nope.x},\n  | ${" ".repeat(37)}^`,
      ],
    );
    // Not of the next option.
    await renderer.render(bars('{type: "bar", data: [1]}'), "");
    assert.deepStrictEqual(renderer.warnings(), []);
  });

  test("draws a chart anew that ECharts left refusing every option by throwing in an action", () => {
    // An action whose handler throws, as ECharts' own can on an option it did not foresee.
    registerAction({ type: "diagramTestThrow", event: "diagramTestThrow", update: "none" }, () => {
      throw new Error("Thrown in an action");
    });
    const ssr = () =>
      initECharts(null, undefined, { renderer: "svg", ssr: true, width: 400, height: 300 });
    const [stuck, fresh] = [ssr(), ssr()];
    const renderer = Object.create(EChartsRenderer.prototype) as EChartsRenderer;
    Object.assign(renderer, {
      echarts: {},
      chart: stuck,
      createChart: () => fresh,
      container: { clientWidth: 400, clientHeight: 300 },
      option: { series: [{ type: "pie", data: [{ name: "A", value: 1 }] }] },
      theme: { colors: testColors, echarts: {} },
      annotation: { marks: [], dim: false },
      selectedKeys: new Set(),
      reducedMotion: { matches: true },
      tabHidden: () => false,
      focus: { chartChanged: () => {}, hide: () => {} },
    });
    const guard = (action: () => void) =>
      (renderer as unknown as { guard(action: () => void): void }).guard(action);
    const { cancelAnimationFrame } = globalThis;
    globalThis.cancelAnimationFrame ??= () => {};
    try {
      stuck.setOption({ series: [{ type: "pie", data: [{ name: "B", value: 1 }] }] });
      // An error that leaves ECharts able to draw is only reported.
      guard(() => {
        throw new Error("Thrown outside");
      });
      assert.strictEqual(Object.getOwnPropertyDescriptor(renderer, "chart")?.value, stuck);
      guard(() => stuck.dispatchAction({ type: "diagramTestThrow" }));
      assert.ok(stuck.isDisposed());
      const shown = Object.getOwnPropertyDescriptor(renderer, "chart")?.value;
      assert.strictEqual(shown, fresh);
      const model = modelOf(fresh as unknown as ECharts.ECharts);
      assert.strictEqual(model.getSeriesByIndex(0)?.getRawData().getName(0), "A");
    } finally {
      globalThis.cancelAnimationFrame = cancelAnimationFrame;
      stuck.dispose();
      fresh.dispose();
    }
  });

  test("works out the items of another timeline step anew", () => {
    const slices = (...names: string[]) => [{ data: names.map((name) => ({ name, value: 1 })) }];
    const { internals } = drawnRenderer({
      baseOption: { timeline: { data: ["2025", "2026"] }, series: [{ type: "pie" }] },
      options: [{ series: slices("Apples", "Pears") }, { series: slices("Kiwis", "Plums") }],
    });
    const find = (name: string) => internals.items()?.find(name);
    assert.deepStrictEqual(find("Apples"), [item(0)]);
    internals.chart.dispatchAction({ type: "timelineChange", currentIndex: 1 });
    assert.deepStrictEqual(find("Kiwis"), [item(0)]);
    assert.deepStrictEqual(find("Apples"), []);
  });

  test("updates items when resizing crosses a media query", () => {
    const slices = (...names: string[]) => [{ data: names.map((name) => ({ name, value: 1 })) }];
    const { container, internals } = drawnRenderer({
      baseOption: { series: [{ type: "pie" }] },
      media: [
        { query: { maxWidth: 380 }, option: { series: slices("Kiwis", "Plums") } },
        { option: { series: slices("Apples", "Pears") } },
      ],
    });
    const find = (name: string) => internals.items()?.find(name);
    assert.deepStrictEqual(find("Apples"), [item(0)]);
    for (const [width, shown, hidden] of [
      [360, "Kiwis", "Apples"],
      [400, "Apples", "Kiwis"],
    ] as const) {
      container.clientWidth = width;
      internals.resize();
      assert.strictEqual(internals.chart.getWidth(), width);
      assert.deepStrictEqual(find(shown), [item(0)]);
      assert.deepStrictEqual(find(hidden), []);
    }
  });
});
