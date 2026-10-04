import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { buildChart } from "../charts";
import { parseTable } from "../data";
import { linkTexts } from "../links";
import { clickToAskQuery, type Diagram, type DiagramPanel, type DiagramState } from "../panel";
import { isFromWebview } from "../protocol";
import { AnnotateDiagramTool, ChartTool, PickDiagramNodesTool, RenderDiagramTool } from "../tools";
import { WebviewChannel } from "../webviewChannel";
import {
  FakeWebview,
  memento,
  newFakePanel,
  newPanel,
  openWebviewPanel,
  showInFake,
} from "./newPanel";
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

/** Applies an edit of the source in the panel, as the webview's Apply does. */
function edit(webview: FakeWebview, source: string): Promise<void> {
  return webview.receive({ type: "sourceEdited", requestId: webview.render.requestId, source });
}

/** Records the requests to chat and the files opened, which clicks on nodes lead to. */
function recordClicks(): { actions: string[]; restore(): void } {
  const execute = vscode.commands.executeCommand;
  const show = vscode.window.showTextDocument;
  const actions: string[] = [];
  vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
    if (command !== "workbench.action.chat.open") return execute(command, ...args);
    actions.push(`chat: ${(args[0] as { query: string }).query}`);
  }) as typeof execute;
  vscode.window.showTextDocument = (async (
    document: vscode.TextDocument,
    options: vscode.TextDocumentShowOptions,
  ) => {
    const line = options.selection ? `#L${options.selection.start.line + 1}` : "";
    actions.push(`open: ${path.basename(document.uri.fsPath)}${line}`);
  }) as unknown as typeof show;
  return {
    actions,
    restore: () => {
      vscode.commands.executeCommand = execute;
      vscode.window.showTextDocument = show;
    },
  };
}

suite("panel", function () {
  // The first render loads the webview, which can take a while.
  this.timeout(10_000);

  test("clickToAskQuery replaces {label}, or appends the label", () => {
    assert.strictEqual(
      clickToAskQuery("Explain {label}, and how {label} is tested", "Parser"),
      "Explain Parser, and how Parser is tested",
    );
    // Not taken as a replacement pattern.
    assert.strictEqual(clickToAskQuery("Explain {label}", "$& $$"), "Explain $& $$");
    assert.strictEqual(
      clickToAskQuery("Tell me more about", "Parser"),
      'Tell me more about "Parser"',
    );
  });

  test("queued edits, writes and selections cannot act on a replacement diagram", async () => {
    const { panel, webview } = await newFakePanel();
    webview.answer = undefined;
    const warning = vscode.window.showWarningMessage;
    const warnings: string[] = [];
    vscode.window.showWarningMessage = async (message: string) => {
      warnings.push(message);
      return undefined;
    };
    try {
      const first = panel.render(flowchart, "tool");
      const oldId = webview.render.requestId;
      await webview.finishRender();
      await first;
      const replacement = { ...flowchart, source: "flowchart ??", title: "Replacement" };
      const rendering = panel.render(replacement, "tool");
      const currentId = webview.render.requestId;
      for (const completed of [false, true]) {
        if (completed) {
          await webview.finishRender("Parse error");
          await rendering;
        }
        await webview.receive({ type: "sourceEdited", requestId: oldId, source: "flowchart TD" });
        await webview.receive({ type: "writeToDocument", requestId: oldId });
        await webview.receive({
          type: "selectionChanged",
          requestId: oldId,
          nodes: [{ id: "A", label: "Old" }],
        });
        assert.strictEqual(panel.current?.source, replacement.source);
        assert.strictEqual(panel.current?.editedByUser, false);
        assert.match(panel.describeForModel() ?? "", /no nodes selected/);
      }
      assert.strictEqual(warnings.length, 4);
      void webview.receive({
        type: "sourceEdited",
        requestId: currentId,
        source: flowchart.source,
      });
      assert.strictEqual(
        panel.current?.source,
        flowchart.source,
        "failed diagrams remain editable",
      );
    } finally {
      vscode.window.showWarningMessage = warning;
      panel.dispose();
    }
  });

  test("explicitly showing the panel focuses it", async () => {
    // Earlier suites dispose their panels asynchronously. Finish closing their tabs before this
    // test opens an editor, so a disappearing group cannot move it into the panel's column.
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const document = await vscode.workspace.openTextDocument({ content: "Keep editing here" });
    const editor = await vscode.window.showTextDocument(document);
    const panel = newPanel();
    try {
      const opened = openWebviewPanel(panel, true);
      assert.ok((await panel.render(flowchart, "tool")).ok);
      assert.strictEqual(vscode.window.activeTextEditor, editor);

      await new Promise<void>((resolve, reject) => {
        const listener = opened.onDidChangeViewState(({ webviewPanel }) => {
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
      assert.ok(opened.active, "Show Panel should focus the diagram");
    } finally {
      panel.dispose();
    }
  });

  test("agent updates preserve editor focus without revealing an already visible panel", async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const document = await vscode.workspace.openTextDocument({ content: "Keep editing here" });
    const editor = await vscode.window.showTextDocument(document);
    const panel = newPanel();
    try {
      const opened = openWebviewPanel(panel, true);
      assert.ok((await panel.render(flowchart, "tool")).ok);
      assert.strictEqual(vscode.window.activeTextEditor, editor);
      assert.ok(opened.visible);
      const reveal = opened.reveal;
      let revealed = false;
      opened.reveal = (...args) => {
        revealed = true;
        reveal.apply(opened, args);
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
    assert.ok(isFromWebview({ type: "exportTheme", requestId: 1, colors: testColors }));
    const malformed = [
      null,
      "ready",
      [{ type: "ready" }],
      { type: "toString" },
      { type: "picked", pickId: "3", nodes: [] },
      { type: "selectionChanged", nodes: [{ id: "A" }] },
      { type: "ask", nodes: [] },
      { type: "exportTheme", requestId: 1 },
      // A saved chart needs every color to draw in.
      { type: "exportTheme", requestId: 1, colors: { ...testColors, palette: [] } },
      { type: "exportTheme", requestId: 1, colors: { ...testColors, focus: { r: 0, g: 0, b: 0 } } },
      { type: "exportTheme", requestId: 1, colors: { ...testColors, fontSize: Number.NaN } },
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
    const { panel, webview } = await newFakePanel();
    webview.answer = undefined;
    try {
      const first = panel.render(flowchart, "tool");
      const second = panel.render({ ...flowchart, title: "Replacement" }, "tool");
      assert.deepStrictEqual(await first, {
        ok: false,
        kind: "unavailable",
        error: "The diagram was replaced before it finished rendering.",
      });
      webview.sent.length = 0;
      await webview.receive({ type: "ready" });
      assert.strictEqual(webview.sent.length, 2);
      assert.deepStrictEqual(webview.sent[0], { type: "chartOptions", visible: false });
      assert.strictEqual(webview.render.title, "Replacement");
      await webview.finishRender();
      assert.ok((await second).ok);
    } finally {
      panel.dispose();
    }
  });

  test("an unavailable render ends a waiting pick without blaming the source", async () => {
    const { panel, webview } = await newFakePanel();
    webview.deliver = (message) => message.type !== "render";
    try {
      const rendering = panel.render(flowchart, "tool");
      const picking = pick(panel);
      const outcome = {
        ok: false,
        kind: "unavailable",
        error: "The diagram panel is unavailable.",
      };
      assert.deepStrictEqual(await rendering, outcome);
      assert.deepStrictEqual(await picking, { picked: false, reason: outcome.error });
      assert.strictEqual(panel.current?.error, undefined);
    } finally {
      panel.dispose();
    }
  });

  test("failed message delivery ends render and pick requests", async () => {
    for (const rejected of [false, true]) {
      const { panel, webview } = await newFakePanel();
      webview.deliver = () => {
        if (rejected) {
          throw new Error("Disconnected");
        }
        return false;
      };
      try {
        const rendering = panel.render(flowchart, "tool");
        const picking = pick(panel);
        const outcome = await rendering;
        assert.ok(!outcome.ok && outcome.kind === "unavailable");
        assert.match(
          outcome.error,
          rejected ? /Disconnected/ : /^The diagram panel is unavailable\.$/,
        );
        assert.deepStrictEqual(await picking, { picked: false, reason: outcome.error });
        assert.strictEqual(panel.current?.error, undefined);
      } finally {
        panel.dispose();
      }
    }
  });

  test("failed deliveries from before a reload cannot cancel replayed requests", async () => {
    const { panel, webview } = await newFakePanel();
    webview.answer = undefined;
    const delivery = Promise.withResolvers<boolean>();
    webview.deliver = () => delivery.promise;
    try {
      const rendering = panel.render(flowchart, "tool");
      const picking = pick(panel);
      const startPick = webview.sent.findLast((message) => message.type === "startPick");
      assert.ok(startPick);

      webview.deliver = () => true;
      await webview.receive({ type: "ready" });
      delivery.resolve(false);
      await new Promise((resolve) => setImmediate(resolve));

      await webview.finishRender();
      const nodes = [{ id: "A", label: "Parser" }];
      await webview.receive({ type: "picked", pickId: startPick.pickId, nodes });
      assert.ok((await rendering).ok);
      assert.deepStrictEqual(await picking, { picked: true, nodes });
    } finally {
      delivery.resolve(false);
      panel.dispose();
    }
  });

  test("source is saved before the webview responds, without saving successful renders twice", async () => {
    const values = new Map<string, unknown>();
    const state = memento(values);
    let writes = 0;
    const update = state.update;
    state.update = (key, value) => {
      writes++;
      return update(key, value);
    };
    const { panel, webview } = await newFakePanel(state);
    webview.answer = undefined;
    try {
      const rendering = panel.render(flowchart, "tool");
      assert.strictEqual((values.get("diagram.state") as DiagramState).source, flowchart.source);
      await webview.finishRender();
      assert.ok((await rendering).ok);
      assert.strictEqual(writes, 1);

      // The webview reloads, and draws the diagram again.
      await webview.receive({ type: "ready" });
      await webview.finishRender();
      assert.strictEqual(writes, 1, "reopening unchanged source must not serialize it again");

      const source = "flowchart LR\n  C --> D";
      const editing = webview.receive({
        type: "sourceEdited",
        requestId: webview.render.requestId,
        source,
      });
      const saved = values.get("diagram.state") as DiagramState;
      assert.strictEqual(saved.source, source);
      assert.strictEqual(saved.editedByUser, true);
      await webview.finishRender();
      await editing;
      assert.strictEqual(writes, 2);
    } finally {
      panel.dispose();
    }
  });

  test("an unavailable rendering ignores stale clicks on the previous diagram", async () => {
    const { panel, webview } = await newFakePanel();
    webview.deliver = (message) => message.type !== "render";
    const clicks = recordClicks();
    try {
      const rendering = panel.render(
        {
          ...flowchart,
          clickPrompt: "Explain {label}",
          links: { A: { file: "sizes.tsv" } },
        },
        "tool",
      );
      assert.ok(!(await rendering).ok);
      const node = { id: "A", label: "Parser" };
      await webview.receive({ type: "clickToAsk", node });
      await webview.receive({ type: "clickToOpen", node });
      assert.deepStrictEqual(clicks.actions, []);
    } finally {
      clicks.restore();
      panel.dispose();
    }
  });

  test("a completed render cannot mark a newer copy of the same source as broken", async () => {
    const { panel, webview } = await newFakePanel();
    webview.answer = undefined;
    try {
      const first = panel.render(flowchart, "tool");
      void webview.finishRender("Old error");
      const second = panel.render(flowchart, "tool");
      assert.deepStrictEqual(await first, {
        ok: false,
        kind: "unavailable",
        error: "The diagram was replaced before it finished rendering.",
      });
      assert.strictEqual(panel.current?.error, undefined);
      await webview.finishRender();
      assert.ok((await second).ok);
    } finally {
      panel.dispose();
    }
  });

  test("replacing a render while it saves prevents an obsolete repair", async () => {
    const save = Promise.withResolvers<void>();
    const saving = Promise.withResolvers<void>();
    const state = memento(new Map());
    state.update = () => {
      saving.resolve();
      return save.promise;
    };
    const { panel, webview } = await newFakePanel(state);
    webview.answer = undefined;
    try {
      const first = panel.render(flowchart, "tool");
      await webview.finishRender("Old error");
      await saving.promise;
      const second = panel.render(flowchart, "tool");
      save.resolve();
      const outcome = await first;
      assert.ok(!outcome.ok && outcome.kind === "unavailable");
      await webview.finishRender();
      assert.ok((await second).ok);
      assert.strictEqual(panel.current?.error, undefined);
    } finally {
      save.resolve();
      panel.dispose();
    }
  });

  test("saving failures do not turn successful renders into errors", async () => {
    const state = memento(new Map());
    state.update = async () => {
      throw new Error("Storage is unavailable");
    };
    const panel = newPanel(state);
    try {
      assert.ok((await panel.render(flowchart, "tool")).ok);
      assert.strictEqual(panel.current?.source, flowchart.source);
      assert.strictEqual(panel.current?.error, undefined);
    } finally {
      panel.dispose();
    }
  });

  test("picking after an unavailable render retries it instead of waiting on an empty panel", async () => {
    const { panel, webview } = await newFakePanel();
    webview.deliver = (message) => message.type !== "render";
    const unavailable = {
      ok: false,
      kind: "unavailable",
      error: "The diagram panel is unavailable.",
    } as const;
    const renders = () => webview.sent.filter((message) => message.type === "render").length;
    try {
      assert.deepStrictEqual(await panel.render(flowchart, "tool"), unavailable);
      assert.strictEqual(panel.current?.error, undefined);

      const picking = pick(panel);
      assert.strictEqual(renders(), 2, "Picking must restart the failed render");
      assert.deepStrictEqual(await picking, { picked: false, reason: unavailable.error });
    } finally {
      panel.dispose();
    }
  });

  for (const rejected of [false, true]) {
    test(`opening a saved chart reports ${rejected ? "rejections" : "an unavailable browser"}`, async () => {
      const state: DiagramState = {
        language: "echarts",
        source: '{"series":[{"type":"pie","data":[1,2]}]}',
        title: "Chart",
        origin: "tool",
        editedByUser: false,
      };
      const panel = newPanel(new Map([["diagram.state", state]]));
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "diagram-save-test-"));
      const target = vscode.Uri.file(path.join(directory, "chart.html"));
      const saveDialog = vscode.window.showSaveDialog;
      const quickPick = vscode.window.showQuickPick;
      const information = vscode.window.showInformationMessage;
      const error = vscode.window.showErrorMessage;
      const open = vscode.env.openExternal;
      const reported = Promise.withResolvers<string>();
      try {
        vscode.window.showQuickPick = (async () => ({
          label: "Interactive HTML",
          format: "html",
        })) as unknown as typeof quickPick;
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
        assert.ok(state.source);
        assert.ok((await panel.render({ ...state, source: state.source }, "tool")).ok);
        await panel.exportDiagram();
        const message = await reported.promise;
        assert.ok(fs.statSync(target.fsPath).size > 500_000);
        assert.match(message, /Could not open the saved chart/);
        assert.ok(message.includes(target.fsPath));
        assert.match(message, rejected ? /Browser unavailable/ : /No application accepted/);
      } finally {
        vscode.window.showQuickPick = quickPick;
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

  test("cancelling a chart stops waiting for a file read", async () => {
    const panel = newPanel();
    const cancellation = new vscode.CancellationTokenSource();
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
        cancellation.token,
      );
      await started.promise;
      cancellation.cancel();
      await assert.rejects(result, vscode.CancellationError);
      assert.strictEqual(panel.current, undefined);
    } finally {
      data.resolve(new TextEncoder().encode("name,value\nA,1"));
      Object.defineProperty(vscode.workspace, "fs", descriptor);
      cancellation.dispose();
      panel.dispose();
    }
  });

  test("a cancelled annotation leaves the current marks alone", () => {
    const panel = newPanel();
    const cancellation = new vscode.CancellationTokenSource();
    let marked = false;
    panel.annotate = () => {
      marked = true;
      return { ok: false, reason: "Unexpected annotation" };
    };
    cancellation.cancel();
    try {
      assert.throws(
        () => new AnnotateDiagramTool(panel).invoke({ input: {} } as never, cancellation.token),
        vscode.CancellationError,
      );
      assert.strictEqual(marked, false);
    } finally {
      cancellation.dispose();
      panel.dispose();
    }
  });

  test("opening chat clears only the selection that sent the request", async () => {
    const { panel, webview } = await newFakePanel();
    const execute = vscode.commands.executeCommand;
    try {
      assert.ok((await panel.render(flowchart, "tool")).ok);
      const { requestId } = webview.render;
      const select = (node: { id: string; label: string }) =>
        webview.receive({ type: "selectionChanged", requestId, nodes: [node] });
      for (const changed of [true, false]) {
        const opened = Promise.withResolvers<void>();
        vscode.commands.executeCommand = (() => opened.promise) as typeof execute;
        await select({ id: "A", label: "Parser" });
        webview.sent.length = 0;
        const asking = webview.receive({ type: "ask", text: "Explain the selection", nodes: [] });
        if (changed) {
          await select({ id: "B", label: "Checker" });
        }
        opened.resolve();
        await asking;
        assert.deepStrictEqual(webview.sent, changed ? [] : [{ type: "clearSelection" }]);
        assert.match(
          panel.describeForModel() ?? "",
          changed ? /selected these nodes in the panel: "Checker"/ : /no nodes selected/,
        );
      }
    } finally {
      vscode.commands.executeCommand = execute;
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
    const { panel, webview } = await newFakePanel();
    try {
      assert.ok((await panel.render(flowchart, "tool")).ok);
      await webview.receive({
        type: "selectionChanged",
        requestId: webview.render.requestId,
        nodes: [{ id: "A", label: "Parser" }],
      });
      assert.match(panel.describeForModel() ?? "", /selected these nodes/);
      await webview.receive({ type: "ready" });
      assert.match(panel.describeForModel() ?? "", /no nodes selected/);
    } finally {
      panel.dispose();
    }
  });

  test("a restored panel without a saved diagram drops the title of the one it showed", async () => {
    const panel = newPanel();
    const webview = new FakeWebview();
    webview.panel.title = "Old flow";
    try {
      panel.restore(webview.panel);
      assert.strictEqual(webview.panel.title, "Diagram");
    } finally {
      panel.dispose();
    }
  });

  test("opening the panel replaces a diagram tab left from before a reload", async () => {
    vscode.window.createWebviewPanel(WebviewChannel.viewType, "Old", {
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
    const { panel, webview } = await newFakePanel();
    const clicks = recordClicks();
    const links = { A: { file: "sizes.tsv", line: 2 } };
    const click = (id: string) => webview.receive({ type: "clickToOpen", node: { id, label: id } });
    try {
      assert.ok((await panel.render({ ...flowchart, clickPrompt: "Explain" }, "tool")).ok);
      await webview.receive({ type: "clickToAsk", node: { id: "A", label: "Parser" } });
      assert.deepStrictEqual(clicks.actions, ['chat: Explain "Parser"']);
      clicks.actions.length = 0;

      webview.nextRender((render) =>
        webview.receive({
          type: "renderError",
          requestId: render.requestId,
          message: "Parse error",
        }),
      );
      const broken = { source: "flowchart TD\n  A --> --> B[", clickPrompt: "Delete", links };
      assert.ok(!(await panel.render({ ...flowchart, ...broken }, "tool")).ok);
      // Clicks on the previous diagram, e.g. sent just before it was replaced.
      await webview.receive({ type: "clickToAsk", node: { id: "A", label: "Parser" } });
      await click("A");
      assert.deepStrictEqual(clicks.actions, []);
    } finally {
      clicks.restore();
      panel.dispose();
    }
  });

  test("only a click on a node with a link opens code", async () => {
    const { panel, webview } = await newFakePanel();
    const clicks = recordClicks();
    const click = (id: string) => webview.receive({ type: "clickToOpen", node: { id, label: id } });
    try {
      const links = { A: { file: "sizes.tsv", line: 2 } };
      assert.ok((await panel.render({ ...flowchart, links }, "tool")).ok);
      assert.match(panel.describeForModel() ?? "", /A → sizes\.tsv#L2/);
      await click("A");
      // A node without a link, and an id that only Object.prototype has, link nowhere.
      await click("B");
      await click("constructor");
      assert.deepStrictEqual(clicks.actions, ["open: sizes.tsv#L2"]);
    } finally {
      clicks.restore();
      panel.dispose();
    }
  });

  test("opening a link shows the file beside the diagram with its lines selected", async () => {
    const { panel, webview } = await newFakePanel();
    const link = { file: "sizes.tsv", line: 2, endLine: 3 };
    try {
      assert.ok((await panel.render({ ...flowchart, links: { A: link } }, "tool")).ok);
      await webview.receive({ type: "clickToOpen", node: { id: "A", label: "Parser" } });
      const shown = vscode.window.visibleTextEditors.find((editor) =>
        editor.document.uri.path.endsWith("/sizes.tsv"),
      );
      assert.ok(shown, "the linked file is shown");
      assert.strictEqual(shown.selection.start.line, 1);
      assert.strictEqual(shown.selection.end.line, 2);
      // Beside the diagram, rather than over it in its own tab group.
      assert.notStrictEqual(shown.viewColumn, webview.panel.viewColumn);
    } finally {
      panel.dispose();
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    }
  });

  test("large manual chart edits survive a reload", async () => {
    const values = new Map<string, unknown>();
    const { panel, webview } = await newFakePanel(values);
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
      await edit(webview, edited);
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

  test("exporting waits for a successful render and reports an unavailable panel", async () => {
    const { panel, webview } = await newFakePanel();
    webview.answer = undefined;
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
      await panel.exportDiagram();
      assert.strictEqual(dialogs, 0);
      assert.match(warning, /Wait.*rendering/);
      webview.deliver = (message) => message.type !== "render";
      assert.ok(!(await panel.render(chart, "tool")).ok);
      await rendering;
      await panel.exportDiagram();
      assert.strictEqual(dialogs, 0);
      assert.strictEqual(
        warning,
        "The diagram panel is unavailable. Use Diagram: Show Panel and try again.",
      );
    } finally {
      vscode.window.showWarningMessage = warn;
      vscode.window.showSaveDialog = save;
      panel.dispose();
    }
  });

  test("refresh preserves manual styling through panel state restoration", async () => {
    const values = new Map<string, unknown>();
    let { panel, webview } = await newFakePanel(values);
    const chart = { type: "bar", data: "name,value\nC,20\nD,40" } as const;
    const option = buildChart(chart, parseTable("name,value\nA,2\nB,4")).option;
    try {
      assert.ok(
        (
          await panel.render(
            { language: "echarts", source: JSON.stringify(option), title: "Sales", chart },
            "tool",
          )
        ).ok,
      );
      option.yAxis = {
        ...(option.yAxis as object),
        name: "Revenue",
        axisLabel: { formatter: "USD {value}" },
      };
      await edit(webview, JSON.stringify(option));
      panel.dispose();
      ({ panel, webview } = await newFakePanel(values));
      await webview.receive({ type: "refresh" });
      const refreshed = JSON.parse(panel.current?.source ?? "");
      assert.deepStrictEqual(refreshed.series[0].data, [20, 40]);
      assert.deepStrictEqual(refreshed.xAxis.data, ["C", "D"]);
      assert.strictEqual(refreshed.yAxis.name, "Revenue");
      assert.strictEqual(refreshed.yAxis.axisLabel.formatter, "USD {value}");
      assert.ok(panel.current?.editedByUser);
      assert.match(panel.describeForModel() ?? "", /diagram_updateChart preserves.*styling/);
    } finally {
      panel.dispose();
    }
  });

  test("blocked custom source is preserved without loading data", async () => {
    const { panel, webview } = await newFakePanel();
    const progress = vscode.window.withProgress;
    const showError = vscode.window.showErrorMessage;
    let error = "";
    let loads = 0;
    const source = '{"series":[{"type":"pie","data":[1]}]}';
    const edited = '{series:[{type:"pie",data:[1]}],tooltip:{formatter: () => "value"}}';
    try {
      await panel.render(
        {
          language: "echarts",
          source,
          title: "Chart",
          chart: { type: "pie", data: "name,value\nA,1" },
        },
        "tool",
      );
      await edit(webview, edited);
      vscode.window.withProgress = async (options, task) => {
        loads++;
        return progress(options, task);
      };
      vscode.window.showErrorMessage = async (message: string) => {
        error = message;
        return undefined;
      };
      await webview.receive({ type: "refresh" });
      assert.strictEqual(loads, 0);
      assert.strictEqual(panel.current?.source, edited);
      assert.match(error, /source is kept.*Reset Styling/);
    } finally {
      vscode.window.withProgress = progress;
      vscode.window.showErrorMessage = showError;
      panel.dispose();
    }
  });

  test("a failed refresh render restores the previous source and presentation", async () => {
    const { panel, webview } = await newFakePanel();
    const showError = vscode.window.showErrorMessage;
    let error = "";
    try {
      const chart = { type: "pie", data: "name,value\nA,9" } as const;
      await panel.render(
        {
          language: "echarts",
          source: JSON.stringify(buildChart(chart, parseTable("name,value\nA,1")).option),
          title: "Chart",
          chart,
        },
        "tool",
      );
      assert.ok(panel.annotate({ marks: [{ id: "A", kind: "good" }], dim: false }).ok);
      const before = panel.current;
      webview.nextRender((render) =>
        webview.receive({
          type: "renderError",
          requestId: render.requestId,
          message: "test refresh failure",
        }),
      );
      vscode.window.showErrorMessage = async (message: string) => {
        error = message;
        return undefined;
      };
      await webview.receive({ type: "refresh" });
      assert.strictEqual(panel.current?.source, before?.source);
      assert.deepStrictEqual(panel.current?.chartPresentation, before?.chartPresentation);
      assert.match(error, /test refresh failure.*previous chart is kept/);
      assert.match(panel.describeForModel() ?? "", /A \(good\)/);
    } finally {
      vscode.window.showErrorMessage = showError;
      panel.dispose();
    }
  });

  test("refreshing chart data ends a pending pick", async () => {
    const { panel, webview } = await newFakePanel();
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
      await webview.receive({ type: "refresh" });
      assert.deepStrictEqual(await picking, {
        picked: false,
        reason: "The chart data was refreshed before the user picked.",
      });
    } finally {
      panel.dispose();
    }
  });

  test("a refresh that started before a hand edit keeps the edit", async () => {
    const { panel, webview } = await newFakePanel();
    const pie = (name: string) =>
      JSON.stringify({ series: [{ type: "pie", data: [{ name, value: 1 }] }] });
    try {
      const chart = { type: "pie", file: "sizes.tsv" } as const;
      const outcome = await panel.render(
        { language: "echarts", source: pie("A"), title: "Sizes", chart },
        "tool",
      );
      assert.ok(outcome.ok);
      const refreshing = webview.receive({ type: "refresh" });
      await Promise.all([refreshing, edit(webview, pie("B"))]);
      assert.strictEqual(panel.current?.source, pie("B"));
      assert.ok(panel.current?.editedByUser);
    } finally {
      panel.dispose();
    }
  });

  for (const action of ["edit and revert", "close and reopen"]) {
    test(`refresh does not overwrite the chart after ${action}`, async () => {
      const { panel, webview } = await newFakePanel();
      const source = JSON.stringify({ series: [{ type: "pie", data: [1] }] });
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
        const refreshing = webview.receive({ type: "refresh" });
        if (action === "edit and revert") {
          await edit(webview, `${source} `);
          await edit(webview, source);
        } else {
          webview.panel.dispose();
          await showInFake(panel);
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
    const { panel, webview } = await newFakePanel();
    const { sent } = webview;
    try {
      assert.ok((await panel.render(flowchart, "tool")).ok);
      sent.length = 0;
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

  test("annotation ids prefer exact names and only repair unambiguous padding", async () => {
    const { panel, webview } = await newFakePanel();
    const draw = async (nodeIds?: string[]) => {
      webview.nextRender((render) =>
        webview.receive({
          type: "rendered",
          requestId: render.requestId,
          diagramType: "test",
          nodeIds,
        }),
      );
      assert.ok((await panel.render(flowchart, "tool")).ok);
    };
    const annotate = (...ids: string[]) => {
      const outcome = panel.annotate({
        marks: ids.map((id) => ({ id, kind: "info" })),
        dim: false,
      });
      assert.ok(outcome.ok);
      return { ids: outcome.annotation.marks.map((mark) => mark.id), unknown: outcome.unknown };
    };
    try {
      await draw(["A", "B", " B "]);
      assert.deepStrictEqual(annotate(" A ", " B "), { ids: ["A", " B "], unknown: [] });
      assert.deepStrictEqual(annotate(" A ", "A"), { ids: ["A"], unknown: [" A "] });
      assert.deepStrictEqual(annotate(" A ", "  A"), { ids: ["A"], unknown: ["  A"] });
      await draw();
      assert.deepStrictEqual(annotate(" A "), { ids: [" A "], unknown: [] });
    } finally {
      panel.dispose();
    }
  });

  test("marking a chart item name that several items share asks for their ids", async () => {
    const { panel, webview } = await newFakePanel();
    const repeatedNames = [{ name: "Yes", ids: ["Yes (q1)", "Yes (q2)"], count: 2 }];
    webview.nextRender((render) =>
      webview.receive({
        type: "rendered",
        requestId: render.requestId,
        diagramType: "sankey",
        repeatedNames,
      }),
    );
    try {
      const chart = { language: "echarts", source: '{"series": []}', title: "Survey" } as const;
      assert.ok((await panel.render(chart, "tool")).ok);
      assert.match(
        panel.describeForModel() ?? "",
        /Chart items that share a name \(mark them by these exact ids with diagram_annotate\): "Yes" \(ids: "Yes \(q1\)", "Yes \(q2\)"\)\./,
      );
      const result = await new AnnotateDiagramTool(panel).invoke(
        { input: { marks: [{ id: "Yes" }, { id: "Yes (q2)" }] } } as never,
        new vscode.CancellationTokenSource().token,
      );
      assert.ok(result.content[0] instanceof vscode.LanguageModelTextPart);
      assert.match(result.content[0].value, /^Marked 1 chart item: Yes \(q2\) \(current\)\./);
      assert.match(
        result.content[0].value,
        /These names each name several items of the chart, so nothing was marked for them: "Yes" \(ids: "Yes \(q1\)", "Yes \(q2\)"\)\. Mark the items you mean by their ids\./,
      );
      const outcome = panel.annotate({ marks: [{ id: "Yes", kind: "info" }], dim: false });
      assert.ok(outcome.ok);
      assert.deepStrictEqual(outcome.annotation.marks, []);
      assert.deepStrictEqual(outcome.repeated, repeatedNames);
    } finally {
      panel.dispose();
    }
  });

  test("the marks go back on a webview that reloaded", async () => {
    const { panel, webview } = await newFakePanel();
    const { sent } = webview;
    try {
      assert.ok((await panel.render(flowchart, "tool")).ok);
      assert.ok(panel.annotate({ marks: [{ id: "B", kind: "current" }], dim: false }).ok);
      sent.length = 0;
      await webview.receive({ type: "ready" });
      // Restore the controls, then the diagram and the marks that belong on it.
      assert.deepStrictEqual(
        sent.map((message) => message.type),
        ["chartOptions", "render", "annotate"],
      );
      assert.deepStrictEqual(sent[0], { type: "chartOptions", visible: false });
      const annotate = sent[2];
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
