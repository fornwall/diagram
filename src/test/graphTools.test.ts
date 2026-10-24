import * as assert from "node:assert";
import * as vscode from "vscode";
import { editFlowchart, flowchartStructure } from "../flowchartEdits";
import { type GraphQuery, queryGraph } from "../graphQuery";
import { GraphDiagramTool } from "../graphTool";
import type { DiagramNode } from "../protocol";
import { StructureDiagramTool } from "../structureTool";
import { cancellationSource } from "./afterTest";
import { newFakePanel } from "./newPanel";
import { invokeTool } from "./toolText";
import { suitePage } from "./webviewHarness";

const node = (id: string): DiagramNode => ({ id, label: id });
const edge = (
  id: string,
  source: string,
  target: string,
  direction: "forward" | "both" | "undirected" = "forward",
): DiagramNode => ({
  id,
  label: `${source} → ${target}`,
  relationship: { kind: "edge", source, target, direction },
});
const matched = (items: DiagramNode[], query: GraphQuery) =>
  queryGraph(items, query).matches.map(({ item }) => item.id);

suite("graph queries", () => {
  const graph = [
    node("A"),
    node("B"),
    node("C"),
    node("D"),
    node("E"),
    edge("ab", "A", "B"),
    edge("bc", "B", "C"),
    edge("cb", "C", "B"),
    edge("de", "D", "E", "undirected"),
  ];

  test("follows direction and includes only edges within the reached nodes", () => {
    assert.deepStrictEqual(matched(graph, { operation: "downstream", id: "B" }), [
      "B",
      "C",
      "bc",
      "cb",
    ]);
    assert.deepStrictEqual(matched(graph, { operation: "upstream", id: "B" }), [
      "A",
      "B",
      "C",
      "ab",
      "bc",
      "cb",
    ]);
    assert.deepStrictEqual(matched(graph, { operation: "downstream", id: "E" }), ["D", "E", "de"]);
    const bounded = queryGraph(graph, { operation: "downstream", id: "A", maxDepth: 1 });
    assert.deepStrictEqual(
      bounded.matches.map(({ item, depth }) => [item.id, depth]),
      [
        ["A", 0],
        ["B", 1],
        ["ab", undefined],
      ],
    );
    assert.deepStrictEqual(matched(graph, { operation: "downstream", id: "A", maxDepth: 0 }), [
      "A",
    ]);
  });

  test("returns an ordered shortest path with exact parallel-edge identity", () => {
    const parallel = [...graph, edge("ab2", "A", "B")];
    assert.deepStrictEqual(matched(parallel, { operation: "path", id: "A", target: "C" }), [
      "A",
      "ab",
      "B",
      "bc",
      "C",
    ]);
    assert.deepStrictEqual(matched(graph, { operation: "path", id: "C", target: "A" }), []);
    assert.deepStrictEqual(
      matched(graph, { operation: "path", id: "A", target: "C", maxDepth: 1 }),
      [],
    );
    assert.deepStrictEqual(matched(graph, { operation: "path", id: "A", target: "A" }), ["A"]);
  });

  test("finds weak components and directed cycles with stable groups", () => {
    const components = queryGraph(graph, { operation: "components" });
    assert.strictEqual(components.groupCount, 2);
    assert.deepStrictEqual(
      components.matches.map(({ item, group }) => [item.id, group]),
      [
        ["A", 1],
        ["B", 1],
        ["C", 1],
        ["D", 2],
        ["E", 2],
        ["ab", 1],
        ["bc", 1],
        ["cb", 1],
        ["de", 2],
      ],
    );
    const cycles = queryGraph(graph, { operation: "cycles" });
    assert.strictEqual(cycles.groupCount, 1);
    assert.strictEqual(cycles.ignoredUndirected, 1);
    assert.deepStrictEqual(
      cycles.matches.map(({ item }) => item.id),
      ["B", "C", "bc", "cb"],
    );
    assert.deepStrictEqual(matched([node("A"), edge("loop", "A", "A")], { operation: "cycles" }), [
      "A",
      "loop",
    ]);
    assert.strictEqual(
      queryGraph([node("A"), node("B"), edge("both", "A", "B", "both")], { operation: "cycles" })
        .groupCount,
      1,
    );
  });

  test("does not treat messages or missing endpoints as graph edges", () => {
    const message: DiagramNode = {
      id: "message",
      label: "A to B",
      relationship: { kind: "message", source: "A", target: "B", direction: "forward" },
    };
    const graph = [node("A"), node("B"), message, edge("missing", "A", "missing")];
    assert.deepStrictEqual(matched(graph, { operation: "downstream", id: "A" }), ["A"]);
    assert.strictEqual(queryGraph(graph, { operation: "components" }).groupCount, 2);
    assert.throws(
      () => queryGraph(graph, { operation: "upstream", id: "missing" }),
      /Unknown node/,
    );
  });

  test("handles deep graphs without recursion", () => {
    const graph = Array.from({ length: 10_000 }, (_, index) => node(`n${index}`));
    for (let index = 1; index < 10_000; index++)
      graph.push(edge(`e${index}`, `n${index - 1}`, `n${index}`));
    assert.strictEqual(queryGraph(graph, { operation: "cycles" }).groupCount, 0);
    assert.strictEqual(queryGraph(graph, { operation: "components" }).groupCount, 1);
  });
});

suite("flowchart structural edits", () => {
  test("renames explicit labels without changing shapes, classes, comments or references", () => {
    const source =
      "%% overview\r\nflowchart LR\r\n  A{Old}:::hot --> B[End]\r\n  A --> C\r\n  %% A{Old}\r\n  style A fill:red";
    assert.strictEqual(
      editFlowchart(source, { operation: "rename", id: "A", label: 'New "label" <safe>' }),
      '%% overview\r\nflowchart LR\r\n  A{"New #34;label#34; #60;safe#62;"}:::hot --> B[End]\r\n  A --> C\r\n  %% A{Old}\r\n  style A fill:red',
    );
  });

  test("adds labels to implicit nodes and updates repeated declarations", () => {
    assert.strictEqual(
      editFlowchart("graph LR; A --> B", { operation: "rename", id: "A", label: "Start" }),
      'graph LR; A["Start"] --> B',
    );
    assert.strictEqual(
      editFlowchart("flowchart TB\n A[One]\n A(Two)", {
        operation: "rename",
        id: "A",
        label: "Same",
      }),
      'flowchart TB\n A["Same"]\n A("Same")',
    );
  });

  test("inserts on an exact edge, preserving its label and definitions and remapping linkStyle", () => {
    const source =
      "flowchart LR\n  A[API] route@-->|hit| B[(DB)] %% call\n  B --> C\n  linkStyle 0,1 stroke:red\n  linkStyle default opacity:1";
    const edited = editFlowchart(source, {
      operation: "insert",
      edgeIndex: 0,
      id: "cache",
      label: "Cache",
    });
    assert.strictEqual(
      edited,
      'flowchart LR\n  A[API] route@-->|hit| cache["Cache"]\n  cache --> B[(DB)] %% call\n  B --> C\n  linkStyle 0,1,2 stroke:red\n  linkStyle default opacity:1',
    );
    assert.deepStrictEqual(
      flowchartStructure(edited).edges.map(({ source, target }) => [source, target]),
      [
        ["A", "cache"],
        ["cache", "B"],
        ["B", "C"],
      ],
    );
  });

  test("reconnects endpoints without renaming or deleting their old inline definitions", () => {
    const source = "flowchart LR\n A[API] --> B[Database]:::storage\n C[Cache]";
    assert.strictEqual(
      editFlowchart(source, { operation: "reconnect", edgeIndex: 0, target: "C" }),
      "flowchart LR\n A[API] --> C\n B[Database]:::storage\n C[Cache]",
    );
    assert.throws(
      () => editFlowchart(source, { operation: "reconnect", edgeIndex: 0, source: "missing" }),
      /Unknown node/,
    );
  });

  test("moves a standalone declaration into a group while retaining external edges", () => {
    const source =
      "flowchart LR\n  A[Worker]\n  A --> B\n  subgraph Service[Service]\n    B[Queue]\n  end";
    assert.strictEqual(
      editFlowchart(source, { operation: "move", id: "A", group: "Service" }),
      "flowchart LR\n  \n  A --> B\n  subgraph Service[Service]\n    B[Queue]\n    A[Worker]\n  end",
    );
    const grouped = "flowchart LR\n subgraph G\n A[Worker]\n A --> B\n end\n subgraph H\n C\n end";
    assert.throws(
      () => editFlowchart(grouped, { operation: "move", id: "A", group: "H" }),
      /Other subgraphs still reference/,
    );
  });

  test("reads around front matter and multiline directives", () => {
    const source =
      '---\ntitle: API\n---\n%%{init: {\n "theme": "base"\n}}%%\nflowchart LR\n A --> B';
    assert.strictEqual(
      editFlowchart(source, { operation: "rename", id: "B", label: "Done" }),
      `${source}["Done"]`,
    );
  });

  test("rejects unsupported or ambiguous syntax before changing anything", () => {
    for (const source of [
      "flowchart LR\n A --> B --> C",
      "flowchart LR\n A & B --> C",
      "flowchart LR\n A -- text --> B",
      "flowchart LR\n A@{ shape: rect }",
      "flowchart LR\n A-B --> C",
      "flowchart LR\n A[unclosed",
      "sequenceDiagram\n A->>B: hello",
    ]) {
      assert.throws(
        () => editFlowchart(source, { operation: "rename", id: "A", label: "New" }),
        /diagram_edit/,
      );
    }
    assert.throws(
      () =>
        editFlowchart("flowchart LR\n A --> B", {
          operation: "insert",
          edgeIndex: 0,
          id: "A",
          label: "Duplicate",
        }),
      /already exists/,
    );
  });
});

async function fakeGraph(items: DiagramNode[]) {
  const fake = await newFakePanel();
  fake.webview.answer = (message) => {
    if (message.type === "render")
      return {
        type: "rendered",
        requestId: message.requestId,
        diagramType: "flowchart-v2",
        nodeIds: items.filter((item) => !item.relationship).map(({ id }) => id),
        relationships: items.filter((item) => item.relationship),
      };
    if (message.type !== "getItems") return undefined;
    const end = Math.min(items.length, message.startItem - 1 + message.maxItems);
    return {
      type: "items",
      requestId: message.requestId,
      page: {
        totalItems: items.length,
        matchedItems: items.length,
        startItem: message.startItem,
        items: items.slice(message.startItem - 1, end),
        ...(end < items.length && { nextItem: end + 1 }),
      },
    };
  };
  await fake.panel.render(
    { language: "mermaid", title: "Graph", source: "flowchart LR\n A --> B" },
    "tool",
  );
  return fake;
}

suite("graph agent tools", () => {
  test("pages query results and focuses the complete match without changing source", async () => {
    const { panel, webview } = await fakeGraph([node("A"), node("B"), edge("ab", "A", "B")]);
    const revision = panel.revision;
    const report = JSON.parse(
      await invokeTool(new GraphDiagramTool(panel), {
        operation: "downstream",
        id: "A",
        maxItems: 1,
        focus: true,
        revision,
      }),
    );
    assert.strictEqual(report.totalItems, 3);
    assert.strictEqual(report.nextItem, 2);
    assert.strictEqual(report.focused, true);
    assert.strictEqual(panel.revision, revision);
    const annotation = webview.sent.findLast((message) => message.type === "annotate");
    assert.ok(annotation?.type === "annotate");
    assert.deepStrictEqual(
      annotation.marks.map(({ id }) => id),
      ["A", "B", "ab"],
    );
    assert.strictEqual(annotation.dim, true);
  });

  test("rejects stale reads, invalid inputs and cancelled calls without focusing", async () => {
    const { panel, webview } = await fakeGraph([node("A")]);
    const tool = new GraphDiagramTool(panel);
    assert.match(
      await invokeTool(tool, {
        operation: "components",
        revision: panel.revision - 1,
        focus: true,
      }),
      /changed since revision/,
    );
    assert.match(await invokeTool(tool, { operation: "cycles", id: "A" }), /takes no "id"/);
    assert.match(await invokeTool(tool, { operation: "path", id: "A" }), /Give "target"/);
    const cancellation = cancellationSource();
    cancellation.cancel();
    await assert.rejects(() => invokeTool(tool, { operation: "components" }, cancellation.token));
    assert.ok(!webview.sent.some((message) => message.type === "annotate"));
  });

  test("shrinks whole graph records to the token budget and reports oversized ids", async () => {
    const { panel } = await fakeGraph(
      Array.from({ length: 12 }, (_, index) => node(`node${index}`)),
    );
    const fitting = { tokenBudget: 260, countTokens: async (text: string) => text.length };
    const report = JSON.parse(
      await invokeTool(
        new GraphDiagramTool(panel),
        { operation: "components" },
        undefined,
        fitting,
      ),
    );
    assert.ok(report.items.length < 12);
    assert.strictEqual(report.nextItem, report.items.length + 1);
    const response = await invokeTool(
      new GraphDiagramTool(panel),
      { operation: "components" },
      undefined,
      { tokenBudget: 1, countTokens: fitting.countTokens },
    );
    assert.match(response, /does not fit the result budget/);
  });

  test("cancels stalled token counting without applying focus", async () => {
    const { panel, webview } = await fakeGraph([node("A")]);
    const cancellation = cancellationSource();
    await assert.rejects(
      () =>
        invokeTool(
          new GraphDiagramTool(panel),
          { operation: "components", focus: true },
          cancellation.token,
          {
            tokenBudget: 1000,
            countTokens: () => {
              cancellation.cancel();
              return new Promise<number>(() => {});
            },
          },
        ),
      vscode.CancellationError,
    );
    assert.ok(!webview.sent.some((message) => message.type === "annotate"));
  });

  test("guards structural changes and preserves metadata", async () => {
    const { panel } = await fakeGraph([node("A"), node("B"), edge("ab", "A", "B")]);
    const tool = new StructureDiagramTool(panel);
    const revision = panel.revision;
    assert.match(
      await invokeTool(tool, { operation: "rename", id: "A", label: "API" }),
      /current nonnegative "revision"/,
    );
    assert.match(
      await invokeTool(tool, {
        operation: "rename",
        id: "A",
        label: "API",
        revision: revision - 1,
      }),
      /changed since revision/,
    );
    assert.strictEqual(panel.revision, revision);
    const response = await invokeTool(tool, {
      operation: "rename",
      id: "A",
      label: "API",
      revision,
    });
    assert.match(response, /Applied the rename/);
    assert.strictEqual(panel.current?.source, 'flowchart LR\n A["API"] --> B');
    assert.strictEqual(panel.current?.title, "Graph");
  });
});

suite("rendered structural edits", function () {
  this.timeout(20_000);
  const page = suitePage();

  test("inserts into a selected parallel edge and keeps its styling", async () => {
    await page.draw({
      source:
        "flowchart LR\n A[API] fast@-->|hit| B[(DB)]\n A slow@-->|miss| B\n linkStyle 1 stroke:red",
    });
    const report = await invokeTool(new StructureDiagramTool(page.panel), {
      operation: "insert",
      edge: "edge:slow",
      id: "cache",
      label: "Cache",
      revision: page.panel.revision,
    });
    assert.match(report, /Applied the insert/);
    assert.ok(
      page.panel.current?.source?.includes('A slow@-->|miss| cache["Cache"]\n cache --> B'),
    );
    assert.ok(page.panel.current?.source?.includes("linkStyle 1,2 stroke:red"));
    const path = JSON.parse(
      await invokeTool(new GraphDiagramTool(page.panel), {
        operation: "path",
        id: "cache",
        target: "B",
      }),
    );
    assert.strictEqual(path.items.length, 3);
    assert.strictEqual(path.items[0].id, "cache");
    assert.strictEqual(path.items[2].id, "B");
  });

  test("rejects ambiguous parallel aliases and preserves the current revision", async () => {
    await page.draw({ source: "flowchart LR\n A --> B\n A --> B" });
    const revision = page.panel.revision;
    const report = await invokeTool(new StructureDiagramTool(page.panel), {
      operation: "reconnect",
      edge: "A --> B",
      target: "A",
      revision,
    });
    assert.match(report, /unknown or ambiguous/);
    assert.strictEqual(page.panel.revision, revision);
  });

  test("renames varied shapes with literal labels that remain renderable", async () => {
    for (const shape of ["A{Decision}", "A([Start])", "A[[Subroutine]]", "A((Circle))"]) {
      await page.draw({ source: `flowchart LR\n ${shape} --> B` });
      const report = await invokeTool(new StructureDiagramTool(page.panel), {
        operation: "rename",
        id: "A",
        label: '"Quoted" & <literal>\nNext',
        revision: page.panel.revision,
      });
      assert.match(report, /Applied the rename/, report);
    }
  });
});
