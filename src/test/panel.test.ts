import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { buildChart } from "../charts";
import { parseTable } from "../data";
import { linkTexts } from "../links";
import { clickToAskQuery, type Diagram, type DiagramPanel, type DiagramState } from "../panel";
import type { ToWebview } from "../protocol";
import { AnnotateDiagramTool, RenderDiagramTool } from "../tools";
import { WebviewChannel } from "../webviewChannel";
import { afterTest, cancellationSource, recordMessages, replace, tempDir } from "./afterTest";
import {
  FakeWebview,
  memento,
  newFakePanel,
  newPanel,
  openWebviewPanel,
  recordChat,
  showInFake,
  webviewTabs,
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

/** Holds back the timers of the given delay until the test expires them, or the test ends. */
function holdTimers(delay: number): { expire(): void } {
  const set = globalThis.setTimeout;
  const held: (() => void)[] = [];
  replace(globalThis, "setTimeout", ((callback: () => void, ms?: number, ...args: unknown[]) => {
    if (ms !== delay) return set(callback, ms, ...args);
    held.push(callback);
    // A handle for clearTimeout, which then has nothing to clear.
    return set(() => {}, 0);
  }) as typeof setTimeout);
  return {
    expire: () => {
      for (const callback of held.splice(0)) callback();
    },
  };
}

function pick(panel: DiagramPanel, token = new vscode.CancellationTokenSource().token) {
  return panel.pickNodes("Which part?", false, token);
}

/**
 * Records the requests to chat and the files and URLs opened, which clicks on nodes lead to, until
 * the test ends.
 */
function recordClicks(): string[] {
  const execute = vscode.commands.executeCommand;
  const actions: string[] = [];
  replace(vscode.env, "openExternal", async (uri) => {
    actions.push(`url: ${uri.toString(true)}`);
    return true;
  });
  replace(vscode.commands, "executeCommand", (async (command: string, ...args: unknown[]) => {
    if (command !== "workbench.action.chat.open") return execute(command, ...args);
    actions.push(`chat: ${(args[0] as { query: string }).query}`);
    return undefined;
  }) as typeof execute);
  replace(vscode.window, "showTextDocument", (async (
    document: vscode.TextDocument,
    options: vscode.TextDocumentShowOptions,
  ) => {
    const line = options.selection ? `#L${options.selection.start.line + 1}` : "";
    actions.push(`open: ${path.basename(document.uri.fsPath)}${line}`);
  }) as unknown as typeof vscode.window.showTextDocument);
  return actions;
}

suite("panel", function () {
  // The first render loads the webview, which can take a while.
  this.timeout(10_000);

  test("asks about a clicked node by its label, in place of {label} or after the prompt", () => {
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
    const warnings = recordMessages("showWarningMessage");
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
    assert.strictEqual(panel.current?.source, flowchart.source, "failed diagrams remain editable");
  });

  test("leaves the focus in the editor as an agent draws and marks, and takes it when shown", async () => {
    // Earlier suites dispose their panels asynchronously. Finish closing their tabs before this
    // test opens an editor, so a disappearing group cannot move it into the panel's column.
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const document = await vscode.workspace.openTextDocument({ content: "Keep editing here" });
    const editor = await vscode.window.showTextDocument(document);
    const panel = newPanel();
    afterTest(() => panel.dispose());
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
  });

  test("ends a render and a waiting pick that cannot reach the page, without blaming the source", async () => {
    const unavailable = /^The diagram panel is unavailable\.$/;
    for (const [failing, deliver, error] of [
      ["renders", (message: ToWebview) => message.type !== "render", unavailable],
      ["every message", () => false, unavailable],
      [
        "every message, throwing",
        () => {
          throw new Error("Disconnected");
        },
        /Disconnected/,
      ],
    ] as const) {
      const { panel, webview } = await newFakePanel();
      webview.deliver = deliver;
      const rendering = panel.render(flowchart, "tool");
      const picking = pick(panel);
      const outcome = await rendering;
      assert.ok(!outcome.ok && outcome.kind === "unavailable", failing);
      assert.match(outcome.error, error, failing);
      assert.deepStrictEqual(await picking, { picked: false, reason: outcome.error }, failing);
      assert.strictEqual(panel.current?.error, undefined, failing);
    }
  });

  for (const reload of ["moving the tab", "granting trust"]) {
    test(`failed deliveries from before a reload by ${reload} cannot cancel replayed requests`, async () => {
      const trust = new vscode.EventEmitter<void>();
      afterTest(() => trust.dispose());
      replace(vscode.workspace, "onDidGrantWorkspaceTrust", trust.event);
      const { panel, webview } = await newFakePanel();
      webview.answer = undefined;
      const delivery = Promise.withResolvers<boolean>();
      webview.deliver = () => delivery.promise;
      const rendering = panel.render(flowchart, "tool");
      const picking = pick(panel);
      const startPick = webview.sent.findLast((message) => message.type === "startPick");
      assert.ok(startPick);

      webview.deliver = () => true;
      // VS Code reloads a moved tab's page itself, which only the page's "ready" tells.
      if (reload === "granting trust") trust.fire();
      else await webview.receive({ type: "ready" });
      delivery.resolve(false);
      await new Promise((resolve) => setImmediate(resolve));
      if (reload === "granting trust") await webview.receive({ type: "ready" });

      await webview.finishRender();
      const nodes = [{ id: "A", label: "Parser" }];
      await webview.receive({ type: "picked", pickId: startPick.pickId, nodes });
      assert.ok((await rendering).ok);
      assert.deepStrictEqual(await picking, { picked: true, nodes });
    });
  }

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
  });

  test("an unavailable rendering ignores stale clicks on the previous diagram", async () => {
    const { panel, webview } = await newFakePanel();
    webview.deliver = (message) => message.type !== "render";
    const clicks = recordClicks();
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
    assert.deepStrictEqual(clicks, []);
  });

  test("a completed render cannot mark a newer copy of the same source as broken", async () => {
    const { panel, webview } = await newFakePanel();
    webview.answer = undefined;
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
  });

  test("saving failures do not turn successful renders into errors", async () => {
    const state = memento(new Map());
    state.update = async () => {
      throw new Error("Storage is unavailable");
    };
    const { panel } = await newFakePanel(state);
    assert.ok((await panel.render(flowchart, "tool")).ok);
    assert.strictEqual(panel.current?.source, flowchart.source);
    assert.strictEqual(panel.current?.error, undefined);
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
    assert.deepStrictEqual(await panel.render(flowchart, "tool"), unavailable);
    assert.strictEqual(panel.current?.error, undefined);

    const picking = pick(panel);
    assert.strictEqual(renders(), 2, "Picking must restart the failed render");
    assert.deepStrictEqual(await picking, { picked: false, reason: unavailable.error });
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
      const target = vscode.Uri.file(path.join(tempDir("diagram-save-test-"), "chart.html"));
      const reported = Promise.withResolvers<string>();
      replace(vscode.window, "showQuickPick", (async () => ({
        label: "Interactive HTML",
        format: "html",
      })) as unknown as typeof vscode.window.showQuickPick);
      replace(vscode.window, "showSaveDialog", async () => target);
      recordMessages("showInformationMessage", () => "Open");
      recordMessages("showErrorMessage", (message) => reported.resolve(message));
      replace(vscode.env, "openExternal", async (uri) => {
        assert.strictEqual(uri.toString(), target.toString());
        if (rejected) {
          throw new Error("Browser unavailable");
        }
        return false;
      });
      await panel.exportDiagram();
      const message = await reported.promise;
      assert.ok(fs.statSync(target.fsPath).size > 500_000);
      assert.match(message, /Could not open the saved chart/);
      assert.ok(message.includes(target.fsPath));
      assert.match(message, rejected ? /Browser unavailable/ : /No application accepted/);
    });
  }

  test("a pick ends when another pick, a new diagram or cancellation replaces it", async () => {
    const { panel } = await newFakePanel();
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

    const cancellation = cancellationSource();
    const third = pick(panel, cancellation.token);
    cancellation.cancel();
    assert.deepStrictEqual(await third, { picked: false, reason: "The request was cancelled." });
  });

  test("a cancelled pick leaves an existing pick active", async () => {
    const { panel } = await newFakePanel();
    const cancellation = cancellationSource();
    cancellation.cancel();
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
  });

  test("opening chat clears only the selection that sent the request", async () => {
    const { panel, webview } = await newFakePanel();
    assert.ok((await panel.render(flowchart, "tool")).ok);
    let opened = Promise.withResolvers<void>();
    replace(vscode.commands, "executeCommand", (() => opened.promise) as never);
    const { requestId } = webview.render;
    const select = (node: { id: string; label: string }) =>
      webview.receive({ type: "selectionChanged", requestId, nodes: [node] });
    for (const changed of [true, false]) {
      opened = Promise.withResolvers<void>();
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
  });

  test("a reloaded webview starts without a selection", async () => {
    const { panel, webview } = await newFakePanel();
    assert.ok((await panel.render(flowchart, "tool")).ok);
    await webview.select([{ id: "A", label: "Parser" }]);
    assert.match(panel.describeForModel() ?? "", /selected these nodes/);
    await webview.receive({ type: "ready" });
    assert.match(panel.describeForModel() ?? "", /no nodes selected/);
  });

  test("a restored panel without a saved diagram drops the title of the one it showed", async () => {
    const panel = newPanel();
    const webview = new FakeWebview();
    webview.panel.title = "Old flow";
    afterTest(() => panel.dispose());
    panel.restore(webview.panel);
    assert.strictEqual(webview.panel.title, "Diagram");
  });

  test("opening the panel replaces a diagram tab left from before a reload, and no other", async () => {
    const other = vscode.window.createWebviewPanel("a.diagram.panel", "Other", {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: true,
    });
    afterTest(() => other.dispose());
    vscode.window.createWebviewPanel(WebviewChannel.viewType, "Old", {
      viewColumn: vscode.ViewColumn.Two,
      preserveFocus: true,
    });
    const [, old] = await webviewTabs((labels) => labels.join() === "Other,Old");
    const panel = newPanel();
    afterTest(() => panel.dispose());
    panel.show(true);
    const [, replacement] = await webviewTabs((labels) => labels.join() === "Other,Diagram");
    assert.strictEqual(replacement?.group.viewColumn, old?.group.viewColumn);
  });

  test("a chart restored without its option, as a large one is saved, waits for Refresh", async () => {
    const { panel } = await newFakePanel(new Map([["diagram.state", withoutSource]]));
    assert.strictEqual(panel.current?.title, "Sizes");
    assert.match(panel.describeForModel() ?? "", /Not drawn.*press Refresh/);
    const picking = await pick(panel);
    assert.ok(!picking.picked && /too large to keep/.test(picking.reason));
    assert.ok((await panel.render(flowchart, "tool")).ok);
  });

  test("a diagram that fails to render takes no clicks", async () => {
    const { panel, webview } = await newFakePanel();
    const clicks = recordClicks();
    const links = { A: { file: "sizes.tsv", line: 2 } };
    const click = (id: string) => webview.receive({ type: "clickToOpen", node: { id, label: id } });
    assert.ok((await panel.render({ ...flowchart, clickPrompt: "Explain" }, "tool")).ok);
    await webview.receive({ type: "clickToAsk", node: { id: "A", label: "Parser" } });
    assert.deepStrictEqual(clicks, ['chat: Explain "Parser"']);
    clicks.length = 0;

    webview.failNextRender("Parse error");
    const broken = { source: "flowchart TD\n  A --> --> B[", clickPrompt: "Delete", links };
    assert.ok(!(await panel.render({ ...flowchart, ...broken }, "tool")).ok);
    // Clicks on the previous diagram, e.g. sent just before it was replaced.
    await webview.receive({ type: "clickToAsk", node: { id: "A", label: "Parser" } });
    await click("A");
    await webview.receive({ type: "openUrl", url: "https://example.com/" });
    assert.deepStrictEqual(clicks, []);
  });

  test("only a click on a node with a link opens code", async () => {
    const { panel, webview } = await newFakePanel();
    const clicks = recordClicks();
    const click = (id: string) => webview.receive({ type: "clickToOpen", node: { id, label: id } });
    const links = { A: { file: "sizes.tsv", line: 2 } };
    assert.ok((await panel.render({ ...flowchart, links }, "tool")).ok);
    assert.match(panel.describeForModel() ?? "", /A → sizes\.tsv#L2/);
    await click("A");
    // A node without a link, and an id that only Object.prototype has, link nowhere.
    await click("B");
    await click("constructor");
    assert.deepStrictEqual(clicks, ["open: sizes.tsv#L2"]);
  });

  test("asks before opening a linked file outside the workspace, and says why one cannot open", async () => {
    const { panel, webview } = await newFakePanel();
    const clicks = recordClicks();
    let answer: string | undefined;
    const asked = recordMessages("showWarningMessage", () => answer);
    const errors = recordMessages("showErrorMessage");
    const outside = path.join(tempDir("diagram-link-test-"), "outside.txt");
    fs.writeFileSync(outside, "outside");
    const click = (id: string) => webview.receive({ type: "clickToOpen", node: { id, label: id } });
    const links = { A: { file: outside }, B: { file: "missing.txt" } };
    assert.ok((await panel.render({ ...flowchart, links }, "tool")).ok);
    await click("A");
    answer = "Open";
    await click("A");
    assert.deepStrictEqual(asked, Array(2).fill('Open the file that "A" links to?'));
    assert.deepStrictEqual(clicks, ["open: outside.txt#L1"]);
    await click("B");
    assert.strictEqual(asked.length, 2);
    assert.deepStrictEqual(errors, [
      'Could not open the code that "B" links to: missing.txt does not exist.',
    ]);
  });

  test("opens only http, https and mailto links that a diagram draws", async () => {
    const { panel, webview } = await newFakePanel();
    const clicks = recordClicks();
    const errors = recordMessages("showErrorMessage");
    const open = (url: string) => webview.receive({ type: "openUrl", url });
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
    assert.deepStrictEqual(clicks, [
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
    assert.strictEqual(clicks.length, 3);
  });

  test("opening a link shows the file beside the diagram with its lines selected", async () => {
    const { panel, webview } = await newFakePanel();
    afterTest(() => vscode.commands.executeCommand("workbench.action.closeAllEditors"));
    const link = { file: "sizes.tsv", line: 2, endLine: 3 };
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
  });

  test("large manual chart edits survive a reload", async () => {
    const values = new Map<string, unknown>();
    const { panel, webview } = await newFakePanel(values);
    const source = JSON.stringify({ series: [{ type: "pie", data: [1] }] });
    const edited = `${source}${" ".repeat(1_000_000)}`;
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
    afterTest(() => restored.dispose());
    assert.strictEqual(restored.current?.source, edited);
    assert.strictEqual(restored.current?.editedByUser, true);
  });

  test("exporting waits for a successful render and reports an unavailable panel", async () => {
    const { panel, webview } = await newFakePanel();
    webview.answer = undefined;
    const warnings = recordMessages("showWarningMessage");
    let dialogs = 0;
    replace(vscode.window, "showSaveDialog", async () => {
      dialogs++;
      return undefined;
    });
    const chart = { language: "echarts", source: '{"series": []}', title: "Chart" } as const;
    const rendering = panel.render(chart, "tool");
    await panel.exportDiagram();
    assert.strictEqual(dialogs, 0);
    assert.match(warnings.at(-1) ?? "", /Wait.*rendering/);
    webview.deliver = (message) => message.type !== "render";
    assert.ok(!(await panel.render(chart, "tool")).ok);
    await rendering;
    await panel.exportDiagram();
    assert.strictEqual(dialogs, 0);
    assert.strictEqual(
      warnings.at(-1),
      "The diagram panel is unavailable. Use Diagram: Show Panel and try again.",
    );
  });

  test("refresh preserves manual styling through panel state restoration", async () => {
    const values = new Map<string, unknown>();
    let { panel, webview } = await newFakePanel(values);
    const chart = { type: "bar", data: "name,value\nC,20\nD,40" } as const;
    const option = buildChart(chart, parseTable("name,value\nA,2\nB,4")).option;
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
  });

  test("blocked custom source is preserved without loading data", async () => {
    const { panel, webview } = await newFakePanel();
    const source = '{"series":[{"type":"pie","data":[1]}]}';
    const edited = '{series:[{type:"pie",data:[1]}],tooltip:{formatter: () => "value"}}';
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
    const progress = vscode.window.withProgress;
    let loads = 0;
    replace(vscode.window, "withProgress", async (options, task) => {
      loads++;
      return progress(options, task);
    });
    const errors = recordMessages("showErrorMessage");
    await webview.receive({ type: "refresh" });
    assert.strictEqual(loads, 0);
    assert.strictEqual(panel.current?.source, edited);
    assert.match(errors.join(), /source is kept.*Reset Styling/);
  });

  test("a failed refresh render restores the previous source and presentation", async () => {
    const { panel, webview } = await newFakePanel();
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
    webview.failNextRender("test refresh failure");
    const errors = recordMessages("showErrorMessage");
    await webview.receive({ type: "refresh" });
    assert.strictEqual(panel.current?.source, before?.source);
    assert.deepStrictEqual(panel.current?.chartPresentation, before?.chartPresentation);
    assert.match(errors.join(), /test refresh failure.*previous chart is kept/);
    assert.match(panel.describeForModel() ?? "", /A \(good\)/);
  });

  test("refreshing chart data ends a pending pick", async () => {
    const { panel, webview } = await newFakePanel();
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
  });

  test("a refresh that started before a hand edit keeps the edit", async () => {
    const { panel, webview } = await newFakePanel();
    const pie = (name: string) =>
      JSON.stringify({ series: [{ type: "pie", data: [{ name, value: 1 }] }] });
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
  });

  for (const action of ["edit and revert", "close and reopen"]) {
    test(`refresh does not overwrite the chart after ${action}`, async () => {
      const { panel, webview } = await newFakePanel();
      const source = JSON.stringify({ series: [{ type: "pie", data: [1] }] });
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
      const progress = vscode.window.withProgress;
      const resumed = Promise.withResolvers<void>();
      replace(vscode.window, "withProgress", async (options, task) => {
        await resumed.promise;
        return progress(options, task);
      });
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
    });
  }

  test("a reloaded page draws the same revision, which a refresh and an update still apply to", async () => {
    const { panel, webview } = await newFakePanel();
    const source = JSON.stringify({ series: [{ type: "pie", data: [1] }] });
    const chart = { type: "pie", file: "sizes.tsv" } as const;
    assert.ok(
      (await panel.render({ language: "echarts", source, title: "Sizes", chart }, "tool")).ok,
    );
    const revision = panel.revision;
    const progress = vscode.window.withProgress;
    const resumed = Promise.withResolvers<void>();
    replace(vscode.window, "withProgress", async (options, task) => {
      await resumed.promise;
      return progress(options, task);
    });
    const refreshing = webview.receive({ type: "refresh" });
    const reload = async () => {
      await webview.receive({ type: "ready" });
      await new Promise((resolve) => setImmediate(resolve));
    };
    await reload();
    assert.strictEqual(panel.revision, revision);
    resumed.resolve();
    await refreshing;
    assert.match(panel.current?.source ?? "", /"src"/);
    assert.strictEqual(panel.revision, revision + 1);

    await reload();
    const token = new vscode.CancellationTokenSource().token;
    assert.ok((await panel.updateChart({ limit: 1, revision: revision + 1 }, token)).ok);
  });

  test("marking the diagram does not render it again, and a new diagram clears the marks", async () => {
    const { panel, webview } = await newFakePanel();
    const { sent } = webview;
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
    await draw(["A", "B", " B "]);
    assert.deepStrictEqual(annotate(" A ", " B "), { ids: ["A", " B "], unknown: [] });
    assert.deepStrictEqual(annotate(" A ", "A"), { ids: ["A"], unknown: [" A "] });
    assert.deepStrictEqual(annotate(" A ", "  A"), { ids: ["A"], unknown: ["  A"] });
    await draw();
    assert.deepStrictEqual(annotate(" A "), { ids: [" A "], unknown: [] });
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
  });

  test("the marks go back on a webview that reloaded", async () => {
    const { panel, webview } = await newFakePanel();
    const { sent } = webview;
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
  });

  test("annotate and pickNodes say why there is nothing to mark or pick", async () => {
    const { panel, webview } = await newFakePanel();
    webview.answer = undefined;
    const mark = () => panel.annotate({ marks: [{ id: "A", kind: "info" }], dim: false });
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
  });

  test("exporting says why there is nothing to export", async () => {
    const warnings = recordMessages("showWarningMessage");
    const { panel, webview } = await newFakePanel();
    const restored = await newFakePanel(new Map([["diagram.state", withoutSource]]));
    await panel.exportDiagram();
    webview.failNextRender("Oops");
    assert.ok(!(await panel.render(flowchart, "tool")).ok);
    await panel.exportDiagram();
    await restored.panel.exportDiagram();
    assert.deepStrictEqual(warnings, [
      "Open or draw a diagram before exporting it.",
      "There is nothing to export, as the diagram fails to render: Oops",
      "Press Refresh to draw the chart again, then export it.",
    ]);
  });

  test("asks @diagram about the diagrams it drew, and keeps the selection if chat fails", async () => {
    const { panel, webview } = await newFakePanel();
    const chat = recordChat();
    const errors = recordMessages("showErrorMessage");
    const ask = () => webview.receive({ type: "ask", text: "Why?", nodes: [] });
    for (const origin of ["tool", "participant"] as const) {
      assert.ok((await panel.render(flowchart, origin)).ok);
      await ask();
    }
    assert.deepStrictEqual(
      chat.requests.map((request) => request.query),
      ["Regarding the diagram: Why?", "@diagram Regarding the diagram: Why?"],
    );
    const nodes = [{ id: "A", label: "Parser" }];
    await webview.select(nodes);
    webview.sent.length = 0;
    chat.fail = true;
    await ask();
    assert.deepStrictEqual(errors, ["Could not send the request to chat: Chat is disabled."]);
    assert.deepStrictEqual(webview.sent, []);
    assert.match(panel.describeForModel() ?? "", /selected these nodes in the panel: "Parser"/);
  });

  test("chart options and chart updates need a chart made from data", async () => {
    const { panel, webview } = await newFakePanel();
    const messages = recordMessages("showInformationMessage");
    const token = new vscode.CancellationTokenSource().token;
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
  });

  test("a render or an export that the page never answers ends after 15 seconds", async () => {
    const { panel, webview } = await newFakePanel();
    const draw = webview.answer;
    webview.answer = undefined;
    const timers = holdTimers(15_000);
    replace(vscode.window, "showQuickPick", (async () => ({
      label: "SVG image",
      format: "svg",
    })) as unknown as typeof vscode.window.showQuickPick);
    replace(vscode.window, "showSaveDialog", async () =>
      assert.fail("Nothing was exported to save."),
    );
    const errors = recordMessages("showErrorMessage");
    const rendering = panel.render(flowchart, "tool");
    timers.expire();
    assert.deepStrictEqual(await rendering, {
      ok: false,
      kind: "unavailable",
      error:
        "The diagram panel did not respond within 15 seconds. It may still be drawing a large diagram. If it stays unresponsive, the diagram hangs it, and only restarting VS Code recovers it.",
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
  });

  test("a render that the page answers after 15 seconds counts once it does", async () => {
    const { panel, webview } = await newFakePanel();
    webview.answer = undefined;
    const timers = holdTimers(15_000);
    const clicks = recordClicks();
    const rendering = panel.render({ ...flowchart, clickPrompt: "Explain {label}" }, "tool");
    timers.expire();
    assert.ok(!(await rendering).ok);
    assert.match(panel.describeForModel() ?? "", /not showing it yet: The diagram panel did not/);
    const click = () => webview.receive({ type: "clickToAsk", node: { id: "A", label: "Parser" } });
    await click();
    await webview.finishRender();
    await click();
    assert.deepStrictEqual(clicks, ["chat: Explain Parser"]);
    assert.doesNotMatch(panel.describeForModel() ?? "", /not showing it/);

    const broken = panel.render({ ...flowchart, source: "flowchart ??" }, "tool");
    timers.expire();
    await broken;
    await webview.finishRender("Parse error");
    assert.strictEqual(panel.current?.error, "Parse error");
  });

  test("a new page does not draw a diagram that the page did not finish drawing", async () => {
    const values = new Map<string, unknown>();
    const { panel, webview } = await newFakePanel(values);
    webview.answer = undefined;
    const timers = holdTimers(15_000);
    const rendering = panel.render(flowchart, "tool");
    timers.expire();
    assert.ok(!(await rendering).ok);
    const unfinished = /^The panel did not finish drawing it/;
    assert.match(panel.current?.error ?? "", unfinished);
    // Revealing the open panel, which may still be drawing, sends the diagram as it is.
    panel.show();
    assert.strictEqual(webview.render.notDrawn, undefined);

    // VS Code restarts: the saved diagram shows as failing, until rendered again.
    const restarted = await newFakePanel(values);
    assert.match(restarted.webview.render.notDrawn ?? "", unfinished);
    assert.match(restarted.panel.current?.error ?? "", unfinished);
    assert.ok((await restarted.panel.render(flowchart, "tool")).ok);
    assert.strictEqual(restarted.webview.render.notDrawn, undefined);

    // The first page answers at last, which clears the error.
    await webview.finishRender();
    assert.strictEqual(panel.current?.error, undefined);
    await webview.receive({ type: "ready" });
    assert.strictEqual(webview.render.notDrawn, undefined);
  });

  test("a chart update that the page answers after 15 seconds cannot replace the kept chart", async () => {
    const { panel, webview } = await newFakePanel();
    const chart = { type: "bar", data: "name,amount\na,1\nb,2\nc,3" } as const;
    const table = parseTable(chart.data);
    const source = JSON.stringify(buildChart(chart, table).option);
    const diagram = { language: "echarts", source, title: "Amounts", chart } as const;
    assert.ok((await panel.render(diagram, "tool", undefined, table)).ok);
    webview.answer = undefined;
    const timers = holdTimers(15_000);
    const token = new vscode.CancellationTokenSource().token;
    const updating = panel.updateChart({ limit: 2 }, token);
    await new Promise((resolve) => setImmediate(resolve));
    const abandoned = webview.render;
    assert.notStrictEqual(abandoned.source, source);
    timers.expire();
    const outcome = await updating;
    assert.ok(!outcome.ok);
    assert.match(outcome.error, /did not respond.*previous chart is kept/);

    // The page draws the abandoned chart late, and then the kept one again.
    const { requestId } = abandoned;
    await webview.receive({ type: "renderError", requestId, message: "Late" });
    await webview.receive({ type: "rendered", requestId, diagramType: "bar" });
    assert.strictEqual(panel.current?.source, source);
    assert.strictEqual(panel.current?.error, undefined);
    assert.strictEqual(webview.render.source, source);
    await webview.finishRender();
    assert.doesNotMatch(panel.describeForModel() ?? "", /not showing it/);
  });
});
