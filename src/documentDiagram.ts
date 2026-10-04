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

type WriteOutcome = { written: true; fence: DiagramFence } | { written: false; reason: string };

/**
 * Replaces an unchanged fence's content with an undoable workspace edit, preserving fence markers,
 * block quote markers, indentation and line endings. Refuses ambiguous or changed blocks, and
 * source that would not read back unchanged. isCurrent guards against panel changes while opening
 * the document.
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
    document = await openDocument(vscode.Uri.parse(binding.uri));
  } catch (error) {
    return { written: false, reason: `Could not write the ${noun}: ${errorMessage(error)}` };
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
  try {
    if (!(await vscode.workspace.applyEdit(edit))) {
      return {
        written: false,
        reason: `Could not write the ${noun} to ${name}: VS Code refused the edit. Check that the file is not read-only.`,
      };
    }
  } catch (error) {
    return {
      written: false,
      reason: `Could not write the ${noun} to ${name}: ${errorMessage(error)}`,
    };
  }
  return { written: true, fence: rewrite.fence };
}

/**
 * Confirms writing to the original document a diagram that an agent replaced, or that JavaScript
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
      ? `An agent replaced the ${noun} that was opened from ${name}.`
      : "The panel ran JavaScript code from a chart, which can apply edits and press Write as if you had.";
  const write = await vscode.window.showWarningMessage(
    `Write this ${noun} to ${name}?`,
    {
      modal: true,
      detail: `${why} Applying replaces the ${binding.fence.language} block it came from with what the panel shows now.`,
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
    const document = await openDocument(vscode.Uri.parse(binding.uri));
    const line = new vscode.Position(binding.fence.openingLine, 0);
    await vscode.window.showTextDocument(document, { selection: new vscode.Range(line, line) });
  } catch (error) {
    void vscode.window.showErrorMessage(errorMessage(error));
  }
}
