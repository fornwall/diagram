import * as assert from "node:assert";
import * as vscode from "vscode";
import { ChartTool, InspectDataTool, UpdateChartTool } from "../chartTools";
import { DraftTool } from "../draftTool";
import { invokeTool, toolText } from "./toolText";
import { suitePage } from "./webviewHarness";

suite("drafts in the webview", function () {
  this.timeout(25_000);
  const page = suitePage();

  test("renders a Mermaid draft and image without disturbing the drawing, selection or source draft", async () => {
    await page.draw({ source: "flowchart LR\n A[Original] --> B", title: "Original title" });
    const before = page.panel.current;
    const revision = page.panel.revision;
    await page.evaluate(`(() => {
      window.beforeDraftSvg = document.querySelector("#diagram svg");
      document.querySelector('.diagram-node[data-diagram-id="A"]').dispatchEvent(new MouseEvent("click", {bubbles:true}));
      document.getElementById("view-split").click();
      const input = document.getElementById("source");
      input.value = "flowchart LR\\n A --> UserDraft";
      input.dispatchEvent(new Event("input"));
    })()`);
    try {
      const result = await new DraftTool(page.panel).invoke(
        {
          input: {
            action: "validate",
            source: "flowchart LR\n X[Draft] --> Y",
            revision,
            image: true,
            preserveNodes: ["X"],
            preservePaths: [{ source: "X", target: "Y" }],
          },
          toolInvocationToken: undefined,
        },
        new vscode.CancellationTokenSource().token,
      );
      const report = JSON.parse(toolText(result));
      assert.strictEqual(report.valid, true);
      assert.strictEqual(report.constraintsChecked, 2);
      const image = result.content.find((part) => part instanceof vscode.LanguageModelDataPart);
      assert.ok(image instanceof vscode.LanguageModelDataPart, toolText(result));
      assert.strictEqual(image.mimeType, "image/png");
      assert.deepStrictEqual([...image.data.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.strictEqual(page.panel.current, before);
      assert.strictEqual(page.panel.revision, revision);
      assert.deepStrictEqual(
        await page.evaluate(
          `({same: window.beforeDraftSvg === document.querySelector("#diagram svg"), title: document.getElementById("title").textContent, source: document.getElementById("source").value, selected: document.querySelector('.diagram-node[data-diagram-id="A"]').classList.contains("diagram-selected")})`,
        ),
        {
          same: true,
          title: "Original title",
          source: "flowchart LR\n A --> UserDraft",
          selected: true,
        },
      );
    } finally {
      await page.evaluate(
        '(() => { document.getElementById("revert").click(); document.getElementById("view-visual").click(); })()',
      );
    }
  });

  test("invalid Mermaid and failed path constraints leave the original source visible", async () => {
    const source = "flowchart LR\n A --> B";
    await page.draw({ source });
    const revision = page.panel.revision;
    const tool = new DraftTool(page.panel);
    assert.match(
      await invokeTool(tool, { action: "validate", source: "flowchart LR\n A[Unclosed", revision }),
      /Draft operation failed/,
    );
    const missing = JSON.parse(
      await invokeTool(tool, {
        action: "validate",
        source: "flowchart LR\n A --> C",
        revision,
        preserveNodes: ["B"],
        preservePaths: [{ source: "A", target: "B" }],
      }),
    );
    assert.strictEqual(missing.valid, false);
    assert.strictEqual(missing.violations.length, 2);
    assert.strictEqual(page.panel.current?.source, source);
    assert.strictEqual(page.panel.revision, revision);
    assert.strictEqual(
      await page.evaluate('document.querySelector("#diagram svg") !== null'),
      true,
    );
  });

  test("safe ECharts drafts reuse isolated canvases without duplicate document ids", async () => {
    await page.draw({ language: "echarts", source: '{"series":[{"type":"pie","data":[1,2]}]}' });
    const before = page.panel.current;
    await page.evaluate('void (window.beforeDraftChart = document.querySelector("#chart svg"))');
    const tool = new DraftTool(page.panel);
    for (const values of [
      [3, 4],
      [5, 6],
    ]) {
      const report = JSON.parse(
        await invokeTool(tool, {
          action: "validate",
          language: "echarts",
          source: JSON.stringify({
            xAxis: { type: "category", data: ["a", "b"] },
            yAxis: {},
            series: [{ type: "bar", data: values }],
          }),
          revision: page.panel.revision,
          image: true,
        }),
      );
      assert.strictEqual(report.valid, true);
    }
    assert.strictEqual(page.panel.current, before);
    assert.deepStrictEqual(
      await page.evaluate(
        `({same: window.beforeDraftChart === document.querySelector("#chart svg"), counts: ["chart", "chart-drawing", "chart-focus", "chart-status"].map(id => document.querySelectorAll("#" + id).length)})`,
      ),
      { same: true, counts: [1, 1, 1, 1] },
    );
    assert.match(
      await invokeTool(tool, {
        action: "validate",
        source: '{series:[{type:"pie",data:[1],label:{formatter:()=>"executed"}}]}',
        revision: page.panel.revision,
      }),
      /without executable JavaScript/,
    );
  });

  test("applying validated chart styling preserves its data and controls", async () => {
    const data = "name,value\na,1\nb,2";
    assert.match(
      await invokeTool(new ChartTool(page.panel), {
        type: "bar",
        data,
        revision: page.panel.revision,
      }),
      /Rendered/,
    );
    const table = page.panel.loadedChartData;
    const before = page.panel.current?.chart;
    const option = JSON.parse(page.panel.current?.source ?? "");
    option.series[0].itemStyle = { color: "#123456" };
    const tool = new DraftTool(page.panel);
    const report = JSON.parse(
      await invokeTool(tool, {
        action: "validate",
        source: JSON.stringify(option),
        revision: page.panel.revision,
      }),
    );
    assert.strictEqual(report.valid, true);
    const applied = await invokeTool(tool, {
      action: "apply",
      id: report.id,
      revision: page.panel.revision,
    });
    assert.doesNotMatch(applied, /failed|Nothing was changed/);
    assert.deepStrictEqual(page.panel.current?.chart, before);
    assert.strictEqual(page.panel.loadedChartData, table);
    assert.match(
      await invokeTool(new UpdateChartTool(page.panel), {
        type: "line",
        revision: page.panel.revision,
      }),
      /Updated/,
    );
    assert.strictEqual(
      JSON.parse(page.panel.current?.source ?? "").series[0].itemStyle.color,
      "#123456",
    );
    assert.match(
      await invokeTool(new InspectDataTool(page.panel), { summary: true }),
      /"rowCount":2/,
    );
  });
});
