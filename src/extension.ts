import * as vscode from "vscode";
import { ChartTool, InspectDataTool, UpdateChartTool } from "./chartTools";
import { CheckpointTool } from "./checkpointTool";
import { DraftTool } from "./draftTool";
import { EditDiagramTool } from "./editTool";
import { EvidenceTool } from "./evidenceTool";
import { ExportDiagramHtmlTool } from "./exportHtmlTool";
import { GraphDiagramTool, QUERY_GRAPH_TOOL } from "./graphTool";
import { DiagramGuideTool } from "./guide";
import { registerMarkdownDiagrams } from "./markdownDiagrams";
import { DiagramPanel } from "./panel";
import {
  ANNOTATE_TOOL,
  CHART_TOOL,
  EDIT_TOOL,
  EXPORT_HTML_TOOL,
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
import { EDIT_STRUCTURE_TOOL, StructureDiagramTool } from "./structureTool";
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

  context.subscriptions.push(
    panel,
    vscode.lm.registerTool(RENDER_TOOL, new RenderDiagramTool(panel)),
    vscode.lm.registerTool(EDIT_TOOL, new EditDiagramTool(panel)),
    vscode.lm.registerTool(CHART_TOOL, new ChartTool(panel)),
    vscode.lm.registerTool(GET_STATE_TOOL, new GetDiagramStateTool(panel)),
    vscode.lm.registerTool(GET_IMAGE_TOOL, new GetDiagramImageTool(panel)),
    vscode.lm.registerTool(
      EXPORT_HTML_TOOL,
      new ExportDiagramHtmlTool(panel, context.extensionUri),
    ),
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
    vscode.lm.registerTool(QUERY_GRAPH_TOOL, new GraphDiagramTool(panel)),
    vscode.lm.registerTool(EDIT_STRUCTURE_TOOL, new StructureDiagramTool(panel)),
    vscode.lm.registerTool("diagram_checkpoint", new CheckpointTool(panel)),
    vscode.lm.registerTool("diagram_draft", new DraftTool(panel)),
    vscode.lm.registerTool("diagram_evidence", new EvidenceTool(panel)),
    vscode.commands.registerCommand("diagram.show", () => panel.show()),
    vscode.commands.registerCommand("diagram.export", () => panel.exportDiagram()),
    vscode.commands.registerCommand("diagram.chartOptions", () => panel.toggleChartOptions()),
    vscode.commands.registerCommand("diagram.highlightPath", () => panel.highlightPath()),
    vscode.commands.registerCommand("diagram.clearSelection", () => panel.clearSelection()),
    vscode.commands.registerCommand("diagram.help", () =>
      vscode.window.showInformationMessage("Diagram Help", {
        modal: true,
        detail:
          "Ask your chat agent to draw or change diagrams and charts, select the Diagram agent for a focused session, or open a diagram from Markdown.\n\n" +
          "Click a linked node to open its code or URL. Other items select on click, or ask about the item in chat when the diagram enables it. Ctrl/Cmd/Shift+click always selects and lets you select several items.\n\n" +
          "Right-click for Highlight Path when two selected nodes have a path from the first to the second. Clear Selection removes selections and agent highlights.\n\n" +
          "Use the message field to ask about your selection, the view buttons to edit the source, and Export to save the drawing. Tab to the drawing, use arrow keys to move, and Enter or Space to select.",
      }),
    ),
    ...registerMarkdownDiagrams(panel),
    vscode.window.registerWebviewPanelSerializer(WebviewChannel.viewType, {
      async deserializeWebviewPanel(webviewPanel) {
        panel.restore(webviewPanel);
      },
    }),
  );
}
