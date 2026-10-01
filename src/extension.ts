import * as vscode from "vscode";
import { DiagramPanel } from "./panel";
import { createParticipantHandler, PARTICIPANT_ID } from "./participant";
import {
  CHART_TOOL,
  ChartTool,
  GET_STATE_TOOL,
  GetDiagramStateTool,
  PICK_NODES_TOOL,
  PickDiagramNodesTool,
  RENDER_TOOL,
  RenderDiagramTool,
} from "./tools";

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
    vscode.lm.registerTool(CHART_TOOL, new ChartTool(panel)),
    vscode.lm.registerTool(GET_STATE_TOOL, new GetDiagramStateTool(panel)),
    vscode.lm.registerTool(PICK_NODES_TOOL, new PickDiagramNodesTool(panel)),
    vscode.commands.registerCommand("diagram.show", () => panel.show()),
    vscode.window.registerWebviewPanelSerializer(DiagramPanel.viewType, {
      async deserializeWebviewPanel(webviewPanel) {
        panel.restore(webviewPanel);
      },
    }),
  );
}

export function deactivate(): void {}
