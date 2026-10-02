import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Diagram, DiagramPanel } from "../panel";
import type { ExportFormat, FromWebview, ToWebview } from "../protocol";
import { newPanel } from "./newPanel";

const diagram: Diagram = {
  language: "mermaid",
  title: "Export / test",
  source: "flowchart LR\n A[Export label] --> B[Done]",
};
const chart: Diagram = {
  language: "echarts",
  title: "Export chart",
  source: '{"series":[{"type":"pie","data":[{"name":"Export label","value":3}]}]}',
};
type Choice = vscode.QuickPickItem & { format: ExportFormat };

suite("native export", function () {
  this.timeout(20_000);
  let panel: DiagramPanel;
  let directory: string;
  let offered: Choice[];
  let dialogs: vscode.SaveDialogOptions[];
  let errors: string[];
  let chosen: ExportFormat | undefined;
  let cancelSave: boolean;
  let choose: ((items: Choice[]) => Promise<Choice | undefined>) | undefined;
  const quickPick = vscode.window.showQuickPick;
  const saveDialog = vscode.window.showSaveDialog;
  const showError = vscode.window.showErrorMessage;
  const information = vscode.window.showInformationMessage;

  setup(() => {
    panel = newPanel();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "diagram-export-test-"));
    offered = [];
    dialogs = [];
    errors = [];
    chosen = "svg";
    cancelSave = false;
    choose = undefined;
    vscode.window.showQuickPick = (async (items: Choice[]) => {
      offered = items;
      return choose ? choose(items) : items.find((item) => item.format === chosen);
    }) as unknown as typeof quickPick;
    vscode.window.showSaveDialog = async (options) => {
      dialogs.push(options ?? {});
      return cancelSave ? undefined : vscode.Uri.file(path.join(directory, `export.${chosen}`));
    };
    vscode.window.showErrorMessage = async (message: string) => {
      errors.push(message);
      return undefined;
    };
    vscode.window.showInformationMessage = async () => undefined;
  });
  teardown(() => {
    vscode.window.showQuickPick = quickPick;
    vscode.window.showSaveDialog = saveDialog;
    vscode.window.showErrorMessage = showError;
    vscode.window.showInformationMessage = information;
    panel.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  for (const drawing of [diagram, chart]) {
    for (const format of (drawing.language === "echarts"
      ? ["png", "svg", "html"]
      : ["png", "svg"]) as ExportFormat[]) {
      test(`exports ${drawing.language} as ${format} through the real webview`, async () => {
        assert.ok((await panel.render(drawing, "tool")).ok);
        chosen = format;
        await panel.exportDiagram();
        assert.deepStrictEqual(errors, []);
        assert.deepStrictEqual(
          offered.map((item) => item.format),
          drawing.language === "echarts" ? ["png", "svg", "html"] : ["png", "svg"],
        );
        assert.strictEqual(dialogs.length, 1);
        assert.strictEqual(
          dialogs[0]?.defaultUri?.path.split("/").pop(),
          `${drawing.language === "mermaid" ? "Export test" : "Export chart"}.${format}`,
        );
        const bytes = fs.readFileSync(path.join(directory, `export.${format}`));
        if (format === "png") {
          assert.deepStrictEqual(
            bytes.subarray(0, 8),
            Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
          );
          assert.ok(bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0);
        } else {
          assert.match(bytes.toString(), /Export[\s\S]*label/);
          assert.match(bytes.toString(), format === "svg" ? /<svg/ : /<!doctype html>/i);
        }
      });
    }
  }

  test("cancels the picker and save dialog without writing", async () => {
    assert.ok((await panel.render(diagram, "tool")).ok);
    chosen = undefined;
    await panel.exportDiagram();
    assert.strictEqual(dialogs.length, 0);
    chosen = "svg";
    cancelSave = true;
    await panel.exportDiagram();
    assert.strictEqual(dialogs.length, 1);
    assert.deepStrictEqual(fs.readdirSync(directory), []);
    assert.deepStrictEqual(errors, []);
  });

  test("rejects a diagram replaced while the picker is open", async () => {
    assert.ok((await panel.render(diagram, "tool")).ok);
    choose = async (items) => {
      assert.ok((await panel.render(chart, "tool")).ok);
      return items[0];
    };
    await panel.exportDiagram();
    assert.strictEqual(dialogs.length, 0);
    assert.match(errors[0] ?? "", /changed.*choosing a format/);
  });

  test("keeps the captured image when the diagram changes during the save dialog", async () => {
    assert.ok((await panel.render(diagram, "tool")).ok);
    vscode.window.showSaveDialog = async () => {
      assert.ok((await panel.render(chart, "tool")).ok);
      return vscode.Uri.file(path.join(directory, "snapshot.svg"));
    };
    await panel.exportDiagram();
    assert.deepStrictEqual(errors, []);
    assert.match(fs.readFileSync(path.join(directory, "snapshot.svg"), "utf8"), /Done/);
  });

  for (const action of ["replace", "reload", "close"] as const) {
    test(`ends a pending export on ${action}, ignores stale replies, and permits retry`, async () => {
      assert.ok((await panel.render(diagram, "tool")).ok);
      const internals = panel as unknown as {
        post(message: ToWebview): Promise<void>;
        onMessage(message: FromWebview): void;
      };
      const post = internals.post.bind(panel);
      const captured = Promise.withResolvers<Extract<ToWebview, { type: "export" }>>();
      internals.post = async (message) => {
        if (message.type === "export") captured.resolve(message);
        else await post(message);
      };
      const exporting = panel.exportDiagram();
      const request = await captured.promise;
      internals.onMessage({
        type: "exportError",
        requestId: request.requestId + 1,
        message: "stale",
      });
      if (action === "replace") await panel.render(chart, "tool");
      else if (action === "reload") internals.onMessage({ type: "ready" });
      else panel.dispose();
      await exporting;
      assert.strictEqual(dialogs.length, 0);
      assert.strictEqual(errors.length, 1);
      assert.match(errors[0] ?? "", /changed|reloaded|closed/);
      internals.onMessage({
        type: "exportImage",
        requestId: request.requestId,
        format: "svg",
        data: "late",
      });
      internals.post = post;
      assert.ok((await panel.render(diagram, "tool")).ok);
      await panel.exportDiagram();
      assert.strictEqual(dialogs.length, 1);
      assert.strictEqual(errors.length, 1);
    });
  }
});
