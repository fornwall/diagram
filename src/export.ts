// Export the drawing shown in the panel as PNG, SVG or offline interactive HTML.

import * as os from "node:os";
import * as vscode from "vscode";
import { fileName } from "./files";
import {
  type DiagramLanguage,
  diagramNoun,
  type ExportFormat,
  type ExportResult,
  errorClause,
  errorMessage,
  safeFileName,
} from "./protocol";
import { savedChartHtml } from "./savedChart";

const PNG_DATA_URL = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/;

/** The bytes of a PNG data URL from the page, unless it is not one. */
export function pngBytes(dataUrl: string): Uint8Array | undefined {
  const base64 = PNG_DATA_URL.exec(dataUrl)?.[1];
  return base64 === undefined ? undefined : Buffer.from(base64, "base64");
}

/** Where the last export went, where the next one is likely to go too. */
let lastFolder: vscode.Uri | undefined;

/**
 * Asks for a format, captures the drawing in it and saves it where the user chooses. capture asks
 * the webview for the drawing, and throws if it changed while the user was choosing. A drawing
 * opened from a document is saved beside it by default, where the document can show the image.
 */
export async function exportDrawing(
  drawing: {
    language: DiagramLanguage;
    title: string;
    source: string;
    document?: vscode.Uri | undefined;
  },
  capture: (format: ExportFormat) => Promise<ExportResult>,
  extensionUri: vscode.Uri,
): Promise<void> {
  const noun = diagramNoun(drawing.language);
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
      title: noun === "chart" ? "Export Chart" : "Export Diagram",
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
        const png = pngBytes(result.data);
        if (!png) {
          throw new Error("The panel returned an invalid PNG image. Try exporting as SVG.");
        }
        bytes = png;
      } else {
        bytes = new TextEncoder().encode(result.data);
      }
    } else {
      throw new Error("The panel returned the wrong export format. Try again.");
    }
    const folder =
      defaultFolder(drawing.document) ??
      vscode.workspace.workspaceFolders?.[0]?.uri ??
      vscode.Uri.file(os.homedir());
    const target = await vscode.window.showSaveDialog({
      title: `Export ${choice.label}`,
      saveLabel: "Export",
      defaultUri: vscode.Uri.joinPath(folder, `${safeFileName(drawing.title, noun)}.${format}`),
      filters: { [choice.label]: [format] },
    });
    if (!target) return;
    try {
      await vscode.workspace.fs.writeFile(target, bytes);
    } catch (error) {
      throw saveError(error, target);
    }
    lastFolder = vscode.Uri.joinPath(target, "..");
    void offerToOpen(target, noun, format);
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not export the ${noun}: ${errorMessage(error)}`);
  }
}

/**
 * The folder of the document a drawing was opened from, or of the last export, if that is in it, as
 * when images go in a folder of their own; without a document on a file system that can be
 * written, unlike an untitled one, a Git revision or a notebook's cell, that of the last export.
 */
function defaultFolder(document: vscode.Uri | undefined): vscode.Uri | undefined {
  if (!document || vscode.workspace.fs.isWritableFileSystem(document.scheme) !== true) {
    return lastFolder;
  }
  const folder = vscode.Uri.joinPath(document, "..");
  const within =
    lastFolder?.scheme === folder.scheme &&
    lastFolder.authority === folder.authority &&
    `${lastFolder.path}/`.startsWith(folder.path.endsWith("/") ? folder.path : `${folder.path}/`);
  return within ? lastFolder : folder;
}

/** Says why the file could not be saved, without the "Error: " that VS Code puts before it. */
function saveError(error: unknown, target: vscode.Uri): Error {
  return new Error(
    error instanceof vscode.FileSystemError && error.code === "NoPermissions"
      ? `You do not have permission to save ${fileName(target)}. Choose another folder.`
      : errorMessage(error).replace(/^Error: /, ""),
  );
}

/**
 * Says where the export was saved, and opens it if the user asks: an image in VS Code, and a page in
 * the user's browser, where its chart is interactive.
 */
async function offerToOpen(target: vscode.Uri, noun: string, format: ExportFormat): Promise<void> {
  try {
    const name = target.path.split("/").pop() || target.path;
    const open = await vscode.window.showInformationMessage(
      `Saved the ${noun} to ${name}.`,
      "Open",
    );
    if (!open) return;
    if (format !== "html") {
      await vscode.commands.executeCommand("vscode.open", target);
    } else if (!(await vscode.env.openExternal(target))) {
      throw new Error("No application accepted the file");
    }
  } catch (error) {
    const where = format === "html" ? " in your browser" : "";
    void vscode.window.showErrorMessage(
      `Could not open the saved ${noun}: ${errorClause(error)}. Open ${target.fsPath}${where}.`,
    );
  }
}
