import * as vscode from "vscode";
import { guessTitle } from "./mermaid";
import type { DiagramPanel } from "./panel";

export const RENDER_TOOL = "diagram_render";
export const GET_STATE_TOOL = "diagram_getState";

interface RenderInput {
  source: string;
  title?: string;
}

/** Lets any agent show a Mermaid diagram in the interactive diagram panel. */
export class RenderDiagramTool implements vscode.LanguageModelTool<RenderInput> {
  constructor(private readonly panel: DiagramPanel) {}

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<RenderInput>,
  ): vscode.PreparedToolInvocation {
    const title = options.input.title ?? guessTitle(options.input.source);
    return { invocationMessage: `Rendering diagram "${title}"` };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RenderInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const { source, title = guessTitle(source) } = options.input;
    const outcome = await this.panel.render(source, title, "tool");
    const text = outcome.ok
      ? `Rendered the ${outcome.diagramType} diagram in the diagram panel next to the chat. The user can select nodes, edit the source and send follow-up requests about it; use the ${GET_STATE_TOOL} tool to see the current source and what the user has selected.`
      : `The diagram failed to render with this error:\n\n${outcome.error}\n\nFix the Mermaid syntax and call ${RENDER_TOOL} again with the complete corrected diagram.`;
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
  }
}

/** Lets any agent see the current diagram, including the user's edits and selection. */
export class GetDiagramStateTool implements vscode.LanguageModelTool<Record<string, never>> {
  constructor(private readonly panel: DiagramPanel) {}

  prepareInvocation(): vscode.PreparedToolInvocation {
    return { invocationMessage: "Reading the diagram panel" };
  }

  invoke(): vscode.LanguageModelToolResult {
    const text =
      this.panel.describeForModel() ??
      `No diagram has been rendered yet. Use the ${RENDER_TOOL} tool to show one.`;
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
  }
}
