import * as assert from "node:assert";
import * as vscode from "vscode";
import type { DiagramPanel, DiagramState } from "../panel";
import { AnnotateDiagramTool, ChartTool, PickDiagramNodesTool, RenderDiagramTool } from "../tools";
import { newPanel } from "./newPanel";
import { toolText } from "./toolText";

const flowchart: DiagramState = {
  language: "mermaid",
  source: "flowchart LR\n  A[Parser] --> B[Checker]",
  title: "Flow",
  origin: "tool",
  editedByUser: true,
};

suite("tools", () => {
  let panel: DiagramPanel;
  let values: Map<string, unknown>;
  const cancellation = new vscode.CancellationTokenSource();
  const token = new vscode.CancellationTokenSource().token;
  setup(() => {
    values = new Map<string, unknown>([["diagram.state", flowchart]]);
    panel = newPanel(values);
  });
  teardown(() => panel.dispose());
  suiteTeardown(() => cancellation.dispose());

  test("diagram_render reads a source starting with a brace as an ECharts option", () => {
    const tool = new RenderDiagramTool(panel);
    const message = (source: string, language?: string) =>
      tool.prepareInvocation({ input: { source, language } }).invocationMessage;
    assert.strictEqual(
      message(' {"title": {"text": "Sales"}, "series": []}'),
      'Rendering chart "Sales"',
    );
    assert.match(String(message("flowchart LR\n  A --> B")), /^Rendering diagram/);
    assert.match(String(message('{"series": []}', "mermaid")), /^Rendering diagram/);
  });

  test("diagram_render takes a source in a Markdown fence, with a longer closing marker", async () => {
    const rendered: string[] = [];
    panel.render = async (diagram) => {
      rendered.push(`${diagram.language}: ${diagram.source.trim()}`);
      return { ok: true, diagramType: "test" };
    };
    const tool = new RenderDiagramTool(panel);
    for (const source of ["```mermaid\nflowchart TD\n````", "  ~~~echarts\r\n{}\r\n~~~~  "]) {
      await tool.invoke({ input: { source } } as never, token);
    }
    assert.deepStrictEqual(rendered, ["mermaid: flowchart TD", "echarts: {}"]);
    for (const source of ["```mermaid\n```", "~~~echarts\n  \n~~~~"]) {
      const result = await tool.invoke({ input: { source } } as never, token);
      assert.match(toolText(result), /Nothing was rendered: Give "source"/);
    }
    assert.strictEqual(rendered.length, 2);
  });

  test("tools report malformed input without throwing during preparation", async () => {
    for (const tool of [
      new RenderDiagramTool(panel),
      new ChartTool(panel),
      new PickDiagramNodesTool(panel),
      new AnnotateDiagramTool(panel),
    ]) {
      for (const input of [null, undefined, [], 42]) {
        const options = { input } as never;
        tool.prepareInvocation(options);
        assert.match(
          toolText(await tool.invoke(options, token)),
          /^(Nothing was rendered|No chart was rendered|No node was picked|Nothing was marked): /,
        );
      }
    }
    assert.strictEqual(panel.current, flowchart);
  });

  test("cancelled tools leave the diagram, its marks and the closed panel alone", async () => {
    cancellation.cancel();
    const calls: string[] = [];
    panel.render = async () => {
      calls.push("render");
      return { ok: true, diagramType: "test" };
    };
    panel.annotate = () => {
      calls.push("annotate");
      return { ok: false, reason: "Unexpected annotation" };
    };
    const create = vscode.window.createWebviewPanel;
    vscode.window.createWebviewPanel = (...args) => {
      calls.push("open");
      return create(...args);
    };
    try {
      for (const [tool, input] of [
        [new RenderDiagramTool(panel), { source: "flowchart LR\n  C --> D" }],
        [new ChartTool(panel), { type: "bar", data: "A,1\nB,2" }],
        [new AnnotateDiagramTool(panel), { marks: ["A"] }],
      ] as const) {
        await assert.rejects(
          async () => tool.invoke({ input } as never, cancellation.token),
          vscode.CancellationError,
        );
      }
      assert.deepStrictEqual(calls, []);
      assert.strictEqual(panel.current, flowchart);
      assert.strictEqual(values.get("diagram.state"), flowchart);
    } finally {
      vscode.window.createWebviewPanel = create;
    }
  });

  test("cancelling a chart stops waiting for a file read", async () => {
    const cancellable = new vscode.CancellationTokenSource();
    const descriptor = Object.getOwnPropertyDescriptor(vscode.workspace, "fs");
    assert.ok(descriptor);
    const started = Promise.withResolvers<void>();
    const data = Promise.withResolvers<Uint8Array>();
    Object.defineProperty(vscode.workspace, "fs", {
      configurable: true,
      value: {
        ...vscode.workspace.fs,
        readFile: () => {
          started.resolve();
          return data.promise;
        },
      },
    });
    try {
      const result = new ChartTool(panel).invoke(
        { input: { type: "bar", file: "sizes.tsv" } } as never,
        cancellable.token,
      );
      await started.promise;
      cancellable.cancel();
      await assert.rejects(result, vscode.CancellationError);
      assert.strictEqual(panel.current, flowchart);
    } finally {
      data.resolve(new TextEncoder().encode("name,value\nA,1"));
      Object.defineProperty(vscode.workspace, "fs", descriptor);
      cancellable.dispose();
    }
  });
});
