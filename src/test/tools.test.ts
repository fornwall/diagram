import * as assert from "node:assert";
import * as vscode from "vscode";
import type { DiagramPanel, DiagramState, RenderOutcome } from "../panel";
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
    const message = (input: { source: string; language?: string }) =>
      tool.prepareInvocation({ input }).invocationMessage;
    assert.strictEqual(
      message({ source: ' {"title": {"text": "Sales"}, "series": []}' }),
      'Rendering chart "Sales"',
    );
    assert.match(String(message({ source: "flowchart LR\n  A --> B" })), /^Rendering diagram/);
    assert.match(
      String(message({ source: '{"series": []}', language: "mermaid" })),
      /^Rendering diagram/,
    );
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

  test("diagram_render reports links it left out, and a panel that could not show the diagram", async () => {
    const outcomes: RenderOutcome[] = [
      { ok: true, diagramType: "flowchart" },
      { ok: false, kind: "invalid", error: "Parse error" },
      { ok: false, kind: "unavailable", error: "The diagram panel is unavailable." },
    ];
    panel.render = async () => outcomes.shift() ?? assert.fail("Rendered too often");
    const render = async () =>
      toolText(
        await new RenderDiagramTool(panel).invoke(
          {
            input: { source: "flowchart LR\n  A --> B", links: { A: "a.ts#L1", B: "b.ts:2" } },
          } as never,
          token,
        ),
      );
    const leftOut =
      '\n\nThese links were left out:\n- "B": "b.ts:2" gives its line after a colon; write it as "#L42"';
    const drawn = await render();
    assert.match(drawn, /^Rendered the flowchart diagram in the diagram panel next to the chat\./);
    assert.ok(drawn.includes(leftOut), drawn);
    assert.match(drawn, /Call diagram_render again with the links corrected to add them\.$/);
    const invalid = await render();
    assert.match(
      invalid,
      /^The diagram failed to render with this error:\n\nParse error\n\nFix the Mermaid syntax/,
    );
    assert.ok(invalid.includes(leftOut), invalid);
    assert.match(
      await render(),
      /^The diagram could not be shown: The diagram panel is unavailable\. This is not a problem with the diagram; .*call diagram_render again to reopen the panel\./,
    );
  });

  test("diagram_render draws despite a misnamed property, and names it", async () => {
    const rendered: (string | undefined)[] = [];
    panel.render = async (diagram) => {
      rendered.push(diagram.clickPrompt);
      return { ok: true, diagramType: "flowchart" };
    };
    const result = await new RenderDiagramTool(panel).invoke(
      {
        input: { source: "flowchart LR\n  A --> B", clickprompt: "Explain {label}", title: null },
      } as never,
      token,
    );
    assert.deepStrictEqual(rendered, [undefined]);
    assert.match(
      toolText(result),
      /\n\nUnknown property "clickprompt"; the properties are "source", "language", "title", "clickPrompt", "links"\. Unknown properties are ignored\.$/,
    );
  });

  test("diagram_chart blames its options for a chart that fails to render", async () => {
    panel.render = async () => ({ ok: false, kind: "invalid", error: "Bad option" });
    const chart = async (input: object) =>
      toolText(
        await new ChartTool(panel).invoke(
          { input: { type: "bar", data: "a,1\nb,2", ...input } } as never,
          token,
        ),
      );
    assert.match(
      await chart({ options: { yAxis: { type: "log" } } }),
      /^The chart failed to render with this error:\n\nBad option\n\n"options" is the likely cause: fix or leave it out and call diagram_chart again\.\n\nCharted /,
    );
    assert.match(
      await chart({}),
      /Bad option\n\nTry another chart type, or write the ECharts option yourself/,
    );
  });

  test("diagram_pickNodes reports the nodes the user picked", async () => {
    const nodes = [
      { id: "A", label: "Parser" },
      {
        id: "edge:L_A_B_0",
        label: "Parser → Checker",
        relationship: { kind: "edge", source: "A", target: "B", direction: "forward" },
      },
    ] as const;
    panel.pickNodes = async () => ({ picked: true, nodes: [...nodes] });
    const result = await new PickDiagramNodesTool(panel).invoke(
      { input: { prompt: "Which?" } } as never,
      token,
    );
    assert.strictEqual(
      toolText(result),
      'The user picked: "Parser" (id: A), "Parser → Checker" (id: edge:L_A_B_0; edge; from: A; to: B; direction: forward).',
    );
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
