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
import { AnnotateDiagramTool, RenderDiagramTool } from "../tools";
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
import { toolText } from "./toolText";

const flowchart: Diagram = {
  language: "mermaid",
  source: "flowchart LR\n  A[Parser] --> B[Checker]",
  title: "Flow",
};

/** A chart of a file as saved when it is too large to keep: without its source. */
const withoutSource: DiagramState = {
  language: "echarts",
  title: "Sizes",
  chart: { type: "pie", file: "sizes.tsv" },
  origin: "tool",
  editedByUser: false,
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

/** Holds back the timers of the given delay, until the test expires them. */
function holdTimers(delay: number): { expire(): void; restore(): void } {
  const set = globalThis.setTimeout;
  const held: (() => void)[] = [];
  globalThis.setTimeout = ((callback: () => void, ms?: number, ...args: unknown[]) => {
    if (ms !== delay) return set(callback, ms, ...args);
    held.push(callback);
    // A handle for clearTimeout, which then has nothing to clear.
    return set(() => {}, 0);
  }) as typeof setTimeout;
  return {
    expire: () => {
      for (const callback of held.splice(0)) callback();
    },
    restore: () => {
      globalThis.setTimeout = set;
    },
  };
}

function pick(panel: DiagramPanel, token = new vscode.CancellationTokenSource().token) {
  return panel.pickNodes("Which part?", false, token);
}

/** Records the requests to chat and the files and URLs opened, which clicks on nodes lead to. */
function recordClicks(): { actions: string[]; restore(): void } {
  const execute = vscode.commands.executeCommand;
  const show = vscode.window.showTextDocument;
  const openExternal = vscode.env.openExternal;
  const actions: string[] = [];
  vscode.env.openExternal = async (uri) => {
    actions.push(`url: ${uri.toString(true)}`);
    return true;
  };
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
      vscode.env.openExternal = openExternal;
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
    const options = { type: "applyChartOptions", revision: 1, controls: { type: "bar" } };
    assert.ok(isFromWebview({ ...options, replaceSource: false }));
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
      // Replacing a chart's source takes an explicit choice, for the revision it was made for.
      options,
      { ...options, replaceSource: "true" },
      { ...options, replaceSource: false, revision: "1" },
      { ...options, replaceSource: false, controls: [] },
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
      await webview.receive({ type: "openUrl", url: "https://example.com/" });
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
    const { panel } = await newFakePanel(state);
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
      const { panel, webview } = await newFakePanel(new Map([["diagram.state", state]]));
      // The page answers an export to HTML with the colors to draw the chart in.
      webview.answer = (message) =>
        message.type === "export"
          ? { type: "exportTheme", requestId: message.requestId, colors: testColors }
          : undefined;
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
    const { panel } = await newFakePanel();
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

  test("a cancelled pick leaves an existing pick active", async () => {
    const { panel } = await newFakePanel();
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

  test("a chart restored without its option, as a large one is saved, waits for Refresh", async () => {
    const { panel } = await newFakePanel(new Map([["diagram.state", withoutSource]]));
    try {
      assert.strictEqual(panel.current?.title, "Sizes");
      assert.match(panel.describeForModel() ?? "", /Not drawn.*press Refresh/);
      const picking = await pick(panel);
      assert.ok(!picking.picked && /too large to keep/.test(picking.reason));
      assert.ok((await panel.render(flowchart, "tool")).ok);
    } finally {
      panel.dispose();
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
      await webview.receive({ type: "openUrl", url: "https://example.com/" });
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

  test("asks before opening a linked file outside the workspace, and says why one cannot open", async () => {
    const { panel, webview } = await newFakePanel();
    const clicks = recordClicks();
    const warn = vscode.window.showWarningMessage;
    const showError = vscode.window.showErrorMessage;
    const asked: string[] = [];
    const errors: string[] = [];
    let answer: string | undefined;
    vscode.window.showWarningMessage = (async (message: string) => {
      asked.push(message);
      return answer;
    }) as typeof warn;
    vscode.window.showErrorMessage = async (message: string) => {
      errors.push(message);
      return undefined;
    };
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "diagram-link-test-"));
    const outside = path.join(directory, "outside.txt");
    fs.writeFileSync(outside, "outside");
    const click = (id: string) => webview.receive({ type: "clickToOpen", node: { id, label: id } });
    try {
      const links = { A: { file: outside }, B: { file: "missing.txt" } };
      assert.ok((await panel.render({ ...flowchart, links }, "tool")).ok);
      await click("A");
      answer = "Open";
      await click("A");
      assert.deepStrictEqual(asked, Array(2).fill('Open the file that "A" links to?'));
      assert.deepStrictEqual(clicks.actions, ["open: outside.txt#L1"]);
      await click("B");
      assert.strictEqual(asked.length, 2);
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(
        errors[0],
        'Could not open the code that "B" links to: missing.txt does not exist.',
      );
    } finally {
      vscode.window.showWarningMessage = warn;
      vscode.window.showErrorMessage = showError;
      clicks.restore();
      panel.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("opens only http, https and mailto links that a diagram draws", async () => {
    const { panel, webview } = await newFakePanel();
    const clicks = recordClicks();
    const showError = vscode.window.showErrorMessage;
    const errors: string[] = [];
    vscode.window.showErrorMessage = async (message: string) => {
      errors.push(message);
      return undefined;
    };
    const open = (url: string) => webview.receive({ type: "openUrl", url });
    try {
      assert.ok((await panel.render(flowchart, "tool")).ok);
      for (const url of [
        "https://example.com/docs?page=2#Usage",
        " HTTP://Example.com",
        "mailto:docs@example.com",
        "javascript:alert(1)",
        "file:///etc/passwd",
        "command:workbench.action.terminal.new",
        "vscode://vscode.git/clone?url=https://example.com",
        "docs/usage.html",
        "about:blank",
      ]) {
        await open(url);
      }
      assert.deepStrictEqual(clicks.actions, [
        "url: https://example.com/docs?page=2#Usage",
        "url: http://example.com/",
        "url: mailto:docs@example.com",
      ]);
      assert.strictEqual(errors.length, 6);
      assert.ok(errors.every((error) => /opens only http, https and mailto URLs/.test(error)));
      assert.match(errors[0] ?? "", /^Cannot open "javascript:alert\(1\)", which the diagram/);
      // Only a Mermaid diagram draws links.
      assert.ok(
        (
          await panel.render(
            { language: "echarts", source: '{"series": []}', title: "Chart" },
            "tool",
          )
        ).ok,
      );
      await open("https://example.com/");
      assert.strictEqual(clicks.actions.length, 3);
    } finally {
      vscode.window.showErrorMessage = showError;
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
      await webview.edit(edited);
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
      await webview.edit(JSON.stringify(option));
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
      await webview.edit(edited);
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
      await Promise.all([refreshing, webview.edit(pie("B"))]);
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
          await webview.edit(`${source} `);
          await webview.edit(source);
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
    const { panel, webview } = await newFakePanel();
    webview.answer = (message) =>
      message.type === "render"
        ? {
            type: "rendered",
            requestId: message.requestId,
            diagramType: "test",
            nodeIds: ["A", "B"],
          }
        : undefined;
    try {
      assert.ok((await panel.render(flowchart, "tool")).ok);
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
      assert.match(toolText(result), /These links name nodes the diagram does not have/);
      assert.match(toolText(result), /"Checker"\. Its node ids are "A", "B"\./);
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
      assert.match(toolText(result), /^Marked 1 chart item: Yes \(q2\) \(current\)\./);
      assert.match(
        toolText(result),
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

  test("annotate and pickNodes say why there is nothing to mark or pick", async () => {
    const { panel, webview } = await newFakePanel();
    webview.answer = undefined;
    const mark = () => panel.annotate({ marks: [{ id: "A", kind: "info" }], dim: false });
    try {
      for (const nothing of [mark(), await pick(panel)]) {
        assert.match(JSON.stringify(nothing), /no diagram.*Render one with diagram_render/i);
      }
      const broken = { ...flowchart, source: "flowchart TD\n  A --> --> B[" };
      // A pick that starts before the render fails ends when it does.
      const rendering = panel.render(broken, "tool");
      const waiting = pick(panel);
      await webview.finishRender("Parse error");
      assert.deepStrictEqual(await rendering, { ok: false, kind: "invalid", error: "Parse error" });
      for (const failed of [await waiting, await pick(panel)]) {
        assert.ok(!failed.picked && /fails to render/.test(failed.reason), JSON.stringify(failed));
      }
      const outcome = mark();
      assert.ok(!outcome.ok && /fails to render, so there is nothing to mark/.test(outcome.reason));
    } finally {
      panel.dispose();
    }
  });

  test("exporting says why there is nothing to export", async () => {
    const warn = vscode.window.showWarningMessage;
    const warnings: string[] = [];
    vscode.window.showWarningMessage = async (message: string) => {
      warnings.push(message);
      return undefined;
    };
    const { panel, webview } = await newFakePanel();
    const restored = await newFakePanel(new Map([["diagram.state", withoutSource]]));
    try {
      await panel.exportDiagram();
      webview.nextRender((render) =>
        webview.receive({ type: "renderError", requestId: render.requestId, message: "Oops" }),
      );
      assert.ok(!(await panel.render(flowchart, "tool")).ok);
      await panel.exportDiagram();
      await restored.panel.exportDiagram();
      assert.deepStrictEqual(warnings, [
        "Open or draw a diagram before exporting it.",
        "There is nothing to export, as the diagram fails to render: Oops",
        "Press Refresh to draw the chart again, then export it.",
      ]);
    } finally {
      vscode.window.showWarningMessage = warn;
      panel.dispose();
      restored.panel.dispose();
    }
  });

  test("asks @diagram about the diagrams it drew, and keeps the selection if chat fails", async () => {
    const { panel, webview } = await newFakePanel();
    const execute = vscode.commands.executeCommand;
    const showError = vscode.window.showErrorMessage;
    const queries: string[] = [];
    const errors: string[] = [];
    let chatFails = false;
    vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
      if (command !== "workbench.action.chat.open") return execute(command, ...args);
      if (chatFails) throw new Error("Chat is disabled.");
      queries.push((args[0] as { query: string }).query);
    }) as typeof execute;
    vscode.window.showErrorMessage = async (message: string) => {
      errors.push(message);
      return undefined;
    };
    const ask = () => webview.receive({ type: "ask", text: "Why?", nodes: [] });
    try {
      for (const origin of ["tool", "participant"] as const) {
        assert.ok((await panel.render(flowchart, origin)).ok);
        await ask();
      }
      assert.deepStrictEqual(queries, [
        "Regarding the diagram: Why?",
        "@diagram Regarding the diagram: Why?",
      ]);
      const nodes = [{ id: "A", label: "Parser" }];
      await webview.receive({
        type: "selectionChanged",
        requestId: webview.render.requestId,
        nodes,
      });
      webview.sent.length = 0;
      chatFails = true;
      await ask();
      assert.deepStrictEqual(errors, ["Could not send the request to chat: Chat is disabled."]);
      assert.deepStrictEqual(webview.sent, []);
      assert.match(panel.describeForModel() ?? "", /selected these nodes in the panel: "Parser"/);
    } finally {
      vscode.commands.executeCommand = execute;
      vscode.window.showErrorMessage = showError;
      panel.dispose();
    }
  });

  test("chart options and chart updates need a chart made from data", async () => {
    const { panel, webview } = await newFakePanel();
    const information = vscode.window.showInformationMessage;
    const messages: string[] = [];
    vscode.window.showInformationMessage = async (message: string) => {
      messages.push(message);
      return undefined;
    };
    const token = new vscode.CancellationTokenSource().token;
    try {
      for (const drawn of [false, true]) {
        if (drawn) assert.ok((await panel.render(flowchart, "tool")).ok);
        webview.sent.length = 0;
        panel.toggleChartOptions();
        assert.deepStrictEqual(webview.sent, []);
        await assert.rejects(
          panel.updateChart({ limit: 2 }, token),
          /^Error: The current diagram is not a generated chart\. Create one with diagram_chart first\.$/,
        );
      }
      assert.deepStrictEqual(
        messages,
        Array(2).fill("Chart Options is available for charts created from data."),
      );
    } finally {
      vscode.window.showInformationMessage = information;
      panel.dispose();
    }
  });

  test("a render or an export that the page never answers ends after 15 seconds", async () => {
    const { panel, webview } = await newFakePanel();
    const draw = webview.answer;
    webview.answer = undefined;
    const timers = holdTimers(15_000);
    const quickPick = vscode.window.showQuickPick;
    const save = vscode.window.showSaveDialog;
    const showError = vscode.window.showErrorMessage;
    const errors: string[] = [];
    vscode.window.showQuickPick = (async () => ({
      label: "SVG image",
      format: "svg",
    })) as unknown as typeof quickPick;
    vscode.window.showSaveDialog = async () => assert.fail("Nothing was exported to save.");
    vscode.window.showErrorMessage = async (message: string) => {
      errors.push(message);
      return undefined;
    };
    try {
      const rendering = panel.render(flowchart, "tool");
      timers.expire();
      assert.deepStrictEqual(await rendering, {
        ok: false,
        kind: "unavailable",
        error: "The diagram panel did not respond within 15 seconds.",
      });
      webview.answer = draw;
      assert.ok((await panel.render(flowchart, "tool")).ok);
      const exporting = panel.exportDiagram();
      while (!webview.sent.some((message) => message.type === "export")) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      timers.expire();
      await exporting;
      assert.deepStrictEqual(errors, [
        "Could not export the diagram: The diagram panel did not finish exporting within 15 seconds. Try again or choose SVG.",
      ]);
    } finally {
      timers.restore();
      vscode.window.showQuickPick = quickPick;
      vscode.window.showSaveDialog = save;
      vscode.window.showErrorMessage = showError;
      panel.dispose();
    }
  });
});
