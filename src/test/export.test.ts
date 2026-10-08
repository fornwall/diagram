import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import * as vscode from "vscode";
import type { Diagram, DiagramPanel } from "../panel";
import type { ExportFormat, ToWebview } from "../protocol";
import { recordMessages, replace, tempDir } from "./afterTest";
import { type FakeWebview, newFakePanel, newPanel, showInFake } from "./newPanel";

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

/** The chunks of a PNG after its signature, each of which must end in its CRC. */
function pngChunks(png: Buffer): { type: string; data: Buffer }[] {
  const chunks = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    const typed = png.subarray(at + 4, at + 8 + length);
    assert.strictEqual(png.readUInt32BE(at + 8 + length), zlib.crc32(typed));
    chunks.push({ type: typed.subarray(0, 4).toString("latin1"), data: typed.subarray(4) });
    at += 12 + length;
  }
  return chunks;
}

suite("export", function () {
  this.timeout(20_000);
  let directory: string;
  let offered: Choice[];
  let pickerTitles: (string | undefined)[];
  let dialogs: vscode.SaveDialogOptions[];
  let errors: string[];
  let chosen: ExportFormat | undefined;
  let cancelSave: boolean;
  let choose: ((items: Choice[]) => Promise<Choice | undefined>) | undefined;

  setup(() => {
    directory = tempDir("diagram-export-test-");
    offered = [];
    pickerTitles = [];
    dialogs = [];
    chosen = "svg";
    cancelSave = false;
    choose = undefined;
    replace(vscode.window, "showQuickPick", (async (
      items: Choice[],
      options?: vscode.QuickPickOptions,
    ) => {
      offered = items;
      pickerTitles.push(options?.title);
      return choose ? choose(items) : items.find((item) => item.format === chosen);
    }) as unknown as typeof vscode.window.showQuickPick);
    replace(vscode.window, "showSaveDialog", async (options) => {
      dialogs.push(options ?? {});
      return cancelSave ? undefined : vscode.Uri.file(path.join(directory, `export.${chosen}`));
    });
    errors = recordMessages("showErrorMessage");
    recordMessages("showInformationMessage");
  });

  suite("through the real webview", () => {
    let panel: DiagramPanel;
    suiteSetup(() => {
      panel = newPanel();
    });
    suiteTeardown(() => panel.dispose());

    for (const drawing of [diagram, chart]) {
      for (const format of (drawing.language === "echarts"
        ? ["png", "svg", "html"]
        : ["png", "svg"]) as ExportFormat[]) {
        test(`exports ${drawing.language} as ${format}`, async () => {
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
            const chunks = pngChunks(bytes);
            assert.deepStrictEqual(
              chunks.filter((chunk) => chunk.type !== "IDAT").map((chunk) => chunk.type),
              ["IHDR", "pHYs", "IEND"],
            );
            const [header, resolution] = chunks;
            assert.ok(header && header.data.readUInt32BE(0) > 0 && header.data.readUInt32BE(4) > 0);
            // Two pixels per CSS pixel, at 96 CSS pixels per inch, in pixels per meter.
            assert.deepStrictEqual(
              resolution?.data,
              Buffer.from([0, 0, 29, 135, 0, 0, 29, 135, 1]),
            );
          } else {
            assert.match(bytes.toString(), /Export[\s\S]*label/);
            assert.match(bytes.toString(), format === "svg" ? /<svg/ : /<!doctype html>/i);
          }
        });
      }
    }
  });

  /** A fake page that draws everything, and exports the source it shows as an SVG image. */
  async function exportingPanel() {
    const fake = await newFakePanel();
    const draw = fake.webview.answer;
    fake.webview.answer = (message) =>
      message.type === "export"
        ? {
            type: "exportImage",
            requestId: message.requestId,
            format: "svg",
            data: `<svg>${fake.webview.render.source}</svg>`,
          }
        : draw?.(message);
    return fake;
  }

  test("cancels the picker and save dialog without writing", async () => {
    const { panel } = await exportingPanel();
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

  test("suggests the folder of the last export", async () => {
    const { panel } = await exportingPanel();
    assert.ok((await panel.render(diagram, "tool")).ok);
    await panel.exportDiagram();
    await panel.exportDiagram();
    assert.strictEqual(dialogs[1]?.defaultUri?.fsPath, path.join(directory, "Export test.svg"));
  });

  test("says whether it exports a diagram or a chart, and names an untitled one so", async () => {
    const { panel } = await exportingPanel();
    for (const drawing of [diagram, chart]) {
      assert.ok((await panel.render({ ...drawing, title: " / " }, "tool")).ok);
      await panel.exportDiagram();
      // The page answers with SVG, which is not the PNG asked for.
      chosen = "png";
      await panel.exportDiagram();
      chosen = "svg";
    }
    assert.deepStrictEqual(pickerTitles, [
      "Export Diagram",
      "Export Diagram",
      "Export Chart",
      "Export Chart",
    ]);
    assert.deepStrictEqual(
      dialogs.map((dialog) => dialog.defaultUri?.path.split("/").pop()),
      ["diagram.svg", "chart.svg"],
    );
    assert.deepStrictEqual(errors, [
      "Could not export the diagram: The panel returned the wrong export format. Try again.",
      "Could not export the chart: The panel returned the wrong export format. Try again.",
    ]);
  });

  test("rejects a diagram replaced while the picker is open", async () => {
    const { panel } = await exportingPanel();
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
    const { panel } = await exportingPanel();
    assert.ok((await panel.render(diagram, "tool")).ok);
    replace(vscode.window, "showSaveDialog", async () => {
      assert.ok((await panel.render(chart, "tool")).ok);
      return vscode.Uri.file(path.join(directory, "snapshot.svg"));
    });
    await panel.exportDiagram();
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(
      fs.readFileSync(path.join(directory, "snapshot.svg"), "utf8"),
      `<svg>${diagram.source}</svg>`,
    );
  });

  test("says why it could not save the export", async () => {
    const { panel } = await exportingPanel();
    assert.ok((await panel.render(diagram, "tool")).ok);
    const folder = path.join(directory, "folder.svg");
    fs.mkdirSync(folder);
    const readOnly = path.join(directory, "read-only");
    fs.mkdirSync(readOnly, { mode: 0o555 });
    for (const target of [folder, path.join(readOnly, "export.svg")]) {
      replace(vscode.window, "showSaveDialog", async () => vscode.Uri.file(target));
      await panel.exportDiagram();
    }
    assert.deepStrictEqual(errors, [
      `Could not export the diagram: EISDIR: illegal operation on a directory, open '${folder}'`,
      `Could not export the diagram: You do not have permission to save ${path.join(readOnly, "export.svg")}. Choose another folder.`,
    ]);
  });

  // The wrong format is reported in "says whether it exports a diagram or a chart".
  test("reports an invalid PNG", async () => {
    const { panel, webview } = await newFakePanel();
    const draw = webview.answer;
    webview.answer = (message) =>
      message.type === "export"
        ? {
            type: "exportImage",
            requestId: message.requestId,
            format: "png",
            data: "data:image/jpeg;base64,AAAA",
          }
        : draw?.(message);
    assert.ok((await panel.render(diagram, "tool")).ok);
    chosen = "png";
    await panel.exportDiagram();
    assert.deepStrictEqual(errors, [
      "Could not export the diagram: The panel returned an invalid PNG image. Try exporting as SVG.",
    ]);
    assert.deepStrictEqual(dialogs, []);
  });

  for (const action of ["replace", "reload", "close"] as const) {
    test(`ends a pending export on ${action}, ignores stale replies, and permits retry`, async () => {
      const { panel, webview: page } = await newFakePanel();
      let webview = page;
      const requested: Extract<ToWebview, { type: "export" }>[] = [];
      /** Answers renders, and exports once the first export request is ended. */
      const answering = (page: FakeWebview) => {
        const answer = page.answer;
        page.answer = (message) => {
          if (message.type !== "export") return answer?.(message);
          requested.push(message);
          return requested.length > 1
            ? { type: "exportImage", requestId: message.requestId, format: "svg", data: "<svg/>" }
            : undefined;
        };
      };
      answering(webview);
      assert.ok((await panel.render(diagram, "tool")).ok);
      const exporting = panel.exportDiagram();
      while (requested.length === 0) await new Promise((resolve) => setImmediate(resolve));
      const [request] = requested;
      assert.ok(request);
      await webview.receive({
        type: "exportError",
        requestId: request.requestId + 1,
        message: "stale",
      });
      if (action === "replace") await panel.render(chart, "tool");
      else if (action === "reload") await webview.receive({ type: "ready" });
      else {
        webview.panel.dispose();
        webview = await showInFake(panel);
        answering(webview);
      }
      await exporting;
      assert.strictEqual(dialogs.length, 0);
      assert.strictEqual(errors.length, 1);
      assert.match(errors[0] ?? "", /changed|reloaded|closed/);
      await webview.receive({
        type: "exportImage",
        requestId: request.requestId,
        format: "svg",
        data: "late",
      });
      assert.ok((await panel.render(diagram, "tool")).ok);
      await panel.exportDiagram();
      assert.strictEqual(dialogs.length, 1);
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(fs.readFileSync(path.join(directory, "export.svg"), "utf8"), "<svg/>");
    });
  }
});
