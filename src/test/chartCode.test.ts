// What the panel lets JavaScript code in a chart option do: it runs in the page, so any message
// the page sends may be the code's rather than the user's.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ChartSpec } from "../chartSpec";
import { buildChart } from "../charts";
import { parseTable } from "../data";
import { findDiagramFences } from "../fences";
import type { DiagramPanel } from "../panel";
import { runsCode } from "../webview/optionSource";
import { type FakeWebview, newFakePanel } from "./newPanel";

const flowchart = "flowchart LR\n  A[Parser] --> B[Checker]";
const codeChart = '{series: [{type: "pie", data: [1]}], tooltip: {formatter: (item) => item.name}}';

function renderChart(panel: DiagramPanel, source: string) {
  return panel.render({ language: "echarts", source, title: "Chart" }, "tool");
}

/** Records modal warnings, answering each with the given button. */
function answerWarnings(button?: string): { warnings: string[]; restore(): void } {
  const warn = vscode.window.showWarningMessage;
  const warnings: string[] = [];
  vscode.window.showWarningMessage = (async (message: string) => {
    warnings.push(message);
    return button;
  }) as typeof warn;
  return {
    warnings,
    restore: () => {
      vscode.window.showWarningMessage = warn;
    },
  };
}

suite("chart code in the panel", function () {
  this.timeout(10_000);

  let dir: string;
  suiteSetup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "diagram-chart-code-"));
  });
  suiteTeardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("tells options that run code from literals", () => {
    assert.ok(!runsCode('{"series": [{"type": "pie", "data": [1]}]}'));
    assert.ok(!runsCode("// Sizes\n{series: [{type: 'pie', data: [1,],}],}"));
    assert.ok(runsCode(codeChart));
    assert.ok(runsCode("{series: [{type: 'pie', data: [1].map(Math.sqrt)}]}"));
    // What fails to read as literals may still evaluate.
    assert.ok(runsCode("{series: [{type: 'pie', data: [1]"));
  });

  test("leaves chat requests for the user to send once the page ran chart code", async () => {
    const execute = vscode.commands.executeCommand;
    const requests: string[] = [];
    vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
      if (command !== "workbench.action.chat.open") return execute(command, ...args);
      const { query, isPartialQuery } = args[0] as { query: string; isPartialQuery: boolean };
      requests.push(`${isPartialQuery ? "fill" : "send"}: ${query}`);
    }) as typeof execute;
    const { panel, webview } = await newFakePanel();
    const click = () => webview.receive({ type: "clickToAsk", node: { id: "A", label: "Parser" } });
    const ask = () => webview.receive({ type: "ask", text: "Why?", nodes: [] });
    try {
      const clickPrompt = "Explain {label}";
      assert.ok(
        (
          await panel.render(
            { language: "mermaid", source: flowchart, title: "Flow", clickPrompt },
            "tool",
          )
        ).ok,
      );
      await click();
      // A chart of literals runs no code, even when written as a JavaScript object literal.
      assert.ok((await renderChart(panel, "{series: [{type: 'pie', data: [1]}]}")).ok);
      await ask();
      assert.ok((await renderChart(panel, codeChart)).ok);
      await ask();
      // The code stays in the page for the diagrams that follow.
      assert.ok(
        (
          await panel.render(
            { language: "mermaid", source: flowchart, title: "Flow", clickPrompt },
            "tool",
          )
        ).ok,
      );
      await click();
      await webview.receive({ type: "ready" });
      await ask();
      assert.deepStrictEqual(requests, [
        "send: Explain Parser",
        "send: Regarding the chart: Why?",
        "fill: Regarding the chart: Why?",
        "fill: Explain Parser",
        "fill: Regarding the diagram: Why?",
      ]);
    } finally {
      vscode.commands.executeCommand = execute;
      panel.dispose();
    }

    // A new panel's page holds no code.
    const fresh = await newFakePanel();
    vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
      if (command !== "workbench.action.chat.open") return execute(command, ...args);
      requests.push(`${(args[0] as { isPartialQuery: boolean }).isPartialQuery ? "fill" : "send"}`);
    }) as typeof execute;
    try {
      assert.ok(
        (
          await fresh.panel.render(
            { language: "mermaid", source: flowchart, title: "Flow" },
            "tool",
          )
        ).ok,
      );
      await fresh.webview.receive({ type: "ask", text: "Why?", nodes: [] });
      assert.strictEqual(requests.at(-1), "send");
    } finally {
      vscode.commands.executeCommand = execute;
      fresh.panel.dispose();
    }
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
    const write = (source: string) =>
      webview.receive({ type: "sourceEdited", requestId: webview.render.requestId, source });
    const declined = answerWarnings();
    try {
      assert.ok((await renderChart(panel, codeChart)).ok);
      assert.ok((await open()).ok);
      await write(flowchart);
      assert.strictEqual(document.getText(), "```mermaid\nflowchart TD\n```\n");
      assert.deepStrictEqual(declined.warnings, ["Write this diagram to notes.md?"]);
    } finally {
      declined.restore();
    }
    const confirmed = answerWarnings("Write");
    try {
      await webview.receive({ type: "writeToDocument", requestId: webview.render.requestId });
      assert.strictEqual(document.getText(), `\`\`\`mermaid\n${flowchart}\n\`\`\`\n`);
      assert.deepStrictEqual(confirmed.warnings, ["Write this diagram to notes.md?"]);
    } finally {
      confirmed.restore();
      panel.dispose();
    }
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
    const declined = answerWarnings();
    try {
      assert.ok((await renderChart(panel, codeChart)).ok);
      const drawn = await panel.render(
        { language: "echarts", source, title: "Sizes", chart },
        "tool",
        undefined,
        table,
      );
      assert.ok(drawn.ok);
      assert.ok(!(await refresh(webview)), "the command ran");
      assert.deepStrictEqual(declined.warnings, [
        "Run the chart's command again to reload its data?",
      ]);
    } finally {
      declined.restore();
    }
    const confirmed = answerWarnings("Run");
    try {
      assert.ok(await refresh(webview), "the confirmed command did not run");
    } finally {
      confirmed.restore();
      panel.dispose();
    }
  });
});
