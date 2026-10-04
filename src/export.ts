// Export the drawing shown in the panel as PNG, SVG or offline interactive HTML.

import * as os from "node:os";
import * as vscode from "vscode";
import {
  type DiagramLanguage,
  type ExportFormat,
  type ExportResult,
  errorMessage,
  safeFileName,
} from "./protocol";
import { savedChartHtml } from "./savedChart";

const PNG_DATA_URL = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * Asks for a format, captures the drawing in it and saves it where the user chooses. capture asks
 * the webview for the drawing, and throws if it changed while the user was choosing.
 */
export async function exportDrawing(
  drawing: { language: DiagramLanguage; title: string; source: string },
  capture: (format: ExportFormat) => Promise<ExportResult>,
  extensionUri: vscode.Uri,
): Promise<void> {
  try {
    const formats: (vscode.QuickPickItem & { format: ExportFormat })[] = [
      { label: "PNG image", description: ".png", format: "png" },
      { label: "SVG image", description: ".svg", format: "svg" },
    ];
    if (drawing.language === "echarts") {
      formats.push({
        label: "Interactive HTML",
        description: ".html · Works offline",
        format: "html",
      });
    }
    const choice = await vscode.window.showQuickPick(formats, {
      title: "Export Diagram",
      placeHolder: "Choose an export format",
    });
    if (!choice) return;
    const { format } = choice;
    const result = await capture(format);
    let bytes: Uint8Array;
    if (result.type === "exportError") {
      throw new Error(result.message);
    } else if (format === "html" && result.type === "exportTheme") {
      const { title, source } = drawing;
      const html = await savedChartHtml({ title, source, colors: result.colors }, extensionUri);
      bytes = new TextEncoder().encode(html);
    } else if (result.type === "exportImage" && result.format === format) {
      if (format === "png") {
        const base64 = PNG_DATA_URL.exec(result.data)?.[1];
        if (!base64)
          throw new Error("The panel returned an invalid PNG image. Try exporting as SVG.");
        bytes = Buffer.from(base64, "base64");
      } else {
        bytes = new TextEncoder().encode(result.data);
      }
    } else {
      throw new Error("The panel returned the wrong export format. Try again.");
    }
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
    const target = await vscode.window.showSaveDialog({
      title: `Export ${choice.label}`,
      saveLabel: "Export",
      defaultUri: vscode.Uri.joinPath(
        folder,
        `${safeFileName(drawing.title, "diagram")}.${format}`,
      ),
      filters: { [choice.label]: [format] },
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, bytes);
    if (format === "html") void offerToOpen(target);
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not export the diagram: ${errorMessage(error)}`);
  }
}

/** Says where a chart was saved, and opens it in the user's browser if they ask. */
async function offerToOpen(target: vscode.Uri): Promise<void> {
  try {
    const name = target.path.split("/").pop() || target.path;
    const open = await vscode.window.showInformationMessage(`Saved the chart to ${name}.`, "Open");
    if (open && !(await vscode.env.openExternal(target))) {
      throw new Error("No application accepted the file");
    }
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Could not open the saved chart: ${errorMessage(error)}. Open ${target.fsPath} in your browser.`,
    );
  }
}
