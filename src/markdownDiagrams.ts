// Opening a diagram that is already written in a Markdown file: the "Open in Diagram" CodeLens above
// each ```mermaid and ```echarts block, and the commands that show one in the panel.

import * as vscode from "vscode";
import { guessTitle } from "./blocks";
import {
  type DiagramFence,
  fenceAt,
  findDiagramFences,
  isDiagramFence,
  relocateFence,
} from "./fences";
import type { DiagramPanel } from "./panel";
import { diagramNoun, errorMessage } from "./protocol";

/**
 * Opens the block a CodeLens points at. It is registered in code alone and not in
 * contributes.commands: a command that needs arguments must not be offered in the Command Palette,
 * which would call it without any.
 */
const OPEN_FENCE_COMMAND = "diagram.openFence";
/** Opens the diagram at the cursor, as contributed to the Command Palette in package.json. */
const OPEN_AT_CURSOR_COMMAND = "diagram.openAtCursor";
const SETTINGS_SECTION = "diagram";
/** Whether the CodeLenses are shown: they are intrusive, so they can be turned off. */
const CODE_LENS_SETTING = "codeLens.enabled";

/** Offers the diagrams written in Markdown documents to the panel, with a CodeLens and a command. */
export function registerMarkdownDiagrams(panel: DiagramPanel): vscode.Disposable[] {
  const lenses = new DiagramCodeLensProvider();
  return [
    lenses,
    vscode.languages.registerCodeLensProvider({ language: "markdown" }, lenses),
    vscode.commands.registerCommand(OPEN_FENCE_COMMAND, async (uri: unknown, fence: unknown) => {
      // The arguments come back through VS Code with the lens, and another extension may pass
      // anything at all, so only a document and a block of its own open anything.
      if (uri instanceof vscode.Uri && isDiagramFence(fence)) {
        await openFence(panel, uri, fence);
      }
    }),
    vscode.commands.registerCommand(OPEN_AT_CURSOR_COMMAND, () => openAtCursor(panel)),
  ];
}

/** Offers to open each diagram in a Markdown document in the panel, while the setting allows it. */
class DiagramCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private readonly settingListener: vscode.Disposable;

  constructor() {
    // Turning the lenses off, or on again, takes effect in the documents already open.
    this.settingListener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${SETTINGS_SECTION}.${CODE_LENS_SETTING}`)) {
        this.changed.fire();
      }
    });
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const settings = vscode.workspace.getConfiguration(SETTINGS_SECTION, document);
    if (!settings.get<boolean>(CODE_LENS_SETTING, true)) {
      return [];
    }
    return findDiagramFences(document.getText()).map((fence) => {
      const line = new vscode.Position(fence.openingLine, 0);
      return new vscode.CodeLens(new vscode.Range(line, line), {
        title: "Open in Diagram",
        tooltip: `Show this ${diagramNoun(fence.language)} in the diagram panel, where you can edit it and write it back`,
        command: OPEN_FENCE_COMMAND,
        arguments: [document.uri, fence],
      });
    });
  }

  dispose(): void {
    this.settingListener.dispose();
    this.changed.dispose();
  }
}

/** Opens the diagram a block holds, as a CodeLens asks. */
async function openFence(panel: DiagramPanel, uri: vscode.Uri, fence: DiagramFence): Promise<void> {
  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(uri);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Could not open ${vscode.workspace.asRelativePath(uri)}: ${errorMessage(error)}`,
    );
    return;
  }
  // Follow a moved block by its content, or an edited block at the same opening line.
  const fences = findDiagramFences(document.getText());
  const current =
    relocateFence(fences, fence) ??
    fences.find((candidate) => candidate.openingLine === fence.openingLine);
  if (!current) {
    void vscode.window.showWarningMessage(
      "This diagram block moved or was removed. Use its current Open in Diagram action.",
    );
    return;
  }
  await openInPanel(panel, document, current);
}

/** Opens the diagram the cursor is in, or the nearest one, as the Command Palette asks. */
async function openAtCursor(panel: DiagramPanel): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor?.document.languageId !== "markdown") {
    void vscode.window.showInformationMessage(
      "Open a Markdown file to open a diagram or chart that is written in it.",
    );
    return;
  }
  const fences = findDiagramFences(editor.document.getText());
  const fence = fenceAt(fences, editor.selection.active.line);
  if (!fence) {
    void vscode.window.showInformationMessage(
      `${vscode.workspace.asRelativePath(editor.document.uri)} holds no mermaid or echarts code block to open.`,
    );
    return;
  }
  await openInPanel(panel, editor.document, fence);
}

/**
 * Shows a document's diagram in the panel, which remembers the block it came from, so that the
 * user's Apply writes their edits back into it. A diagram that fails to render is reported by the
 * panel itself, as it is for an agent's.
 */
async function openInPanel(
  panel: DiagramPanel,
  document: vscode.TextDocument,
  fence: DiagramFence,
): Promise<void> {
  await panel.render(
    {
      language: fence.language,
      source: fence.source,
      title: guessTitle(fence),
      document: { uri: document.uri.toString(), fence },
    },
    "document",
  );
}
