import * as assert from "node:assert";
import * as vscode from "vscode";

async function invoke(
  name: string,
  input: object,
  token?: vscode.CancellationToken,
): Promise<string> {
  const result = await vscode.lm.invokeTool(name, { input, toolInvocationToken: undefined }, token);
  return result.content
    .map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : ""))
    .join("");
}

suite("Extension", () => {
  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension("fornwall.diagram");
    assert.ok(extension);
    await extension.activate();
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("registers the language model tools", () => {
    const names = vscode.lm.tools.map((tool) => tool.name);
    assert.ok(names.includes("diagram_render"), names.join(", "));
    assert.ok(names.includes("diagram_getState"), names.join(", "));
    assert.ok(names.includes("diagram_pickNodes"), names.join(", "));
  });

  test("renders a valid diagram", async () => {
    const text = await invoke("diagram_render", {
      source: "flowchart TD\n  A[Start] --> B{Valid?}\n  B -->|yes| C[Done]",
      title: "Test flow",
    });
    assert.match(text, /Rendered the flowchart/);

    const state = await invoke("diagram_getState", {});
    assert.match(state, /"Test flow"/);
    assert.match(state, /A\[Start\] --> B\{Valid\?\}/);
    assert.doesNotMatch(state, /fails to render/);
  });

  test("reports syntax errors back to the agent", async () => {
    const text = await invoke("diagram_render", { source: "flowchart TD\n  A --> --> B[" });
    assert.match(text, /failed to render/);

    const state = await invoke("diagram_getState", {});
    assert.match(state, /fails to render/);
  });

  test("renders a diagram in click-to-ask mode", async () => {
    const text = await invoke("diagram_render", {
      source: "flowchart LR\n  A[Parser] --> B[Checker]",
      clickPrompt: "Explain {label} in more detail",
    });
    assert.match(text, /Clicking a node sends your click prompt/);
  });

  test("a new pick replaces a waiting one, and cancelling ends a pick", async () => {
    await invoke("diagram_render", { source: "flowchart LR\n  A[Parser] --> B[Checker]" });

    const first = invoke("diagram_pickNodes", { prompt: "Which part?" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const cancellation = new vscode.CancellationTokenSource();
    const second = invoke("diagram_pickNodes", { prompt: "Which other part?" }, cancellation.token);
    assert.match(
      await first,
      /No node was picked: Another request to pick nodes replaced this one/,
    );

    await new Promise((resolve) => setTimeout(resolve, 300));
    cancellation.cancel();
    // VS Code may either return the tool's result or reject with a cancellation error.
    const outcome = await second.catch((error: unknown) => `rejected: ${error}`);
    assert.match(outcome, /cancel/i);
  });
});
