import * as assert from "node:assert";
import * as vscode from "vscode";
import { ChartTool } from "../chartTools";
import type { DiagramPanel, DiagramState, Drawn } from "../panel";
import type { FromWebview, ImageView } from "../protocol";
import {
  AnnotateDiagramTool,
  GetDiagramImageTool,
  GetDiagramStateTool,
  PickDiagramNodesTool,
  RenderDiagramTool,
} from "../tools";
import { formatOption } from "../webview/optionSource";
import { afterTest, cancellationSource, replace } from "./afterTest";
import { FakeWebview, newFakePanel, newPanel, openWebviewPanelAlone, within } from "./newPanel";
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

  test("diagram_getState leaves out a source that does not fit, instead of having it cut", async () => {
    const source = `flowchart TD\n${"  A --> B\n".repeat(4_000)}`;
    values.set("diagram.state", { ...flowchart, source });
    panel.dispose();
    panel = newPanel(values);
    let counted = 0;
    const state = (tokenBudget: number) =>
      invokeTool(new GetDiagramStateTool(panel), {}, undefined, {
        tokenBudget,
        countTokens: async (text) => {
          counted++;
          return text.length / 4;
        },
      });
    assert.ok((await state(20_000)).includes(source));
    // Whether the source fits is plain from its length alone, without counting its tokens.
    assert.ok((await state(200_000)).includes(source));
    assert.strictEqual(counted, 1);
    assert.doesNotMatch(await state(1_000), /A --> B/);
    assert.strictEqual(counted, 1);
    const summary = await state(10_000);
    assert.doesNotMatch(summary, /A --> B/);
    assert.match(
      summary,
      /\(The source, 40,013 characters long, is left out, as the room left in your input is too small for it\. Without it, you cannot change the diagram: tell the user/,
    );
    assert.match(summary, /"Flow"[\s\S]*The user edited this source/);
  });

  test("diagram_getState gives a caller without a token budget a large chart without its data", async () => {
    const data = Array.from({ length: 20_000 }, (_, i) => i);
    const source = formatOption(JSON.stringify({ series: [{ type: "line", data }] }));
    values.set("diagram.state", { ...flowchart, language: "echarts", source, title: "Line" });
    panel.dispose();
    panel = newPanel(values);
    const state = await invokeTool(new GetDiagramStateTool(panel), {});
    assert.ok(source.length > 100_000);
    assert.match(state, /too long for the room left in your input\. Here it is with long runs/);
    assert.ok(state.length < 2_000, state);
    // With a budget that it fits, it is given in full.
    const budget = { tokenBudget: 100_000, countTokens: async (text: string) => text.length / 4 };
    assert.ok(
      (await invokeTool(new GetDiagramStateTool(panel), {}, undefined, budget)).includes(source),
    );
  });

  test("diagram_getState cancels while waiting for a token counter that does not respond", async () => {
    const cancellation = cancellationSource();
    const reading = invokeTool(new GetDiagramStateTool(panel), {}, cancellation.token, {
      tokenBudget: 200,
      countTokens: () => {
        cancellation.cancel();
        return new Promise<number>(() => {});
      },
    });
    await assert.rejects(reading, vscode.CancellationError);
  });

  test("diagram_getState gives the source of a diagram before a long list of its relationships", async () => {
    const { panel: shown, webview } = await newFakePanel();
    // Two edges between each pair of nodes, which only their ids tell apart.
    const count = 1_600;
    const pair = (i: number) => [`n${Math.floor(i / 2)}`, `n${Math.floor(i / 2) + 1}`] as const;
    const edges = Array.from(
      { length: count },
      (_, i) => `  ${pair(i)[0]}[Service] --> ${pair(i)[1]}`,
    );
    const source = `flowchart TD\n${edges.join("\n")}`;
    const relationships = Array.from({ length: count }, (_, i) => ({
      id: `edge:L_${pair(i).join("_")}_${i % 2}`,
      label: "Service → Service",
      relationship: {
        kind: "edge",
        source: pair(i)[0],
        target: pair(i)[1],
        direction: "forward",
      } as const,
    }));
    webview.answer = (message): FromWebview | undefined =>
      message.type === "render"
        ? {
            type: "rendered",
            requestId: message.requestId,
            diagramType: "flowchart-v2",
            nodeIds: Array.from({ length: count / 2 + 1 }, (_, i) => `n${i}`),
            relationships,
          }
        : undefined;
    assert.ok((await shown.render({ language: "mermaid", source, title: "Services" }, "tool")).ok);
    const full = shown.describeForModel({ detail: "full" }) ?? "";
    assert.ok(full.length > 100_000, String(full.length));
    // Without a budget, and with one that the source fits but not the list.
    const budget = { tokenBudget: 20_000, countTokens: async (text: string) => text.length / 4 };
    for (const room of [undefined, budget]) {
      const state = await invokeTool(new GetDiagramStateTool(shown), {}, undefined, room);
      assert.ok(state.includes(source), state.slice(0, 500));
      assert.match(
        state,
        /It has 1,600 edges, which their ends and labels do not tell apart, too many to list their ids in the room left/,
      );
    }
  });

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
    // As a model may write the language.
    assert.match(
      String(message({ source: "flowchart LR", language: "Mermaid" })),
      /^Rendering diagram/,
    );
    assert.match(String(message({ source: "{}", language: "ECharts" })), /^Rendering chart/);
  });

  test("diagram_render keeps user edits made while checking code links", async () => {
    const { panel: shown, webview } = await newFakePanel();
    await shown.render(
      { language: "mermaid", source: "flowchart TD\n  Original", title: "A" },
      "tool",
    );
    const edited = "flowchart TD\n  Edited";
    const stat = vscode.workspace.fs.stat;
    replace(vscode.workspace, "fs", {
      ...vscode.workspace.fs,
      stat: async (uri) => {
        await webview.edit(edited);
        return stat(uri);
      },
    });
    const result = await invokeTool(new RenderDiagramTool(shown), {
      source: "flowchart TD\n  Replacement",
      links: { Replacement: "sizes.tsv" },
    });
    assert.strictEqual(shown.current?.source, edited);
    assert.match(result, /Nothing was rendered because the diagram changed in the panel/);
  });

  test("diagram_render takes a source in a Markdown fence, with a longer closing marker", async () => {
    const rendered: string[] = [];
    panel.render = async (diagram) => {
      rendered.push(`${diagram.language}: ${diagram.source.trim()}`);
      return { ok: true, diagramType: "test", revision: 1 };
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
      return { ok: true, diagramType: "test", revision: 1 };
    };
    const tool = new RenderDiagramTool(panel);
    const option = { title: { text: "Sales" }, series: [] };
    for (const language of [undefined, "echarts", "ECharts"]) {
      const input = { source: option, language };
      assert.strictEqual(
        tool.prepareInvocation({ input } as never).invocationMessage,
        'Rendering chart "Sales"',
      );
      await invokeTool(tool, input);
    }
    assert.match(
      await invokeTool(tool, { source: option, language: "mermaid" }),
      /Nothing was rendered: Give "source"/,
    );
    assert.deepStrictEqual(
      rendered,
      Array(3).fill(`echarts "Sales": ${JSON.stringify(option, null, 2)}`),
    );
  });

  test("diagram_render reports links it left out, and a panel that could not show the diagram", async () => {
    const outcomes: Drawn[] = [
      { ok: true, diagramType: "flowchart", revision: 1 },
      { ok: false, kind: "invalid", error: "Parse error", revision: 1 },
      { ok: false, kind: "unavailable", error: "The diagram panel is unavailable.", revision: 1 },
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
    assert.match(drawn, /\. Correct them with "links" in diagram_edit\.\n\nRevision: 1\.$/);
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
    // A chart takes no links, which no correction adds.
    outcomes.push({ ok: true, diagramType: "bar", revision: 2 });
    const chart = await invokeTool(new RenderDiagramTool(panel), {
      source: '{"series": [{"type": "bar", "data": [1]}]}',
      links: { A: "a.ts" },
    });
    assert.match(
      chart,
      /\n\nThe links were left out\. Links are only for the nodes of a Mermaid diagram; a chart's items are data points rather than places in the code\.\n\nRevision: 2\.$/,
    );
  });

  test("diagram_render draws despite a misnamed property, and names it", async () => {
    const rendered: (string | undefined)[] = [];
    panel.render = async (diagram) => {
      rendered.push(diagram.clickPrompt);
      return { ok: true, diagramType: "flowchart", revision: 1 };
    };
    const result = await invokeTool(new RenderDiagramTool(panel), {
      source: "flowchart LR\n  A --> B",
      clickprompt: "Explain {label}",
      title: null,
    });
    assert.deepStrictEqual(rendered, [undefined]);
    assert.match(
      result,
      /\n\nUnknown property "clickprompt"; the properties are "source", "language", "title", "clickPrompt", "links"\. Unknown properties are ignored\.\n\nRevision: 1\.$/,
    );
  });

  test("diagram_render draws despite a title or click prompt that is not a string, and says so", async () => {
    panel.render = async () => ({ ok: true, diagramType: "flowchart", revision: 1 });
    assert.match(
      await invokeTool(new RenderDiagramTool(panel), {
        source: "flowchart LR\n  A --> B",
        title: 5,
        clickPrompt: [],
      }),
      /\n\n"title" must be a string, so it was ignored\. "clickPrompt" must be a string, so it was ignored\.\n\nRevision: 1\.$/,
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
      return { ok: true, diagramType: "test", revision: 1 };
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
      [new GetDiagramStateTool(panel), {}],
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

  test("diagram_getImage draws within 1568 pixels a side and 1.15 million in all, and says what it shows", async function () {
    this.timeout(20_000);
    afterTest(() => vscode.commands.executeCommand("workbench.action.closeAllEditors"));
    const opened = await openWebviewPanelAlone(panel);
    const view = async () => {
      const result = await new GetDiagramImageTool(panel).invoke(
        { input: {}, toolInvocationToken: undefined },
        new vscode.CancellationTokenSource().token,
      );
      const image = result.content[1];
      assert.ok(image instanceof vscode.LanguageModelDataPart, toolText(result));
      const png = Buffer.from(image.data);
      assert.strictEqual(png.subarray(1, 4).toString(), "PNG");
      const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)];
      assert.ok(
        Math.max(width, height) <= 1568 && width * height <= 1_150_000,
        `${width}×${height}`,
      );
      const text = toolText(result);
      // The text gives the size of the image the model sees.
      assert.ok(text.includes(` in this ${width}×${height} px image.`), text);
      return { text, size: [width, height] };
    };
    const steps = Array.from({ length: 30 }, (_, step) => `S${step}[Step ${step}]`).join(" --> ");
    const wide = {
      language: "mermaid",
      source: `flowchart LR\n  ${steps}`,
      title: "Steps",
    } as const;
    assert.ok((await panel.render(wide, "tool")).ok);
    const steps30 = await view();
    assert.strictEqual(steps30.size[0], 1568);
    assert.match(
      steps30.text,
      /^Revision \d+ of the diagram: all of its \d{4}×\d+ px drawing, at \d\d% in this 1568×\d+ px image\. Its text, 16 px, is \d+(\.\d)? px here: too small to read reliably\. To read it, call diagram_getImage with the "ids" of a few items, to see the part around them\. The panel shows it at \d+% in \d+×\d+ px(?:, too small to read without zooming in)?, \d+% of its width at a time, scrolling sideways for the rest\.$/,
    );
    const pie = '{"series": [{"type": "pie", "data": [{"name": "Pie", "value": 1}]}]}';
    assert.ok((await panel.render({ language: "echarts", source: pie, title: "Pie" }, "tool")).ok);
    const shown = await view();
    const layout = /^Revision \d+ of the chart: all of it, laid out for the panel at (\d+×\d+ px),/;
    const [, size] = layout.exec(shown.text) ?? [];
    assert.ok(size, shown.text);
    // The page of a hidden tab has the size of an empty frame, too small to lay the chart out for.
    const { viewColumn } = opened;
    assert.ok(viewColumn);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(), viewColumn);
    assert.ok(await within(() => !opened.visible));
    const hidden = await view();
    assert.deepStrictEqual(hidden.size, shown.size);
    assert.match(
      hidden.text,
      new RegExp(`^Revision \\d+ of the chart: all of it, laid out at ${size},`),
    );
    // The user closed the panel: viewing opens it again, beside chat, without taking the focus.
    const tabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    assert.ok(await within(() => tabs().length === 0));
    const reopened = await view();
    assert.match(reopened.text, layout);
    assert.ok(tabs().some((tab) => tab.input instanceof vscode.TabInputWebview));
  });

  test("diagram_getImage tells what its image shows, and what it cannot show", async () => {
    const { panel, webview } = await newFakePanel();
    const drawn = webview.answer;
    let png = Buffer.from("png");
    const view = async (input: unknown, answer: ImageView | string) => {
      webview.answer = (message) =>
        message.type !== "export"
          ? drawn?.(message)
          : typeof answer === "string"
            ? { type: "exportError", requestId: message.requestId, message: answer }
            : {
                type: "exportImage",
                requestId: message.requestId,
                format: "png",
                data: `data:image/png;base64,${png.toString("base64")}`,
                view: answer,
              };
      return invokeTool(new GetDiagramImageTool(panel), input);
    };
    const flow = { language: "mermaid", source: "flowchart LR\n  A --> B", title: "Flow" } as const;
    assert.ok((await panel.render(flow, "tool")).ok);
    const room = { width: 800, height: 600, zoom: 0.2 };
    const drawing = { width: 4000, height: 500, textSize: 16, panel: room };
    assert.deepStrictEqual(
      [
        await view(
          {},
          { width: 400, height: 300, textSize: 16, scale: 1, panel: { ...room, zoom: 1 } },
        ),
        await view({}, { ...drawing, scale: 0.392 }),
        // As fitting a wide drawing only as far as its text reads shows it.
        await view({}, { ...drawing, scale: 0.392, panel: { ...room, zoom: 0.5625 } }),
        await view(
          { ids: ["A", "B", "C"] },
          {
            ...drawing,
            area: { width: 1500, height: 300 },
            scale: 0.4,
            missing: ["C"],
          },
        ),
        await view({ ids: "A" }, { ...drawing, area: { width: 200, height: 120 }, scale: 1 }),
        await view({ ids: "A" }, 'Nothing drawn has these ids: "A".'),
      ],
      [
        "Revision 1 of the diagram: all of its 400×300 px drawing, at 100% in this 400×300 px image. The panel shows it at 100% in 800×600 px.",
        'Revision 1 of the diagram: all of its 4000×500 px drawing, at 39% in this 1568×196 px image. Its text, 16 px, is 6.3 px here: too small to read reliably. To read it, call diagram_getImage with the "ids" of a few items, to see the part around them. The panel shows it at 20% in 800×600 px, too small to read without zooming in.',
        'Revision 1 of the diagram: all of its 4000×500 px drawing, at 39% in this 1568×196 px image. Its text, 16 px, is 6.3 px here: too small to read reliably. To read it, call diagram_getImage with the "ids" of a few items, to see the part around them. The panel shows it at 56% in 800×600 px, 36% of its width at a time, scrolling sideways for the rest.',
        'Revision 1 of the diagram: the part around "A", "B" (1500×300 px of the 4000×500 px drawing), at 40% in this 600×120 px image. Its text, 16 px, is 6.4 px here: too small to read reliably. To read it, give fewer "ids", of items close together. The panel shows it at 20% in 800×600 px, too small to read without zooming in.\n\nThese ids name nothing drawn, so the image leaves them out: "C".',
        'Revision 1 of the diagram: the part around "A" (200×120 px of the 4000×500 px drawing), at 100% in this 200×120 px image. The panel shows it at 20% in 800×600 px, too small to read without zooming in.',
        'There is no image to view. Nothing drawn has these ids: "A".',
      ],
    );
    const pie = '{"series": [{"type": "pie", "data": [1]}]}';
    assert.ok((await panel.render({ language: "echarts", source: pie, title: "Pie" }, "tool")).ok);
    const chart = { width: 800, height: 1400, textSize: 12, scale: 0.82 };
    assert.deepStrictEqual(
      [
        await view({}, { ...chart, panel: { width: 800, height: 600, zoom: 1 } }),
        await view({}, chart),
      ],
      [
        "Revision 2 of the chart: all of it, laid out for the panel at 800×1400 px, at 82% in this 656×1148 px image. The panel shows 800×600 px of it at a time, and scrolls the rest.",
        "Revision 2 of the chart: all of it, laid out at 800×1400 px, at 82% in this 656×1148 px image.",
      ],
    );
    // The size of the image is that of the PNG, whose sides the page rounds down.
    png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.write("IHDR", 12);
    png.writeUInt32BE(803, 16);
    png.writeUInt32BE(897, 20);
    assert.match(
      await view({}, { width: 602, height: 673, scale: 1.3339 }),
      / at 133% in this 803×897 px image\.$/,
    );
  });

  test("diagram_getImage checks the ids it is given, as far as the panel knows them", async () => {
    const { panel, webview } = await newFakePanel();
    const edge = (id: string, source: string, target: string, direction = "forward") => ({
      id,
      label: `${source} → ${target}`,
      relationship: { kind: "edge", source, target, direction },
    });
    webview.answer = (message) =>
      message.type === "render"
        ? ({
            type: "rendered",
            requestId: message.requestId,
            diagramType: "flowchart-v2",
            nodeIds: ["A", "B", "C"],
            relationships: [
              edge("edge:L_A_B_0", "A", "B"),
              edge("edge:L_A_B_1", "A", "B"),
              edge("edge:L_B_C_0", "B", "C", "both"),
            ],
          } as FromWebview)
        : message.type === "export"
          ? {
              type: "exportImage",
              requestId: message.requestId,
              format: "png",
              data: `data:image/png;base64,${Buffer.from("png").toString("base64")}`,
              view: { width: 400, height: 300, area: { width: 200, height: 100 }, scale: 1 },
            }
          : undefined;
    const flow = { language: "mermaid", source: "flowchart LR\n  A --> B", title: "Flow" } as const;
    assert.ok((await panel.render(flow, "tool")).ok);
    const tool = new GetDiagramImageTool(panel);
    const results = [];
    for (const input of [
      { ids: ["X", "a"] },
      { ids: ["A --> C", "Q -> A", "B → A"] },
      { ids: [1] },
      { id: "A" },
    ]) {
      results.push(await invokeTool(tool, input));
    }
    const items = '"A", "B", "C", "edge:L_A_B_0", "edge:L_A_B_1", "B --> C"';
    assert.deepStrictEqual(results, [
      `There is no image to view: no item of the diagram has these ids: "X", "a". Its items are ${items}.`,
      'There is no image to view: no item of the diagram has these ids: "A --> C" (nothing goes from "A" to "C"), "Q -> A" ("Q" is not a node id), "B → A" (nothing goes from "B" to "A", only from "A" to "B"). ' +
        `Its items are ${items}.`,
      'There is no image to view: "ids" must be an array of item ids, such as ["A", "A --> B"].',
      'There is no image to view: Unknown property "id"; the properties are "ids".',
    ]);
    assert.deepStrictEqual(
      webview.sent.filter((message) => message.type === "export"),
      [],
    );
    // Ends name all edges between them, either way for an edge both ways.
    assert.strictEqual(
      await invokeTool(tool, { ids: ["A --> B", "C -> B", "X"] }),
      'Revision 1 of the diagram: the part around "A --> B", "C -> B" (200×100 px of the 400×300 px drawing), at 100% in this 200×100 px image.\n\n' +
        `These ids name nothing drawn, so the image leaves them out: "X". Its items are ${items}.`,
    );
    const exported = webview.sent.filter((message) => message.type === "export");
    assert.deepStrictEqual(
      exported.map((message) => message.ids),
      [["edge:L_A_B_0", "edge:L_A_B_1", "edge:L_B_C_0"]],
    );
    assert.deepStrictEqual(
      [
        tool.prepareInvocation({ input: { ids: ["A", "edge:L_A_B_0"] } }).invocationMessage,
        tool.prepareInvocation({ input: { ids: ["A", "B", "C", "D"] } }).invocationMessage,
        tool.prepareInvocation({ input: {} }).invocationMessage,
      ],
      [
        'Viewing "A", "edge:L_A_B_0" in the diagram',
        "Viewing 4 items in the diagram",
        "Viewing the diagram",
      ],
    );
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
      exports.map(({ format, forModel, maxSide, maxPixels, ids }) => ({
        format,
        forModel,
        maxSide,
        maxPixels,
        ids,
      })),
      Array(2).fill({
        format: "png",
        forModel: true,
        maxSide: 1568,
        maxPixels: 1_150_000,
        ids: [],
      }),
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
        ["Revision 1 of the chart:", "image/png: png 1"],
        ["Revision 1 of the chart:", "image/png: png 0"],
      ],
    );
  });

  test("diagram_getImage resolves relationship names after reopening the panel", async () => {
    const { panel, webview } = await newFakePanel();
    assert.ok(flowchart.source !== undefined);
    assert.ok((await panel.render({ ...flowchart, source: flowchart.source }, "tool")).ok);
    webview.panel.dispose();
    const reopened = new FakeWebview();
    replace(vscode.window, "createWebviewPanel", () => reopened.panel);
    reopened.answer = (message) => {
      if (message.type === "render") {
        return {
          type: "rendered",
          requestId: message.requestId,
          diagramType: "flowchart",
          nodeIds: ["A", "B"],
          relationships: [
            {
              id: "edge:L_A_B_0",
              label: "Parser → Checker",
              relationship: { kind: "edge", source: "A", target: "B", direction: "forward" },
            },
          ],
        };
      }
      if (message.type === "export") {
        return {
          type: "exportImage",
          requestId: message.requestId,
          format: "png",
          data: `data:image/png;base64,${Buffer.from("png").toString("base64")}`,
        };
      }
      return undefined;
    };
    const viewing = invokeTool(new GetDiagramImageTool(panel), { ids: ["A --> B"] });
    await reopened.receive({ type: "ready" });
    assert.match(await viewing, /^Revision 1 of the diagram:/);
    const exported = reopened.sent.find((message) => message.type === "export");
    assert.deepStrictEqual(exported?.ids, ["edge:L_A_B_0"]);
  });

  test("diagram_getImage says why there is no image to view", async () => {
    const view = (from: DiagramPanel) => invokeTool(new GetDiagramImageTool(from), {});
    const empty = newPanel();
    afterTest(() => empty.dispose());
    const flow = { language: "mermaid", source: "flowchart LR\n  A --> B", title: "Flow" } as const;
    const { panel: shown, webview } = await newFakePanel();
    const reasons = [await view(empty)];
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
      "There is no diagram to view. Render one with diagram_render or diagram_chart first.",
      "There is no image to view. The diagram fails to render. Render a working diagram first. The error is: Oops",
      "There is no image to view. The panel is still drawing the diagram.",
      "There is no image to view. The diagram changed before it could be exported. Try again.",
      "There is no image to view. The diagram panel returned an invalid PNG image.",
    ]);
  });
});
