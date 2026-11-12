import * as fs from "node:fs";
import * as vscode from "vscode";
import {
  type DiagramFence,
  findDocumentDiagramFences,
  relocateFence,
  rewriteFence,
  trimBlankLines,
} from "./fences";
import { baseName, contains, openDocument } from "./files";
import { diagramNoun, errorMessage } from "./protocol";

// The last-read fence detects conflicting edits.
export interface DocumentBinding {
  uri: string;
  fence: DiagramFence;
  // By an agent: writing needs confirmation.
  replaced?: boolean;
}

export function documentName({ uri }: DocumentBinding): string {
  return baseName(vscode.Uri.parse(uri));
}

// Cell URIs have the path of their notebook.
export const NOTEBOOK_CELL = "vscode-notebook-cell";

export function openCell(
  uri: string,
): { notebook: vscode.NotebookDocument; index: number } | undefined {
  if (!uri.startsWith(`${NOTEBOOK_CELL}:`)) return undefined;
  for (const notebook of vscode.workspace.notebookDocuments) {
    const index = notebook.getCells().findIndex((cell) => cell.document.uri.toString() === uri);
    if (index !== -1) return { notebook, index };
  }
  return undefined;
}

export function notebookOf(uri: vscode.Uri): vscode.Uri {
  if (uri.scheme !== NOTEBOOK_CELL) return uri;
  const open = openCell(uri.toString());
  if (open) return open.notebook.uri;
  const folder = vscode.workspace.workspaceFolders?.find((root) =>
    contains(root.uri, uri.with({ scheme: root.uri.scheme, fragment: "" })),
  );
  return folder ? uri.with({ scheme: folder.uri.scheme, fragment: "" }) : uri;
}

// An untitled document is found only while open: opening it again would make an empty one.
async function openBound(binding: DocumentBinding): Promise<vscode.TextDocument> {
  const uri = vscode.Uri.parse(binding.uri);
  const isBound = (other: vscode.Uri) => other.toString() === binding.uri;
  if (
    uri.scheme === "untitled" &&
    !vscode.workspace.textDocuments.some((document) => isBound(document.uri)) &&
    !vscode.window.tabGroups.all.some((group) =>
      group.tabs.some(({ input }) => input instanceof vscode.TabInputText && isBound(input.uri)),
    )
  ) {
    throw new Error(`${documentName(binding)} was closed or saved under another name.`);
  }
  return openDocument(uri);
}

// As far as an extension can tell: VS Code does not tell of session read-only documents.
export function isReadonly(document: vscode.TextDocument): boolean {
  const { uri } = document;
  if (vscode.workspace.fs.isWritableFileSystem(uri.scheme) === false) return true;
  if (document.isUntitled) return false;
  const settings = vscode.workspace.getConfiguration("files", document);
  // Of the path, or of the path within a workspace folder, as VS Code matches them.
  const folders = vscode.workspace.workspaceFolders ?? [];
  const matches = (setting: string) =>
    Object.entries(settings.get<Record<string, unknown>>(setting) ?? {}).some(
      ([glob, on]) =>
        on === true &&
        [glob, ...folders.map((folder) => new vscode.RelativePattern(folder, glob))].some(
          (pattern) => vscode.languages.match({ pattern }, document) > 0,
        ),
    );
  if (matches("readonlyInclude") && !matches("readonlyExclude")) return true;
  if (uri.scheme === "file" && settings.get<boolean>("readonlyFromPermissions") === true) {
    try {
      fs.accessSync(uri.fsPath, fs.constants.W_OK);
    } catch {
      return true;
    }
  }
  return false;
}

type WriteOutcome = { written: true; fence: DiagramFence } | { written: false; reason: string };

// Refuses ambiguous or changed blocks, and source that would not read back unchanged. isCurrent
// guards against panel changes while opening the document. Leaves the document unsaved.
export async function writeFence(
  binding: DocumentBinding,
  source: string,
  isCurrent?: () => boolean,
): Promise<WriteOutcome> {
  const name = documentName(binding);
  const noun = diagramNoun(binding.fence.language);
  const diagram = trimBlankLines(source.split(/\r\n|\r|\n/));
  if (!diagram) {
    return { written: false, reason: `There is no ${noun} to write to ${name}.` };
  }
  let document: vscode.TextDocument;
  try {
    document = await openBound(binding);
  } catch (error) {
    return { written: false, reason: `Could not write the ${noun}: ${errorMessage(error)}` };
  }
  if (isReadonly(document)) {
    return {
      written: false,
      reason: `${name} is read-only, so the ${noun} was not written to it.`,
    };
  }
  const changed = {
    written: false,
    reason: `The ${binding.fence.language} block in ${name} has changed or cannot be identified safely, so it was not overwritten. Copy the ${noun} to paste it into the block, or reopen the block with Open in Diagram, which replaces the ${noun} in the panel.`,
  } as const;
  for (let attempt = 1; ; attempt++) {
    if (isCurrent && !isCurrent()) {
      return {
        written: false,
        reason: "The diagram changed before it could be written. Review it and write it again.",
      };
    }
    const fence = relocateFence(findDocumentDiagramFences(document), binding.fence);
    if (!fence) {
      return changed;
    }
    if (fence.source === diagram) {
      return { written: true, fence };
    }
    const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    // In the text the scan read rather than VS Code's lines, which may split unusual breaks.
    const rewrite = rewriteFence(document.getText(), fence, diagram, eol);
    if (!rewrite) {
      return changed;
    }
    if (!("fence" in rewrite)) {
      const line = diagram.split("\n")[rewrite.endingLine];
      return {
        written: false,
        reason: `The ${noun} contains a closing Markdown fence on line ${rewrite.endingLine + 1}, ${JSON.stringify(line)}, so it was not written to ${name}. Use a longer fence around the block in the document and reopen it.`,
      };
    }
    const range = new vscode.Range(
      document.positionAt(rewrite.start),
      document.positionAt(rewrite.end),
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, range, rewrite.text);
    const version = document.version;
    try {
      if (await vscode.workspace.applyEdit(edit)) {
        return { written: true, fence: rewrite.fence };
      }
    } catch (error) {
      return {
        written: false,
        reason: `Could not write the ${noun} to ${name}: ${errorMessage(error)}`,
      };
    }
    if (document.version === version) {
      return {
        written: false,
        reason: `Could not write the ${noun} to ${name}: VS Code refused the edit. Check that the file is not read-only.`,
      };
    }
    // VS Code refuses an edit of a document that changed meanwhile: find the block again.
    if (attempt === MAX_WRITE_ATTEMPTS) {
      return {
        written: false,
        reason: `Could not write the ${noun} to ${name}, as the file kept changing. Write it again.`,
      };
    }
  }
}

const MAX_WRITE_ATTEMPTS = 3;

// For diagrams an agent changed, or chart code may have edited or asked to write.
export async function confirmWrite(
  binding: DocumentBinding,
  cause: "replaced" | "code",
): Promise<boolean> {
  const name = documentName(binding);
  const noun = diagramNoun(binding.fence.language);
  const why =
    cause === "replaced"
      ? `An agent changed the ${noun} that was opened from ${name}.`
      : `The panel ran JavaScript code from a chart, which can apply edits and press Write to ${name} as if you had.`;
  const write = await vscode.window.showWarningMessage(
    `Write this ${noun} to ${name}?`,
    {
      modal: true,
      detail: `${why} Writing replaces the ${binding.fence.language} block it came from with what the panel shows now.`,
    },
    "Write",
  );
  return write !== undefined;
}

// Offers to copy the source, as reopening the block replaces it in the panel.
export async function reportWriteFailure(
  binding: DocumentBinding,
  reason: string,
  source: string,
): Promise<void> {
  const name = documentName(binding);
  const copy = binding.fence.language === "echarts" ? "Copy Chart" : "Copy Diagram";
  const action = await vscode.window.showWarningMessage(reason, `Open ${name}`, copy);
  if (action === undefined) {
    return;
  }
  if (action !== copy) return showBlock(binding);
  try {
    await vscode.env.clipboard.writeText(source);
  } catch (error) {
    void vscode.window.showErrorMessage(errorMessage(error));
  }
}

async function showBlock(binding: DocumentBinding): Promise<void> {
  try {
    const document = await openBound(binding);
    const line = new vscode.Position(binding.fence.openingLine, 0);
    await vscode.window.showTextDocument(document, { selection: new vscode.Range(line, line) });
  } catch (error) {
    void vscode.window.showErrorMessage(errorMessage(error));
  }
}
