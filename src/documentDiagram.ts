import * as fs from "node:fs";
import * as vscode from "vscode";
import {
  type DiagramFence,
  findDocumentDiagramFences,
  relocateFence,
  rewriteFence,
  trimBlankLines,
} from "./fences";
import { openDocument } from "./files";
import { diagramNoun, errorMessage } from "./protocol";

/** JSON-serializable document location and last-read fence, used to detect conflicting edits. */
export interface DocumentBinding {
  /** The document, as vscode.Uri.toString(). */
  uri: string;
  fence: DiagramFence;
  /** Agent replacements retain the binding but require confirmation before writing. */
  replaced?: boolean;
}

export function documentName({ uri }: DocumentBinding): string {
  const { path } = vscode.Uri.parse(uri);
  return path.split("/").pop() || path;
}

/**
 * Opens the bound document. One that was never saved is found only while it is open, in a tab or
 * not yet disposed, as opening it after it was closed or saved elsewhere would make an empty one.
 */
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

/**
 * Whether VS Code keeps the document from being changed and saved, as far as an extension can tell:
 * on a read-only file system, such as a Git revision, by the files.readonlyInclude setting, or, with
 * files.readonlyFromPermissions, as the file may not be written. Not one made read-only for the
 * session, which VS Code does not tell extensions.
 */
export function isReadonly(document: vscode.TextDocument): boolean {
  const { uri } = document;
  if (vscode.workspace.fs.isWritableFileSystem(uri.scheme) === false) return true;
  if (document.isUntitled) return false;
  const settings = vscode.workspace.getConfiguration("files", document);
  // Globs as VS Code matches them: of the path, or of the path within a workspace folder.
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

/**
 * Replaces an unchanged fence's content with an undoable workspace edit, preserving fence markers,
 * block quote markers, indentation and line endings. Refuses ambiguous or changed blocks, and
 * source that would not read back unchanged. isCurrent guards against panel changes while opening
 * the document. An edit that races with typing in the document is made again on what it holds now.
 */
export async function writeFence(
  binding: DocumentBinding,
  source: string,
  isCurrent?: () => boolean,
): Promise<WriteOutcome> {
  const name = documentName(binding);
  const noun = diagramNoun(binding.fence.language);
  // Written as a fence is read: no blank lines around the diagram.
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
    // The scan read this text, so the replacement is located in the text rather than in VS Code's
    // lines, whatever either makes of unusual line breaks.
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
    // VS Code refuses an edit of a document that changed after the edit was made, as when the user
    // types meanwhile. Find the block again in what the document holds now.
    if (attempt === MAX_WRITE_ATTEMPTS) {
      return {
        written: false,
        reason: `Could not write the ${noun} to ${name}, as the file kept changing. Write it again.`,
      };
    }
  }
}

/** How often a write is tried while the document changes under it. */
const MAX_WRITE_ATTEMPTS = 3;

/**
 * Confirms writing to the original document a diagram that an agent changed, or that JavaScript
 * code from a chart in the panel may have edited or asked to write.
 */
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

/**
 * Reports a failed write and offers to open the original block, or to copy the source that was not
 * written, to paste it there, as reopening the block replaces it in the panel.
 */
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

/**
 * The documents that {@link reportUnshownWrite} told of, until they are saved or a write finds them
 * saved, as after a revert.
 */
const reportedUnsaved = new Set<string>();

/** Forgets the report of a document once it is saved, for a later write to be reported again. */
export function forgetReportsOnSave(): vscode.Disposable {
  return vscode.workspace.onDidSaveTextDocument(({ uri }) =>
    reportedUnsaved.delete(uri.toString()),
  );
}

/**
 * Tells the user of a write to a document that no tab shows, as when its tab was closed, which
 * VS Code keeps unsaved with only the Explorer to mark it, and offers to show it: once until the
 * document is saved, which `savedBefore` says it was before the write.
 */
export async function reportUnshownWrite(
  binding: DocumentBinding,
  savedBefore: boolean,
): Promise<void> {
  if (savedBefore) reportedUnsaved.delete(binding.uri);
  const document = vscode.workspace.textDocuments.find(({ uri }) => uri.toString() === binding.uri);
  const shown = vscode.window.tabGroups.all.some((group) =>
    group.tabs.some(({ input }) => {
      if (input instanceof vscode.TabInputText) return input.uri.toString() === binding.uri;
      if (input instanceof vscode.TabInputTextDiff) {
        return [input.original, input.modified].some((uri) => uri.toString() === binding.uri);
      }
      return (
        input instanceof vscode.TabInputNotebook &&
        vscode.workspace.notebookDocuments.some(
          (notebook) =>
            notebook.uri.toString() === input.uri.toString() &&
            notebook.getCells().some((cell) => cell.document.uri.toString() === binding.uri),
        )
      );
    }),
  );
  if (shown || !document?.isDirty || reportedUnsaved.has(binding.uri)) return;
  reportedUnsaved.add(binding.uri);
  const name = documentName(binding);
  const show = `Show ${name}`;
  const action = await vscode.window.showInformationMessage(
    `The ${diagramNoun(binding.fence.language)} was written to ${name}, which is not open in an editor. Save it to keep the change.`,
    show,
  );
  if (action === show) await showBlock(binding);
}

/** Opens the bound document at its block, saying why if it cannot. */
async function showBlock(binding: DocumentBinding): Promise<void> {
  try {
    const document = await openBound(binding);
    const line = new vscode.Position(binding.fence.openingLine, 0);
    await vscode.window.showTextDocument(document, { selection: new vscode.Range(line, line) });
  } catch (error) {
    void vscode.window.showErrorMessage(errorMessage(error));
  }
}
