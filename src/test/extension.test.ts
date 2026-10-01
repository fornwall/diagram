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
    assert.ok(names.includes("diagram_chart"), names.join(", "));
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

    const pick = await invoke("diagram_pickNodes", { prompt: "Which part?" });
    assert.match(pick, /No node was picked: The diagram fails to render/);
  });

  test("renders an ECharts option", async () => {
    const option = {
      title: { text: "Languages" },
      series: [
        {
          type: "pie",
          data: [
            { name: "TypeScript", value: 3 },
            { name: "CSS", value: 1 },
          ],
        },
      ],
    };
    const text = await invoke("diagram_render", {
      source: JSON.stringify(option),
      language: "echarts",
    });
    assert.match(text, /Rendered the pie chart/);

    const state = await invoke("diagram_getState", {});
    assert.match(state, /"Languages"/);
    assert.match(state, /```echarts/);
    assert.doesNotMatch(state, /fails to render/);
  });

  test("reports invalid ECharts JSON back to the agent", async () => {
    const text = await invoke("diagram_render", {
      source: '{"series": [{"type": "bar", }]}',
      language: "echarts",
    });
    assert.match(text, /failed to render/);
    assert.match(text, /valid JSON/);
  });

  test("charts inline data", async () => {
    const text = await invoke("diagram_chart", {
      type: "bar",
      title: "Sales",
      data: "region,sales\nNorth,10\nSouth,20\nEast,5",
    });
    assert.match(text, /Rendered a bar chart of inline data/);
    assert.match(text, /3 rows/);

    const state = await invoke("diagram_getState", {});
    assert.match(state, /"Sales"/);
    assert.match(state, /North/);
    assert.doesNotMatch(state, /Refresh/);
  });

  test("charts the data in a workspace file, which can be refreshed", async () => {
    // The test workspace is src/test/workspace.
    const text = await invoke("diagram_chart", { type: "pie", file: "sizes.tsv" });
    assert.match(text, /Rendered a pie chart of file/);
    const state = await invoke("diagram_getState", {});
    assert.match(state, /"Pie chart of sizes\.tsv"/);
    assert.match(state, /Refresh/);
  });

  test("reports chart input errors back to the agent", async () => {
    const text = await invoke("diagram_chart", { type: "pie", data: "a,1", file: "x.csv" });
    assert.match(text, /No chart was drawn/);
  });

  test("renders a diagram in click-to-ask mode", async () => {
    const text = await invoke("diagram_render", {
      source: "flowchart LR\n  A[Parser] --> B[Checker]",
      clickPrompt: "Explain {label} in more detail",
    });
    assert.match(text, /Rendered the flowchart/);
  });

  test("reports malformed input back to the agent", async () => {
    assert.match(await invoke("diagram_render", {}), /"source" must be the complete diagram/);
    assert.match(
      await invoke("diagram_render", { source: "A", language: "dot" }),
      /Unknown language "dot"/,
    );
    assert.match(await invoke("diagram_pickNodes", {}), /"prompt" must be the question/);
  });
});
