import * as assert from "node:assert";
import * as vscode from "vscode";
import { clickToAskQuery, type Diagram, DiagramPanel } from "../panel";

const flowchart: Diagram = {
  language: "mermaid",
  source: "flowchart LR\n  A[Parser] --> B[Checker]",
  title: "Flow",
};

/** A panel of its own, with state that is not saved. */
function newPanel(): DiagramPanel {
  const extension = vscode.extensions.getExtension("fornwall.diagram");
  assert.ok(extension);
  const values = new Map<string, unknown>();
  const workspaceState: vscode.Memento = {
    keys: () => [...values.keys()],
    get: <T>(key: string, defaultValue?: T) => (values.get(key) as T | undefined) ?? defaultValue,
    update: async (key, value) => void values.set(key, value),
  };
  const context = { extensionUri: extension.extensionUri, workspaceState };
  return new DiagramPanel(context as unknown as vscode.ExtensionContext);
}

function pick(panel: DiagramPanel, token = new vscode.CancellationTokenSource().token) {
  return panel.pickNodes("Which part?", false, token);
}

suite("panel", () => {
  test("clickToAskQuery replaces {label}", () => {
    assert.strictEqual(
      clickToAskQuery("Explain {label}, and how {label} is tested", "Parser"),
      "Explain Parser, and how Parser is tested",
    );
  });

  test("clickToAskQuery appends the label when there is no placeholder", () => {
    assert.strictEqual(
      clickToAskQuery("Tell me more about", "Parser"),
      'Tell me more about "Parser"',
    );
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
    } finally {
      panel.dispose();
    }
  });
});
