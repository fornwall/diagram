import * as assert from "node:assert";
import * as vscode from "vscode";
import { clickToAskQuery, type Diagram, DiagramPanel, type DiagramState } from "../panel";
import { type FromWebview, isFromWebview, type ToWebview } from "../protocol";
import { ChartTool, PickDiagramNodesTool, RenderDiagramTool } from "../tools";
import { newPanel } from "./newPanel";

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

  test("isFromWebview accepts only well-formed messages", () => {
    assert.ok(isFromWebview({ type: "ready" }));
    assert.ok(isFromWebview({ type: "picked", pickId: 3, nodes: [{ id: "A", label: "Parser" }] }));
    const malformed = [
      null,
      "ready",
      [{ type: "ready" }],
      { type: "toString" },
      { type: "picked", pickId: "3", nodes: [] },
      { type: "selectionChanged", nodes: [{ id: "A" }] },
      { type: "ask", nodes: [] },
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

  test("tools report malformed input without throwing during preparation", async () => {
    const panel = newPanel();
    const cancellation = new vscode.CancellationTokenSource();
    try {
      for (const tool of [
        new RenderDiagramTool(panel),
        new ChartTool(panel),
        new PickDiagramNodesTool(panel),
      ]) {
        for (const input of [null, undefined, [], 42]) {
          const options = { input } as never;
          assert.doesNotThrow(() => tool.prepareInvocation(options));
          const result = await tool.invoke(options, cancellation.token);
          assert.ok(result.content[0] instanceof vscode.LanguageModelTextPart);
          assert.match(
            result.content[0].value,
            /Nothing was rendered|No chart was rendered|No node was picked/,
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
