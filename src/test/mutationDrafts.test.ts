import * as assert from "node:assert";
import { parseTable } from "../data";
import { DraftTool } from "../draftTool";
import { editFlowchart, flowchartStructure } from "../flowchartEdits";
import type { DiagramNode } from "../protocol";
import { StructureDiagramTool } from "../structureTool";
import { drawChart, newFakePanel } from "./newPanel";
import { invokeTool } from "./toolText";

async function graph(
  source = "flowchart LR\n A[API] --> B[Database]\n B --> C[Client]",
  renderedLabels: string[] = [],
) {
  const fake = await newFakePanel();
  let items: DiagramNode[] = [];
  fake.webview.answer = (message) => {
    if (message.type === "render" || message.type === "validateDraft") {
      const model = flowchartStructure(message.source);
      items = [
        ...model.nodes.map((id) => ({ id, label: id })),
        ...model.edges.map((edge, linkStyle) => ({
          id: `edge:${linkStyle}`,
          label: edge.label,
          relationship: {
            kind: "edge" as const,
            source: edge.source,
            target: edge.target,
            direction: edge.direction,
            linkStyle,
            text: renderedLabels[linkStyle] ?? edge.label,
          },
        })),
      ];
      return message.type === "render"
        ? {
            type: "rendered",
            requestId: message.requestId,
            diagramType: "flowchart-v2",
            nodeIds: model.nodes,
            relationships: items.filter((item) => item.relationship),
          }
        : { type: "draftResult", requestId: message.requestId, diagramType: "flowchart-v2", items };
    }
    if (message.type === "getItems")
      return {
        type: "items",
        requestId: message.requestId,
        page: { totalItems: items.length, matchedItems: items.length, startItem: 1, items },
      };
    return undefined;
  };
  await fake.panel.render({ source, language: "mermaid", title: "Graph" }, "tool");
  return fake;
}

suite("structural mutations", () => {
  test("adds standalone nodes to groups and removes their edges, styles and class membership", () => {
    const source =
      "flowchart LR\r\n subgraph G\r\n B[Database]\r\n end\r\n %% keep this\r\n classDef hot fill:red";
    const added = editFlowchart(source, {
      operation: "addNode",
      id: "A",
      label: "API",
      group: "G",
    });
    assert.match(added, /A\["API"\]\r\n end/);
    const linked = editFlowchart(added, {
      operation: "addEdge",
      source: "A",
      target: "B",
      label: "writes",
    });
    const removed = editFlowchart(
      `${linked}\r\n style A fill:red\r\n class A,B hot\r\n linkStyle 0 stroke:red`,
      { operation: "removeNode", id: "A" },
    );
    assert.deepStrictEqual(flowchartStructure(removed).nodes, ["B"]);
    assert.deepStrictEqual(flowchartStructure(removed).edges, []);
    assert.match(removed, /class B hot/);
    assert.match(removed, /%% keep this/);
    assert.doesNotMatch(removed, /style A|linkStyle 0/);
  });

  test("removes edges without deleting endpoint definitions and remaps styles", () => {
    const source =
      "flowchart LR\n A[API] first@--> B[(DB)] %% keep\n B --> C\n linkStyle 0 stroke:red\n linkStyle 0,1 stroke:blue\n style first stroke:red";
    const result = editFlowchart(source, { operation: "removeEdge", edgeIndex: 0 });
    assert.match(result, /A\[API\]\n B\[\(DB\)\] %% keep/);
    assert.match(result, /linkStyle 0 stroke:blue/);
    assert.doesNotMatch(result, /stroke:red/);
    assert.deepStrictEqual(flowchartStructure(result).nodes, ["A", "B", "C"]);
    assert.strictEqual(flowchartStructure(result).edges.length, 1);
  });

  test("applies a batch once while preserving original edge identities after insertion", async () => {
    const { panel, webview } = await graph();
    const revision = panel.revision;
    const renders = webview.sent.filter(({ type }) => type === "render").length;
    const report = await invokeTool(new StructureDiagramTool(panel), {
      revision,
      operations: [
        { operation: "insert", edge: "edge:0", id: "Cache", label: "Cache" },
        { operation: "removeEdge", edge: "edge:1" },
        { operation: "addNode", id: "Queue", label: "Queue" },
        { operation: "addEdge", source: "Cache", target: "Queue" },
        { operation: "reconnect", edge: "Cache --> Queue", source: "A" },
      ],
    });
    assert.match(report, /Applied 5 operations/);
    assert.deepStrictEqual(
      flowchartStructure(panel.current?.source ?? "").edges.map(({ source, target }) => [
        source,
        target,
      ]),
      [
        ["A", "Cache"],
        ["Cache", "B"],
        ["A", "Queue"],
      ],
    );
    assert.strictEqual(panel.revision, revision + 1);
    assert.strictEqual(webview.sent.filter(({ type }) => type === "render").length, renders + 1);
  });

  test("resolves literal labels on new parallel edges without decoding them twice", async () => {
    const { panel } = await graph("flowchart LR\n A --> B");
    const labels = ["yes|no", 'say "yes"', "#34; &amp;", "A&B"];
    const report = await invokeTool(new StructureDiagramTool(panel), {
      revision: panel.revision,
      operations: [
        ...labels.map((label) => ({ operation: "addEdge", source: "A", target: "B", label })),
        ...labels
          .toReversed()
          .map((label) => ({ operation: "removeEdge", edge: `A --> B: ${label}` })),
      ],
    });
    assert.match(report, /Applied 8 operations/);
    assert.deepStrictEqual(flowchartStructure(panel.current?.source ?? "").edges, [
      { source: "A", target: "B", label: "", direction: "forward" },
    ]);
  });

  test("resolves rendered labels of existing encoded edges while preserving their source", async () => {
    const encoded = '"yes#124;no #34;quoted#34; #38; #35;34;"';
    const { panel } = await graph(`flowchart LR\n A -->|${encoded}| B\n C`, [
      'yes|no "quoted" & #34;',
    ]);
    const report = await invokeTool(new StructureDiagramTool(panel), {
      revision: panel.revision,
      operations: [
        {
          operation: "insert",
          edge: 'A --> B: yes|no "quoted" & #34;',
          id: "Cache",
          label: "Cache",
        },
        { operation: "reconnect", edge: 'A --> Cache: yes|no "quoted" & #34;', target: "C" },
      ],
    });
    assert.match(report, /Applied 2 operations/);
    assert.ok(panel.current?.source?.includes(`A -->|${encoded}| C`));
  });

  test("rejects an invalid later operation without applying the earlier changes", async () => {
    const { panel } = await graph();
    const state = panel.current;
    const revision = panel.revision;
    const report = await invokeTool(new StructureDiagramTool(panel), {
      revision,
      operations: [
        { operation: "removeNode", id: "B" },
        { operation: "reconnect", edge: "edge:0", target: "C" },
      ],
    });
    assert.match(report, /unknown or ambiguous/);
    assert.strictEqual(panel.current, state);
    assert.strictEqual(panel.revision, revision);
  });
});

suite("mutation drafts", () => {
  test("validates exact edits without replacing the current drawing and applies them", async () => {
    const { panel } = await graph();
    const tool = new DraftTool(panel);
    const before = panel.current;
    const draft = JSON.parse(
      await invokeTool(tool, {
        action: "validate",
        revision: panel.revision,
        edits: [{ oldText: "A[API]", newText: "A[Service]" }],
        preserveNodes: ["A", "B"],
      }),
    );
    assert.strictEqual(draft.valid, true);
    assert.strictEqual(panel.current, before);
    assert.match(await invokeTool(tool, { action: "apply", id: draft.id }), /Edited/);
    assert.match(panel.current?.source ?? "", /A\[Service\]/);
  });

  test("validates and applies structural batches", async () => {
    const { panel } = await graph();
    const tool = new DraftTool(panel);
    const draft = JSON.parse(
      await invokeTool(tool, {
        action: "validate",
        revision: panel.revision,
        operations: [
          { operation: "addNode", id: "Queue", label: "Queue" },
          { operation: "addEdge", source: "B", target: "Queue" },
        ],
        preservePaths: [{ source: "A", target: "Queue" }],
      }),
    );
    assert.strictEqual(draft.valid, true);
    assert.match(await invokeTool(tool, { action: "apply", id: draft.id }), /Applied 2 operations/);
    assert.ok(flowchartStructure(panel.current?.source ?? "").nodes.includes("Queue"));
  });

  test("refuses generated data edits before offscreen rendering", async () => {
    const { panel, webview } = await newFakePanel();
    await drawChart(panel, { type: "bar", data: "name,value\na,2\nb,3" }, "name,value\na,2\nb,3");
    const before = panel.current;
    const option = JSON.parse(before?.source ?? "");
    option.series[0].data = [999];
    const report = await invokeTool(new DraftTool(panel), {
      action: "validate",
      source: JSON.stringify(option),
    });
    assert.match(report, /keeping only edits of its styling/);
    assert.strictEqual(panel.current, before);
    assert.strictEqual(webview.sent.filter(({ type }) => type === "validateDraft").length, 0);
  });

  test("prepares chart settings using the loaded table and applies the validated settings", async () => {
    const { panel, webview } = await newFakePanel();
    const table = parseTable("name,value\na,2\nb,3");
    await drawChart(panel, { type: "bar", command: "must-not-run" }, table);
    const answer = webview.answer;
    webview.answer = (message) =>
      message.type === "validateDraft"
        ? { type: "draftResult", requestId: message.requestId, diagramType: "echarts" }
        : answer?.(message);
    const before = panel.current;
    const tool = new DraftTool(panel);
    const draft = JSON.parse(
      await invokeTool(tool, { action: "validate", chartUpdate: { type: "pie", title: "Share" } }),
    );
    assert.strictEqual(draft.valid, true);
    assert.strictEqual(panel.current, before);
    assert.match(
      await invokeTool(tool, { action: "apply", id: draft.id }),
      /Applied the validated chart update/,
    );
    assert.strictEqual(panel.current?.chart?.type, "pie");
    assert.strictEqual(panel.current?.title, "Share");
    assert.strictEqual(panel.loadedChartData, table);
  });
});
