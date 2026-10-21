import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ChartSpec } from "../chartSpec";
import { ChartTool, InspectDataTool, inspectTable, UpdateChartTool } from "../chartTools";
import { parseTable } from "../data";
import { EditDiagramTool } from "../editTool";
import type { DiagramPanel, DiagramState, RenderOutcome } from "../panel";
import { StyleDiagramTool } from "../styleTool";
import { RenderDiagramTool } from "../tools";
import { formatOption } from "../webview/optionSource";
import { afterTest, cancellationSource, replace, tempDir, workspaceLink } from "./afterTest";
import { drawChart, newFakePanel } from "./newPanel";
import { invokeTool } from "./toolText";

const data = "name,amount\na,1\nb,2\nc,3";
const token = new vscode.CancellationTokenSource().token;

async function harness() {
  const values = new Map<string, unknown>();
  return { ...(await newFakePanel(values)), values };
}

function draw(panel: DiagramPanel, chart: ChartSpec = { type: "bar", data }) {
  return drawChart(panel, chart, data);
}

suite("chartTools", function () {
  this.timeout(10_000);

  test("keeps user edits made while chart data loads", async () => {
    const { panel, webview } = await harness();
    await draw(panel);
    const edited = '{"series": [{"type": "pie", "data": [7]}]}';
    const readFile = vscode.workspace.fs.readFile;
    replace(vscode.workspace, "fs", {
      ...vscode.workspace.fs,
      readFile: async (uri) => {
        await webview.edit(edited);
        return readFile(uri);
      },
    });
    const result = await invokeTool(new ChartTool(panel), { type: "bar", file: "sizes.tsv" });
    assert.strictEqual(panel.current?.source, edited);
    assert.match(result, /No chart was rendered because the diagram changed in the panel/);
  });

  test("analysis updates reuse the full cached table and retain the prior chart on invalid filters", async () => {
    const { panel, values } = await harness();
    const samples = "service,latency\na,1\na,2\nb,10\nb,20";
    const table = parseTable(samples);
    const chart: ChartSpec = { type: "bar", command: "must-not-run", valueColumns: ["latency"] };
    await drawChart(panel, chart, table, "Samples");
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
    const unicode = `${"x".repeat(254)}😀end`;
    const clipped = JSON.parse(
      inspectTable(
        { columns: [{ name: unicode, numeric: false }], rows: [[unicode]], header: true },
        1,
      ),
    );
    assert.strictEqual(clipped.columns[0].name, unicode);
    assert.strictEqual(clipped.sample[0][0], `${"x".repeat(254)}…`);
  });

  test("inspection pages through every column with exact usable names and aligned sample cells", async () => {
    const names = Array.from({ length: 125 }, (_, i) => `column ${i + 1}`);
    names[70] = `${"long header ".repeat(30)}😀`;
    const rows = Array.from({ length: 25 }, (_, row) => names.map((_, col) => row * 1000 + col));
    const table = parseTable(JSON.stringify([names, ...rows]));
    const found: string[] = [];
    let startColumn: number | undefined = 1;
    while (startColumn !== undefined) {
      const page = JSON.parse(inspectTable(table, 2, { startColumn, startRow: 21 }));
      assert.strictEqual(page.startColumn, startColumn);
      assert.strictEqual(page.startRow, 21);
      assert.strictEqual(page.nextRow, 23);
      for (const [i, column] of page.columns.entries()) {
        assert.strictEqual(column.index, startColumn + i);
        assert.strictEqual(page.sample[0][i], 20_000 + column.index - 1);
        assert.strictEqual(column.nullCount, 0);
        found.push(column.name);
      }
      startColumn = page.nextColumn;
    }
    assert.deepStrictEqual(found, names);

    const { panel } = await harness();
    const input = JSON.stringify([names, ...rows]);
    const result = await invokeTool(new ChartTool(panel), {
      type: "bar",
      data: input,
      valueColumns: [found[70]],
      limit: 2,
    });
    assert.match(result, /Rendered the bar chart/);
    assert.deepStrictEqual(panel.current?.chart?.valueColumns, [names[70]]);
  });

  test("inspection bounds escaped exact names and reports continuation after the actual page", () => {
    const table = {
      columns: Array.from({ length: 20 }, (_, i) => ({
        name: `${i}${"\u0000".repeat(1000)}`,
        numeric: false,
      })),
      rows: [Array.from({ length: 20 }, () => "sample")],
      header: true,
    };
    const names: string[] = [];
    let startColumn: number | undefined = 1;
    while (startColumn !== undefined) {
      const output = inspectTable(table, 1, { startColumn });
      assert.ok(output.length <= 24_000);
      const page = JSON.parse(output);
      assert.ok(page.columns.length > 0);
      assert.strictEqual(page.columnsOmitted, 20 - page.columns.length);
      names.push(...page.columns.map((column: { name: string }) => column.name));
      if (page.nextColumn !== undefined) assert.ok(page.nextColumn > startColumn);
      startColumn = page.nextColumn;
    }
    assert.deepStrictEqual(
      names,
      table.columns.map(({ name }) => name),
    );
    const samples = JSON.parse(inspectTable(table, 1, { startColumn: 5, maxColumns: 1 }));
    assert.deepStrictEqual(samples.sample, [["sample"]]);
    assert.strictEqual(samples.columns[0].index, 5);
  });

  test("inspection never silently clips an identifier too large to return", () => {
    const table = {
      columns: [
        { name: "x".repeat(24_000), numeric: false },
        { name: "usable", numeric: true },
      ],
      rows: [["sample", 12]],
      header: true,
    };
    assert.throws(
      () => inspectTable(table, 0),
      /Column 1's exact name exceeds.+Shorten its header.+"startColumn": 2/,
    );
    const skipped = JSON.parse(inspectTable(table, 1, { startColumn: 2 }));
    assert.strictEqual(skipped.columns[0].name, "usable");
    assert.deepStrictEqual(skipped.sample, [[12]]);
  });

  test("inspection bounds parser notes without losing the table schema or sample", () => {
    const data = {
      items: [{ value: 1 }],
      ...Object.fromEntries(Array.from({ length: 3_000 }, (_, i) => [`metadata${i}`, i])),
    };
    const table = parseTable(JSON.stringify(data));
    assert.ok((table.note?.length ?? 0) > 24_000);
    const output = inspectTable(table, 1);
    assert.ok(output.length <= 24_000);
    const report = JSON.parse(output);
    assert.ok(report.truncated);
    assert.match(report.note, /…$/);
    assert.strictEqual(report.columns[0].name, "value");
    assert.deepStrictEqual(report.sample, [[1]]);
  });

  test("inspection reads inline and loaded data without replacing the current chart", async () => {
    const { panel } = await harness();
    await draw(panel);
    const before = panel.current;
    const tool = new InspectDataTool(panel);
    const inline = await invokeTool(tool, { data, sampleRows: 0 });
    assert.match(inline, /"rowCount":3/);
    assert.match(inline, /"sample":\[\]/);
    assert.doesNotMatch(inline, /Current chart data, revision/);
    // Some models send null for the properties they leave out.
    assert.match(
      await invokeTool(tool, { data, file: null, sampleRows: null }),
      /"sample":\[\["a",1\]/,
    );
    const cached = await invokeTool(tool, {});
    assert.ok(cached.startsWith(`Current chart data, revision ${panel.revision}.\n`));
    assert.match(cached, /"rowCount":3/);
    const page = await invokeTool(tool, {
      startColumn: 2,
      maxColumns: 1,
      startRow: 2,
      sampleRows: 1,
    });
    assert.match(page, /"columns":\[\{"name":"amount","numeric":true,"index":2,"nullCount":0\}\]/);
    assert.match(page, /"sample":\[\[2\]\],"nextRow":3/);
    assert.ok(page.startsWith(`Current chart data, revision ${panel.revision}.\n`));
    assert.doesNotMatch(page, /"nextColumn"/);
    assert.strictEqual(panel.current, before);
    for (const input of [
      { sampleRows: 21 },
      { data, file: "x" },
      { type: "bar", data },
      { startColumn: 0 },
      { startColumn: 3 },
      { startColumn: "2" },
      { startRow: 0 },
      { startRow: 4 },
      { startRow: 1.5 },
      { startRow: Number.MAX_SAFE_INTEGER + 1 },
      { maxColumns: 0 },
      { maxColumns: 61 },
      { maxColumns: 1.5 },
    ]) {
      assert.match(await invokeTool(tool, input), /could not be inspected/);
    }
  });

  test("inspection confirms external files and commands, and reads a file without rendering", async () => {
    const file = path.join(tempDir("diagram-inspect-"), "data.csv");
    fs.writeFileSync(file, data);
    const { panel } = await harness();
    const tool = new InspectDataTool(panel);
    assert.ok(tool.prepareInvocation({ input: { file } }).confirmationMessages);
    const link = workspaceLink("diagram-inspect-link.csv", file);
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
      'Data could not be inspected: The input must be an object with the properties "data", "file", "command", "format", "sampleRows", "startRow", "startColumn", "maxColumns".',
    );
  });

  test("inspection reads a file that it did not ask about only if it is still inside", async () => {
    // Asking goes by the path alone, which the call tells again: preparing keeps no state.
    const file = path.join(tempDir("diagram-inspect-"), "data.csv");
    fs.writeFileSync(file, data);
    const { panel, webview } = await harness();
    const tool = new InspectDataTool(panel);
    const link = workspaceLink("diagram-inspect-swap.csv", "sizes.tsv");
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
    workspaceLink("diagram-linked-folder", folder);
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
    const link = workspaceLink(
      "diagram-bytes-link.csv",
      Buffer.from("/tmp/diagram-\xff.csv", "latin1"),
    );
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
    const input = { type: "horizontalBar", sort: "descending", limit: 2, revision: panel.revision };
    assert.match(await invokeTool(new UpdateChartTool(panel), input), /Updated/);
    assert.strictEqual(panel.current?.chart?.type, "horizontalBar");
    assert.strictEqual(panel.current?.chart?.limit, 2);
    assert.strictEqual(panel.loadedChartData?.rows.length, 3);
    assert.strictEqual(JSON.parse(panel.current?.source ?? "").backgroundColor, "#123456");
    assert.ok(panel.current?.editedByUser);
    assert.match(panel.describeForModel() ?? "", new RegExp(`Revision: ${panel.revision}`));
  });

  test("a chart's default title follows its type, unlike a title given to it", async () => {
    const { panel, webview } = await harness();
    assert.match(
      await invokeTool(new ChartTool(panel), { type: "bar", file: "sizes.tsv" }),
      /^Rendered/,
    );
    assert.strictEqual(panel.current?.title, "Bar chart of sizes.tsv");
    assert.ok((await panel.updateChart({ type: "pie" }, token)).ok);
    assert.strictEqual(panel.current?.title, "Pie chart of sizes.tsv");
    assert.strictEqual(webview.render.title, "Pie chart of sizes.tsv");
    await webview.receive({
      type: "applyChartOptions",
      revision: panel.revision,
      controls: { type: "horizontalBar" },
      replaceSource: false,
    });
    assert.strictEqual(panel.current?.title, "Horizontal bar chart of sizes.tsv");
    assert.ok((await panel.updateChart({ title: "Sizes" }, token)).ok);
    assert.ok((await panel.updateChart({ type: "bar" }, token)).ok);
    assert.strictEqual(panel.current?.title, "Sizes");
  });

  test("a refused update says how to clear the setting that it keeps", async () => {
    const { panel } = await harness();
    const scores = "name,team,score\na,x,1\nb,y,2\nc,x,3";
    await drawChart(panel, { type: "bar", data: scores, limit: 2 }, scores, "Scores");
    const update = (input: object) => invokeTool(new UpdateChartTool(panel), input);
    assert.match(
      await update({ labelColumn: ["name", "team"] }),
      /Leave "limit" out \(set it to null with diagram_updateChart\)/,
    );
    assert.match(await update({ labelColumn: ["name", "team"], limit: null }), /^Updated/);
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
    // Neither can be cleared or be other than text, which the update refuses.
    assert.strictEqual(message({ type: null, title: 5, limit: 3 }), "Updating the chart: limit 3");
    assert.strictEqual(message("line"), "Updating the chart");
  });

  test("the model learns of styling that waits for a chart that can show it", async () => {
    const { panel, webview } = await harness();
    const styled = JSON.parse(await draw(panel));
    styled.series[0].itemStyle = { color: "red" };
    await webview.edit(JSON.stringify(styled));
    const update = (input: object) => invokeTool(new UpdateChartTool(panel), input);
    assert.match(await update({ type: "pie" }), /^Updated/);
    assert.match(
      panel.describeForModel() ?? "",
      /Manual styling that this pie chart cannot show comes back with a chart that can; replacing the chart with diagram_chart or diagram_render drops it\./,
    );
    assert.match(await update({ type: "bar" }), /^Updated/);
    assert.strictEqual(JSON.parse(panel.current?.source ?? "").series[0].itemStyle.color, "red");
    assert.doesNotMatch(panel.describeForModel() ?? "", /comes back with a chart that can/);
  });

  test("the model is not told of styling that waits as the chart shows it already", async () => {
    const { panel, webview } = await harness();
    const styled = JSON.parse(await draw(panel));
    styled.yAxis.scale = true;
    await webview.edit(JSON.stringify(styled));
    const update = (input: object) => invokeTool(new UpdateChartTool(panel), input);
    // A line chart's axis has the scale too, which stays for a bar chart again.
    assert.match(await update({ type: "line" }), /^Updated/);
    assert.ok(panel.current?.chartPresentation?.kept?.length);
    assert.doesNotMatch(panel.describeForModel() ?? "", /comes back with a chart that can/);
    assert.match(await update({ type: "bar" }), /^Updated/);
    assert.strictEqual(JSON.parse(panel.current?.source ?? "").yAxis.scale, true);
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
    assert.deepStrictEqual(values.get("diagram.state"), { ...before, revision: panel.revision });
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

  test("every drawing tool tells what the panel warns of, and of a generated chart the settings that fix it", async () => {
    const { panel, webview } = await harness();
    const warning =
      'xAxis shows only 9 of its 25 category labels at the panel\'s width of 376 pixels, leaving out the others for lack of room: put the categories on yAxis as a horizontal bar chart, shorten the names, or add a "dataZoom" to show fewer at a time.';
    const drawn = webview.answer;
    webview.answer = (message) => {
      const answer = drawn?.(message);
      return answer?.type === "rendered"
        ? { ...answer, nodeIds: ["A", "B"], warnings: [warning] }
        : answer;
    };
    const fixes =
      'As diagram_chart made this chart, fix these by its settings with diagram_updateChart where they do it: "type": "horizontalBar" for category names too long for the width. Change its styling, such as "grid", "dataZoom" or label wrapping, with diagram_edit. Preserve all requested categories and series; use a "limit", fewer "valueColumns" or aggregated data only when the user wants that subset or summary, not just to fit the panel.';
    const told = (result: string, ...paragraphs: string[]) =>
      assert.ok(result.includes(`\n\n${paragraphs.join("\n\n")}`), result);

    told(
      await invokeTool(new ChartTool(panel), { type: "bar", data }),
      warning,
      fixes,
      "If columns",
    );
    told(
      await invokeTool(new UpdateChartTool(panel), { sort: "descending" }),
      warning,
      fixes,
      `Revision: ${panel.revision}.`,
    );
    told(
      await invokeTool(new EditDiagramTool(panel), {
        edits: [{ oldText: '"type": "value"', newText: '"type": "value", "splitNumber": 3' }],
      }),
      warning,
      fixes,
      `Revision: ${panel.revision}.`,
    );
    // Not of a diagram or chart drawn from its source alone, which a model fixes in the source.
    const source = "flowchart LR\n  A --> B";
    assert.strictEqual(
      await invokeTool(new RenderDiagramTool(panel), { source }),
      `Rendered the test diagram in the diagram panel next to the chat.\n\n${warning}\n\nRevision: ${panel.revision}.`,
    );
    told(
      await invokeTool(new StyleDiagramTool(panel), { styles: [{ id: "A", fill: "red" }] }),
      warning,
      `Revision: ${panel.revision}.`,
    );
  });

  test("diagram_chart writes the option as the source view shows it, with values on few lines", async () => {
    const { panel } = await harness();
    const rows = Array.from({ length: 200 }, (_, i) => `r${i},${i}`).join("\n");
    await invokeTool(new ChartTool(panel), { type: "bar", data: `name,value\n${rows}` });
    const source = panel.current?.source ?? "";
    assert.strictEqual(formatOption(JSON.stringify(JSON.parse(source))), source);
    // Rather than a line for each of the 400 labels and values, which models read in every request.
    assert.ok(source.split("\n").length < 60, source);
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
