import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { linkTexts } from "../links";
import { clickToAskQuery, type Diagram, type DiagramState } from "../panel";
import { AnnotateDiagramTool, GetDiagramStateTool, RenderDiagramTool } from "../tools";
import { WebviewChannel } from "../webviewChannel";
import { afterTest, interceptCommand, recordMessages, replace, tempDir } from "./afterTest";
import {
  FakeWebview,
  memento,
  newFakePanel,
  newPanel,
  openWebviewPanel,
  recordChat,
  webviewTabs,
  within,
} from "./newPanel";
import { invokeTool } from "./toolText";

const flowchart: Diagram = {
  language: "mermaid",
  source: "flowchart LR\n  A[Parser] --> B[Checker]",
  title: "Flow",
};

/**
 * Leaves what the page is sent unanswered, and holds the panel's timers of 15 seconds, after which
 * it gives up on an answer, until `expire()` runs those not cleared, which `pending` counts;
 * `started` counts all.
 */
function hangPage(webview: FakeWebview): {
  expire(): void;
  readonly pending: number;
  readonly started: number;
} {
  webview.answer = undefined;
  const delay = 15_000;
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  const held = new Map<unknown, () => void>();
  let started = 0;
  replace(globalThis, "setTimeout", ((callback: () => void, ms?: number, ...args: unknown[]) => {
    if (ms !== delay) return set(callback, ms, ...args);
    started++;
    // A handle of a timer that does nothing, which identifies the held callback.
    const handle = set(() => {}, 0);
    held.set(handle, callback);
    return handle;
  }) as typeof setTimeout);
  replace(globalThis, "clearTimeout", ((handle) => {
    if (!held.delete(handle)) clear(handle);
  }) as typeof clearTimeout);
  return {
    expire: () => {
      const callbacks = [...held.values()];
      held.clear();
      for (const callback of callbacks) callback();
    },
    get pending() {
      return held.size;
    },
    get started() {
      return started;
    },
  };
}

/**
 * Records the requests to chat and the files and URLs opened, which clicks on nodes lead to, until
 * the test ends.
 */
function recordClicks(): string[] {
  const actions: string[] = [];
  replace(vscode.env, "openExternal", async (uri) => {
    actions.push(`url: ${uri.toString(true)}`);
    return true;
  });
  interceptCommand("workbench.action.chat.open", (request) => {
    actions.push(`chat: ${(request as { query: string }).query}`);
  });
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

    panel.show();
    assert.ok(await within(() => opened.active), "Show Panel should focus the diagram");
  });

  test("a diagram with no panel to render in is still a new revision", async () => {
    const panel = newPanel();
    afterTest(() => panel.dispose());
    replace(WebviewChannel.prototype, "reveal", () => false);
    const outcome = await panel.render(flowchart, "tool");
    assert.deepStrictEqual(outcome, {
      ok: false,
      kind: "unavailable",
      error: "There is no diagram panel to render in.",
      revision: 1,
    });
    assert.strictEqual(panel.revision, 1);
    assert.strictEqual(panel.current?.source, flowchart.source);
  });

  test("a closed panel knows no drawing, which asking for its ids opens it again to draw", async () => {
    const { panel, webview } = await newFakePanel();
    const drawn = (ids: string[]) => {
      webview.answer = (message) =>
        message.type === "render"
          ? {
              type: "rendered",
              requestId: message.requestId,
              diagramType: "flowchart",
              nodeIds: ids,
            }
          : undefined;
    };
    drawn(["A", "B"]);
    assert.ok((await panel.render(flowchart, "tool")).ok);
    assert.deepStrictEqual(panel.drawnIds, ["A", "B"]);
    webview.panel.dispose();
    assert.strictEqual(panel.drawnIds, undefined);
    assert.strictEqual(panel.itemNames, undefined);
    assert.deepStrictEqual(panel.warnings, []);
    // Opened again beside chat, without taking the focus, as diagram_getImage opens it.
    const reopened = new FakeWebview();
    let preserveFocus: boolean | undefined;
    replace(vscode.window, "createWebviewPanel", (_type, _title, options) => {
      preserveFocus = typeof options === "object" ? options.preserveFocus : undefined;
      return reopened.panel;
    });
    reopened.answer = (message) =>
      message.type === "render"
        ? {
            type: "rendered",
            requestId: message.requestId,
            diagramType: "flowchart",
            nodeIds: ["A"],
          }
        : undefined;
    const ids = panel.itemIds();
    await reopened.receive({ type: "ready" });
    assert.deepStrictEqual(await ids, ["A"]);
    assert.strictEqual(preserveFocus, true);
    assert.strictEqual(reopened.render.source, flowchart.source);
    assert.strictEqual(panel.revision, 1);
    reopened.panel.dispose();
  });

  test("an image requested while reopening cannot capture a replacement diagram", async () => {
    const storage = memento(new Map());
    const { panel, webview } = await newFakePanel(storage);
    // A redraw shares an outstanding save, which can finish after another diagram renders.
    const saved = Promise.withResolvers<void>();
    const update = storage.update;
    let writes = 0;
    replace(storage, "update", (key, value) => {
      const written = update(key, value);
      return ++writes === 1 ? saved.promise : written;
    });
    const rendering = panel.render(flowchart, "tool");
    await webview.finishRender();
    webview.panel.dispose();
    const reopened = new FakeWebview();
    replace(vscode.window, "createWebviewPanel", () => reopened.panel);
    const image = panel.captureImage({ maxSide: 100, maxPixels: 10_000 });
    await reopened.receive({ type: "ready" });
    assert.ok((await panel.render({ ...flowchart, source: "flowchart LR\n  C --> D" }, "tool")).ok);
    saved.resolve();
    await rendering;
    assert.strictEqual(await image, "The diagram changed while it was drawn. Try again.");
    assert.ok(!reopened.sent.some((message) => message.type === "export"));
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
      revision: 1,
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

  test("opening chat keeps the current selection available to tools", async () => {
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
      const asking = webview.receive({
        type: "ask",
        requestId,
        text: "Explain the selection",
        nodes: [],
      });
      if (changed) {
        await select({ id: "B", label: "Checker" });
      }
      opened.resolve();
      await asking;
      assert.deepStrictEqual(webview.sent, []);
      assert.match(
        await invokeTool(new GetDiagramStateTool(panel), {}),
        changed ? /has selected: "Checker"/ : /has selected: "Parser"/,
      );
    }
  });

  test("leaves a message about a replaced drawing in the chat input for the user to review", async () => {
    const { panel, webview } = await newFakePanel();
    const chat = recordChat();
    assert.ok((await panel.render(flowchart, "tool")).ok);
    const { requestId } = webview.render;
    const next = { ...flowchart, source: `${flowchart.source}\n  B --> C` };
    assert.ok((await panel.render(next, "tool")).ok);
    const nodes = [{ id: "A", label: "Parser" }];
    await webview.receive({ type: "ask", requestId, text: "Why?", nodes });
    await webview.ask("Why?");
    assert.deepStrictEqual(chat.requests, [
      { query: 'Regarding "Parser" in the diagram: Why?', isPartialQuery: true },
      { query: "Regarding the diagram: Why?", isPartialQuery: false },
    ]);
  });

  test("a reloaded webview starts without a selection", async () => {
    const { panel, webview } = await newFakePanel();
    assert.ok((await panel.render(flowchart, "tool")).ok);
    await webview.select([{ id: "A", label: "Parser" }]);
    assert.match(panel.describeForModel() ?? "", /has selected: /);
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
    // Without the tabs that earlier tests left open, such as the page that the webview suites share,
    // which the panel takes for left over as well: in the extension, no other panel owns one.
    await vscode.window.tabGroups.close(await webviewTabs(() => true));
    await webviewTabs((labels) => labels.length === 0);
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

  for (const failure of ["fails to render", "the panel cannot show"] as const) {
    test(`a diagram that ${failure} takes no clicks`, async () => {
      const { panel, webview } = await newFakePanel();
      const clicks = recordClicks();
      const node = { id: "A", label: "Parser" };
      assert.ok((await panel.render({ ...flowchart, clickPrompt: "Explain" }, "tool")).ok);
      const shown = webview.render.requestId;
      await webview.receive({ type: "clickNode", requestId: shown, node });
      assert.deepStrictEqual(clicks, ['chat: Explain "Parser"']);
      clicks.length = 0;

      if (failure === "fails to render") webview.failNextRender("Parse error");
      else webview.deliver = (message) => message.type !== "render";
      const links = { A: { file: "sizes.tsv", line: 2 } };
      const broken = { source: "flowchart TD\n  A --> --> B[", clickPrompt: "Delete", links };
      assert.ok(!(await panel.render({ ...flowchart, ...broken }, "tool")).ok);
      // Clicks on the previous diagram, e.g. sent just before it was replaced, and clicks that name
      // the broken one, which has no nodes to click.
      for (const requestId of [shown, webview.render.requestId]) {
        await webview.receive({ type: "clickNode", requestId, node });
        await webview.receive({ type: "openUrl", requestId, url: "https://example.com/" });
      }
      assert.deepStrictEqual(clicks, []);
    });
  }

  test("only a click on a node with a link opens code", async () => {
    const { panel, webview } = await newFakePanel();
    const clicks = recordClicks();
    const click = (id: string, requestId = webview.render.requestId) =>
      webview.receive({ type: "clickNode", requestId, node: { id, label: id } });
    const links = { A: { file: "sizes.tsv", line: 2 } };
    assert.ok((await panel.render({ ...flowchart, links }, "tool")).ok);
    assert.match(panel.describeForModel() ?? "", /A → sizes\.tsv#L2/);
    await click("A");
    // A node without a link, and an id that only Object.prototype has, link nowhere.
    await click("B");
    await click("constructor");
    assert.deepStrictEqual(clicks, ["open: sizes.tsv#L2"]);
    // A click on the drawing shown is dropped once the next diagram is sent, which links the node
    // elsewhere, also when it arrives before the page drew that one.
    const shown = webview.render.requestId;
    webview.answer = undefined;
    const rendering = panel.render({ ...flowchart, links: { A: { file: "sizes.tsv" } } }, "tool");
    await click("A", shown);
    await webview.finishRender();
    assert.ok((await rendering).ok);
    await click("A", shown);
    assert.deepStrictEqual(clicks, ["open: sizes.tsv#L2"]);
    await click("A");
    assert.deepStrictEqual(clicks, ["open: sizes.tsv#L2", "open: sizes.tsv#L1"]);
    // A node's link comes before the diagram's clickPrompt, which an edge of the node's id asks.
    clicks.length = 0;
    const clickPrompt = "Explain";
    const prompting = panel.render({ ...flowchart, links, clickPrompt }, "tool");
    await webview.finishRender();
    assert.ok((await prompting).ok);
    await click("A");
    const relationship = { kind: "edge", source: "A", target: "B", direction: "forward" } as const;
    const node = { id: "A", label: "A to B", relationship };
    await webview.receive({ type: "clickNode", requestId: webview.render.requestId, node });
    await click("B");
    assert.deepStrictEqual(clicks, [
      "open: sizes.tsv#L2",
      'chat: Explain "A to B"',
      'chat: Explain "B"',
    ]);
  });

  test("a click on a replaced drawing that arrives after the next is drawn is dropped", async () => {
    const { panel, webview } = await newFakePanel();
    const clicks = recordClicks();
    const node = { id: "A", label: "Parser" };
    const click = async (requestId: number) => {
      await webview.receive({ type: "clickNode", requestId, node });
      await webview.receive({ type: "openUrl", requestId, url: "https://example.com/" });
    };
    assert.ok((await panel.render({ ...flowchart, clickPrompt: "Explain" }, "tool")).ok);
    const replaced = webview.render.requestId;
    assert.ok((await panel.render({ ...flowchart, clickPrompt: "Delete" }, "tool")).ok);
    await click(replaced);
    assert.deepStrictEqual(clicks, []);
    await click(webview.render.requestId);
    assert.deepStrictEqual(clicks, ['chat: Delete "Parser"', "url: https://example.com/"]);
  });

  test("asks before opening a linked file outside the workspace, and says why one cannot open", async () => {
    const { panel, webview } = await newFakePanel();
    const clicks = recordClicks();
    let answer: string | undefined;
    const asked = recordMessages("showWarningMessage", () => answer);
    const errors = recordMessages("showErrorMessage");
    const outside = path.join(tempDir("diagram-link-test-"), "outside.txt");
    fs.writeFileSync(outside, "outside");
    const click = (id: string) =>
      webview.receive({
        type: "clickNode",
        requestId: webview.render.requestId,
        node: { id, label: id },
      });
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
    const open = (url: string) =>
      webview.receive({ type: "openUrl", requestId: webview.render.requestId, url });
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
    // The HTML of a chart's tooltip can hold links too.
    assert.ok(
      (
        await panel.render(
          { language: "echarts", source: '{"series": []}', title: "Chart" },
          "tool",
        )
      ).ok,
    );
    await open("https://example.com/");
    await open("vscode://file/etc/passwd");
    assert.deepStrictEqual(clicks.slice(3), ["url: https://example.com/"]);
    assert.strictEqual(errors.length, 7);
    assert.match(errors[6] ?? "", /^Cannot open "vscode:\/\/file\/etc\/passwd", which the chart/);
  });

  test("opening a link shows the file beside the diagram with its lines selected", async () => {
    const { panel, webview } = await newFakePanel();
    afterTest(() => vscode.commands.executeCommand("workbench.action.closeAllEditors"));
    const link = { file: "sizes.tsv", line: 2, endLine: 3 };
    assert.ok((await panel.render({ ...flowchart, links: { A: link } }, "tool")).ok);
    const node = { id: "A", label: "Parser" };
    await webview.receive({ type: "clickNode", requestId: webview.render.requestId, node });
    const shown = vscode.window.visibleTextEditors.find((editor) =>
      editor.document.uri.path.endsWith("/sizes.tsv"),
    );
    assert.ok(shown, "the linked file is shown");
    assert.strictEqual(shown.selection.start.line, 1);
    assert.strictEqual(shown.selection.end.line, 2);
    // Beside the diagram, rather than over it in its own tab group.
    assert.notStrictEqual(shown.viewColumn, webview.panel.viewColumn);
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
    assert.strictEqual(
      warnings.at(-1),
      "Wait for the chart to finish rendering before exporting it.",
    );
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

  test("a diagram restored after a restart keeps its revision, which a model may still hold", async () => {
    const values = new Map<string, unknown>();
    const { panel, webview } = await newFakePanel(values);
    assert.ok((await panel.render(flowchart, "tool")).ok);
    await webview.edit("flowchart LR\n  A --> C");
    const revision = panel.revision;
    assert.strictEqual(revision, 2);
    panel.dispose();

    const { panel: restored } = await newFakePanel(values);
    assert.strictEqual(restored.revision, revision);
    // A later diagram's revision is not one that a model held for an earlier one.
    assert.ok((await restored.render(flowchart, "tool")).ok);
    assert.strictEqual(restored.revision, revision + 1);
  });

  test("a changed source that the panel draws has no error yet, whatever the one before had", async () => {
    const { panel, webview } = await newFakePanel();
    const broken = "Parse error on line 2.";
    webview.failNextRender(broken);
    await panel.render(flowchart, "tool");
    assert.strictEqual(panel.current?.error, broken);
    // The page takes its time to draw the user's fix, and an agent's.
    webview.answer = undefined;
    const applying = webview.edit("flowchart LR\n  A --> C");
    assert.strictEqual(panel.current?.error, undefined);
    assert.doesNotMatch(panel.describeForModel() ?? "", /Parse error/);
    await webview.finishRender(broken);
    await applying;
    assert.strictEqual(panel.current?.error, broken);
    const editing = panel.editByAgent({ source: flowchart.source, title: "Flow" }, panel.revision);
    assert.strictEqual(panel.current?.error, undefined);
    await webview.finishRender();
    assert.ok((await editing).ok);
  });

  test("an agent's edit drops the selection of the items it removes, as the page does", async () => {
    const { panel, webview } = await newFakePanel();
    // The page draws the nodes named by single capital letters.
    webview.answer = (message) =>
      message.type === "render"
        ? {
            type: "rendered",
            requestId: message.requestId,
            diagramType: "flowchart-v2",
            nodeIds: [...new Set(message.source.match(/\b[A-Z]\b/g))],
          }
        : undefined;
    const source = `${flowchart.source}\n  B --> C`;
    assert.ok((await panel.render({ ...flowchart, source }, "tool")).ok);
    await webview.select([{ id: "C", label: "C" }]);
    assert.match(panel.describeForModel() ?? "", /has selected: "C"/);
    const edit = { source: flowchart.source, title: flowchart.title };
    assert.ok((await panel.editByAgent(edit, panel.revision)).ok);
    assert.deepStrictEqual(webview.render.selection, ["C"]);
    // Which leaves nothing selected in the page, which then says nothing.
    assert.match(panel.describeForModel() ?? "", /has no nodes selected/);
  });

  test("marking the diagram does not render it again, and a new diagram clears the marks", async () => {
    const { panel, webview } = await newFakePanel();
    const { sent } = webview;
    assert.ok((await panel.render(flowchart, "tool")).ok);
    sent.length = 0;
    const outcome = panel.annotate({
      marks: [{ id: "A", kind: "problem" }],
      dim: true,
    });
    assert.ok(outcome.ok && outcome.unknown.length === 0);
    // Only the marks go to the webview: the diagram it already shows stays as it is.
    assert.deepStrictEqual(
      sent.map((message) => message.type),
      ["annotate"],
    );
    const described = panel.describeForModel() ?? "";
    assert.match(described, /Marked: "A" \(problem\)\./);
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
    assert.deepStrictEqual(outcome.unknown, [{ name: "Parser", ids: [] }]);
    assert.deepStrictEqual(outcome.annotation.marks, [{ id: "A", kind: "good" }]);
    // The links of a diagram are checked against the same ids, once it is drawn.
    const links = { A: { file: "sizes.tsv" }, Checker: { file: "sizes.tsv" } };
    const result = await invokeTool(new RenderDiagramTool(panel), {
      source: flowchart.source,
      links: linkTexts(links),
    });
    assert.match(result, /These links name nodes the diagram does not have/);
    assert.match(result, /"Checker"\. Its node ids are "A", "B"\./);
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
      return {
        ids: outcome.annotation.marks.map((mark) => mark.id),
        unknown: outcome.unknown.map(({ name }) => name),
      };
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
      /Chart items that share a name, by id: "Yes" \(ids: "Yes \(q1\)", "Yes \(q2\)"\)\./,
    );
    const result = await invokeTool(new AnnotateDiagramTool(panel), {
      marks: [{ id: "Yes" }, { id: "Yes (q2)" }],
    });
    assert.match(result, /^Marked 1 chart item: "Yes \(q2\)" \(current\)\./);
    assert.match(
      result,
      /These names each name several items of the chart, so nothing was marked for them: "Yes" \(ids: "Yes \(q1\)", "Yes \(q2\)"\)\. Mark the items you mean by their ids\./,
    );
    const outcome = panel.annotate({ marks: [{ id: "Yes", kind: "info" }], dim: false });
    assert.ok(outcome.ok);
    assert.deepStrictEqual(outcome.annotation.marks, []);
    assert.deepStrictEqual(outcome.repeated, repeatedNames);
  });

  test("sends follow-ups to the current chat without changing agents", async () => {
    const { panel, webview } = await newFakePanel();
    const chat = recordChat();
    const errors = recordMessages("showErrorMessage");
    const ask = () => webview.ask("Why?");
    for (const origin of ["tool", "document"] as const) {
      assert.ok((await panel.render(flowchart, origin)).ok);
      await ask();
    }
    assert.deepStrictEqual(
      chat.requests,
      Array(2).fill({ query: "Regarding the diagram: Why?", isPartialQuery: false }),
    );
    const nodes = [{ id: "A", label: "Parser" }];
    await webview.select(nodes);
    const sent = webview.sent.length;
    chat.fail = true;
    await ask();
    assert.deepStrictEqual(errors, ["Could not send the request to chat: Chat is disabled."]);
    assert.strictEqual(webview.sent.length, sent);
    assert.match(panel.describeForModel() ?? "", /has selected: "Parser"/);
  });

  test("a render or an export that the page never answers ends after 15 seconds", async () => {
    const { panel, webview } = await newFakePanel();
    const draw = webview.answer;
    const timers = hangPage(webview);
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
      revision: 1,
    });
    webview.answer = draw;
    assert.ok((await panel.render(flowchart, "tool")).ok);
    const exporting = panel.exportDiagram();
    assert.ok(await within(() => webview.sent.some((message) => message.type === "export")));
    timers.expire();
    await exporting;
    assert.deepStrictEqual(errors, [
      "Could not export the diagram: The diagram panel did not finish exporting within 15 seconds. Try again or choose SVG.",
    ]);
  });

  test("a render that the page answers after 15 seconds counts once it does", async () => {
    const { panel, webview } = await newFakePanel();
    const timers = hangPage(webview);
    const clicks = recordClicks();
    const rendering = panel.render({ ...flowchart, clickPrompt: "Explain {label}" }, "tool");
    timers.expire();
    assert.ok(!(await rendering).ok);
    assert.match(panel.describeForModel() ?? "", /not showing it yet: The diagram panel did not/);
    const click = () =>
      webview.receive({
        type: "clickNode",
        requestId: webview.render.requestId,
        node: { id: "A", label: "Parser" },
      });
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
    const timers = hangPage(webview);
    const rendering = panel.render(flowchart, "tool");
    timers.expire();
    assert.ok(!(await rendering).ok);
    const unfinished = /^The panel did not finish drawing it/;
    assert.match(panel.current?.error ?? "", unfinished);
    // Revealing the open panel, which may still be drawing, sends the diagram as it is.
    panel.show();
    assert.strictEqual(webview.render.notDrawn, undefined);
    // Rendering it again, which the page has not taken up yet, keeps it unfinished.
    const again = panel.render(flowchart, "tool");
    timers.expire();
    await again;
    assert.match(panel.current?.error ?? "", unfinished);

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

  test("a render that the page takes up after the one it was drawing gets the full 15 seconds", async () => {
    const { panel, webview } = await newFakePanel();
    const timers = hangPage(webview);
    void panel.render({ ...flowchart, source: "flowchart LR\n  A" }, "tool");
    const { requestId } = webview.render;
    const rendering = panel.render(flowchart, "tool");
    const started = timers.started;
    // The page draws the first, then skips to the last render sent, which hangs it.
    await webview.receive({ type: "rendered", requestId, diagramType: "test" });
    assert.strictEqual(timers.started, started + 1);
    assert.strictEqual(timers.pending, 1);
    timers.expire();
    assert.ok(!(await rendering).ok);
    assert.match(panel.current?.error ?? "", /^The panel did not finish drawing it/);
  });

  test("a render that ended before the page took it up is unfinished if it hangs the page then", async () => {
    const { panel, webview } = await newFakePanel();
    const timers = hangPage(webview);
    void panel.render({ ...flowchart, source: "flowchart LR\n  A" }, "tool");
    const { requestId } = webview.render;
    const rendering = panel.render(flowchart, "tool");
    // The page is still drawing the first.
    timers.expire();
    assert.ok(!(await rendering).ok);
    assert.strictEqual(panel.current?.error, undefined);
    await webview.receive({ type: "rendered", requestId, diagramType: "test" });
    timers.expire();
    assert.match(panel.current?.error ?? "", /^The panel did not finish drawing it/);
    await webview.finishRender();
    assert.strictEqual(panel.current?.error, undefined);
  });

  test("a page that takes over 15 seconds to load draws the diagram once it does", async () => {
    const values = new Map<string, unknown>();
    const { panel } = await newFakePanel(values);
    assert.ok((await panel.render(flowchart, "tool")).ok);
    const restarted = newPanel(values);
    afterTest(() => restarted.dispose());
    const webview = new FakeWebview();
    const timers = hangPage(webview);
    restarted.restore(webview.panel);
    assert.strictEqual(timers.pending, 1);
    timers.expire();
    assert.strictEqual(restarted.current?.error, undefined);
    await webview.receive({ type: "ready" });
    assert.strictEqual(webview.render.notDrawn, undefined);
    // With the full 15 seconds, also when the page loads again, which replaces the timer.
    assert.strictEqual(timers.pending, 1);
    await webview.receive({ type: "ready" });
    assert.strictEqual(timers.pending, 1);
    await webview.finishRender();
    assert.strictEqual(timers.pending, 0);
  });
});
