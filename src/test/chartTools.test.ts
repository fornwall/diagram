import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ChartSpec } from "../chartSpec";
import { buildChart } from "../charts";
import { ChartTool, InspectDataTool, inspectTable, UpdateChartTool } from "../chartTools";
import { parseTable } from "../data";
import type { DiagramPanel, DiagramState, RenderOutcome } from "../panel";
import { afterTest, cancellationSource, replace, tempDir } from "./afterTest";
import { newFakePanel } from "./newPanel";
import { invokeTool, toolText } from "./toolText";

const data = "name,amount\na,1\nb,2\nc,3";
const token = new vscode.CancellationTokenSource().token;

async function harness() {
  const values = new Map<string, unknown>();
  return { ...(await newFakePanel(values)), values };
}

async function draw(panel: DiagramPanel, spec: ChartSpec = { type: "bar", data }) {
  const table = parseTable(data);
  const source = JSON.stringify(buildChart(spec, table).option);
  assert.ok(
    (
      await panel.render(
        { language: "echarts", title: "Chart", source, chart: spec },
        "tool",
        table,
      )
    ).ok,
  );
  return source;
}

suite("chartTools", function () {
  this.timeout(10_000);

  test("analysis updates reuse the full cached table and retain the prior chart on invalid filters", async () => {
    const { panel, values } = await harness();
    const samples = "service,latency\na,1\na,2\nb,10\nb,20";
    const table = parseTable(samples);
    const chart: ChartSpec = { type: "bar", command: "must-not-run", valueColumns: ["latency"] };
    assert.ok(
      (
        await panel.render(
          {
            language: "echarts",
            title: "Samples",
            chart,
            source: JSON.stringify(buildChart(chart, table).option),
          },
          "tool",
          table,
        )
      ).ok,
    );
    assert.ok(
      (
        await panel.updateChart(
          {
            type: "histogram",
            bins: 2,
            facetColumn: "service",
            filters: [{ column: "latency", op: "gte", value: 2 }],
          },
          token,
        )
      ).ok,
    );
    assert.strictEqual(panel.loadedChartData, table);
    assert.strictEqual(panel.current?.chart?.facetColumn, "service");
    assert.deepStrictEqual((values.get("diagram.state") as DiagramState).chart?.filters, [
      { column: "latency", op: "gte", value: 2 },
    ]);
    const filtered = panel.current;
    await assert.rejects(
      panel.updateChart(
        {
          filters: [{ column: "latency", op: "gt", value: 1000 }],
        },
        token,
      ),
      /No rows match/,
    );
    assert.strictEqual(panel.current, filtered);
    assert.ok((await panel.updateChart({ filters: null, facetColumn: null }, token)).ok);
    const option = JSON.parse(panel.current?.source ?? "");
    assert.strictEqual(
      option.series[0].data.reduce((total: number, count: number) => total + count, 0),
      4,
    );
    assert.strictEqual(panel.loadedChartData, table);
  });

  test("inspection reports inferred schema, nulls and bounded samples", () => {
    const table = parseTable("name,amount\na,1\nb,NULL\nc,3");
    const report = JSON.parse(inspectTable(table, 2));
    assert.strictEqual(report.rowCount, 3);
    assert.strictEqual(report.header, true);
    assert.strictEqual(report.columns[1].numeric, true);
    assert.strictEqual(report.columns[1].nullCount, 1);
    assert.deepStrictEqual(report.sample, [
      ["a", 1],
      ["b", null],
    ]);
    assert.strictEqual(report.sampleRowsOmitted, 1);
    const wide = {
      columns: Array.from({ length: 100 }, () => ({ name: "\u0000".repeat(1000), numeric: false })),
      rows: Array.from({ length: 20 }, () => Array(100).fill("x".repeat(1000))),
      header: true,
    };
    const bounded = inspectTable(wide, 20);
    assert.ok(bounded.length <= 24_000);
    assert.ok(JSON.parse(bounded).truncated);
  });

  test("inspection reads inline and loaded data without replacing the current chart", async () => {
    const { panel } = await harness();
    await draw(panel);
    const before = panel.current;
    const tool = new InspectDataTool(panel);
    const inline = await invokeTool(tool, { data, sampleRows: 0 });
    assert.match(inline, /"rowCount":3/);
    assert.match(inline, /"sample":\[\]/);
    // Some models send null for the properties they leave out.
    assert.match(
      await invokeTool(tool, { data, file: null, sampleRows: null }),
      /"sample":\[\["a",1\]/,
    );
    const cached = await invokeTool(tool, {});
    assert.match(cached, /"rowCount":3/);
    assert.strictEqual(panel.current, before);
    for (const input of [{ sampleRows: 21 }, { data, file: "x" }, { type: "bar", data }]) {
      assert.match(await invokeTool(tool, input), /could not be inspected/);
    }
  });

  test("inspection confirms external files and commands, and reads a file without rendering", async () => {
    const file = path.join(tempDir("diagram-inspect-"), "data.csv");
    fs.writeFileSync(file, data);
    const { panel } = await harness();
    const tool = new InspectDataTool(panel);
    assert.ok(tool.prepareInvocation({ input: { file } }).confirmationMessages);
    const root = vscode.workspace.workspaceFolders?.[0];
    assert.ok(root);
    const link = path.join(root.uri.fsPath, "diagram-inspect-link.csv");
    fs.symlinkSync(file, link);
    afterTest(() => fs.rmSync(link));
    // A link in the workspace is read without asking only while it leads inside.
    const linked = { file: path.basename(link) };
    assert.ok(!tool.prepareInvocation({ input: linked }).confirmationMessages);
    assert.strictEqual(
      await invokeTool(tool, linked),
      `Data could not be inspected: The file diagram-inspect-link.csv leads out of the workspace, to ${file}, ` +
        "so it was not read without asking the user. Call the tool again with the path that it leads to.",
    );
    assert.ok(!tool.prepareInvocation({ input: { file: "sizes.tsv" } }).confirmationMessages);
    assert.ok(tool.prepareInvocation({ input: { command: "printf data" } }).confirmationMessages);
    assert.ok(!tool.prepareInvocation({ input: { data } }).confirmationMessages);
    assert.match(await invokeTool(tool, { file }), /"rowCount":3/);
    assert.strictEqual(panel.current, undefined);
    assert.strictEqual(
      await invokeTool(tool, file),
      'Data could not be inspected: The input must be an object with the properties "data", "file", "command", "format", "sampleRows".',
    );
  });

  test("inspection reads a file that it did not ask about only if it is still inside", async () => {
    // Asking goes by the path alone, which the call tells again: preparing keeps no state.
    const file = path.join(tempDir("diagram-inspect-"), "data.csv");
    fs.writeFileSync(file, data);
    const { panel, webview } = await harness();
    const tool = new InspectDataTool(panel);
    const root = vscode.workspace.workspaceFolders?.[0];
    assert.ok(root);
    const link = path.join(root.uri.fsPath, "diagram-inspect-swap.csv");
    fs.symlinkSync("sizes.tsv", link);
    afterTest(() => fs.rmSync(link));
    const input = { file: path.basename(link) };
    await draw(panel, { type: "pie", ...input });
    assert.ok(!tool.prepareInvocation({ input }).confirmationMessages);
    // A refresh of a chart of the file meanwhile leaves the check to the tool.
    await webview.receive({ type: "refresh" });
    fs.rmSync(link);
    fs.symlinkSync(file, link);
    assert.match(await invokeTool(tool, input), /leads out of the workspace, to /);
    // The path it leads to is asked about, and then read.
    assert.ok(tool.prepareInvocation({ input: { file } }).confirmationMessages);
    assert.match(await invokeTool(tool, { file }), /"rowCount":3/);
  });

  test("both data tools name where a file in a linked folder leads, which a new call asks about", async () => {
    const folder = tempDir("diagram-linked-");
    fs.writeFileSync(path.join(folder, "data.csv"), data);
    const root = vscode.workspace.workspaceFolders?.[0];
    assert.ok(root);
    const link = path.join(root.uri.fsPath, "diagram-linked-folder");
    fs.symlinkSync(folder, link);
    afterTest(() => fs.rmSync(link));
    const { panel } = await harness();
    const target = path.join(folder, "data.csv");
    const file = "diagram-linked-folder/data.csv";
    for (const [tool, input] of [
      [new InspectDataTool(panel), { file }],
      [new ChartTool(panel), { type: "bar", file }],
    ] as const) {
      assert.ok(!tool.prepareInvocation({ input: input as never }).confirmationMessages);
      assert.match(
        await invokeTool(tool, input),
        new RegExp(
          `The file diagram-linked-folder/data.csv leads out of the workspace, to ${RegExp.escape(target)}, .* Call the tool again with the path that it leads to`,
        ),
      );
      const retry = { ...input, file: target };
      assert.ok(tool.prepareInvocation({ input: retry as never }).confirmationMessages);
      assert.doesNotMatch(await invokeTool(tool, retry), /could not|not rendered|leads out/i);
    }
    assert.strictEqual(panel.current?.chart?.file, target);
  });

  test("asks the user for another way to a file whose link names no path", async function () {
    if (process.platform !== "linux") this.skip();
    const root = vscode.workspace.workspaceFolders?.[0];
    assert.ok(root);
    const link = path.join(root.uri.fsPath, "diagram-bytes-link.csv");
    fs.symlinkSync(Buffer.from("/tmp/diagram-\xff.csv", "latin1"), link);
    afterTest(() => fs.rmSync(link));
    const { panel } = await harness();
    assert.strictEqual(
      await invokeTool(new InspectDataTool(panel), { file: path.basename(link) }),
      "Data could not be inspected: The file diagram-bytes-link.csv leads out of the workspace " +
        "through a symbolic link whose target cannot be named, such as one that is not UTF-8, so " +
        "it was not read without asking the user. Ask the user to copy the file into the " +
        "workspace, or to give its data another way.",
    );
  });

  test("updates retain manual styling and loaded command data", async () => {
    const { panel, webview } = await harness();
    const source = await draw(panel, { type: "bar", command: "this-command-must-never-run" });
    const styled = JSON.parse(source);
    styled.backgroundColor = "#123456";
    await webview.edit(JSON.stringify(styled));
    const result = await new UpdateChartTool(panel).invoke(
      {
        input: { type: "horizontalBar", sort: "descending", limit: 2, revision: panel.revision },
        toolInvocationToken: undefined,
      },
      token,
    );
    assert.match(toolText(result), /Updated/);
    assert.strictEqual(panel.current?.chart?.type, "horizontalBar");
    assert.strictEqual(panel.current?.chart?.limit, 2);
    assert.strictEqual(panel.loadedChartData?.rows.length, 3);
    assert.strictEqual(JSON.parse(panel.current?.source ?? "").backgroundColor, "#123456");
    assert.ok(panel.current?.editedByUser);
    assert.match(panel.describeForModel() ?? "", new RegExp(`Revision: ${panel.revision}`));
  });

  test("an update says in chat what it changes", async () => {
    const { panel } = await harness();
    const tool = new UpdateChartTool(panel);
    const message = (input: unknown) =>
      tool.prepareInvocation({ input: input as never }).invocationMessage;
    assert.strictEqual(
      message({ type: "horizontalBar", sort: "descending", limit: 5, revision: 3 }),
      'Updating the chart: horizontal bar chart, sort "descending", limit 5',
    );
    assert.strictEqual(
      message({ title: "Sales", valueColumns: ["q1", "q2"], filters: null, max: 100 }),
      'Updating the chart: title "Sales", value columns "q1", "q2", filters cleared, maximum 100',
    );
    assert.strictEqual(
      message({ filters: [{ column: "a", op: "eq", value: 1 }], facetColumn: "region" }),
      'Updating the chart: 1 filter, facet column "region"',
    );
    assert.strictEqual(message({ revision: 2 }), "Updating the chart");
    assert.strictEqual(message("line"), "Updating the chart");
  });

  test("updates reject stale revisions, missing caches and unsupported manual data edits", async () => {
    const { panel, webview, values } = await harness();
    const source = await draw(panel, { type: "bar", command: "never-run" });
    const before = panel.current;
    await assert.rejects(
      panel.updateChart({ limit: 2, revision: panel.revision - 1 }, token),
      /chart changed/,
    );
    assert.strictEqual(panel.current, before);
    // The table of a command is not kept when VS Code restarts.
    const restored = await newFakePanel(values);
    await assert.rejects(
      restored.panel.updateChart({ limit: 2 }, token),
      /not loaded.*Call diagram_chart again with the same command and the new settings/,
    );
    const edited = JSON.parse(source);
    edited.series[0].data[0] = 999;
    await webview.edit(JSON.stringify(edited));
    const manual = panel.current;
    await assert.rejects(
      panel.updateChart({ limit: 2 }, token),
      /styling can't be kept, because the source changes the chart's data or structure/,
    );
    assert.strictEqual(panel.current, manual);
  });

  test("render failure restores the prior chart and persisted state", async () => {
    const { panel, webview, values } = await harness();
    const { sent } = webview;
    await draw(panel);
    const annotation = { marks: [{ id: "a", kind: "good" as const }], dim: true };
    assert.ok(panel.annotate(annotation).ok);
    sent.length = 0;
    const before = panel.current;
    webview.failNextRender("bad renderer");
    const result = await panel.updateChart({ limit: 2 }, token);
    assert.ok(!result.ok);
    assert.match(result.error, /previous chart is kept/);
    assert.deepStrictEqual(panel.current, before);
    assert.deepStrictEqual(values.get("diagram.state"), before);
    const renders = sent.filter((message) => message.type === "render");
    assert.strictEqual(renders.length, 2);
    assert.deepStrictEqual(sent.at(-1), { type: "annotate", ...annotation });
    assert.strictEqual(sent.at(-2), renders[1]);
  });

  test("closing the panel during an update restores persisted state", async () => {
    const { panel, webview, values } = await harness();
    await draw(panel);
    const before = panel.current;
    webview.nextRender(() => panel.dispose());
    assert.ok(!(await panel.updateChart({ limit: 2 }, token)).ok);
    assert.deepStrictEqual((values.get("diagram.state") as DiagramState).source, before?.source);
    assert.deepStrictEqual(panel.current, before);
  });

  test("cancellation while rendering restores the chart, and pre-cancellation makes no changes", async () => {
    const { panel, webview } = await harness();
    const cancellation = cancellationSource();
    await draw(panel);
    const before = panel.current;
    webview.nextRender(() => cancellation.cancel());
    await assert.rejects(
      panel.updateChart({ limit: 2 }, cancellation.token),
      vscode.CancellationError,
    );
    assert.deepStrictEqual(panel.current, before);
    await assert.rejects(
      panel.updateChart({ limit: 1 }, cancellation.token),
      vscode.CancellationError,
    );
    await assert.rejects(
      invokeTool(new InspectDataTool(panel), { data }, cancellation.token),
      vscode.CancellationError,
    );
    assert.deepStrictEqual(panel.current, before);
  });

  test("a superseding render wins over an in-flight chart update", async () => {
    const { panel, webview } = await harness();
    let replacement: Promise<RenderOutcome> | undefined;
    await draw(panel);
    webview.nextRender(() => {
      replacement = panel.render(
        { language: "mermaid", title: "New", source: "flowchart TD\nA-->B" },
        "tool",
      );
    });
    assert.ok(!(await panel.updateChart({ limit: 2 }, token)).ok);
    assert.ok((await replacement)?.ok);
    assert.strictEqual(panel.current?.title, "New");
    assert.strictEqual(panel.current?.chart, undefined);
  });

  test("cancellation does not wait for an unresponsive rollback renderer", async () => {
    const { panel, webview } = await harness();
    const cancellation = cancellationSource();
    await draw(panel);
    const before = panel.current;
    webview.nextRender(() => {
      // The page does not answer the render that restores the chart.
      webview.nextRender(() => {});
      cancellation.cancel();
    });
    await assert.rejects(
      panel.updateChart({ limit: 2 }, cancellation.token),
      vscode.CancellationError,
    );
    assert.deepStrictEqual(panel.current, before);
  });

  test("cancelling a superseded update does not restore the older chart", async () => {
    const { panel, webview } = await harness();
    const cancellation = cancellationSource();
    let replacement: Promise<RenderOutcome> | undefined;
    await draw(panel);
    webview.nextRender(() => {
      replacement = panel.render(
        { language: "mermaid", title: "Replacement", source: "flowchart TD\nA-->B" },
        "tool",
      );
      cancellation.cancel();
    });
    await assert.rejects(
      panel.updateChart({ limit: 2 }, cancellation.token),
      vscode.CancellationError,
    );
    assert.ok((await replacement)?.ok);
    assert.strictEqual(panel.current?.title, "Replacement");
  });

  test("diagram_chart blames its options for a chart that fails to render", async () => {
    const { panel } = await harness();
    panel.render = async () => ({ ok: false, kind: "invalid", error: "Bad option", revision: 1 });
    const chart = (input: object) =>
      invokeTool(new ChartTool(panel), { type: "bar", data: "a,1\nb,2", ...input });
    assert.match(
      await chart({ options: { yAxis: { type: "log" } } }),
      /^The chart failed to render with this error:\n\nBad option\n\n"options" is the likely cause: fix or leave it out and call diagram_chart again\.\n\nCharted /,
    );
    assert.match(
      await chart({}),
      /Bad option\n\nTry another chart type, or write the ECharts option yourself/,
    );
  });

  test("cancelling a chart stops waiting for a file read", async () => {
    const { panel } = await harness();
    const cancellable = cancellationSource();
    const started = Promise.withResolvers<void>();
    const data = Promise.withResolvers<Uint8Array>();
    afterTest(() => data.resolve(new TextEncoder().encode("name,value\nA,1")));
    replace(vscode.workspace, "fs", {
      ...vscode.workspace.fs,
      readFile: () => {
        started.resolve();
        return data.promise;
      },
    });
    const result = invokeTool(
      new ChartTool(panel),
      { type: "bar", file: "sizes.tsv" },
      cancellable.token,
    );
    await started.promise;
    cancellable.cancel();
    await assert.rejects(result, vscode.CancellationError);
    assert.strictEqual(panel.current, undefined);
  });
});
