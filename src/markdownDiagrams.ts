import * as vscode from "vscode";
import { guessTitle } from "./blocks";
import {
  type DiagramFence,
  fenceAt,
  findDocumentDiagramFences,
  isDiagramFence,
  relocateFence,
} from "./fences";
import type { DiagramPanel } from "./panel";
import { diagramNoun, errorMessage } from "./protocol";

// Requires CodeLens arguments, so it is not contributed to the Command Palette.
const OPEN_FENCE_COMMAND = "diagram.openFence";
const OPEN_AT_CURSOR_COMMAND = "diagram.openAtCursor";
const SETTINGS_SECTION = "diagram";
const CODE_LENS_SETTING = "codeLens.enabled";

export function registerMarkdownDiagrams(panel: DiagramPanel): vscode.Disposable[] {
  const lenses = new DiagramCodeLensProvider();
  return [
    lenses,
    vscode.languages.registerCodeLensProvider({ language: "markdown" }, lenses),
    vscode.commands.registerCommand(OPEN_FENCE_COMMAND, async (uri: unknown, fence: unknown) => {
      // Other extensions can call this command with arbitrary arguments.
      if (uri instanceof vscode.Uri && isDiagramFence(fence)) {
        await openFence(panel, uri, fence);
      }
    }),
    vscode.commands.registerCommand(OPEN_AT_CURSOR_COMMAND, () => openAtCursor(panel)),
  ];
}

class DiagramCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private readonly settingListener: vscode.Disposable;

  constructor() {
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
    return findDocumentDiagramFences(document).map((fence) => {
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
  const fences = findDocumentDiagramFences(document);
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

async function openAtCursor(panel: DiagramPanel): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor?.document.languageId !== "markdown") {
    void vscode.window.showInformationMessage(
      "Open a Markdown file to open a diagram or chart that is written in it.",
    );
    return;
  }
  const fences = findDocumentDiagramFences(editor.document);
  const fence = fenceAt(fences, editor.selection.active.line);
  if (!fence) {
    void vscode.window.showInformationMessage(
      `${vscode.workspace.asRelativePath(editor.document.uri)} holds no mermaid or echarts code block to open.`,
    );
    return;
  }
  await openInPanel(panel, editor.document, fence);
}

/** Opens a document diagram and reports failures that the webview cannot display. */
async function openInPanel(
  panel: DiagramPanel,
  document: vscode.TextDocument,
  fence: DiagramFence,
): Promise<void> {
  const outcome = await panel.render(
    {
      language: fence.language,
      source: fence.source,
      title: guessTitle(fence),
      document: { uri: document.uri.toString(), fence },
    },
    "document",
  );
  if (!outcome.ok && outcome.kind === "unavailable") {
    void vscode.window.showWarningMessage(outcome.error);
  }
}
