import * as assert from "node:assert";
import { parseTable } from "../data";
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
    const description = describeDiagram(chart);
    assert.ok(description.includes(chart.source ?? ""));
    assert.ok(description.includes(JSON.stringify(chart.chart)));
    assert.strictEqual(description.match(/sales\.csv/g)?.length, 1);
    assert.match(description, /use diagram_updateChart with the loaded data/);
  });

  test("tells the units that sizes and durations were converted to", () => {
    const table = parseTable("name,Latency (ms),Size (KB),Wait,share\na,1.5,2,3s,5%");
    assert.match(
      describeDiagram(chart, { chartTable: table }),
      /\n"Size \(KB\)" is in bytes; "Latency \(ms\)", "Wait" are in seconds\.\n/,
    );
    assert.doesNotMatch(
      describeDiagram(chart, { chartTable: parseTable("name,share\na,5%") }),
      / is in /,
    );
  });

  test("manual chart edits are preserved rather than regenerated", () => {
    const description = describeDiagram({ ...chart, editedByUser: true });
    assert.ok(description.includes(chart.source ?? ""));
    assert.match(description, /Preserve their edits/);
    assert.doesNotMatch(description, /call diagram_chart/);
  });

  test("large inline data does not bypass the source limit or hide chart settings", () => {
    const data = "name,value\nPrivate row,42\n".repeat(10_000);
    const description = describeDiagram({
      ...chart,
      source: data,
      chart: { type: "bar", data, aggregate: "sum" },
    });
    assert.ok(description.length < 1_000);
    assert.doesNotMatch(description, /Private row/);
    assert.match(description, /"aggregate":"sum"/);
    assert.ok(description.includes(`inline data: ${data.length} characters`));
    assert.match(description, /diagram_inspectData/);
  });

  test("a long Mermaid source is left out of requests, but given in full when asked for", () => {
    const source = `flowchart TD\n${"  A --> B\n".repeat(4_000)}`;
    const state: DiagramState = {
      language: "mermaid",
      source,
      title: "Flow",
      origin: "tool",
      editedByUser: false,
    };
    const summary = describeDiagram(state);
    assert.doesNotMatch(summary, /A --> B/);
    assert.match(summary, /too long to repeat in every request; diagram_getState gives it in full/);
    assert.ok(describeDiagram(state, { fullSource: true }).includes(source));
    // A generated chart is changed with the chart tools, not by rewriting its long option.
    const generated = { ...chart, source: `{"dataset":${"[1,2],".repeat(10_000)}}` };
    const full = describeDiagram(generated, { fullSource: true });
    assert.match(full, /too long to show here/);
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
