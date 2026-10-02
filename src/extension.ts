import * as vscode from "vscode";
import { InspectDataTool, UpdateChartTool } from "./chartTools";
import { registerMarkdownDiagrams } from "./markdownDiagrams";
import { DiagramPanel } from "./panel";
import { createParticipantHandler, PARTICIPANT_ID } from "./participant";
import {
  ANNOTATE_TOOL,
  CHART_TOOL,
  FIND_FILES_TOOL,
  GET_STATE_TOOL,
  INSPECT_DATA_TOOL,
  PICK_NODES_TOOL,
  READ_FILE_TOOL,
  RENDER_TOOL,
  SEARCH_TEXT_TOOL,
  UPDATE_CHART_TOOL,
} from "./protocol";
import {
  AnnotateDiagramTool,
  ChartTool,
  GetDiagramStateTool,
  PickDiagramNodesTool,
  RenderDiagramTool,
} from "./tools";
import {
  FindWorkspaceFilesTool,
  ReadWorkspaceFileTool,
  SearchWorkspaceTextTool,
} from "./workspaceTools";

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
    vscode.lm.registerTool(ANNOTATE_TOOL, new AnnotateDiagramTool(panel)),
    vscode.lm.registerTool(FIND_FILES_TOOL, new FindWorkspaceFilesTool()),
    vscode.lm.registerTool(SEARCH_TEXT_TOOL, new SearchWorkspaceTextTool()),
    vscode.lm.registerTool(READ_FILE_TOOL, new ReadWorkspaceFileTool()),
    vscode.lm.registerTool(INSPECT_DATA_TOOL, new InspectDataTool(panel)),
    vscode.lm.registerTool(UPDATE_CHART_TOOL, new UpdateChartTool(panel)),
    vscode.commands.registerCommand("diagram.show", () => panel.show()),
    vscode.commands.registerCommand("diagram.export", () => panel.exportDiagram()),
    vscode.commands.registerCommand("diagram.chartOptions", () => panel.toggleChartOptions()),
    ...registerMarkdownDiagrams(panel),
    vscode.window.registerWebviewPanelSerializer(DiagramPanel.viewType, {
      async deserializeWebviewPanel(webviewPanel) {
        panel.restore(webviewPanel);
      },
    }),
  );
}
