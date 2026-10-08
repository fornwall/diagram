import * as assert from "node:assert";
import * as vscode from "vscode";
import { ChartTool } from "../chartTools";
import type { DiagramPanel, DiagramState, RenderOutcome } from "../panel";
import type { FromWebview } from "../protocol";
import {
  AnnotateDiagramTool,
  GetDiagramImageTool,
  PickDiagramNodesTool,
  RenderDiagramTool,
} from "../tools";
import { afterTest, cancellationSource, replace } from "./afterTest";
import { newFakePanel, newPanel, openWebviewPanel, within } from "./newPanel";
import { invokeTool, toolText } from "./toolText";

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

  test("diagram_render takes an ECharts option given as an object", async () => {
    const rendered: string[] = [];
    panel.render = async (diagram) => {
      rendered.push(`${diagram.language} "${diagram.title}": ${diagram.source}`);
      return { ok: true, diagramType: "test" };
    };
    const tool = new RenderDiagramTool(panel);
    const option = { title: { text: "Sales" }, series: [] };
    await invokeTool(tool, { source: option });
    assert.match(
      await invokeTool(tool, { source: option, language: "mermaid" }),
      /Nothing was rendered: Give "source"/,
    );
    assert.deepStrictEqual(rendered, [`echarts "Sales": ${JSON.stringify(option, null, 2)}`]);
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
      'The user picked: "Parser" (id: "A"), "Parser → Checker" (id: "edge:L_A_B_0"; edge; from: "A"; to: "B"; direction: forward).',
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
    const cancellation = cancellationSource();
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
      [new GetDiagramImageTool(panel), {}],
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

  test("diagram_getImage draws at most 1024 pixels a side, and a hidden chart as it was shown", async function () {
    this.timeout(20_000);
    afterTest(() => vscode.commands.executeCommand("workbench.action.closeAllEditors"));
    const opened = openWebviewPanel(panel);
    const imageSize = async () => {
      const result = await new GetDiagramImageTool(panel).invoke(
        { input: {}, toolInvocationToken: undefined },
        new vscode.CancellationTokenSource().token,
      );
      const image = result.content[1];
      assert.ok(image instanceof vscode.LanguageModelDataPart, toolText(result));
      const png = Buffer.from(image.data);
      assert.strictEqual(png.subarray(1, 4).toString(), "PNG");
      return [png.readUInt32BE(16), png.readUInt32BE(20)];
    };
    const steps = Array.from({ length: 12 }, (_, step) => `S${step}[Step ${step}]`).join(" --> ");
    const wide = {
      language: "mermaid",
      source: `flowchart LR\n  ${steps}`,
      title: "Steps",
    } as const;
    assert.ok((await panel.render(wide, "tool")).ok);
    assert.strictEqual((await imageSize())[0], 1024);
    const pie = '{"series": [{"type": "pie", "data": [{"name": "Pie", "value": 1}]}]}';
    assert.ok((await panel.render({ language: "echarts", source: pie, title: "Pie" }, "tool")).ok);
    const shown = await imageSize();
    assert.ok(Math.max(...shown) <= 1024 && Math.min(...shown) > 300, String(shown));
    // The page of a hidden tab has the size of an empty frame, too small to lay the chart out for.
    const { viewColumn } = opened;
    assert.ok(viewColumn);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(), viewColumn);
    assert.ok(await within(() => !opened.visible));
    assert.deepStrictEqual(await imageSize(), shown);
  });

  test("diagram_getImage answers each of several calls at once", async () => {
    const { panel, webview } = await newFakePanel();
    const pie = '{"series": [{"type": "pie", "data": [1]}]}';
    assert.ok((await panel.render({ language: "echarts", source: pie, title: "Pie" }, "tool")).ok);
    webview.answer = undefined;
    const tool = new GetDiagramImageTool(panel);
    const token = new vscode.CancellationTokenSource().token;
    const viewing = [1, 2].map(() =>
      tool.invoke({ input: {}, toolInvocationToken: undefined }, token),
    );
    await new Promise((resolve) => setImmediate(resolve));
    const exports = webview.sent.filter((message) => message.type === "export");
    assert.deepStrictEqual(
      exports.map(({ format, maxSide }) => ({ format, maxSide })),
      Array(2).fill({ format: "png", maxSide: 1024 }),
    );
    // The page may answer them in any order.
    for (const [index, { requestId }] of exports.reverse().entries()) {
      const data = `data:image/png;base64,${Buffer.from(`png ${index}`).toString("base64")}`;
      await webview.receive({ type: "exportImage", requestId, format: "png", data });
    }
    const results = await Promise.all(viewing);
    assert.deepStrictEqual(
      results.map(({ content: [text, image] }) => [
        text instanceof vscode.LanguageModelTextPart && text.value,
        image instanceof vscode.LanguageModelDataPart &&
          `${image.mimeType}: ${Buffer.from(image.data)}`,
      ]),
      [
        [
          "Revision 1 of the chart, laid out for the panel's size, or for 800 by 500 pixels if first drawn while the panel was hidden:",
          "image/png: png 1",
        ],
        [
          "Revision 1 of the chart, laid out for the panel's size, or for 800 by 500 pixels if first drawn while the panel was hidden:",
          "image/png: png 0",
        ],
      ],
    );
  });

  test("diagram_getImage says why there is no image to view", async () => {
    const view = (from: DiagramPanel) => invokeTool(new GetDiagramImageTool(from), {});
    const empty = newPanel();
    afterTest(() => empty.dispose());
    const flow = { language: "mermaid", source: "flowchart LR\n  A --> B", title: "Flow" } as const;
    const { panel: shown, webview } = await newFakePanel();
    const reasons = [await view(empty), await view(panel)];
    webview.failNextRender("Oops");
    assert.ok(!(await shown.render(flow, "tool")).ok);
    reasons.push(await view(shown));
    webview.answer = undefined;
    const rendering = shown.render(flow, "tool");
    reasons.push(await view(shown));
    await webview.finishRender();
    assert.ok((await rendering).ok);
    for (const answer of [
      {
        type: "exportError",
        message: "The diagram changed before it could be exported. Try again.",
      },
      { type: "exportImage", format: "svg", data: "<svg/>" },
    ] as const) {
      webview.answer = (message) =>
        message.type === "export"
          ? ({ ...answer, requestId: message.requestId } as FromWebview)
          : undefined;
      reasons.push(await view(shown));
    }
    assert.deepStrictEqual(reasons, [
      "No diagram is shown. Use diagram_render or diagram_chart to show one.",
      "There is no image to view. The diagram panel is closed. The user can open it again with Diagram: Show Panel.",
      "There is no image to view. The diagram fails to render: Oops",
      "There is no image to view. The panel is still drawing the diagram.",
      "There is no image to view. The diagram changed before it could be exported. Try again.",
      "There is no image to view. The diagram panel returned an invalid PNG image.",
    ]);
  });
});
