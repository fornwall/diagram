import * as assert from "node:assert";
import * as vscode from "vscode";
import { loadTable } from "../dataSource";

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

  test("loads chart data from a command's output", async function () {
    if (process.platform === "win32") {
      this.skip();
    }
    const token = new vscode.CancellationTokenSource().token;
    const { table, origin } = await loadTable(
      { type: "pie", command: "printf 'apples 3\\npears 5\\n'" },
      token,
    );
    assert.match(origin, /printf/);
    assert.deepStrictEqual(table.rows, [
      ["apples", 3],
      ["pears", 5],
    ]);
    await assert.rejects(loadTable({ type: "pie", command: "exit 3" }, token), /3/);
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
