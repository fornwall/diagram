import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { ExportDiagramHtmlTool } from "../exportHtmlTool";
import type { DiagramPanel } from "../panel";
import { cancellationSource, diagramExtension, folders, replace, tempDir } from "./afterTest";
import { newFakePanel } from "./newPanel";
import { testColors } from "./themeColors";
import { invokeTool } from "./toolText";

suite("exportHtmlTool", () => {
  let panel: DiagramPanel;
  let tool: ExportDiagramHtmlTool;
  let directory: string;
  setup(async () => {
    directory = tempDir("diagram-html-");
    replace(vscode.workspace, "workspaceFolders", folders(directory));
    ({ panel } = await newFakePanel());
    await panel.render(
      { language: "mermaid", source: "flowchart LR\n A[Alpha] --> B[Beta]", title: "HTML export" },
      "tool",
    );
    panel.captureTheme = async () => ({ type: "exportTheme", requestId: 1, colors: testColors });
    tool = new ExportDiagramHtmlTool(panel, diagramExtension().extensionUri);
  });

  test("confirms the named destination, overwrite policy and browser dependency", () => {
    const prepared = tool.prepareInvocation({
      input: { file: "report.html", revision: panel.revision },
    });
    assert.ok(prepared.confirmationMessages);
    const message = prepared.confirmationMessages.message as vscode.MarkdownString;
    const plain = message.value.replaceAll("&nbsp;", " ");
    assert.match(plain, /revision 1/);
    assert.ok(plain.includes(path.join(directory, "report.html")));
    assert.match(plain, /without overwriting/);
    assert.match(plain, /internet access.*jsDelivr/);
    assert.match(plain, /callbacks run in the browser/);
  });

  test("writes the current source to a named HTML file and keeps the panel revision", async () => {
    const before = panel.revision;
    const answer = await invokeTool(tool, { file: "report.html", revision: before });
    assert.match(answer, /Exported revision 1/);
    assert.ok(answer.includes(vscode.Uri.file(path.join(directory, "report.html")).toString(true)));
    const html = fs.readFileSync(path.join(directory, "report.html"), "utf8");
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /mermaid@12\.1\.0/);
    assert.ok(html.includes(JSON.stringify(panel.current?.source)));
    assert.strictEqual(panel.revision, before);
  });

  test("requires explicit overwrite and refuses unsaved editor changes even then", async () => {
    const file = path.join(directory, "existing.html");
    fs.writeFileSync(file, "original");
    assert.match(await invokeTool(tool, { file }), /already exists/);
    assert.strictEqual(fs.readFileSync(file, "utf8"), "original");
    const uri = vscode.Uri.file(file);
    const documents = vscode.workspace.textDocuments;
    replace(vscode.workspace, "textDocuments", [
      ...documents,
      { uri, isDirty: true } as vscode.TextDocument,
    ]);
    assert.match(await invokeTool(tool, { file, overwrite: true }), /unsaved edits/);
    assert.strictEqual(fs.readFileSync(file, "utf8"), "original");
    replace(vscode.workspace, "textDocuments", documents);
    assert.match(await invokeTool(tool, { file, overwrite: true }), /Exported revision/);
    assert.match(fs.readFileSync(file, "utf8"), /<!DOCTYPE html>/);
  });

  test("rejects malformed input, stale revisions and missing folders without writing", async () => {
    for (const input of [
      { file: "report.txt" },
      { file: "report.html", revision: -1 },
      { file: "report.html", overwrite: "true" },
      { file: "report.html", unexpected: true },
      { file: "report.html", revision: panel.revision + 1 },
      { file: "missing/report.html" },
    ]) {
      assert.match(await invokeTool(tool, input), /HTML was not exported/);
    }
    assert.deepStrictEqual(fs.readdirSync(directory), []);
  });

  test("refuses a diagram that changes while its theme is captured", async () => {
    panel.captureTheme = async () => {
      await panel.render(
        { language: "mermaid", source: "flowchart LR\n New", title: "New" },
        "tool",
      );
      return { type: "exportTheme", requestId: 1, colors: testColors };
    };
    assert.match(await invokeTool(tool, { file: "report.html" }), /changed during export/);
    assert.deepStrictEqual(fs.readdirSync(directory), []);
  });

  test("cancels while waiting for the panel without writing", async () => {
    const source = cancellationSource();
    panel.captureTheme = () => {
      source.cancel();
      return new Promise(() => {});
    };
    await assert.rejects(
      invokeTool(tool, { file: "report.html" }, source.token),
      vscode.CancellationError,
    );
    assert.deepStrictEqual(fs.readdirSync(directory), []);
  });

  test("rejects a destination redirected outside the workspace during theme capture", async () => {
    const external = tempDir("diagram-html-outside-");
    const folder = path.join(directory, "reports");
    fs.mkdirSync(folder);
    panel.captureTheme = async () => {
      fs.rmdirSync(folder);
      fs.symlinkSync(external, folder, "junction");
      return { type: "exportTheme", requestId: 1, colors: testColors };
    };
    assert.match(await invokeTool(tool, { file: "reports/public.html" }), /symbolic link/);
    assert.deepStrictEqual(fs.readdirSync(external), []);
  });

  test("reports a failed render and a failed editor write", async () => {
    panel.captureTheme = async () => "The diagram fails to render.";
    assert.match(await invokeTool(tool, { file: "report.html" }), /fails to render/);
    panel.captureTheme = async () => ({ type: "exportTheme", requestId: 1, colors: testColors });
    replace(vscode.workspace, "applyEdit", async () => false);
    assert.match(await invokeTool(tool, { file: "report.html" }), /could not be saved/);
    assert.deepStrictEqual(fs.readdirSync(directory), []);
  });

  test("exports chart source already loaded without rereading its data file", async () => {
    const chart = { type: "bar", file: "data.csv" } as const;
    const source = '{"series":[{"type":"bar","data":[1,2]}]}';
    await panel.render({ language: "echarts", title: "Chart", source, chart }, "tool");
    const reads: string[] = [];
    const readFile = vscode.workspace.fs.readFile;
    replace(vscode.workspace, "fs", {
      ...vscode.workspace.fs,
      readFile: async (uri) => {
        reads.push(uri.path);
        return readFile(uri);
      },
    });
    assert.match(await invokeTool(tool, { file: "chart.html" }), /Exported revision/);
    assert.ok(
      reads.every((file) => /standalone\.(?:js|css)$/.test(file)),
      JSON.stringify(reads),
    );
    const html = fs.readFileSync(path.join(directory, "chart.html"), "utf8");
    assert.match(html, /echarts@6\.1\.0/);
    assert.ok(html.includes(JSON.stringify(source)));
    assert.ok(!html.includes("data.csv"));
  });

  test("exports only the rendered chart data, without filtered input rows or old source", async () => {
    const source = '{"series":[{"type":"pie","data":[{"name":"Public","value":1}]}]}';
    const chart = {
      type: "pie",
      data: "name,value\nPublic,1\nPRIVATE_FILTERED_ROW,2",
      filters: [{ column: "name", op: "eq", value: "Public" }],
    } as const;
    await panel.render(
      {
        language: "echarts",
        title: "Public chart",
        source,
        chart: { ...chart, filters: [...chart.filters] },
      },
      "tool",
    );
    const state = panel.current;
    assert.ok(state);
    Object.assign(state, {
      userEdit: { from: "PRIVATE_OLD_SOURCE", to: source },
      openedFrom: "file:///PRIVATE_WORKSPACE_PATH/chart.echarts",
    });
    assert.match(await invokeTool(tool, { file: "public.html" }), /Exported revision/);
    const html = fs.readFileSync(path.join(directory, "public.html"), "utf8");
    assert.ok(html.includes(JSON.stringify(source)));
    assert.doesNotMatch(html, /PRIVATE_FILTERED_ROW|PRIVATE_OLD_SOURCE|PRIVATE_WORKSPACE_PATH/);
  });
});
