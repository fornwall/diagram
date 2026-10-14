import * as vscode from "vscode";
import { ChartTool, InspectDataTool, UpdateChartTool } from "./chartTools";
import { EditDiagramTool } from "./editTool";
import { DiagramGuideTool } from "./guide";
import { registerMarkdownDiagrams } from "./markdownDiagrams";
import { DiagramPanel } from "./panel";
import { createParticipantHandler, PARTICIPANT_ID } from "./participant";
import {
  ANNOTATE_TOOL,
  CHART_TOOL,
  EDIT_TOOL,
  FIND_FILES_TOOL,
  GET_IMAGE_TOOL,
  GET_STATE_TOOL,
  GUIDE_TOOL,
  INSPECT_DATA_TOOL,
  PICK_NODES_TOOL,
  READ_FILE_TOOL,
  RENDER_TOOL,
  SEARCH_TEXT_TOOL,
  STYLE_TOOL,
  UPDATE_CHART_TOOL,
} from "./protocol";
import { StyleDiagramTool } from "./styleTool";
import {
  AnnotateDiagramTool,
  GetDiagramImageTool,
  GetDiagramStateTool,
  PickDiagramNodesTool,
  RenderDiagramTool,
} from "./tools";
import { WebviewChannel } from "./webviewChannel";
import {
  cacheIgnoreFiles,
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
    vscode.lm.registerTool(EDIT_TOOL, new EditDiagramTool(panel)),
    vscode.lm.registerTool(CHART_TOOL, new ChartTool(panel)),
    vscode.lm.registerTool(GET_STATE_TOOL, new GetDiagramStateTool(panel)),
    vscode.lm.registerTool(GET_IMAGE_TOOL, new GetDiagramImageTool(panel)),
    vscode.lm.registerTool(PICK_NODES_TOOL, new PickDiagramNodesTool(panel)),
    vscode.lm.registerTool(ANNOTATE_TOOL, new AnnotateDiagramTool(panel)),
    vscode.lm.registerTool(FIND_FILES_TOOL, new FindWorkspaceFilesTool()),
    vscode.lm.registerTool(SEARCH_TEXT_TOOL, new SearchWorkspaceTextTool()),
    vscode.lm.registerTool(READ_FILE_TOOL, new ReadWorkspaceFileTool()),
    cacheIgnoreFiles(),
    vscode.lm.registerTool(INSPECT_DATA_TOOL, new InspectDataTool(panel)),
    vscode.lm.registerTool(UPDATE_CHART_TOOL, new UpdateChartTool(panel)),
    vscode.lm.registerTool(STYLE_TOOL, new StyleDiagramTool(panel)),
    vscode.lm.registerTool(GUIDE_TOOL, new DiagramGuideTool()),
    vscode.commands.registerCommand("diagram.show", () => panel.show()),
    vscode.commands.registerCommand("diagram.export", () => panel.exportDiagram()),
    vscode.commands.registerCommand("diagram.chartOptions", () => panel.toggleChartOptions()),
    ...registerMarkdownDiagrams(panel),
    vscode.window.registerWebviewPanelSerializer(WebviewChannel.viewType, {
      async deserializeWebviewPanel(webviewPanel) {
        panel.restore(webviewPanel);
      },
    }),
  );
}
