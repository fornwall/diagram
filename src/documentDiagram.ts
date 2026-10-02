// A diagram that was opened from a fenced code block in a document: where it came from, and writing
// what the user applies in the panel back into that very block. The file is only ever written for an
// explicit action of the user's; see DiagramPanel.applyEdit.

import * as vscode from "vscode";
import { isClosingFence, openingFence } from "./blocks";
import { type DiagramFence, fenceSource, findDiagramFences, relocateFence } from "./fences";
import { diagramNoun, errorMessage } from "./protocol";

/**
 * The block a diagram shown in the panel was opened from. The document is kept as a URI string and
 * the fence as plain lines and text, as the panel's state is saved as JSON; the fence is the one
 * last read or written, which is what the document must still hold for a write to go ahead.
 */
export interface DocumentBinding {
  /** The document, as vscode.Uri.toString(). */
  uri: string;
  fence: DiagramFence;
  /**
   * Set when an agent replaced the diagram after it was opened from the document: the binding is
   * kept, so that the user can still write what they end up with back to the file, but what the
   * panel shows is no longer what they opened, so the next write asks them first. An agent's render
   * never writes by itself.
   */
  replaced?: boolean;
}

/** The name of the document a diagram came from, as the panel's title and its messages name it. */
export function documentName({ uri }: DocumentBinding): string {
  const { path } = vscode.Uri.parse(uri);
  return path.split("/").pop() || path;
}

/** Whether a diagram was written back, and else why not, as the panel tells the user. */
export type WriteOutcome =
  | { written: true; fence: DiagramFence }
  | { written: false; reason: string };

/**
 * Writes a diagram into the block it was opened from, replacing its content lines alone: the fence
 * markers, their length and their indentation, the document's line endings and whether it ends with
 * a newline are all left as they are. The edit goes through a workspace edit, so that the user can
 * undo it in the editor.
 *
 * The block is located again first, as it may have moved and may have been edited since it was read.
 * A document that no longer holds what was read is never written over: the user is told instead.
 * If supplied, isCurrent also checks that the panel's write is still current after opening the file.
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
  const diagram = fenceSource(source.split(/\r?\n/), "");
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

/**
 * Asks before writing a diagram that an agent drew into the document the panel's diagram was opened
 * from. Applying is the user's own action, but the diagram is no longer the one they opened.
 */
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

/**
 * Says why a diagram was not written back, and opens the document if the user wants to reconcile it
 * themselves, at the line the block was on.
 */
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
