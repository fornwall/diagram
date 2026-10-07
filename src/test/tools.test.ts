import * as assert from "node:assert";
import * as vscode from "vscode";
import { ChartTool } from "../chartTools";
import type { DiagramPanel, DiagramState, RenderOutcome } from "../panel";
import { AnnotateDiagramTool, PickDiagramNodesTool, RenderDiagramTool } from "../tools";
import { afterTest, replace } from "./afterTest";
import { newPanel } from "./newPanel";
import { invokeTool } from "./toolText";

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
  setup(() => {
    values = new Map<string, unknown>([["diagram.state", flowchart]]);
    panel = newPanel(values);
  });
  teardown(() => panel.dispose());

  test("diagram_render says it renders a chart for a source that starts with a brace", () => {
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
      await invokeTool(tool, { source });
    }
    assert.deepStrictEqual(rendered, ["mermaid: flowchart TD", "echarts: {}"]);
    for (const source of ["```mermaid\n```", "~~~echarts\n  \n~~~~"]) {
      assert.match(await invokeTool(tool, { source }), /Nothing was rendered: Give "source"/);
    }
    assert.strictEqual(rendered.length, 2);
  });

  test("diagram_render reports links it left out, and a panel that could not show the diagram", async () => {
    const outcomes: RenderOutcome[] = [
      { ok: true, diagramType: "flowchart" },
      { ok: false, kind: "invalid", error: "Parse error" },
      { ok: false, kind: "unavailable", error: "The diagram panel is unavailable." },
    ];
    const linked: unknown[] = [];
    panel.render = async ({ links }) => {
      linked.push(links);
      return outcomes.shift() ?? assert.fail("Rendered too often");
    };
    const render = () =>
      invokeTool(new RenderDiagramTool(panel), {
        source: "flowchart LR\n  A --> B",
        links: { A: "sizes.tsv#L1", B: "b.ts:2", C: "made-up.ts" },
      });
    const leftOut =
      '\n\nThese links were left out:\n- "B": "b.ts:2" gives its line after a colon; write it as "#L42" or "#L42-L80".\n- "C": made-up.ts does not exist.\n';
    const drawn = await render();
    assert.match(drawn, /^Rendered the flowchart diagram in the diagram panel next to the chat\./);
    assert.ok(drawn.includes(leftOut), drawn);
    assert.match(drawn, /Call diagram_render again with the links corrected to add them\.$/);
    assert.deepStrictEqual(linked, [{ A: { file: "sizes.tsv", line: 1 } }]);
    const invalid = await render();
    assert.match(
      invalid,
      /^The diagram failed to render with this error:\n\nParse error\n\nFix the Mermaid syntax/,
    );
    assert.ok(invalid.includes(leftOut), invalid);
    assert.match(
      await render(),
      /^The diagram could not be shown: The diagram panel is unavailable\. This is not a problem with the diagram, and the panel may still be drawing it: diagram_getState says whether it is shown\. Call diagram_render again only to reopen a closed panel/,
    );
  });

  test("diagram_render draws despite a misnamed property, and names it", async () => {
    const rendered: (string | undefined)[] = [];
    panel.render = async (diagram) => {
      rendered.push(diagram.clickPrompt);
      return { ok: true, diagramType: "flowchart" };
    };
    const result = await invokeTool(new RenderDiagramTool(panel), {
      source: "flowchart LR\n  A --> B",
      clickprompt: "Explain {label}",
      title: null,
    });
    assert.deepStrictEqual(rendered, [undefined]);
    assert.match(
      result,
      /\n\nUnknown property "clickprompt"; the properties are "source", "language", "title", "clickPrompt", "links"\. Unknown properties are ignored\.$/,
    );
  });

  test("diagram_render draws despite a title or click prompt that is not a string, and says so", async () => {
    panel.render = async () => ({ ok: true, diagramType: "flowchart" });
    assert.match(
      await invokeTool(new RenderDiagramTool(panel), {
        source: "flowchart LR\n  A --> B",
        title: 5,
        clickPrompt: [],
      }),
      /\n\n"title" must be a string, so it was ignored\. "clickPrompt" must be a string, so it was ignored\.$/,
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
    assert.strictEqual(
      await invokeTool(new PickDiagramNodesTool(panel), { prompt: "Which?" }),
      'The user picked: "Parser" (id: A), "Parser → Checker" (id: edge:L_A_B_0; edge; from: A; to: B; direction: forward).',
    );
  });

  test("diagram_pickNodes refuses a misnamed or mistyped setting instead of picking one item", async () => {
    let picks = 0;
    panel.pickNodes = async () => ({ picked: false, reason: `Pick ${++picks}` });
    const pick = (input: object) => invokeTool(new PickDiagramNodesTool(panel), input);
    assert.match(await pick({ prompt: "Which?", multi: true }), /Unknown property "multi"/);
    assert.match(await pick({ prompt: "Which?", multiple: "true" }), /"multiple" must be true/);
    assert.strictEqual(
      await pick({ prompt: "Which?", multiple: null }),
      "No node was picked: Pick 1",
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
        tool.prepareInvocation({ input } as never);
        assert.match(
          await invokeTool(tool, input),
          /^(Nothing was rendered|No chart was rendered|No node was picked|Nothing was marked): /,
        );
      }
    }
    assert.deepStrictEqual(panel.current, flowchart);
  });

  test("cancelled tools leave the diagram, its marks and the closed panel alone", async () => {
    const cancellation = new vscode.CancellationTokenSource();
    afterTest(() => cancellation.dispose());
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
    replace(vscode.window, "createWebviewPanel", (...args) => {
      calls.push("open");
      return create(...args);
    });
    for (const [tool, input] of [
      [new RenderDiagramTool(panel), { source: "flowchart LR\n  C --> D" }],
      [new ChartTool(panel), { type: "bar", data: "A,1\nB,2" }],
      [new AnnotateDiagramTool(panel), { marks: ["A"] }],
    ] as const) {
      await assert.rejects(
        () => invokeTool(tool, input, cancellation.token),
        vscode.CancellationError,
      );
    }
    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(panel.current, flowchart);
    assert.strictEqual(values.get("diagram.state"), flowchart);
  });
});
