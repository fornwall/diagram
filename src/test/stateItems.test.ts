import * as assert from "node:assert";
import * as vscode from "vscode";
import { collectItemPage } from "../itemPage";
import type { DiagramNode, ItemPage } from "../protocol";
import { itemPageText } from "../stateItems";
import { GetDiagramStateTool } from "../tools";
import { cancellationSource, replace } from "./afterTest";
import { FakeWebview, newFakePanel } from "./newPanel";
import { invokeTool } from "./toolText";

const nodes: DiagramNode[] = [
  { id: "A", label: "Cache.*" },
  { id: "B", label: "Store" },
  {
    id: "edge:1",
    label: "Cache → Store: put",
    relationship: { kind: "edge", source: "A", target: "B", direction: "forward", text: "put" },
  },
  {
    id: "edge:2",
    label: "Cache → Store: put",
    relationship: { kind: "edge", source: "A", target: "B", direction: "forward", text: "put" },
  },
];
const diagram = { language: "mermaid" as const, source: "flowchart LR\n A --> B", title: "Flow" };

suite("item lookup", () => {
  const page = (input = {}) =>
    collectItemPage((visit) => nodes.forEach(visit), { startItem: 1, maxItems: 50, ...input });

  test("filters literal labels and endpoints and pages through exact identities", () => {
    assert.deepStrictEqual(page({ query: ".*" }).items, [nodes[0]]);
    assert.strictEqual(page({ query: "cache" }).matchedItems, 0);
    const first = page({ query: "B", maxItems: 2 });
    assert.strictEqual(first.totalItems, 4);
    assert.strictEqual(first.matchedItems, 3);
    assert.deepStrictEqual(first.items, nodes.slice(1, 3));
    assert.strictEqual(first.nextItem, 3);
    const last = page({ query: "B", startItem: first.nextItem });
    assert.deepStrictEqual(last.items, [nodes[3]]);
    assert.strictEqual(last.nextItem, undefined);
  });

  test("bounds transport without shortening identifiers or skipping oversized items", async () => {
    const large = [
      { id: "Exact ".repeat(2000), label: "One" },
      { id: "Second ".repeat(2000), label: "Two" },
    ];
    const first = collectItemPage((visit) => large.forEach(visit), { startItem: 1, maxItems: 50 });
    assert.deepStrictEqual(first.items, [large[0]]);
    assert.strictEqual(first.nextItem, 2);
    assert.ok(JSON.stringify(first).length < 24_000);
    const huge = collectItemPage((visit) => visit({ id: "x".repeat(21_000), label: "Huge" }), {
      startItem: 1,
      maxItems: 50,
    });
    assert.deepStrictEqual(huge.items, []);
    assert.strictEqual(huge.nextItem, 1);
    assert.match(
      await itemPageText(huge, 7, async () => true),
      /Revision: 7.*Item 1 exceeds.*startItem:2/,
    );
  });

  test("shrinks whole JSON records to the token budget and preserves continuation", async () => {
    const complete = page();
    const one = await itemPageText(
      { ...complete, items: complete.items.slice(0, 1), nextItem: 2 },
      7,
      async () => true,
    );
    const text = await itemPageText(complete, 7, async (text) => text.length <= one.length);
    assert.strictEqual(text, one);
    assert.deepStrictEqual(JSON.parse(text).items, [nodes[0]]);
    assert.strictEqual(JSON.parse(text).nextItem, 2);
    assert.strictEqual(JSON.parse(text).revision, 7);
    const diagnostic = await itemPageText(complete, 7, async (text) => text.length <= 60);
    assert.ok(diagnostic.length <= 60);
    assert.doesNotMatch(diagnostic, /\{|Cache/);
  });

  test("returns empty matches and out-of-range pages with actionable metadata", async () => {
    const empty = JSON.parse(await itemPageText(page({ query: "absent" }), 1, async () => true));
    assert.strictEqual(empty.matchedItems, 0);
    assert.deepStrictEqual(empty.items, []);
    assert.strictEqual(empty.nextItem, undefined);
    assert.match(empty.note, /No matching/);
    const past = JSON.parse(await itemPageText(page({ startItem: 5 }), 1, async () => true));
    assert.match(past.note, /past the end.*1 through 4/);
    assert.strictEqual(past.nextItem, undefined);
  });

  async function shown() {
    const { panel, webview } = await newFakePanel();
    webview.answer = (message) => {
      if (message.type === "render")
        return { type: "rendered", requestId: message.requestId, diagramType: "flowchart" };
      if (message.type === "getItems")
        return {
          type: "items",
          requestId: message.requestId,
          page: collectItemPage((visit) => nodes.forEach(visit), message),
        };
      return undefined;
    };
    await panel.render(diagram, "tool");
    return { panel, webview, tool: new GetDiagramStateTool(panel) };
  }

  test("reads live items through the tool without returning diagram source", async () => {
    const { panel, tool } = await shown();
    const text = await invokeTool(tool, { detail: "items", query: "Store", maxItems: 1 });
    const result: ItemPage & { revision: number } = JSON.parse(text);
    assert.strictEqual(result.revision, panel.revision);
    assert.strictEqual(result.matchedItems, 3);
    assert.deepStrictEqual(result.items, [nodes[1]]);
    assert.strictEqual(result.nextItem, 2);
    assert.doesNotMatch(text, /flowchart/);
  });

  test("rejects conflicting modes and invalid limits before asking the panel", async () => {
    const { webview, tool } = await shown();
    for (const input of [
      { startItem: 1 },
      { detail: "summary", maxItems: 2 },
      ...[
        { startItem: 0 },
        { startItem: 1.5 },
        { maxItems: 101 },
        { maxItems: "5" },
        { query: "" },
        { query: "a\nb" },
        { startLine: 1 },
        { startMatch: 1 },
        { maxMatches: 1 },
        { contextLines: 0 },
      ].map((input) => ({ detail: "items", ...input })),
    ]) {
      assert.match(
        await invokeTool(tool, input),
        /^The diagram was not read:/,
        JSON.stringify(input),
      );
    }
    assert.ok(webview.sent.every((message) => message.type !== "getItems"));
  });

  test("keeps the captured revision when token counting yields to another drawing", async () => {
    const { panel, tool } = await shown();
    const revision = panel.revision;
    let changed = false;
    const result = await invokeTool(tool, { detail: "items" }, undefined, {
      tokenBudget: 1000,
      countTokens: async (text) => {
        if (!changed) {
          changed = true;
          await panel.render({ ...diagram, source: "flowchart LR; C --> D" }, "tool");
        }
        return text.length;
      },
    });
    assert.ok(changed);
    assert.strictEqual(JSON.parse(result).revision, revision);
    assert.deepStrictEqual(JSON.parse(result).items, nodes);
    assert.notStrictEqual(panel.revision, revision);
  });

  test("reopens a closed panel without changing the revision", async () => {
    const { panel, webview, tool } = await shown();
    const revision = panel.revision;
    webview.panel.dispose();
    const reopened = new FakeWebview();
    reopened.answer = webview.answer;
    replace(vscode.window, "createWebviewPanel", () => {
      queueMicrotask(() => void reopened.receive({ type: "ready" }));
      return reopened.panel;
    });
    const text = await invokeTool(tool, { detail: "items" });
    assert.strictEqual(JSON.parse(text).revision, revision);
    assert.deepStrictEqual(JSON.parse(text).items, nodes);
  });

  test("ends pending reads when the panel closes, reloads or changes", async () => {
    for (const action of ["close", "reload", "change"] as const) {
      const { panel, webview, tool } = await shown();
      const answer = webview.answer;
      let requested!: () => void;
      const request = new Promise<void>((resolve) => {
        requested = resolve;
      });
      webview.answer = (message) => {
        if (message.type === "getItems") {
          requested();
          return undefined;
        }
        return answer?.(message);
      };
      const reading = invokeTool(tool, { detail: "items" });
      await request;
      if (action === "close") webview.panel.dispose();
      else if (action === "reload") await webview.receive({ type: "ready" });
      else await panel.render({ ...diagram, title: "New" }, "tool");
      assert.match(await reading, /changed|closed/);
    }
  });

  test("reports delivery failures and propagates cancellation", async () => {
    const { webview, tool } = await shown();
    webview.deliver = (message) => message.type !== "getItems";
    assert.match(await invokeTool(tool, { detail: "items" }), /unavailable/i);
    webview.deliver = () => true;
    const cancel = cancellationSource();
    webview.answer = (message) => {
      if (message.type === "getItems") cancel.cancel();
      return undefined;
    };
    await assert.rejects(
      invokeTool(tool, { detail: "items" }, cancel.token),
      vscode.CancellationError,
    );
  });
});
