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
    const declared: { name: string }[] =
      vscode.extensions.getExtension("fornwall.diagram")?.packageJSON.contributes
        .languageModelTools;
    const registered = vscode.lm.tools.filter((tool) => tool.name.startsWith("diagram_"));
    assert.deepStrictEqual(
      registered.map((tool) => tool.name).sort(),
      declared.map((tool) => tool.name).sort(),
    );
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

  test("renders a source wrapped in a code fence", async () => {
    const option = { series: [{ type: "bar", data: [1, 2] }], xAxis: {}, yAxis: {} };
    const text = await invoke("diagram_render", {
      source: `\`\`\`echarts\n${JSON.stringify(option)}\n\`\`\`\n`,
    });
    assert.match(text, /Rendered the bar chart/);
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
    assert.match(state, /no chart items selected/);
    assert.doesNotMatch(state, /fails to render/);
  });

  test("reports an unparsable ECharts option back to the agent", async () => {
    const text = await invoke("diagram_render", {
      // Unclosed, and so neither JSON nor a JavaScript object literal; a trailing comma would be
      // a syntax error only in JSON, which an option is no longer limited to.
      source: '{"series": [{"type": "bar"}',
      language: "echarts",
    });
    assert.match(text, /failed to render/);
    assert.match(text, /could not be parsed/);
  });

  test("charts inline data", async () => {
    const text = await invoke("diagram_chart", {
      type: "bar",
      title: "Sales",
      data: "region,sales\nNorth,10\nSouth,20\nEast,5",
    });
    assert.match(
      text,
      /^Rendered the bar chart of inline data .*\. Charted "sales" by "region"\.\n\nThe data was read as: 3 rows;/,
    );

    const state = await invoke("diagram_getState", {});
    assert.match(state, /"Sales"/);
    assert.match(state, /North/);
    assert.doesNotMatch(state, /Refresh/);
  });

  test("charts the data in a workspace file, which can be refreshed", async () => {
    // The test workspace is src/test/workspace.
    const text = await invoke("diagram_chart", { type: "pie", file: "sizes.tsv" });
    assert.match(text, /Rendered the pie chart of file/);
    const state = await invoke("diagram_getState", {});
    assert.match(state, /"Pie chart of sizes\.tsv"/);
    assert.match(state, /Refresh/);
  });

  test("reports chart input errors back to the agent", async () => {
    const text = await invoke("diagram_chart", { type: "pie", data: "a,1", file: "x.csv" });
    assert.match(text, /No chart was rendered/);
    assert.match(
      await invoke("diagram_chart", { type: "bar", data: "a b\nc d" }),
      /^No chart was rendered: No column holds numbers.*\n\nThe data was read as: 2 rows; columns: "Column 1" \(text\)/,
    );
  });

  test("marks the diagram already shown, and clears the marks again", async () => {
    assert.match(
      await invoke("diagram_render", {
        source: "flowchart LR\n  parse[Parser] --> check[Checker]",
        title: "Pipeline",
      }),
      /Rendered the flowchart/,
    );
    const marked = await invoke("diagram_annotate", {
      marks: [
        { id: "parse", mark: "current", note: "we are here" },
        { id: "Checker", mark: "problem" },
      ],
      caption: "Step 1 of 2",
      dim: true,
    });
    assert.match(marked, /^Marked 1 node on the diagram already shown in the panel/);
    assert.match(marked, /parse \(current\)\./);
    assert.match(marked, /The caption above it reads "Step 1 of 2"\./);
    // The label of a node is not its id, so there is nothing to mark for it.
    assert.match(
      marked,
      /These ids are not nodes of the diagram.*"Checker"\. Its ids are "parse", "check"\./,
    );

    // The marks belong to the state a later request sees, and the diagram is still the one drawn.
    const state = await invoke("diagram_getState", {});
    assert.match(state, /Marked nodes: parse \(current: we are here\)\./);
    assert.match(state, /flowchart LR/);

    assert.match(await invoke("diagram_annotate", {}), /^Cleared the marks on the diagram/);
    assert.doesNotMatch(await invoke("diagram_getState", {}), /marked/);
  });

  test("reports malformed input back to the agent", async () => {
    assert.match(
      await invoke("diagram_render", {}),
      /Nothing was rendered: Give "source", the complete diagram/,
    );
    assert.match(
      await invoke("diagram_render", { source: "A", language: "dot" }),
      /Unknown language "dot"/,
    );
    assert.match(
      await invoke("diagram_pickNodes", {}),
      /No node was picked: Give "prompt", the question/,
    );
    assert.match(
      await invoke("diagram_annotate", { marks: [{ id: "a", mark: "red" }] }),
      /Nothing was marked: Invalid marks:\n- Mark 1: "mark" must be one of/,
    );
  });
});
