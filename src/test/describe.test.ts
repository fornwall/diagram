import * as assert from "node:assert";
import { describeChartParameters, describeDiagram } from "../describe";
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

  test("large inline data does not bypass the source limit or hide chart settings", () => {
    const data = "name,value\nPrivate row,42\n".repeat(10_000);
    const description = describeDiagram(
      { ...chart, source: data, chart: { type: "bar", data, aggregate: "sum" } },
      [],
    );
    assert.ok(description.length < 1_000);
    assert.doesNotMatch(description, /Private row/);
    assert.match(description, /"aggregate":"sum"/);
    assert.ok(description.includes(`inline data: ${data.length} characters`));
    assert.match(description, /diagram_inspectData/);
  });

  test("oversized chart options are omitted from model context", () => {
    const description = describeChartParameters({
      type: "bar",
      options: { series: { data: Array(50_000).fill(42) } },
    });
    assert.ok(description.length < 100);
    assert.match(description, /parameters omitted/);
  });
});
