// What the panel lets JavaScript code in a chart option do: it runs in the page, so any message
// the page sends may be the code's rather than the user's.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ChartSpec } from "../chartSpec";
import { buildChart } from "../charts";
import { parseTable } from "../data";
import { findDiagramFences } from "../fences";
import type { DiagramPanel } from "../panel";
import { runsCode } from "../webview/optionSource";
import { afterTest, recordMessages, replace, suiteTempDir } from "./afterTest";
import { type FakeWebview, newFakePanel, recordChat } from "./newPanel";

const flowchart = "flowchart LR\n  A[Parser] --> B[Checker]";
const codeChart = '{series: [{type: "pie", data: [1]}], tooltip: {formatter: (item) => item.name}}';

function renderChart(panel: DiagramPanel, source: string) {
  return panel.render({ language: "echarts", source, title: "Chart" }, "tool");
}

suite("chart code in the panel", function () {
  this.timeout(10_000);

  const dir = suiteTempDir("diagram-chart-code-");

  test("tells options that run code from literals", () => {
    assert.ok(!runsCode('{"series": [{"type": "pie", "data": [1]}]}'));
    assert.ok(!runsCode("// Sizes\n{series: [{type: 'pie', data: [1,],}],}"));
    assert.ok(runsCode(codeChart));
    assert.ok(runsCode("{series: [{type: 'pie', data: [1].map(Math.sqrt)}]}"));
    // What fails to read as literals may still evaluate.
    assert.ok(runsCode("{series: [{type: 'pie', data: [1]"));
  });

  test("leaves chat requests for the user to send once the page ran chart code", async () => {
    const chat = recordChat();
    const requests = () =>
      chat.requests.map(
        ({ query, isPartialQuery }) => `${isPartialQuery ? "fill" : "send"}: ${query}`,
      );
    const { panel, webview } = await newFakePanel();
    const click = () =>
      webview.receive({
        type: "clickToAsk",
        requestId: webview.render.requestId,
        node: { id: "A", label: "Parser" },
      });
    const ask = () => webview.ask("Why?");
    const clickPrompt = "Explain {label}";
    const drawFlowchart = async (on: DiagramPanel) =>
      assert.ok(
        (
          await on.render(
            { language: "mermaid", source: flowchart, title: "Flow", clickPrompt },
            "tool",
          )
        ).ok,
      );
    await drawFlowchart(panel);
    await click();
    // A chart of literals runs no code, even when written as a JavaScript object literal.
    assert.ok((await renderChart(panel, "{series: [{type: 'pie', data: [1]}]}")).ok);
    await ask();
    assert.ok((await renderChart(panel, codeChart)).ok);
    await ask();
    // The code stays in the page for the diagrams that follow.
    await drawFlowchart(panel);
    await click();
    await webview.receive({ type: "ready" });
    await ask();
    assert.deepStrictEqual(requests(), [
      "send: Explain Parser",
      "send: Regarding the chart: Why?",
      "fill: Regarding the chart: Why?",
      "fill: Explain Parser",
      "fill: Regarding the diagram: Why?",
    ]);
    panel.dispose();

    // A new panel's page holds no code.
    const fresh = await newFakePanel();
    await drawFlowchart(fresh.panel);
    await fresh.webview.ask("Why?");
    assert.strictEqual(requests().at(-1), "send: Regarding the diagram: Why?");
  });

  test("knows that the page ran chart code that was trusted while it waited to render", async () => {
    const trust = Object.getOwnPropertyDescriptor(vscode.workspace, "isTrusted");
    assert.ok(trust);
    const chat = recordChat();
    const { panel, webview } = await newFakePanel();
    Object.defineProperty(vscode.workspace, "isTrusted", { get: () => false, configurable: true });
    afterTest(() => Object.defineProperty(vscode.workspace, "isTrusted", trust));
    const answer = webview.answer;
    webview.answer = undefined;
    const rendering = renderChart(panel, codeChart);
    // Granting trust reloads the page, which then renders the chart with its code.
    Object.defineProperty(vscode.workspace, "isTrusted", trust);
    webview.answer = answer;
    await webview.receive({ type: "ready" });
    assert.ok((await rendering).ok);
    await webview.ask("Why?");
    assert.deepStrictEqual(
      chat.requests.map((request) => request.isPartialQuery),
      [true],
    );
  });

  test("reads an option for code only until the page ran some", async () => {
    const { panel } = await newFakePanel();
    const literals = JSON.stringify({ series: [{ type: "pie", data: [1] }] });
    const parse = JSON.parse;
    let read = 0;
    replace(JSON, "parse", (text: string, ...rest) => {
      if (text === literals) read++;
      return parse(text, ...rest);
    });
    assert.ok((await renderChart(panel, literals)).ok);
    assert.strictEqual(read, 1);
    assert.ok((await renderChart(panel, codeChart)).ok);
    assert.ok((await renderChart(panel, literals)).ok);
    assert.strictEqual(read, 1);
  });

  test("asks before writing to a document once the page ran chart code", async () => {
    const file = path.join(dir, "notes.md");
    fs.writeFileSync(file, "```mermaid\nflowchart TD\n```\n");
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const [fence] = findDiagramFences(document.getText());
    assert.ok(fence);
    const { panel, webview } = await newFakePanel();
    const open = () =>
      panel.render(
        {
          language: "mermaid",
          source: fence.source,
          title: "Flow",
          document: { uri: document.uri.toString(), fence },
        },
        "document",
      );
    let answer: string | undefined = "Write";
    const warnings = recordMessages("showWarningMessage", () => answer);
    assert.ok((await renderChart(panel, codeChart)).ok);
    assert.ok((await open()).ok);
    await webview.edit(flowchart);
    assert.strictEqual(document.getText(), `\`\`\`mermaid\n${flowchart}\n\`\`\`\n`);
    assert.deepStrictEqual(warnings, ["Write this diagram to notes.md?"]);

    answer = undefined;
    await webview.edit("flowchart TD");
    assert.strictEqual(document.getText(), `\`\`\`mermaid\n${flowchart}\n\`\`\`\n`);
    assert.deepStrictEqual(warnings, [
      "Write this diagram to notes.md?",
      "Write this diagram to notes.md?",
    ]);
  });

  test("asks before rerunning a chart's command once the page ran chart code", async () => {
    const marker = path.join(dir, "ran");
    const chart: ChartSpec = {
      type: "bar",
      command: `echo >> ${JSON.stringify(marker)}; printf 'name,amount\\na,1\\n'`,
    };
    const table = parseTable("name,amount\na,1");
    const source = JSON.stringify(buildChart(chart, table).option);
    const { panel, webview } = await newFakePanel();
    const refresh = async (webview: FakeWebview) => {
      await webview.receive({ type: "refresh" });
      return fs.existsSync(marker);
    };
    let answer: string | undefined = "Run";
    const warnings = recordMessages("showWarningMessage", () => answer);
    assert.ok((await renderChart(panel, codeChart)).ok);
    const drawn = await panel.render(
      { language: "echarts", source, title: "Sizes", chart },
      "tool",
      table,
    );
    assert.ok(drawn.ok);
    assert.ok(await refresh(webview), "the confirmed command did not run");
    assert.deepStrictEqual(warnings, ["Run the chart's command again to reload its data?"]);

    fs.rmSync(marker);
    answer = undefined;
    assert.ok(!(await refresh(webview)), "the declined command ran");
    assert.strictEqual(warnings.length, 2);
  });

  test("does not rerun a chart's command confirmed after the panel closed", async () => {
    const marker = path.join(dir, "ran after close");
    const chart: ChartSpec = {
      type: "bar",
      command: `echo >> ${JSON.stringify(marker)}; printf 'name,amount\\na,1\\n'`,
    };
    const table = parseTable("name,amount\na,1");
    const source = JSON.stringify(buildChart(chart, table).option);
    const { panel, webview } = await newFakePanel();
    assert.ok((await renderChart(panel, codeChart)).ok);
    const diagram = { language: "echarts", source, title: "Sizes", chart } as const;
    assert.ok((await panel.render(diagram, "tool", table)).ok);
    const asked = recordMessages("showWarningMessage", () => {
      webview.panel.dispose();
      return "Run";
    });
    await webview.receive({ type: "refresh" });
    assert.deepStrictEqual(asked, ["Run the chart's command again to reload its data?"]);
    assert.ok(!fs.existsSync(marker), "the command ran");
  });

  test("asks before opening a link once the page ran chart code", async () => {
    const { panel, webview } = await newFakePanel();
    const details: string[] = [];
    const opened: string[] = [];
    let answer: string | undefined = "Open";
    const questions = recordMessages("showWarningMessage", (_, options) => {
      details.push((options as vscode.MessageOptions).detail ?? "");
      return answer;
    });
    replace(vscode.env, "openExternal", async (uri) => {
      opened.push(uri.toString(true));
      return true;
    });
    // VS Code shortens a long URL when it asks, which the panel names in full.
    const url = `https://example.com/collect?data=${"x".repeat(200)}`;
    const open = () =>
      webview.receive({ type: "openUrl", requestId: webview.render.requestId, url });
    // A link in the HTML of the chart's tooltip, and one that a diagram drew after it.
    assert.ok((await renderChart(panel, codeChart)).ok);
    await open();
    assert.ok(
      (await panel.render({ language: "mermaid", source: flowchart, title: "Flow" }, "tool")).ok,
    );
    await open();
    answer = undefined;
    await open();
    await open();
    assert.deepStrictEqual(opened, [url, url]);
    assert.deepStrictEqual(questions, [
      "Open the link that you clicked in the chart?",
      "Open the link that you clicked in the diagram?",
      "Open the link that you clicked in the diagram?",
    ]);
    assert.ok(details[0]?.startsWith(`${url}\n`));
  });

  test("asks one question at a time, and no more once the user declines one", async () => {
    const file = path.join(dir, "spammed.md");
    fs.writeFileSync(file, "```mermaid\nflowchart TD\n```\n");
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const [fence] = findDiagramFences(document.getText());
    assert.ok(fence);
    const { panel, webview } = await newFakePanel();
    // The user takes a while to answer, while the page asks again.
    const questions = recordMessages(
      "showWarningMessage",
      () => new Promise((resolve) => setTimeout(resolve, 10)),
    );
    const write = () =>
      webview.receive({ type: "writeToDocument", requestId: webview.render.requestId });
    assert.ok((await renderChart(panel, codeChart)).ok);
    const opened = await panel.render(
      {
        language: "mermaid",
        source: flowchart,
        title: "Flow",
        document: { uri: document.uri.toString(), fence },
      },
      "document",
    );
    assert.ok(opened.ok);
    await Promise.all([write(), write(), write()]);
    assert.strictEqual(questions.length, 1);
    await write();
    assert.strictEqual(questions.length, 1);
    assert.strictEqual(document.getText(), "```mermaid\nflowchart TD\n```\n");
  });
});
