import * as assert from "node:assert";
import type * as vscode from "vscode";
import type { Diagram, DiagramPanel, RenderOutcome } from "../panel";
import { newPanel } from "./newPanel";

const MERMAID: Record<string, string> = {
  "flowchart-v2": "flowchart LR\n  A[Parser] --> B[Checker]",
  sequence: "sequenceDiagram\n  Alice->>Bob: Hello",
  classDiagram: "classDiagram\n  class Parser {\n    +parse() Ast\n  }",
  er: "erDiagram\n  CUSTOMER ||--o{ ORDER : places",
  gantt: "gantt\n  dateFormat YYYY-MM-DD\n  Design :a1, 2026-01-01, 7d",
  mindmap: "mindmap\n  root((Plan))\n    Research",
  timeline: "timeline\n  2025 : Started\n  2026 : Shipped",
  journey: "journey\n  section Work\n    Make tea: 5: Me",
  pie: 'pie\n  "Dogs" : 386\n  "Rats" : 2',
  gitGraph: 'gitGraph\n  commit id: "init"\n  branch develop\n  commit tag: "v1"',
  xychart: "xychart\n  x-axis [jan, feb]\n  bar [10, 50]\n  line [15, 45]",
};

suite("webview", function () {
  // The first render loads the webview and the libraries, which can take a while.
  this.timeout(20_000);

  let panel: DiagramPanel;
  suiteSetup(() => {
    panel = newPanel();
  });
  suiteTeardown(() => panel.dispose());

  const render = (diagram: Partial<Diagram>): Promise<RenderOutcome> =>
    panel.render({ language: "mermaid", source: "", title: "Test", ...diagram }, "tool");

  test("renders Mermaid diagrams of the common types", async () => {
    for (const [diagramType, source] of Object.entries(MERMAID)) {
      assert.deepStrictEqual(await render({ source }), { ok: true, diagramType });
    }
  });

  test("names an unknown Mermaid diagram type instead of repeating the source", async () => {
    const outcome = await render({ source: "flowchar TD\n  A --> B" });
    assert.ok(!outcome.ok);
    assert.match(outcome.error, /^Unknown diagram type "flowchar": the first line must declare/);
    const fenced = await render({ source: "```mermaid\nflowchart TD\n  A --> B\n```" });
    assert.ok(!fenced.ok);
    assert.match(fenced.error, /^Remove the code fence/);
  });

  test("reports Mermaid errors on the line of the source", async () => {
    // Mermaid numbers the lines without front matter, directives, comments and leading blank lines.
    const source =
      "---\ntitle: T\n---\n%%{init: {}}%%\n\nflowchart TD\n  %% note\n  A --> B\n  B -> C";
    const outcome = await render({ source });
    assert.ok(!outcome.ok);
    assert.match(outcome.error, /^Parse error on line 9:/);
    const yaml = await render({ source: "---\ntitle: [\n---\nflowchart TD" });
    assert.ok(!yaml.ok);
    assert.match(yaml.error, /^Invalid YAML in the front matter on line \d+: /);
  });

  test("explains Mermaid's limits", async () => {
    const edges = Array.from({ length: 501 }, (_, i) => `  n${i} --> n${i + 1}`);
    const outcome = await render({ source: `flowchart TD\n${edges.join("\n")}` });
    assert.ok(!outcome.ok);
    assert.match(outcome.error, /^The diagram has more than 500 edges/);
    // Mermaid would draw a message in place of the diagram.
    const long = await render({ source: `flowchart TD\n${"  A --> B\n".repeat(5000)}` });
    assert.ok(!long.ok);
    assert.match(long.error, /^The diagram is too long/);
  });

  test("lets the webview compile an option written as JavaScript", () => {
    panel.show();
    const { webview } = (panel as unknown as { panel: vscode.WebviewPanel }).panel;
    assert.match(webview.html, /script-src 'nonce-[\w-]+' 'unsafe-eval'/);
  });

  test("renders charts, and switches between charts and diagrams", async () => {
    const option = {
      xAxis: { type: "category", data: ["A", "B"] },
      yAxis: {},
      series: [{ type: "bar", data: [1, 2] }],
    };
    const chart = { language: "echarts", source: JSON.stringify(option) } as const;
    assert.deepStrictEqual(await render(chart), { ok: true, diagramType: "bar" });
    assert.ok((await render({ source: MERMAID["flowchart-v2"] })).ok);
    assert.ok((await render(chart)).ok);
  });

  test("reports the node ids it drew, and marks them on the diagram it already shows", async () => {
    assert.ok((await render({ source: MERMAID["flowchart-v2"] })).ok);
    assert.deepStrictEqual([...(panel.drawnIds ?? [])].sort(), ["A", "B"]);
    const marked = panel.annotate({
      marks: [
        { id: "A", kind: "problem", note: "fails here" },
        { id: "B", kind: "good" },
      ],
      caption: "Step 1 of 2",
      dim: true,
    });
    assert.ok(marked.ok);
    assert.deepStrictEqual(marked.unknown, []);
    // The diagram is still the one that was rendered, and it still renders and picks.
    assert.strictEqual(panel.current?.source, MERMAID["flowchart-v2"]);
    assert.strictEqual(panel.current?.error, undefined);
    assert.ok((await render({ source: MERMAID.sequence })).ok);
    assert.deepStrictEqual([...(panel.drawnIds ?? [])].sort(), ["Alice", "Bob"]);

    // A chart's items are its data, which the panel does not name, so ids cannot be checked.
    const pie = '{"series": [{"type": "pie", "data": [1]}]}';
    assert.ok((await render({ language: "echarts", source: pie })).ok);
    assert.strictEqual(panel.drawnIds, undefined);
    const chartMarks = panel.annotate({ marks: [{ id: "1", kind: "info" }], dim: true });
    assert.ok(chartMarks.ok);
    assert.deepStrictEqual(chartMarks.unknown, []);
  });

  test("explains charts that cannot render", async () => {
    const outcome = await render({
      language: "echarts",
      source: '{"series": [{"type": "map"}]}',
    });
    assert.ok(!outcome.ok && outcome.kind === "invalid");
    assert.match(outcome.error, /unsupported type "map"/);
  });

  test("recovers from invalid chart components and renders an explicit graph view", async () => {
    const invalid = await render({
      language: "echarts",
      source: '{"xAxis": null, "yAxis": {}, "series": [{"type": "bar", "data": [1]}]}',
    });
    assert.ok(!invalid.ok);
    assert.match(invalid.error, /needs "xAxis" and "yAxis"/);
    const graph = await render({
      language: "echarts",
      source: JSON.stringify({
        series: [
          {
            type: "graph",
            coordinateSystem: "view",
            layout: "circular",
            data: [{ name: "A" }, { name: "B" }],
            links: [{ source: 0, target: 1 }],
          },
        ],
      }),
    });
    assert.deepStrictEqual(graph, { ok: true, diagramType: "graph" });
  });
});
