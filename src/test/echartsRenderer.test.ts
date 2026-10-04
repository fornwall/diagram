import * as assert from "node:assert";
import { EChartsRenderer } from "../webview/echartsRenderer";
import { itemsOf, withChart } from "./echartsModel";

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

const item = (dataIndex: number) => ({ seriesIndex: 0, dataType: undefined, dataIndex });

suite("echartsRenderer interactions", () => {
  test("updates notes, kinds and order without revisiting chart graphics", () => {
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
    renderer.showMarks({ marks: [{ id: "C", kind: "info" }], dim: false });
    assert.deepStrictEqual(actions, [
      { type: "downplay", batch: [item(1), item(0)] },
      { type: "highlight", batch: [item(2)] },
    ]);
    actions.length = 0;
    renderer.showMarks({ marks: [], dim: false });
    assert.deepStrictEqual(actions, [{ type: "downplay", batch: [item(2)] }]);
  });

  test("changing marks only downplays removed items while restoring retained emphasis", () => {
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
    assert.deepStrictEqual(actions, [
      { type: "downplay", batch: [item(0)] },
      { type: "highlight", batch: [item(1)] },
    ]);
  });

  test("changing dimming still relayouts unchanged marks", () => {
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
    assert.deepStrictEqual(actions, [
      { type: "highlight", batch: [{ seriesIndex: 0, dataType: "node", dataIndex: 2 }] },
    ]);
  });

  test("coalesces selection updates and selects only the latest items", async () => {
    const { renderer, actions } = interactionRenderer();
    renderer.showSelection(new Set(["0::1"]));
    renderer.showSelection(new Set(["0::2"]));
    assert.deepStrictEqual(actions, []);
    await Promise.resolve();
    assert.deepStrictEqual(actions, [
      { type: "select", batch: [{ seriesIndex: 0, dataType: undefined, dataIndex: 2 }] },
    ]);
    actions.length = 0;
    renderer.showSelection(new Set(["0::3"]));
    await Promise.resolve();
    assert.deepStrictEqual(actions, [
      { type: "select", batch: [{ seriesIndex: 0, dataType: undefined, dataIndex: 3 }] },
    ]);
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
});
