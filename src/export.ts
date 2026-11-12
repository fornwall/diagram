import * as os from "node:os";
import * as vscode from "vscode";
import { notebookOf } from "./documentDiagram";
import { baseName, contains, fileName } from "./files";
import {
  type DiagramLanguage,
  diagramNoun,
  type ExportFormat,
  type ExportResult,
  errorClause,
  errorMessage,
  safeFileName,
} from "./protocol";

const PNG_DATA_URL = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/;

export function pngBytes(dataUrl: string): Uint8Array | undefined {
  const base64 = PNG_DATA_URL.exec(dataUrl)?.[1];
  return base64 === undefined ? undefined : Buffer.from(base64, "base64");
}

let lastFolder: vscode.Uri | undefined;

// capture throws if the drawing changed while the user was choosing.
export async function exportDrawing(
  drawing: {
    language: DiagramLanguage;
    title: string;
    document?: vscode.Uri | undefined;
  },
  capture: (format: ExportFormat) => Promise<ExportResult>,
): Promise<void> {
  const noun = diagramNoun(drawing.language);
  try {
    const formats: (vscode.QuickPickItem & { format: ExportFormat })[] = [
      { label: "PNG image", description: ".png", format: "png" },
      { label: "SVG image", description: ".svg", format: "svg" },
    ];
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
    void offerToOpen(target, noun);
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not export the ${noun}: ${errorMessage(error)}`);
  }
}

// Beside the document, or in the last export's folder if that is within it (as for an images
// folder). Without a writable document, such as an untitled one or a Git revision, the last one.
function defaultFolder(opened: vscode.Uri | undefined): vscode.Uri | undefined {
  const document = opened && notebookOf(opened);
  if (!document || vscode.workspace.fs.isWritableFileSystem(document.scheme) !== true) {
    return lastFolder;
  }
  const folder = vscode.Uri.joinPath(document, "..");
  // Windows ignores case.
  return lastFolder && contains(folder, lastFolder) ? lastFolder : folder;
}

// Without the "Error: " that VS Code prefixes.
function saveError(error: unknown, target: vscode.Uri): Error {
  const code = error instanceof vscode.FileSystemError ? error.code : undefined;
  const message = errorMessage(error).replace(/^Error: /, "");
  if (code === "NoPermissions") {
    return new Error(
      `You do not have permission to save ${fileName(target)}. Choose another folder.`,
    );
  }
  // VS Code passes on the Node.js error of a local folder as it is.
  if (code === "FileIsADirectory" || message.startsWith("EISDIR:")) {
    return new Error(`${fileName(target)} is a folder. Choose another name.`);
  }
  return new Error(message);
}

async function offerToOpen(target: vscode.Uri, noun: string): Promise<void> {
  try {
    const open = await vscode.window.showInformationMessage(
      `Saved the ${noun} to ${baseName(target)}.`,
      "Open",
    );
    if (!open) return;
    await vscode.commands.executeCommand("vscode.open", target);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Could not open the saved ${noun}: ${errorClause(error)}. Open ${target.fsPath}.`,
    );
  }
}
