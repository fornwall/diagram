import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { linkText, linkTexts, type NodeLink } from "../links";
import {
  clickToAskQuery,
  type Diagram,
  DiagramPanel,
  type DiagramState,
  type RenderOutcome,
} from "../panel";
import { type FromWebview, isFromWebview, type ToWebview } from "../protocol";
import { AnnotateDiagramTool, ChartTool, PickDiagramNodesTool, RenderDiagramTool } from "../tools";
import { newPanel } from "./newPanel";
import { testColors } from "./themeColors";

const flowchart: Diagram = {
  language: "mermaid",
  source: "flowchart LR\n  A[Parser] --> B[Checker]",
  title: "Flow",
};

/** Waits until the webview tabs have the given labels, as tabs are updated asynchronously. */
async function webviewTabs(labels: string[]): Promise<vscode.Tab[]> {
  for (;;) {
    const tabs = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.input instanceof vscode.TabInputWebview);
    if (tabs.map((tab) => tab.label).join() === labels.join()) {
      return tabs;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function pick(panel: DiagramPanel, token = new vscode.CancellationTokenSource().token) {
  return panel.pickNodes("Which part?", false, token);
}

suite("panel", function () {
  // The first render loads the webview, which can take a while.
  this.timeout(10_000);

  test("clickToAskQuery replaces {label}", () => {
    assert.strictEqual(
      clickToAskQuery("Explain {label}, and how {label} is tested", "Parser"),
      "Explain Parser, and how Parser is tested",
    );
    // Not taken as a replacement pattern.
    assert.strictEqual(clickToAskQuery("Explain {label}", "$& $$"), "Explain $& $$");
  });

  test("clickToAskQuery appends the label when there is no placeholder", () => {
    assert.strictEqual(
      clickToAskQuery("Tell me more about", "Parser"),
      'Tell me more about "Parser"',
    );
  });

  test("explicitly showing the panel focuses it", async () => {
    // Earlier suites dispose their panels asynchronously. Finish closing their tabs before this
    // test opens an editor, so a disappearing group cannot move it into the panel's column.
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const document = await vscode.workspace.openTextDocument({ content: "Keep editing here" });
    const editor = await vscode.window.showTextDocument(document);
    const panel = newPanel();
    const internals = panel as unknown as { panel: vscode.WebviewPanel };
    try {
      assert.ok((await panel.render(flowchart, "tool")).ok);
      assert.strictEqual(vscode.window.activeTextEditor, editor);

      await new Promise<void>((resolve, reject) => {
        const listener = internals.panel.onDidChangeViewState(({ webviewPanel }) => {
          if (webviewPanel.active) {
            clearTimeout(timeout);
            listener.dispose();
            resolve();
          }
        });
        const timeout = setTimeout(() => {
          listener.dispose();
          reject(new Error("Show Panel did not activate the diagram"));
        }, 5000);
        panel.show();
      });
      assert.ok(internals.panel.active, "Show Panel should focus the diagram");
    } finally {
      panel.dispose();
    }
  });

  test("agent updates preserve editor focus without revealing an already visible panel", async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const document = await vscode.workspace.openTextDocument({ content: "Keep editing here" });
    const editor = await vscode.window.showTextDocument(document);
    const panel = newPanel();
    const internals = panel as unknown as { panel: vscode.WebviewPanel };
    try {
      assert.ok((await panel.render(flowchart, "tool")).ok);
      assert.strictEqual(vscode.window.activeTextEditor, editor);
      assert.ok(internals.panel.visible);
      const reveal = internals.panel.reveal;
      let revealed = false;
      internals.panel.reveal = (...args) => {
        revealed = true;
        reveal.apply(internals.panel, args);
      };
      assert.ok(panel.annotate({ marks: [], dim: false }).ok);
      assert.ok(!revealed, "An annotation should not reveal a panel that is already visible");
      assert.strictEqual(vscode.window.activeTextEditor, editor);
    } finally {
      panel.dispose();
    }
  });

  test("isFromWebview accepts only well-formed messages", () => {
    assert.ok(isFromWebview({ type: "ready" }));
    assert.ok(isFromWebview({ type: "picked", pickId: 3, nodes: [{ id: "A", label: "Parser" }] }));
    assert.ok(isFromWebview({ type: "save", colors: testColors }));
    const malformed = [
      null,
      "ready",
      [{ type: "ready" }],
      { type: "toString" },
      { type: "picked", pickId: "3", nodes: [] },
      { type: "selectionChanged", nodes: [{ id: "A" }] },
      { type: "ask", nodes: [] },
      { type: "save" },
      // A saved chart needs every color to draw in.
      { type: "save", colors: { ...testColors, palette: [] } },
      { type: "save", colors: { ...testColors, focus: { r: 0, g: 0, b: 0 } } },
      { type: "save", colors: { ...testColors, fontSize: Number.NaN } },
    ];
    for (const message of malformed) {
      assert.ok(!isFromWebview(message), JSON.stringify(message));
    }
  });

  test("closing the panel ends a waiting render and pick, without blaming the diagram", async () => {
    const panel = newPanel();
    const rendering = panel.render(flowchart, "tool");
    const picking = pick(panel);
    panel.dispose();
    assert.deepStrictEqual(await rendering, {
      ok: false,
      kind: "unavailable",
      error: "The diagram panel was closed before it finished rendering.",
    });
    assert.deepStrictEqual(await picking, {
      picked: false,
      reason: "The user closed the diagram panel.",
    });
    assert.doesNotMatch(panel.describeForModel() ?? "", /fails to render/);
  });

  test("replacing a pending render ends it and replays only the latest diagram", async () => {
    const panel = newPanel();
    const sent: ToWebview[] = [];
    const internals = panel as unknown as {
      onMessage(message: FromWebview): void;
      post(message: ToWebview): void;
    };
    internals.post = (message) => sent.push(message);
    try {
      const first = panel.render(flowchart, "tool");
      const second = panel.render({ ...flowchart, title: "Replacement" }, "tool");
      assert.deepStrictEqual(await first, {
        ok: false,
        kind: "unavailable",
        error: "The diagram was replaced before it finished rendering.",
      });
      sent.length = 0;
      internals.onMessage({ type: "ready" });
      assert.strictEqual(sent.length, 1);
      const latest = sent[0];
      assert.ok(latest?.type === "render");
      assert.strictEqual(latest.title, "Replacement");
      internals.onMessage({
        type: "rendered",
        requestId: latest.requestId,
        diagramType: "flowchart",
      });
      assert.ok((await second).ok);
    } finally {
      panel.dispose();
    }
  });

  test("an unavailable render ends a waiting pick without blaming the source", async () => {
    const panel = newPanel();
    const internals = panel as unknown as {
      pendingRender: { message: { requestId: number } };
      finishRender(requestId: number, outcome: unknown): void;
    };
    try {
      const rendering = panel.render(flowchart, "tool");
      const picking = pick(panel);
      const outcome = {
        ok: false,
        kind: "unavailable",
        error: "The diagram panel did not respond within 15 seconds.",
      };
      internals.finishRender(internals.pendingRender.message.requestId, outcome);
      assert.deepStrictEqual(await rendering, outcome);
      assert.deepStrictEqual(await picking, { picked: false, reason: outcome.error });
      assert.strictEqual(panel.current?.error, undefined);
    } finally {
      panel.dispose();
    }
  });

  test("failed message delivery ends render and pick requests", async () => {
    for (const rejected of [false, true]) {
      const panel = newPanel();
      const internals = panel as unknown as {
        panel: vscode.WebviewPanel;
        webviewReady: boolean;
      };
      try {
        panel.show();
        internals.webviewReady = true;
        internals.panel.webview.postMessage = async () => {
          if (rejected) {
            throw new Error("Disconnected");
          }
          return false;
        };
        const rendering = panel.render(flowchart, "tool");
        const picking = pick(panel);
        const outcome = await rendering;
        assert.ok(!outcome.ok && outcome.kind === "unavailable");
        assert.match(outcome.error, rejected ? /Disconnected/ : /Reopen it/);
        assert.deepStrictEqual(await picking, { picked: false, reason: outcome.error });
        assert.strictEqual(panel.current?.error, undefined);
      } finally {
        panel.dispose();
      }
    }
  });

  test("a completed render cannot mark a newer copy of the same source as broken", async () => {
    const panel = newPanel();
    const internals = panel as unknown as {
      onMessage(message: FromWebview): void;
      pendingRender: { message: { requestId: number } };
    };
    try {
      const first = panel.render(flowchart, "tool");
      internals.onMessage({
        type: "renderError",
        requestId: internals.pendingRender.message.requestId,
        message: "Old error",
      });
      const second = panel.render(flowchart, "tool");
      assert.deepStrictEqual(await first, {
        ok: false,
        kind: "unavailable",
        error: "The diagram was replaced before it finished rendering.",
      });
      assert.strictEqual(panel.current?.error, undefined);
      internals.onMessage({
        type: "rendered",
        requestId: internals.pendingRender.message.requestId,
        diagramType: "flowchart",
      });
      assert.ok((await second).ok);
    } finally {
      panel.dispose();
    }
  });

  test("replacing a render while it saves prevents an obsolete repair", async () => {
    const panel = newPanel();
    const internals = panel as unknown as {
      onMessage(message: FromWebview): void;
      pendingRender: { message: { requestId: number } };
      context: vscode.ExtensionContext;
    };
    const save = Promise.withResolvers<void>();
    const saving = Promise.withResolvers<void>();
    internals.context.workspaceState.update = () => {
      saving.resolve();
      return save.promise;
    };
    try {
      const first = panel.render(flowchart, "tool");
      internals.onMessage({
        type: "renderError",
        requestId: internals.pendingRender.message.requestId,
        message: "Old error",
      });
      await saving.promise;
      const second = panel.render(flowchart, "tool");
      save.resolve();
      const outcome = await first;
      assert.ok(!outcome.ok && outcome.kind === "unavailable");
      internals.onMessage({
        type: "rendered",
        requestId: internals.pendingRender.message.requestId,
        diagramType: "flowchart",
      });
      assert.ok((await second).ok);
      assert.strictEqual(panel.current?.error, undefined);
    } finally {
      save.resolve();
      panel.dispose();
    }
  });

  test("saving failures do not turn successful renders into errors", async () => {
    const panel = newPanel();
    const internals = panel as unknown as {
      context: vscode.ExtensionContext;
    };
    internals.context.workspaceState.update = async () => {
      throw new Error("Storage is unavailable");
    };
    try {
      assert.ok((await panel.render(flowchart, "tool")).ok);
      assert.strictEqual(panel.current?.source, flowchart.source);
      assert.strictEqual(panel.current?.error, undefined);
    } finally {
      panel.dispose();
    }
  });

  test("picking after an unavailable render retries it instead of waiting on an empty panel", async () => {
    const panel = newPanel();
    const internals = panel as unknown as {
      post(): void;
      pendingRender?: { message: { requestId: number } };
      finishRender(id: number, outcome: RenderOutcome): void;
    };
    internals.post = () => {};
    const unavailable = {
      ok: false,
      kind: "unavailable",
      error: "The diagram panel did not respond.",
    } as const;
    try {
      const rendering = panel.render(flowchart, "tool");
      assert.ok(internals.pendingRender);
      internals.finishRender(internals.pendingRender.message.requestId, unavailable);
      assert.deepStrictEqual(await rendering, unavailable);
      assert.strictEqual(panel.current?.error, undefined);

      const picking = pick(panel);
      assert.ok(internals.pendingRender, "Picking must restart the failed render");
      internals.finishRender(internals.pendingRender.message.requestId, unavailable);
      assert.deepStrictEqual(await picking, { picked: false, reason: unavailable.error });
    } finally {
      panel.dispose();
    }
  });

  for (const rejected of [false, true]) {
    test(`opening a saved chart reports ${rejected ? "rejections" : "an unavailable browser"}`, async () => {
      const state: DiagramState = {
        language: "echarts",
        source: '{"series":[]}',
        title: "Chart",
        origin: "tool",
        editedByUser: false,
      };
      const panel = newPanel(new Map([["diagram.state", state]]));
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "diagram-save-test-"));
      const target = vscode.Uri.file(path.join(directory, "chart.html"));
      const saveDialog = vscode.window.showSaveDialog;
      const information = vscode.window.showInformationMessage;
      const error = vscode.window.showErrorMessage;
      const open = vscode.env.openExternal;
      const reported = Promise.withResolvers<string>();
      try {
        vscode.window.showSaveDialog = async () => target;
        vscode.window.showInformationMessage = async () => "Open" as never;
        vscode.window.showErrorMessage = async (message: string) => {
          reported.resolve(message);
          return undefined;
        };
        vscode.env.openExternal = async (uri) => {
          assert.strictEqual(uri.toString(), target.toString());
          if (rejected) {
            throw new Error("Browser unavailable");
          }
          return false;
        };
        await (
          panel as unknown as { saveChart(colors: typeof testColors): Promise<void> }
        ).saveChart(testColors);
        const message = await reported.promise;
        assert.ok(fs.statSync(target.fsPath).size > 500_000);
        assert.match(message, /Could not open the saved chart/);
        assert.ok(message.includes(target.fsPath));
        assert.match(message, rejected ? /Browser unavailable/ : /No application accepted/);
      } finally {
        vscode.window.showSaveDialog = saveDialog;
        vscode.window.showInformationMessage = information;
        vscode.window.showErrorMessage = error;
        vscode.env.openExternal = open;
        panel.dispose();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  test("a pick ends when another pick, a new diagram or cancellation replaces it", async () => {
    const panel = newPanel();
    try {
      assert.ok((await panel.render(flowchart, "tool")).ok);
      const first = pick(panel);
      const second = pick(panel);
      assert.deepStrictEqual(await first, {
        picked: false,
        reason: "Another request to pick nodes replaced this one.",
      });
      const rendering = panel.render({ ...flowchart, source: "flowchart LR\n  C --> D" }, "tool");
      assert.deepStrictEqual(await second, {
        picked: false,
        reason: "The diagram was replaced before the user picked.",
      });
      assert.ok((await rendering).ok);

      const cancellation = new vscode.CancellationTokenSource();
      const third = pick(panel, cancellation.token);
      cancellation.cancel();
      assert.deepStrictEqual(await third, { picked: false, reason: "The request was cancelled." });
    } finally {
      panel.dispose();
    }
  });

  test("cancelled render tools leave the current diagram and closed panel alone", async () => {
    const state: DiagramState = { ...flowchart, origin: "tool", editedByUser: true };
    const values = new Map<string, unknown>([["diagram.state", state]]);
    const panel = newPanel(values);
    const cancellation = new vscode.CancellationTokenSource();
    cancellation.cancel();
    try {
      const tools = [
        { tool: new RenderDiagramTool(panel), input: { source: "flowchart LR\n  C --> D" } },
        { tool: new ChartTool(panel), input: { type: "bar" as const, data: "A,1\nB,2" } },
      ];
      for (const { tool, input } of tools) {
        await assert.rejects(
          tool.invoke({ input } as never, cancellation.token),
          vscode.CancellationError,
        );
        assert.strictEqual(panel.current, state);
        assert.strictEqual(values.get("diagram.state"), state);
      }
      await webviewTabs([]);
    } finally {
      cancellation.dispose();
      panel.dispose();
    }
  });

  test("a cancelled pick leaves an existing pick active", async () => {
    const panel = newPanel();
    const cancellation = new vscode.CancellationTokenSource();
    cancellation.cancel();
    try {
      assert.ok((await panel.render(flowchart, "tool")).ok);
      const active = pick(panel);
      assert.deepStrictEqual(await pick(panel, cancellation.token), {
        picked: false,
        reason: "The request was cancelled.",
      });
      panel.dispose();
      assert.deepStrictEqual(await active, {
        picked: false,
        reason: "The user closed the diagram panel.",
      });
    } finally {
      cancellation.dispose();
      panel.dispose();
    }
  });

  test("render tools accept Markdown fences with longer closing markers", async () => {
    const panel = newPanel();
    const cancellation = new vscode.CancellationTokenSource();
    const rendered: string[] = [];
    panel.render = async (diagram) => {
      rendered.push(`${diagram.language}: ${diagram.source.trim()}`);
      return { ok: true, diagramType: "test" };
    };
    try {
      const tool = new RenderDiagramTool(panel);
      for (const source of ["```mermaid\nflowchart TD\n````", "  ~~~echarts\r\n{}\r\n~~~~  "]) {
        await tool.invoke({ input: { source } } as never, cancellation.token);
      }
      assert.deepStrictEqual(rendered, ["mermaid: flowchart TD", "echarts: {}"]);
      for (const source of ["```mermaid\n```", "~~~echarts\n  \n~~~~"]) {
        const result = await tool.invoke({ input: { source } } as never, cancellation.token);
        assert.ok(result.content[0] instanceof vscode.LanguageModelTextPart);
        assert.match(result.content[0].value, /Nothing was rendered: Give "source"/);
      }
      assert.strictEqual(rendered.length, 2);
    } finally {
      cancellation.dispose();
      panel.dispose();
    }
  });

  test("tools report malformed input without throwing during preparation", async () => {
    const panel = newPanel();
    const cancellation = new vscode.CancellationTokenSource();
    try {
      for (const tool of [
        new RenderDiagramTool(panel),
        new ChartTool(panel),
        new PickDiagramNodesTool(panel),
        new AnnotateDiagramTool(panel),
      ]) {
        for (const input of [null, undefined, [], 42]) {
          const options = { input } as never;
          assert.doesNotThrow(() => tool.prepareInvocation(options));
          const result = await tool.invoke(options, cancellation.token);
          assert.ok(result.content[0] instanceof vscode.LanguageModelTextPart);
          assert.match(
            result.content[0].value,
            /Nothing was rendered|No chart was rendered|No node was picked|Nothing was marked/,
          );
        }
      }
      assert.strictEqual(panel.current, undefined);
    } finally {
      cancellation.dispose();
      panel.dispose();
    }
  });

  test("a reloaded webview starts without a selection", async () => {
    const panel = newPanel();
    try {
      assert.ok((await panel.render(flowchart, "tool")).ok);
      const receive = (message: FromWebview) =>
        (panel as unknown as { onMessage(message: FromWebview): void }).onMessage(message);
      receive({ type: "selectionChanged", nodes: [{ id: "A", label: "Parser" }] });
      assert.match(panel.describeForModel() ?? "", /selected these nodes/);
      receive({ type: "ready" });
      assert.match(panel.describeForModel() ?? "", /no nodes selected/);
    } finally {
      panel.dispose();
    }
  });

  test("opening the panel replaces a diagram tab left from before a reload", async () => {
    vscode.window.createWebviewPanel(DiagramPanel.viewType, "Old", {
      viewColumn: vscode.ViewColumn.Two,
      preserveFocus: true,
    });
    const [old] = await webviewTabs(["Old"]);
    const panel = newPanel();
    try {
      assert.ok((await panel.render(flowchart, "tool")).ok);
      const [replacement] = await webviewTabs(["Flow"]);
      assert.strictEqual(replacement?.group.viewColumn, old?.group.viewColumn);
    } finally {
      panel.dispose();
    }
  });

  test("a large chart of a file is saved without its option, to be refreshed", async () => {
    const values = new Map<string, unknown>();
    const panel = newPanel(values);
    const option = JSON.stringify({ series: [{ type: "pie", data: [{ name: "A", value: 1 }] }] });
    try {
      const outcome = await panel.render(
        {
          language: "echarts",
          source: option + " ".repeat(1_000_000),
          title: "Sizes",
          chart: { type: "pie", file: "sizes.tsv" },
        },
        "tool",
      );
      assert.ok(outcome.ok);
      const saved = values.get("diagram.state") as DiagramState;
      assert.strictEqual(saved.source, undefined);
      assert.strictEqual(saved.title, "Sizes");
    } finally {
      panel.dispose();
    }

    const restored = newPanel(values);
    try {
      assert.strictEqual(restored.current?.title, "Sizes");
      restored.show();
      assert.match(restored.describeForModel() ?? "", /Not drawn.*press Refresh/);
      const picking = await pick(restored);
      assert.ok(!picking.picked && /too large to keep/.test(picking.reason));
      assert.ok((await restored.render(flowchart, "tool")).ok);
    } finally {
      restored.dispose();
    }
  });

  test("a diagram that fails to render takes no clicks", async () => {
    const panel = newPanel();
    const asked: string[] = [];
    const internals = panel as unknown as {
      onMessage(message: FromWebview): void;
      askInChat(text: string): void;
    };
    internals.askInChat = (text) => asked.push(text);
    try {
      assert.ok((await panel.render({ ...flowchart, clickPrompt: "Explain" }, "tool")).ok);
      const broken = { source: "flowchart TD\n  A --> --> B[", clickPrompt: "Delete" };
      assert.ok(!(await panel.render({ ...flowchart, ...broken }, "tool")).ok);
      // A click on the previous diagram, e.g. one sent just before it was replaced.
      internals.onMessage({ type: "clickToAsk", node: { id: "A", label: "Parser" } });
      assert.deepStrictEqual(asked, []);
    } finally {
      panel.dispose();
    }
  });

  test("only a click on a node with a link opens code", async () => {
    const panel = newPanel();
    const opened: string[] = [];
    const internals = panel as unknown as {
      onMessage(message: FromWebview): void;
      openLink(link: NodeLink, label: string): Promise<void>;
    };
    internals.openLink = async (link, label) => void opened.push(`${label}: ${linkText(link)}`);
    const click = (id: string) =>
      internals.onMessage({ type: "clickToOpen", node: { id, label: id } });
    const links = { A: { file: "sizes.tsv", line: 2 } };
    try {
      assert.ok((await panel.render({ ...flowchart, links }, "tool")).ok);
      assert.match(panel.describeForModel() ?? "", /A → sizes\.tsv#L2/);
      click("A");
      // A node without a link, and an id that only Object.prototype has, link nowhere.
      click("B");
      click("constructor");
      assert.deepStrictEqual(opened, ["A: sizes.tsv#L2"]);

      // A diagram that fails to render has no nodes: the click was on the one it replaced.
      const broken = { ...flowchart, source: "flowchart TD\n  A --> --> B[", links };
      assert.ok(!(await panel.render(broken, "tool")).ok);
      click("A");
      assert.deepStrictEqual(opened, ["A: sizes.tsv#L2"]);
    } finally {
      panel.dispose();
    }
  });

  test("opening a link shows the file with its lines selected", async () => {
    const panel = newPanel();
    const link = { file: "sizes.tsv", line: 2, endLine: 3 };
    try {
      assert.ok((await panel.render({ ...flowchart, links: { A: link } }, "tool")).ok);
      await (
        panel as unknown as { openLink(link: NodeLink, label: string): Promise<void> }
      ).openLink(link, "Parser");
      const shown = vscode.window.visibleTextEditors.find((editor) =>
        editor.document.uri.path.endsWith("/sizes.tsv"),
      );
      assert.ok(shown, "the linked file is shown");
      assert.strictEqual(shown.selection.start.line, 1);
      assert.strictEqual(shown.selection.end.line, 2);
      // Beside the diagram, rather than over it in its own tab group.
      const diagramColumn = (panel as unknown as { panel?: vscode.WebviewPanel }).panel?.viewColumn;
      assert.notStrictEqual(shown.viewColumn, diagramColumn);
    } finally {
      panel.dispose();
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    }
  });

  test("large manual chart edits survive a reload", async () => {
    const values = new Map<string, unknown>();
    const panel = newPanel(values);
    const source = JSON.stringify({ series: [{ type: "pie", data: [1] }] });
    const edited = `${source}${" ".repeat(1_000_000)}`;
    try {
      const outcome = await panel.render(
        {
          language: "echarts",
          source,
          title: "Sizes",
          chart: { type: "pie", file: "sizes.tsv" },
        },
        "tool",
      );
      assert.ok(outcome.ok);
      const internals = panel as unknown as {
        onMessage(message: FromWebview): void;
        save(): Promise<void>;
      };
      internals.onMessage({ type: "sourceEdited", source: edited });
      await internals.save();
      const restored = newPanel(values);
      try {
        assert.strictEqual(restored.current?.source, edited);
        assert.strictEqual(restored.current?.editedByUser, true);
      } finally {
        restored.dispose();
      }
    } finally {
      panel.dispose();
    }
  });

  test("saving waits for a successful render and recovers when the panel does", async () => {
    const panel = newPanel();
    const internals = panel as unknown as {
      post(): void;
      pendingRender: { message: { requestId: number } };
      finishRender(id: number, outcome: RenderOutcome): void;
      saveChart(colors: typeof testColors): Promise<void>;
    };
    internals.post = () => {};
    const warn = vscode.window.showWarningMessage;
    const save = vscode.window.showSaveDialog;
    let warning = "";
    let dialogs = 0;
    vscode.window.showWarningMessage = async (message: string) => {
      warning = message;
      return undefined;
    };
    vscode.window.showSaveDialog = async () => {
      dialogs++;
      return undefined;
    };
    const chart = { language: "echarts", source: '{"series": []}', title: "Chart" } as const;
    try {
      const rendering = panel.render(chart, "tool");
      await internals.saveChart(testColors);
      assert.strictEqual(dialogs, 0);
      assert.match(warning, /Wait.*rendering/);
      internals.finishRender(internals.pendingRender.message.requestId, {
        ok: false,
        kind: "unavailable",
        error: "The diagram panel did not respond.",
      });
      await rendering;
      await internals.saveChart(testColors);
      assert.strictEqual(dialogs, 0);
      assert.match(warning, /not saved.*did not respond.*Reopen/);

      const retry = panel.render(chart, "tool");
      internals.finishRender(internals.pendingRender.message.requestId, {
        ok: true,
        diagramType: "chart",
      });
      await retry;
      panel.annotate({ marks: [], dim: false });
      await internals.saveChart(testColors);
      assert.strictEqual(dialogs, 1);
    } finally {
      vscode.window.showWarningMessage = warn;
      vscode.window.showSaveDialog = save;
      panel.dispose();
    }
  });

  test("refreshing chart data ends a pending pick", async () => {
    const panel = newPanel();
    try {
      const outcome = await panel.render(
        {
          language: "echarts",
          source: JSON.stringify({ series: [{ type: "pie", data: [1] }] }),
          title: "Sizes",
          chart: { type: "pie", file: "sizes.tsv" },
        },
        "tool",
      );
      assert.ok(outcome.ok);
      const picking = pick(panel);
      await (panel as unknown as { refreshChart(): Promise<void> }).refreshChart();
      assert.deepStrictEqual(await picking, {
        picked: false,
        reason: "The chart data was refreshed before the user picked.",
      });
    } finally {
      panel.dispose();
    }
  });

  test("a refresh that started before a hand edit keeps the edit", async () => {
    const panel = newPanel();
    const pie = (name: string) =>
      JSON.stringify({ series: [{ type: "pie", data: [{ name, value: 1 }] }] });
    try {
      const chart = { type: "pie", file: "sizes.tsv" } as const;
      const outcome = await panel.render(
        { language: "echarts", source: pie("A"), title: "Sizes", chart },
        "tool",
      );
      assert.ok(outcome.ok);
      const internals = panel as unknown as {
        onMessage(message: FromWebview): void;
        refreshChart(): Promise<void>;
      };
      const refreshing = internals.refreshChart();
      internals.onMessage({ type: "sourceEdited", source: pie("B") });
      await refreshing;
      assert.strictEqual(panel.current?.source, pie("B"));
      assert.ok(panel.current?.editedByUser);
    } finally {
      panel.dispose();
    }
  });

  for (const action of ["edit and revert", "close and reopen"]) {
    test(`refresh does not overwrite the chart after ${action}`, async () => {
      const panel = newPanel();
      const source = JSON.stringify({ series: [{ type: "pie", data: [1] }] });
      const internals = panel as unknown as {
        refreshChart(): Promise<void>;
        applyEdit(source: string): Promise<void>;
      };
      const progress = vscode.window.withProgress;
      const resumed = Promise.withResolvers<void>();
      try {
        const outcome = await panel.render(
          {
            language: "echarts",
            source,
            title: "Sizes",
            chart: { type: "pie", file: "sizes.tsv" },
          },
          "tool",
        );
        assert.ok(outcome.ok);
        vscode.window.withProgress = async (options, task) => {
          await resumed.promise;
          return progress(options, task);
        };
        const refreshing = internals.refreshChart();
        if (action === "edit and revert") {
          await internals.applyEdit(`${source} `);
          await internals.applyEdit(source);
        } else {
          panel.dispose();
          panel.show();
        }
        resumed.resolve();
        await refreshing;
        assert.strictEqual(panel.current?.source, source);
        assert.strictEqual(panel.current?.editedByUser, action === "edit and revert");
      } finally {
        resumed.resolve();
        vscode.window.withProgress = progress;
        panel.dispose();
      }
    });
  }

  test("marking the diagram does not render it again, and a new diagram clears the marks", async () => {
    const panel = newPanel();
    const sent: ToWebview[] = [];
    try {
      assert.ok((await panel.render(flowchart, "tool")).ok);
      const internals = panel as unknown as { post(message: ToWebview): void };
      const post = internals.post.bind(internals);
      internals.post = (message) => {
        sent.push(message);
        post(message);
      };
      const outcome = panel.annotate({
        marks: [{ id: "A", kind: "problem", note: "fails here" }],
        caption: "Step 1 of 2",
        dim: true,
      });
      assert.ok(outcome.ok && outcome.unknown.length === 0);
      // Only the marks go to the webview: the diagram it already shows stays as it is.
      assert.deepStrictEqual(
        sent.map((message) => message.type),
        ["annotate"],
      );
      const described = panel.describeForModel() ?? "";
      assert.match(described, /Marked nodes: A \(problem: fails here\)\./);
      assert.match(described, /Annotation caption: Step 1 of 2/);
      assert.match(described, /Everything else is faded\./);

      sent.length = 0;
      const next = { ...flowchart, source: "flowchart LR\n  C[Lexer] --> D[Printer]" };
      assert.ok((await panel.render(next, "tool")).ok);
      assert.doesNotMatch(panel.describeForModel() ?? "", /marked/);
      assert.deepStrictEqual(
        sent.filter((message) => message.type === "annotate"),
        [],
      );
    } finally {
      panel.dispose();
    }
  });

  test("marking reports the ids the diagram has no node for", async () => {
    const panel = newPanel();
    try {
      assert.ok((await panel.render(flowchart, "tool")).ok);
      const drawn = panel.drawnIds;
      assert.ok(drawn?.includes("A") && drawn.includes("B"), JSON.stringify(drawn));
      const outcome = panel.annotate({
        marks: [
          { id: "A", kind: "good" },
          // The label of A, not its id, so there is no such node.
          { id: "Parser", kind: "problem" },
        ],
        dim: false,
      });
      assert.ok(outcome.ok);
      assert.deepStrictEqual(outcome.unknown, ["Parser"]);
      assert.deepStrictEqual(outcome.annotation.marks, [{ id: "A", kind: "good" }]);
      // The links of a diagram are checked against the same ids, once it is drawn.
      const links = { A: { file: "sizes.tsv" }, Checker: { file: "sizes.tsv" } };
      const result = await new RenderDiagramTool(panel).invoke(
        { input: { source: flowchart.source, links: linkTexts(links) } } as never,
        new vscode.CancellationTokenSource().token,
      );
      assert.ok(result.content[0] instanceof vscode.LanguageModelTextPart);
      assert.match(result.content[0].value, /These links name nodes the diagram does not have/);
      assert.match(result.content[0].value, /"Checker"\. Its node ids are "A", "B"\./);
    } finally {
      panel.dispose();
    }
  });

  test("the marks go back on a webview that reloaded", async () => {
    const panel = newPanel();
    const sent: ToWebview[] = [];
    try {
      assert.ok((await panel.render(flowchart, "tool")).ok);
      assert.ok(panel.annotate({ marks: [{ id: "B", kind: "current" }], dim: false }).ok);
      const internals = panel as unknown as {
        onMessage(message: FromWebview): void;
        post(message: ToWebview): void;
      };
      internals.post = (message) => sent.push(message);
      internals.onMessage({ type: "ready" });
      // The diagram first, then the marks that belong on it.
      assert.deepStrictEqual(
        sent.map((message) => message.type),
        ["render", "annotate"],
      );
      const annotate = sent[1];
      assert.ok(annotate?.type === "annotate");
      assert.deepStrictEqual(annotate.marks, [{ id: "B", kind: "current" }]);
    } finally {
      panel.dispose();
    }
  });

  test("annotate says why there is nothing to mark", async () => {
    const panel = newPanel();
    try {
      const empty = panel.annotate({ marks: [], dim: false });
      assert.ok(!empty.ok && /Render one with diagram_render/.test(empty.reason));

      const broken = { ...flowchart, source: "flowchart TD\n  A --> --> B[" };
      assert.ok(!(await panel.render(broken, "tool")).ok);
      const outcome = panel.annotate({ marks: [{ id: "A", kind: "info" }], dim: false });
      assert.ok(!outcome.ok);
      assert.match(outcome.reason, /fails to render, so there is nothing to mark/);
    } finally {
      panel.dispose();
    }
  });

  test("pickNodes says why there is nothing to pick", async () => {
    const panel = newPanel();
    try {
      const empty = await pick(panel);
      assert.ok(!empty.picked && /Render one with diagram_render/.test(empty.reason));

      const outcome = await panel.render(
        { ...flowchart, source: "flowchart TD\n  A --> --> B[" },
        "tool",
      );
      assert.ok(!outcome.ok && outcome.kind === "invalid");
      const broken = await pick(panel);
      assert.ok(!broken.picked && /fails to render/.test(broken.reason), JSON.stringify(broken));

      // A pick that starts before the render fails ends when it does.
      const rendering = panel.render(
        { ...flowchart, source: "flowchart TD\n  C --> --> D[" },
        "tool",
      );
      const waiting = await pick(panel);
      assert.ok(!waiting.picked && /fails to render/.test(waiting.reason), JSON.stringify(waiting));
      assert.ok(!(await rendering).ok);
    } finally {
      panel.dispose();
    }
  });
});
