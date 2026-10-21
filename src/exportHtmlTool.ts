// Agent export to a named, undoable HTML file. Source/data stay embedded; renderers use a CDN.

import * as vscode from "vscode";
import { throwIfCancelled, unlessCancelled } from "./cancellation";
import { cdnDiagramHtml } from "./cdnDiagram";
import { fileName, pathOutside, resolveFile } from "./files";
import type { DiagramPanel } from "./panel";
import { diagramNoun, EXPORT_HTML_TOOL, errorMessage, GET_STATE_TOOL } from "./protocol";
import { nonBlank, toolInput } from "./text";
import { noDiagram, textResult } from "./toolResults";

interface ExportHtmlInput {
  file: string;
  revision?: number;
  overwrite?: boolean;
}

function exportInput(value: unknown): {
  target: vscode.Uri;
  revision?: number;
  overwrite: boolean;
} {
  const input = toolInput(value, ["file", "revision", "overwrite"]);
  const file = nonBlank(input.file);
  if (!file || file.length > 4096 || !/\.html?$/i.test(file) || /[\0\r\n]/.test(file)) {
    throw new Error('Give "file", a path ending in .html or .htm, such as "diagram.html".');
  }
  if (
    input.revision !== undefined &&
    (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0)
  ) {
    throw new Error(`"revision" must be a nonnegative integer from ${GET_STATE_TOOL}.`);
  }
  if (input.overwrite !== undefined && typeof input.overwrite !== "boolean") {
    throw new Error('"overwrite" must be true or false; omit it to create a new file.');
  }
  return {
    target: resolveFile(file),
    ...(input.revision !== undefined && { revision: Number(input.revision) }),
    overwrite: input.overwrite === true,
  };
}

/** Do not replace an editor's unsaved work, even if the disk file may be overwritten. */
function checkDirty(target: vscode.Uri): void {
  if (
    vscode.workspace.textDocuments.some(
      (document) => document.uri.toString() === target.toString() && document.isDirty,
    )
  ) {
    throw new Error(`${fileName(target)} has unsaved edits. Save it first or choose another file.`);
  }
}

/** The approved path must not silently change to one outside the workspace through a link. */
function checkDestination(target: vscode.Uri): void {
  const outside = pathOutside(target);
  if (outside !== undefined) {
    throw new Error(
      `The export path leads outside the workspace through a symbolic link. Call ${EXPORT_HTML_TOOL} with the resolved path ${JSON.stringify(outside)} instead.`,
    );
  }
  checkDirty(target);
}

export class ExportDiagramHtmlTool implements vscode.LanguageModelTool<ExportHtmlInput> {
  constructor(
    private readonly panel: DiagramPanel,
    private readonly extensionUri: vscode.Uri,
  ) {}

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<ExportHtmlInput>,
  ): vscode.PreparedToolInvocation {
    try {
      const { target, revision, overwrite } = exportInput(options.input);
      const which = revision === undefined ? "the current diagram" : `diagram revision ${revision}`;
      const message = new vscode.MarkdownString();
      message.appendText(
        `Export ${which} to this HTML file${overwrite ? ", replacing it if it exists" : ", without overwriting an existing file"}?`,
      );
      message.appendCodeblock(target.fsPath, "text");
      message.appendText(
        "The source and data are embedded. Opening it requires internet access to load Mermaid or ECharts from jsDelivr; chart JavaScript callbacks run in the browser.",
      );
      return {
        invocationMessage: `Exporting the diagram to ${fileName(target)}`,
        confirmationMessages: { title: "Export diagram to HTML?", message },
      };
    } catch {
      return { invocationMessage: "Exporting the diagram to HTML" };
    }
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ExportHtmlInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      throwIfCancelled(token);
      const { target, revision: expected, overwrite } = exportInput(options.input);
      const state = this.panel.current;
      const revision = this.panel.revision;
      if (!state) throw new Error(noDiagram("export"));
      if (expected !== undefined && expected !== revision) {
        throw new Error(`The diagram changed. Read ${GET_STATE_TOOL} and retry with its revision.`);
      }
      const current = () => {
        throwIfCancelled(token);
        if (this.panel.revision !== revision) {
          throw new Error(`The diagram changed during export. Read ${GET_STATE_TOOL} and retry.`);
        }
      };
      checkDestination(target);
      let exists: vscode.FileStat | undefined;
      try {
        exists = await unlessCancelled(async () => vscode.workspace.fs.stat(target), token);
      } catch (error) {
        if (!(error instanceof vscode.FileSystemError && error.code === "FileNotFound"))
          throw error;
      }
      if (
        exists &&
        (exists.type & vscode.FileType.Directory || !(exists.type & vscode.FileType.File))
      ) {
        throw new Error(`${fileName(target)} is not a regular file. Choose another name.`);
      }
      if (exists?.type && exists.type & vscode.FileType.SymbolicLink) {
        throw new Error(`${fileName(target)} is a symbolic link. Choose a regular file instead.`);
      }
      if (exists && !overwrite) {
        throw new Error(
          `${fileName(target)} already exists. Choose another name, or set "overwrite": true to replace it.`,
        );
      }
      const parent = vscode.Uri.joinPath(target, "..");
      try {
        const folder = await unlessCancelled(async () => vscode.workspace.fs.stat(parent), token);
        if (!(folder.type & vscode.FileType.Directory)) throw new Error("Not a folder");
      } catch (error) {
        if (error instanceof vscode.CancellationError) throw error;
        throw new Error(
          `The destination folder ${fileName(parent)} is unavailable. Choose an existing folder.`,
        );
      }
      current();
      const theme = await unlessCancelled(() => this.panel.captureTheme(), token);
      if (typeof theme === "string") throw new Error(theme);
      current();
      // captureTheme rejects a source that was not retained or could not render.
      const { source } = state;
      if (source === undefined) throw new Error("Refresh the chart before exporting it.");
      const html = await unlessCancelled(
        () =>
          cdnDiagramHtml(
            { language: state.language, title: state.title, source },
            theme.colors,
            this.extensionUri,
          ),
        token,
      );
      current();
      checkDestination(target);
      const edit = new vscode.WorkspaceEdit();
      edit.createFile(target, { contents: new TextEncoder().encode(html), overwrite });
      // The editor enforces overwrite atomically with creation, including files created meanwhile.
      if (!(await vscode.workspace.applyEdit(edit))) {
        throw new Error("The HTML file could not be saved. Check the destination and retry.");
      }
      return textResult(
        `Exported revision ${revision} of the ${diagramNoun(state.language)} to ${target.toString(true)}. ` +
          "This single HTML file embeds the source and data and loads its version-pinned renderer from jsDelivr. " +
          "Internet access is required when opening it. Chart data commands are not rerun; panel selections, marks, chat actions and workspace code links are not exported.",
      );
    } catch (error) {
      if (error instanceof vscode.CancellationError) throw error;
      return textResult(`The HTML was not exported: ${errorMessage(error)}`);
    }
  }
}
