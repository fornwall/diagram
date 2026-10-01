import * as assert from "node:assert";
import * as vscode from "vscode";

async function invoke(name: string, input: object): Promise<string> {
  const result = await vscode.lm.invokeTool(name, { input, toolInvocationToken: undefined });
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
});
