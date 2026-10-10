import * as vscode from "vscode";
import { guessTitle } from "./blocks";
import { isReadonly } from "./documentDiagram";
import {
  type DiagramFence,
  emptyDiagramBlockAt,
  fenceAt,
  findDocumentDiagramFences,
  isDiagramFence,
  relocateFence,
  setMermaidLanguages,
} from "./fences";
import { openDocument } from "./files";
import type { DiagramPanel } from "./panel";
import { diagramNoun, errorMessage } from "./protocol";

// Requires CodeLens arguments, so it is not contributed to the Command Palette.
const OPEN_FENCE_COMMAND = "diagram.openFence";
const OPEN_AT_CURSOR_COMMAND = "diagram.openAtCursor";
const SETTINGS_SECTION = "diagram";
const CODE_LENS_SETTING = "codeLens.enabled";
/** The fence languages that VS Code's preview draws as Mermaid, from its Mermaid extension. */
const MERMAID_LANGUAGES_SETTING = "markdown-mermaid.languages";
/** Whether the active editor is a Markdown document with a diagram, as its context menu shows. */
const EDITOR_HAS_DIAGRAM_CONTEXT = "diagram.editorHasDiagram";
/** How long typing in the active editor goes on before it is looked through for diagrams again. */
const TYPING_DELAY_MS = 250;

export function registerMarkdownDiagrams(panel: DiagramPanel): vscode.Disposable[] {
  const lenses = new DiagramCodeLensProvider();
  return [
    lenses,
    trackEditorDiagrams(lenses.onDidChangeCodeLenses),
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
    readMermaidLanguages();
    this.settingListener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(MERMAID_LANGUAGES_SETTING)) {
        readMermaidLanguages();
        this.changed.fire();
      } else if (event.affectsConfiguration(`${SETTINGS_SECTION}.${CODE_LENS_SETTING}`)) {
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

/**
 * Keeps the context key that shows Open Diagram at Cursor in the context menu of the active editor
 * only while it holds a diagram, also after typing or as settings, which settingsChanged tells,
 * change what counts as one.
 */
function trackEditorDiagrams(settingsChanged: vscode.Event<void>): vscode.Disposable {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let holds: boolean | undefined;
  const update = () => {
    clearTimeout(timer);
    timer = undefined;
    const document = vscode.window.activeTextEditor?.document;
    const now =
      document?.languageId === "markdown" && findDocumentDiagramFences(document).length > 0;
    if (now !== holds) {
      holds = now;
      void vscode.commands.executeCommand("setContext", EDITOR_HAS_DIAGRAM_CONTEXT, now);
    }
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(update, TYPING_DELAY_MS);
  };
  update();
  return vscode.Disposable.from(
    vscode.window.onDidChangeActiveTextEditor(update),
    vscode.workspace.onDidChangeTextDocument(({ document }) => {
      if (document === vscode.window.activeTextEditor?.document) later();
    }),
    // A change of language opens the document again.
    vscode.workspace.onDidOpenTextDocument(later),
    settingsChanged(later),
    { dispose: () => clearTimeout(timer) },
  );
}

/** Finds diagrams where VS Code's preview draws them, with its default for an invalid setting. */
function readMermaidLanguages(): void {
  const words = vscode.workspace.getConfiguration().get<unknown>(MERMAID_LANGUAGES_SETTING);
  setMermaidLanguages(
    Array.isArray(words) && words.every((word) => typeof word === "string") ? words : ["mermaid"],
  );
}

async function openFence(panel: DiagramPanel, uri: vscode.Uri, fence: DiagramFence): Promise<void> {
  let document: vscode.TextDocument;
  try {
    document = await openDocument(uri);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Could not open the ${diagramNoun(fence.language)}: ${errorMessage(error)}`,
    );
    return;
  }
  // Follow a moved block by its content, or an edited block at the same opening line, which a
  // block of another language that moved there is not.
  const fences = findDocumentDiagramFences(document);
  const current =
    relocateFence(fences, fence) ??
    fences.find(
      ({ openingLine, language }) =>
        openingLine === fence.openingLine && language === fence.language,
    );
  if (!current) {
    void vscode.window.showWarningMessage(
      `The ${fence.language} block that was at line ${fence.openingLine + 1} of ${vscode.workspace.asRelativePath(uri)} moved or was removed. If it is still there, use the Open in Diagram action above it.`,
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
  const { line } = editor.selection.active;
  const empty = emptyDiagramBlockAt(editor.document.getText(), line);
  if (empty) {
    void vscode.window.showInformationMessage(
      `The ${empty.language} block at line ${empty.openingLine + 1} is empty. Write a ${diagramNoun(empty.language)} in it to open it.`,
    );
    return;
  }
  const fence = fenceAt(findDocumentDiagramFences(editor.document), line);
  if (!fence) {
    void vscode.window.showInformationMessage(
      `${vscode.workspace.asRelativePath(editor.document.uri)} holds no mermaid or echarts code block to open.`,
    );
    return;
  }
  await openInPanel(panel, editor.document, fence);
}

/**
 * Opens a document diagram, bound to its block unless the document is read-only, and reports
 * failures that the webview cannot display.
 */
async function openInPanel(
  panel: DiagramPanel,
  document: vscode.TextDocument,
  fence: DiagramFence,
): Promise<void> {
  const readonly = isReadonly(document);
  if (readonly) {
    void vscode.window.showInformationMessage(
      `${vscode.workspace.asRelativePath(document.uri)} is read-only, so edits of the ${diagramNoun(fence.language)} in the panel are not written to it.`,
    );
  }
  const outcome = await panel.render(
    {
      language: fence.language,
      source: fence.source,
      title: guessTitle(fence),
      ...(readonly
        ? { openedFrom: document.uri.toString() }
        : { document: { uri: document.uri.toString(), fence } }),
    },
    "document",
  );
  if (!outcome.ok && outcome.kind === "unavailable") {
    void vscode.window.showWarningMessage(outcome.error);
  }
}
