import * as vscode from "vscode";
import { guessTitle } from "./mermaid";
import type { DiagramPanel } from "./panel";

export const RENDER_TOOL = "diagram_render";
export const GET_STATE_TOOL = "diagram_getState";
export const PICK_NODES_TOOL = "diagram_pickNodes";

interface RenderInput {
  source: string;
  title?: string;
  clickPrompt?: string;
}

interface PickNodesInput {
  prompt: string;
  multiple?: boolean;
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
    const { source, title = guessTitle(source), clickPrompt } = options.input;
    const outcome = await this.panel.render(source, title, "tool", clickPrompt || undefined);
    const clicks = clickPrompt
      ? "Clicking a node sends your click prompt to the chat on the user's behalf."
      : `The user can select nodes and send follow-up requests about them; use ${PICK_NODES_TOOL} to ask them to click a node.`;
    const text = outcome.ok
      ? `Rendered the ${outcome.diagramType} diagram in the diagram panel next to the chat. ${clicks} The user can also edit the source; use ${GET_STATE_TOOL} to see the current source and selection.`
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

/** Lets any agent ask the user to answer by clicking nodes in the diagram. */
export class PickDiagramNodesTool implements vscode.LanguageModelTool<PickNodesInput> {
  constructor(private readonly panel: DiagramPanel) {}

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<PickNodesInput>,
  ): vscode.PreparedToolInvocation {
    return { invocationMessage: `Waiting for you to pick in the diagram: ${options.input.prompt}` };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<PickNodesInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { prompt, multiple = false } = options.input;
    const outcome = await this.panel.pickNodes(prompt, multiple, token);
    const text = outcome.picked
      ? `The user picked: ${outcome.nodes.map((node) => `"${node.label}" (id: ${node.id})`).join(", ")}.`
      : `No node was picked: ${outcome.reason}`;
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
  }
}
