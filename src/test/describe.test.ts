import * as assert from "node:assert";
import { parseTable } from "../data";
import { describeChartParameters, describeDiagram } from "../describe";
import type { DiagramState } from "../panel";

suite("describe", () => {
  const chart: DiagramState = {
    language: "echarts",
    source: '{"series":[{"type":"pie","data":[{"name":"Sales","value":42}]}]}',
    title: "Sales",
    origin: "tool",
    editedByUser: false,
    chart: { type: "pie", file: "sales.csv" },
  };
  const flowchart = (source: string): DiagramState => ({
    language: "mermaid",
    source,
    title: "Flow",
    origin: "tool",
    editedByUser: false,
  });

  test("keeps chart data and parameters available without repeating its origin", () => {
    const description = describeDiagram(chart);
    assert.ok(description.includes(chart.source ?? ""));
    assert.ok(description.includes(JSON.stringify(chart.chart)));
    assert.strictEqual(description.match(/sales\.csv/g)?.length, 1);
    assert.match(
      description,
      /Its data is not loaded, .* ask the user to press Refresh in the diagram panel first\./,
    );
    assert.doesNotMatch(description, /diagram_inspectData/);
    // Loaded, the data is updated and inspected with the chart tools.
    const loaded = describeDiagram(chart, { chartTable: parseTable("name,value\nSales,42") });
    assert.match(loaded, /use diagram_updateChart with the loaded data/);
    assert.match(loaded, /diagram_inspectData shows its columns/);
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
    const description = describeDiagram(
      { ...chart, source: data, chart: { type: "bar", data, aggregate: "sum" } },
      { chartTable: parseTable(data) },
    );
    assert.ok(description.length < 1_000);
    assert.doesNotMatch(description, /Private row/);
    assert.match(description, /"aggregate":"sum"/);
    assert.ok(
      description.includes(`inline data: ${data.length.toLocaleString("en-US")} characters`),
    );
    assert.match(description, /diagram_inspectData/);
  });

  test("a long Mermaid source is left out of requests, but given in full when asked for", () => {
    const source = `flowchart TD\n${"  A --> B\n".repeat(4_000)}`;
    const state = flowchart(source);
    const summary = describeDiagram(state);
    assert.doesNotMatch(summary, /A --> B/);
    assert.match(summary, /too long to repeat in every request; diagram_getState gives it in full/);
    assert.ok(describeDiagram(state, { detail: "full" }).includes(source));
    // A generated chart is changed with the chart tools, not by rewriting its long option.
    const generated = { ...chart, source: `{"dataset":${"[1,2],".repeat(10_000)}}` };
    const full = describeDiagram(generated, { detail: "full" });
    assert.match(full, /too long to show here/);
  });

  test("many relationships are left out of requests, but listed in full when asked for", () => {
    const relationships = Array.from({ length: 100 }, (_, index) => ({
      id: `edge:L_A_B_${index}`,
      label: "A → B",
      relationship: { kind: "edge", source: "A", target: "B", direction: "forward" } as const,
    }));
    const state = flowchart("flowchart LR\n  A --> B");
    const summary = describeDiagram(state, { relationships });
    assert.doesNotMatch(summary, /L_A_B_/);
    assert.match(
      summary,
      /It has 100 selectable relationships, .*diagram_getState lists their ids/,
    );
    assert.doesNotMatch(describeDiagram(state, { relationships, callsTools: false }), /relation/);
    assert.match(describeDiagram(state, { relationships, detail: "full" }), /L_A_B_99";/);
  });

  test("a model that calls no tools is told of the drawing, but of no tool", () => {
    const edge = { kind: "edge", source: "A", target: "B", direction: "forward" } as const;
    const drawing = {
      relationships: [{ id: "L_A_B", label: "A → B", relationship: edge }],
      repeatedNames: [{ name: "Sales", ids: ["Sales", "Sales/1"], count: 2 }],
      annotation: { marks: [{ id: "A", kind: "problem" as const }], dim: false },
    };
    const state = { ...chart, links: { A: { file: "src/a.ts", line: 3 } } };
    assert.match(describeDiagram(state, drawing), /diagram_annotate.*\n.*diagram_annotate/);
    const described = describeDiagram(state, { ...drawing, callsTools: false });
    assert.doesNotMatch(described, /diagram_/);
    assert.match(described, /Code links: A → src\/a\.ts#L3\.\n/);
    assert.match(described, /Selectable relationships: "A → B" \(id: "L_A_B"; edge/);
    assert.match(described, /Marked chart items: "A" \(problem\)\./);
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
