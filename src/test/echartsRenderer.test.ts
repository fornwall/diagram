import * as assert from "node:assert";
import { EChartsRenderer } from "../webview/echartsRenderer";

/** Exercise interaction updates without loading ECharts or constructing a browser document. */
function interactionRenderer() {
  const actions: unknown[] = [];
  let relayouts = 0;
  const renderer = Object.create(EChartsRenderer.prototype) as EChartsRenderer;
  Object.assign(renderer, {
    chart: { dispatchAction: (action: unknown) => actions.push(action) },
    option: { series: [{ type: "pie" }] },
    annotation: { marks: [], dim: false },
    hasHighlights: false,
    selectedKeys: new Set<string>(),
    shownSelected: [],
    selectionScheduled: false,
    relayout: () => relayouts++,
  });
  return { renderer, actions, relayouts: () => relayouts };
}

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
    assert.deepStrictEqual(actions, [{ type: "highlight", batch: [{ name: "A" }, { name: "B" }] }]);
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
      { type: "downplay" },
      { type: "highlight", batch: [{ name: "C" }] },
    ]);
    actions.length = 0;
    renderer.showMarks({ marks: [], dim: false });
    assert.deepStrictEqual(actions, [{ type: "downplay" }]);
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
});
