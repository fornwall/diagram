import * as assert from "node:assert";
import * as vscode from "vscode";
import { DraftTool, draftConstraints } from "../draftTool";
import type { DiagramPanel } from "../panel";
import type { DiagramNode } from "../protocol";
import { cancellationSource } from "./afterTest";
import { newFakePanel } from "./newPanel";
import { invokeTool } from "./toolText";

const source = "flowchart LR\n A --> B";
const items: DiagramNode[] = [
  { id: "A", label: "A" },
  { id: "B", label: "B" },
  {
    id: "edge:A:B",
    label: "A to B",
    relationship: { kind: "edge", source: "A", target: "B", direction: "forward" },
  },
];

suite("draftTool", () => {
  test("checks exact node ids and directed reachability", () => {
    assert.deepStrictEqual(
      draftConstraints(
        { preserveNodes: ["A"], preservePaths: [{ source: "A", target: "B" }] },
        items,
      ),
      [],
    );
    assert.deepStrictEqual(
      draftConstraints(
        { preserveNodes: ["C"], preservePaths: [{ source: "B", target: "A" }] },
        items,
      ),
      ['Missing node "C".', 'No directed path from "B" to "A".'],
    );
  });

  test("validates and discards without changing the current diagram", async () => {
    const { panel, webview } = await newFakePanel();
    await panel.render({ language: "mermaid", title: "Original", source }, "tool");
    const answer = webview.answer;
    webview.answer = (message) =>
      message.type === "validateDraft"
        ? { type: "draftResult", requestId: message.requestId, diagramType: "flowchart-v2", items }
        : answer?.(message);
    const before = panel.current;
    const revision = panel.revision;
    const tool = new DraftTool(panel);
    const result = JSON.parse(await invokeTool(tool, { action: "validate", source, revision }));
    assert.strictEqual(result.valid, true);
    assert.strictEqual(panel.current, before);
    assert.strictEqual(panel.revision, revision);
    assert.match(
      await invokeTool(tool, { action: "discard", id: result.id, revision }),
      /Discarded draft/,
    );
    assert.match(
      await invokeTool(tool, { action: "apply", id: result.id, revision }),
      /Unknown or expired/,
    );
  });

  test("rejects stale application after the user changes the source", async () => {
    const { panel, webview } = await newFakePanel();
    await panel.render({ language: "mermaid", title: "Original", source }, "tool");
    const answer = webview.answer;
    webview.answer = (message) =>
      message.type === "validateDraft"
        ? { type: "draftResult", requestId: message.requestId, diagramType: "flowchart-v2", items }
        : answer?.(message);
    const tool = new DraftTool(panel);
    const result = JSON.parse(
      await invokeTool(tool, {
        action: "validate",
        source: "flowchart LR\n A --> C",
        revision: panel.revision,
      }),
    );
    await webview.edit("flowchart LR\n User --> Edit");
    assert.match(
      await invokeTool(tool, { action: "apply", id: result.id, revision: panel.revision }),
      /changed since validation/,
    );
    assert.strictEqual(panel.current?.source, "flowchart LR\n User --> Edit");
  });

  test("returns failed constraints without creating an applicable draft", async () => {
    const panel = {
      revision: 1,
      validateDraft: async () => ({ diagramType: "flowchart-v2", items }),
    } as unknown as DiagramPanel;
    const result = JSON.parse(
      await invokeTool(new DraftTool(panel), {
        action: "validate",
        source,
        revision: 1,
        preserveNodes: ["C"],
      }),
    );
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.id, undefined);
    assert.deepStrictEqual(result.violations, ['Missing node "C".']);
  });

  test("bounds successful reports and checks cancellation while counting tokens", async () => {
    const panel = {
      revision: 0,
      validateDraft: async () => ({
        diagramType: "flowchart-v2",
        items,
        warnings: ["a".repeat(30_000)],
      }),
    } as unknown as DiagramPanel;
    assert.match(
      await invokeTool(new DraftTool(panel), { action: "validate", source }),
      /exceeds the result budget/,
    );
    const small = {
      revision: 0,
      validateDraft: async () => ({ diagramType: "flowchart-v2", items }),
    } as unknown as DiagramPanel;
    const cancelled = cancellationSource();
    await assert.rejects(
      invokeTool(new DraftTool(small), { action: "validate", source }, cancelled.token, {
        tokenBudget: 100_000,
        countTokens: async () => {
          cancelled.cancel();
          return 1;
        },
      }),
      vscode.CancellationError,
    );
  });

  test("bounds failed constraint reports instead of returning truncated JSON", async () => {
    const panel = {
      revision: 0,
      validateDraft: async () => ({ diagramType: "flowchart-v2", items: [] }),
    } as unknown as DiagramPanel;
    const result = await invokeTool(
      new DraftTool(panel),
      {
        action: "validate",
        source,
        preserveNodes: Array.from({ length: 100 }, (_, index) => `${index}${"a".repeat(990)}`),
      },
      undefined,
      { tokenBudget: 300, countTokens: async (text) => text.length },
    );
    assert.ok(result.length <= 300);
    assert.match(result, /budget/);
  });
});
