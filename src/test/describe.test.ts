import * as assert from "node:assert";
import { describeDiagram } from "../describe";
import type { DiagramState } from "../panel";

suite("describeDiagram", () => {
  const chart: DiagramState = {
    language: "echarts",
    source: '{"series":[{"type":"pie","data":[{"name":"Sales","value":42}]}]}',
    title: "Sales",
    origin: "tool",
    editedByUser: false,
    chart: { type: "pie", file: "sales.csv" },
  };

  test("keeps chart data and parameters available without repeating its origin", () => {
    const description = describeDiagram(chart, []);
    assert.ok(description.includes(chart.source ?? ""));
    assert.ok(description.includes(JSON.stringify(chart.chart)));
    assert.strictEqual(description.match(/sales\.csv/g)?.length, 1);
    assert.match(description, /use diagram_updateChart with the loaded data/);
  });

  test("manual chart edits are preserved rather than regenerated", () => {
    const description = describeDiagram({ ...chart, editedByUser: true }, []);
    assert.ok(description.includes(chart.source ?? ""));
    assert.match(description, /Preserve their edits/);
    assert.doesNotMatch(description, /call diagram_chart/);
  });
});
