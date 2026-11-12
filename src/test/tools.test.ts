import * as assert from "node:assert";
import * as vscode from "vscode";
import type { DiagramPanel, DiagramState, Drawn } from "../panel";
import type { FromWebview, ImageView } from "../protocol";
import { AnnotateDiagramTool, GetDiagramImageTool, RenderDiagramTool } from "../tools";
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
    assert.match(result, /Nothing was rendered, as the user changed the diagram meanwhile/);
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
      await invokeTool(tool, { source: option, language });
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
    assert.match(drawn, /^Rendered the flowchart diagram in the diagram panel\./);
    assert.ok(drawn.includes(leftOut), drawn);
    assert.deepStrictEqual(linked, [{ A: { file: "sizes.tsv", line: 1 } }]);
    const invalid = await render();
    assert.match(
      invalid,
      /^The diagram fails to render:\n\nParse error\n\nThe panel shows the error\./,
    );
    assert.ok(invalid.includes(leftOut), invalid);
    assert.match(
      await render(),
      /^The panel could not show the diagram: The diagram panel is unavailable\. The panel may still be drawing it\./,
    );
    // A chart takes no links, which no correction adds.
    outcomes.push({ ok: true, diagramType: "bar", revision: 2 });
    const chart = await invokeTool(new RenderDiagramTool(panel), {
      source: '{"series": [{"type": "bar", "data": [1]}]}',
      links: { A: "a.ts" },
    });
    assert.match(
      chart,
      /\n\nThe links were left out\. Links are only for the nodes of a Mermaid diagram; a chart's items are data points rather than places in the code\.$/,
    );
  });

  test("diagram_annotate rejects unsupported fields without clearing existing marks", async () => {
    const { panel, webview } = await newFakePanel();
    assert.ok(
      (await panel.render({ ...flowchart, source: flowchart.source as string }, "tool")).ok,
    );
    const tool = new AnnotateDiagramTool(panel);
    assert.match(await invokeTool(tool, { marks: [{ id: "A", mark: "problem" }] }), /^Marked/);
    const before = panel.describeForModel();
    webview.sent.length = 0;

    assert.match(await invokeTool(tool, { caption: "Look here" }), /Unknown property "caption"/);
    assert.match(
      await invokeTool(tool, { marks: [{ id: "A", note: "Slow" }] }),
      /Unknown property "note"/,
    );

    assert.strictEqual(panel.describeForModel(), before);
    assert.ok(!webview.sent.some((message) => message.type === "annotate"));
  });

  test("diagram_annotate resolves relationship names after reopening the panel", async () => {
    const { panel, webview } = await newFakePanel();
    assert.ok(
      (await panel.render({ ...flowchart, source: flowchart.source as string }, "tool")).ok,
    );
    webview.panel.dispose();
    const reopened = new FakeWebview();
    replace(vscode.window, "createWebviewPanel", () => reopened.panel);
    reopened.answer = (message) =>
      message.type === "render"
        ? {
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
          }
        : undefined;
    const marking = invokeTool(new AnnotateDiagramTool(panel), {
      marks: [{ id: "A --> B", mark: "problem" }],
      dim: true,
    });
    await reopened.receive({ type: "ready" });
    assert.match(await marking, /^Marked 1 item: "A --> B" \(problem\)\./);
    assert.deepStrictEqual(
      reopened.sent.filter((message) => message.type === "annotate"),
      [{ type: "annotate", marks: [{ id: "edge:L_A_B_0", kind: "problem" }], dim: true }],
    );
    assert.strictEqual(panel.revision, 1);
  });

  test("diagram_annotate disambiguates repeated chart names after reopening the panel", async () => {
    const { panel, webview } = await newFakePanel();
    assert.ok(
      (
        await panel.render(
          { language: "echarts", source: '{"series": []}', title: "Survey" },
          "tool",
        )
      ).ok,
    );
    webview.panel.dispose();
    const reopened = new FakeWebview();
    replace(vscode.window, "createWebviewPanel", () => reopened.panel);
    reopened.answer = (message) =>
      message.type === "render"
        ? {
            type: "rendered",
            requestId: message.requestId,
            diagramType: "sankey",
            repeatedNames: [{ name: "Yes", ids: ["Yes (q1)", "Yes (q2)"], count: 2 }],
          }
        : undefined;
    const marking = invokeTool(new AnnotateDiagramTool(panel), {
      marks: [{ id: "Yes", mark: "good" }],
      dim: true,
    });
    await reopened.receive({ type: "ready" });
    assert.match(await marking, /"Yes" \(ids: "Yes \(q1\)", "Yes \(q2\)"\)/);
    assert.deepStrictEqual(
      reopened.sent.filter((message) => message.type === "annotate"),
      [{ type: "annotate", marks: [], dim: true }],
    );
  });

  test("diagram_annotate refuses unverified marks during an in-flight render", async () => {
    const { panel, webview } = await newFakePanel();
    webview.answer = undefined;
    const drawing = panel.render({ ...flowchart, source: flowchart.source as string }, "tool");
    const result = await invokeTool(new AnnotateDiagramTool(panel), {
      marks: [{ id: "A --> B", mark: "problem" }],
      dim: true,
    });
    assert.match(result, /^Nothing was marked: .*still drawing.*Wait for the current render/);
    assert.ok(!webview.sent.some((message) => message.type === "annotate"));
    await webview.finishRender();
    assert.ok((await drawing).ok);
  });

  test("diagram_annotate cannot mark a replacement while reopening the panel", async () => {
    const { panel, webview } = await newFakePanel();
    assert.ok(
      (await panel.render({ ...flowchart, source: flowchart.source as string }, "tool")).ok,
    );
    webview.panel.dispose();
    const reopened = new FakeWebview();
    reopened.answer = undefined;
    replace(vscode.window, "createWebviewPanel", () => reopened.panel);
    const marking = invokeTool(new AnnotateDiagramTool(panel), { marks: ["A"] });
    await reopened.receive({ type: "ready" });
    const replacement = panel.render(
      { language: "mermaid", source: "flowchart LR\n  A[Another node] --> C", title: "Other" },
      "tool",
    );
    assert.match(
      await marking,
      /^Nothing was marked: the diagram changed while it was drawn\. Try again\.$/,
    );
    assert.ok(!reopened.sent.some((message) => message.type === "annotate"));
    await reopened.finishRender();
    assert.ok((await replacement).ok);
  });

  test("diagram_annotate cancellation during reopening leaves marks untouched", async () => {
    const { panel, webview } = await newFakePanel();
    assert.ok(
      (await panel.render({ ...flowchart, source: flowchart.source as string }, "tool")).ok,
    );
    webview.panel.dispose();
    const reopened = new FakeWebview();
    reopened.answer = undefined;
    replace(vscode.window, "createWebviewPanel", () => reopened.panel);
    const cancellation = cancellationSource();
    const marking = invokeTool(
      new AnnotateDiagramTool(panel),
      { marks: ["A"] },
      cancellation.token,
    );
    await reopened.receive({ type: "ready" });
    cancellation.cancel();
    await assert.rejects(marking, vscode.CancellationError);
    await reopened.finishRender();
    assert.ok(!reopened.sent.some((message) => message.type === "annotate"));
    assert.doesNotMatch(panel.describeForModel() ?? "", /Marked: /);
  });

  test("diagram_getImage draws within 1568 pixels a side and 1.15 million in all, and says what it shows", async function () {
    this.timeout(20_000);
    afterTest(() => vscode.commands.executeCommand("workbench.action.closeAllEditors"));
    const opened = await openWebviewPanelAlone(panel);
    const view = async () => {
      const result = await new GetDiagramImageTool(panel).invoke(
        { input: {}, toolInvocationToken: undefined },
        cancellationSource().token,
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
      /^The diagram: all of its \d{4}×\d+ px drawing, at \d\d% in this 1568×\d+ px image\. Its text, 16 px, is \d+(\.\d)? px here: too small to read reliably\. To read it, call diagram_getImage with the "ids" of a few items, to see the part around them\. The panel shows it at \d+% in \d+×\d+ px(?:, too small to read without zooming in)?, \d+% of its width at a time, scrolling sideways for the rest\.$/,
    );
    const pie = '{"series": [{"type": "pie", "data": [{"name": "Pie", "value": 1}]}]}';
    assert.ok((await panel.render({ language: "echarts", source: pie, title: "Pie" }, "tool")).ok);
    const shown = await view();
    const layout = /^The chart: all of it, laid out for the panel at (\d+×\d+ px),/;
    const [, size] = layout.exec(shown.text) ?? [];
    assert.ok(size, shown.text);
    // The page of a hidden tab has the size of an empty frame, too small to lay the chart out for.
    const { viewColumn } = opened;
    assert.ok(viewColumn);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(), viewColumn);
    assert.ok(await within(() => !opened.visible));
    const hidden = await view();
    assert.deepStrictEqual(hidden.size, shown.size);
    assert.match(hidden.text, new RegExp(`^The chart: all of it, laid out at ${size},`));
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
        "The diagram: all of its 400×300 px drawing, at 100% in this 400×300 px image. The panel shows it at 100% in 800×600 px.",
        'The diagram: all of its 4000×500 px drawing, at 39% in this 1568×196 px image. Its text, 16 px, is 6.3 px here: too small to read reliably. To read it, call diagram_getImage with the "ids" of a few items, to see the part around them. The panel shows it at 20% in 800×600 px, too small to read without zooming in.',
        'The diagram: all of its 4000×500 px drawing, at 39% in this 1568×196 px image. Its text, 16 px, is 6.3 px here: too small to read reliably. To read it, call diagram_getImage with the "ids" of a few items, to see the part around them. The panel shows it at 56% in 800×600 px, 36% of its width at a time, scrolling sideways for the rest.',
        'The diagram: the part around "A", "B" (1500×300 px of the 4000×500 px drawing), at 40% in this 600×120 px image. Its text, 16 px, is 6.4 px here: too small to read reliably. To read it, give fewer "ids", of items close together. The panel shows it at 20% in 800×600 px, too small to read without zooming in.\n\nThese ids name nothing drawn, so the image leaves them out: "C".',
        'The diagram: the part around "A" (200×120 px of the 4000×500 px drawing), at 100% in this 200×120 px image. The panel shows it at 20% in 800×600 px, too small to read without zooming in.',
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
        "The chart: all of it, laid out for the panel at 800×1400 px, at 82% in this 656×1148 px image. The panel shows 800×600 px of it at a time, and scrolls the rest.",
        "The chart: all of it, laid out at 800×1400 px, at 82% in this 656×1148 px image.",
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
    for (const input of [{ ids: ["X", "a"] }, { ids: ["A --> C", "Q -> A", "B → A"] }]) {
      results.push(await invokeTool(tool, input));
    }
    const items = '"A", "B", "C", "edge:L_A_B_0", "edge:L_A_B_1", "B --> C"';
    assert.deepStrictEqual(results, [
      `There is no image to view: no item of the diagram has these ids: "X", "a". Its items are ${items}.`,
      'There is no image to view: no item of the diagram has these ids: "A --> C" (nothing goes from "A" to "C"), "Q -> A" ("Q" is not a node id), "B → A" (nothing goes from "B" to "A", only from "A" to "B"). ' +
        `Its items are ${items}.`,
    ]);
    assert.deepStrictEqual(
      webview.sent.filter((message) => message.type === "export"),
      [],
    );
    // Ends name all edges between them, either way for an edge both ways.
    assert.strictEqual(
      await invokeTool(tool, { ids: ["A --> B", "C -> B", "X"] }),
      'The diagram: the part around "A --> B", "C -> B" (200×100 px of the 400×300 px drawing), at 100% in this 200×100 px image.\n\n' +
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
    const token = cancellationSource().token;
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
        ["The chart:", "image/png: png 1"],
        ["The chart:", "image/png: png 0"],
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
    assert.match(await viewing, /^The diagram:/);
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
      "There is no diagram to view. Render one with diagram_render first.",
      "There is no image to view. The diagram fails to render. Render a working diagram first. The error is: Oops",
      "There is no image to view. The panel is still drawing the diagram.",
      "There is no image to view. The diagram changed before it could be exported. Try again.",
      "There is no image to view. The diagram panel returned an invalid PNG image.",
    ]);
  });
});
