import * as vscode from "vscode";
import { DiagramPanel } from "./panel";
import { createParticipantHandler, PARTICIPANT_ID } from "./participant";
import { GET_STATE_TOOL, GetDiagramStateTool, RENDER_TOOL, RenderDiagramTool } from "./tools";

export function activate(context: vscode.ExtensionContext): void {
  const panel = new DiagramPanel(context);

  const participant = vscode.chat.createChatParticipant(
    PARTICIPANT_ID,
    createParticipantHandler(panel),
  );
  participant.iconPath = new vscode.ThemeIcon("type-hierarchy");

  context.subscriptions.push(
    panel,
    participant,
    vscode.lm.registerTool(RENDER_TOOL, new RenderDiagramTool(panel)),
    vscode.lm.registerTool(GET_STATE_TOOL, new GetDiagramStateTool(panel)),
    vscode.commands.registerCommand("diagram.show", () => panel.show()),
    vscode.window.registerWebviewPanelSerializer(DiagramPanel.viewType, {
      async deserializeWebviewPanel(webviewPanel) {
        panel.restore(webviewPanel);
      },
    }),
  );
}

export function deactivate(): void {}
