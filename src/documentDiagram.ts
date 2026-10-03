import * as vscode from "vscode";
import { isClosingFence, openingFence } from "./blocks";
import { type DiagramFence, fenceSource, findDiagramFences, relocateFence } from "./fences";
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

export type WriteOutcome =
  | { written: true; fence: DiagramFence }
  | { written: false; reason: string };

/**
 * Replaces an unchanged fence's content with an undoable workspace edit, preserving fence markers,
 * indentation and line endings. Refuses ambiguous or changed blocks. isCurrent guards against
 * panel changes while opening the document.
 */
export async function writeFence(
  binding: DocumentBinding,
  source: string,
  isCurrent?: () => boolean,
): Promise<WriteOutcome> {
  const name = documentName(binding);
  const noun = diagramNoun(binding.fence.language);
  // Written as a fence is read: no blank lines around the diagram, and every line indented like the
  // opening fence, which may sit in a list item.
  const diagram = fenceSource(source.split(/\r\n|\r|\n/), "");
  if (!diagram) {
    return { written: false, reason: `There is no ${noun} to write to ${name}.` };
  }
  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(vscode.Uri.parse(binding.uri));
  } catch (error) {
    return { written: false, reason: `Could not open ${name}: ${errorMessage(error)}` };
  }
  if (isCurrent && !isCurrent()) {
    return {
      written: false,
      reason: "The diagram changed before it could be written. Review it and write it again.",
    };
  }
  const changed = {
    written: false,
    reason: `The ${binding.fence.language} block in ${name} has changed or cannot be identified safely, so it was not overwritten. Reopen it with Open in Diagram to continue.`,
  } as const;
  const fence = relocateFence(findDiagramFences(document.getText()), binding.fence);
  if (!fence) {
    return changed;
  }
  const lines = diagram.split("\n").map((line) => (line.trim() ? fence.indent + line : line));
  const opening = openingFence(document.lineAt(fence.openingLine).text);
  if (!opening) {
    return changed;
  }
  if (lines.some((line) => isClosingFence(line, opening.fence))) {
    return {
      written: false,
      reason: `The ${noun} contains a closing Markdown fence, so it was not written to ${name}. Use a longer fence around the block in the document and reopen it.`,
    };
  }

  const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
  const closingLine = fence.lastLine + 1;
  // A block that is never closed ends at the end of the document, whose last line may have no
  // newline of its own to keep.
  const end =
    closingLine < document.lineCount
      ? new vscode.Position(closingLine, 0)
      : document.lineAt(fence.lastLine).range.end;
  const range = new vscode.Range(new vscode.Position(fence.openingLine + 1, 0), end);
  // The lines the block was found on must hold what was found on them, whatever VS Code makes of
  // the document's line endings. Anything else means the range is not the diagram's.
  if (fenceSource(document.getText(range).split(/\r?\n/), fence.indent) !== fence.source) {
    return changed;
  }

  const text = lines.join(eol);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, range, end.character === 0 ? `${text}${eol}` : text);
  try {
    if (!(await vscode.workspace.applyEdit(edit))) {
      return { written: false, reason: `Could not write the ${noun} to ${name}.` };
    }
  } catch (error) {
    return {
      written: false,
      reason: `Could not write the ${noun} to ${name}: ${errorMessage(error)}`,
    };
  }
  // The block now holds the diagram that was written, and has grown or shrunk with it.
  return {
    written: true,
    fence: {
      ...fence,
      source: fenceSource(lines, fence.indent),
      lastLine: fence.openingLine + lines.length,
    },
  };
}

/** Confirms writing an agent replacement back to the original document. */
export async function confirmReplacedWrite(binding: DocumentBinding): Promise<boolean> {
  const name = documentName(binding);
  const noun = diagramNoun(binding.fence.language);
  const write = await vscode.window.showWarningMessage(
    `Write this ${noun} to ${name}?`,
    {
      modal: true,
      detail: `An agent replaced the ${noun} that was opened from ${name}. Applying replaces the ${binding.fence.language} block it came from with what the panel shows now.`,
    },
    "Write",
  );
  return write !== undefined;
}

/** Reports a failed write and offers to open the original block. */
export async function reportWriteFailure(binding: DocumentBinding, reason: string): Promise<void> {
  const name = documentName(binding);
  if ((await vscode.window.showWarningMessage(reason, `Open ${name}`)) === undefined) {
    return;
  }
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(binding.uri));
    const line = new vscode.Position(binding.fence.openingLine, 0);
    await vscode.window.showTextDocument(document, { selection: new vscode.Range(line, line) });
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not open ${name}: ${errorMessage(error)}`);
  }
}
