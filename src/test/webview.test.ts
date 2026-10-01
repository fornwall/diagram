import * as assert from "node:assert";
import * as vscode from "vscode";
import { type Diagram, DiagramPanel, type RenderOutcome } from "../panel";

const MERMAID: Record<string, string> = {
  "flowchart-v2": "flowchart LR\n  A[Parser] --> B[Checker]",
  sequence: "sequenceDiagram\n  Alice->>Bob: Hello",
  classDiagram: "classDiagram\n  class Parser {\n    +parse() Ast\n  }",
  er: "erDiagram\n  CUSTOMER ||--o{ ORDER : places",
  gantt: "gantt\n  dateFormat YYYY-MM-DD\n  Design :a1, 2026-01-01, 7d",
  mindmap: "mindmap\n  root((Plan))\n    Research",
  timeline: "timeline\n  2025 : Started\n  2026 : Shipped",
};

suite("webview", function () {
  // The first render loads the webview and the libraries, which can take a while.
  this.timeout(20_000);

  let panel: DiagramPanel;
  suiteSetup(() => {
    const extension = vscode.extensions.getExtension("fornwall.diagram");
    assert.ok(extension);
    const workspaceState = { get: () => undefined, update: async () => {} };
    const context = { extensionUri: extension.extensionUri, workspaceState };
    panel = new DiagramPanel(context as unknown as vscode.ExtensionContext);
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

  test("explains charts that cannot render", async () => {
    const outcome = await render({
      language: "echarts",
      source: '{"series": [{"type": "custom"}]}',
    });
    assert.ok(!outcome.ok && outcome.kind === "invalid");
    assert.match(outcome.error, /unsupported type "custom"/);
  });
});
