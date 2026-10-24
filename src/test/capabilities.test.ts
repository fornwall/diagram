import * as assert from "node:assert";
import { diagramCapabilities } from "../capabilities";
import { rebuildChart } from "../chartPresentation";
import type { ChartSpec } from "../chartSpec";
import { parseTable } from "../data";
import { describeDiagram } from "../describe";
import type { DiagramState } from "../panel";

suite("capabilities", () => {
  const flow: DiagramState = {
    language: "mermaid",
    source: "flowchart LR\n A --> B",
    title: "Flow",
    origin: "tool",
    editedByUser: false,
  };

  test("reports structural syntax limits before an agent attempts an edit", () => {
    assert.strictEqual(diagramCapabilities(flow).editStructure.available, true);
    const unsupported = diagramCapabilities({ ...flow, source: "flowchart LR\n A & B --> C" });
    assert.strictEqual(unsupported.editStructure.available, false);
    assert.match(
      describeDiagram(flow, { detail: "metadata" }),
      /Capabilities: .*"editStructure":\{"available":true\}/,
    );
    assert.strictEqual(
      diagramCapabilities({ ...flow, error: "Invalid" }).editStructure.available,
      false,
    );
  });

  test("explains unloaded data and incompatible manual chart edits", () => {
    const state: DiagramState = {
      ...flow,
      language: "echarts",
      source: "{}",
      chart: { type: "treemap", file: "data.csv" },
    };
    const table = parseTable("name,value\na,1");
    assert.strictEqual(diagramCapabilities(state).inspectRows.available, false);
    assert.strictEqual(diagramCapabilities(state, table).inspectRows.available, true);
    const changed = {
      ...state,
      chartPresentation: { baseline: {}, dataHash: "", edits: [], blocked: "Changed data" },
    };
    assert.strictEqual(diagramCapabilities(changed, table).inspectRows.available, false);
    assert.strictEqual(diagramCapabilities(changed, table).updateChart.available, false);
    const failed = diagramCapabilities({ ...state, error: "Render failed" }, table);
    assert.strictEqual(failed.inspectRows.available, false);
    assert.strictEqual(failed.updateChart.available, true);
  });

  test("distinguishes styling options from options that replace generated data", () => {
    const table = parseTable("name,value\na,1");
    for (const [options, expected] of [
      [{ legend: { show: false } }, true],
      [{ series: [{ type: "bar", data: [99] }] }, false],
    ] as const) {
      const spec: ChartSpec = { type: "bar", data: "name,value\na,1", options };
      const built = rebuildChart(spec, table);
      const state: DiagramState = {
        ...flow,
        language: "echarts",
        source: JSON.stringify(built.option),
        chart: spec,
        chartPresentation: built.presentation,
      };
      assert.strictEqual(diagramCapabilities(state, table).inspectRows.available, expected);
      assert.strictEqual(diagramCapabilities(state, table).updateChart.available, true);
    }
  });
});
