import * as vscode from "vscode";
import { EditDiagramTool } from "./editTool";
import { DiagramGuideTool } from "./guide";
import { registerMarkdownDiagrams } from "./markdownDiagrams";
import { DiagramPanel } from "./panel";
import {
  ANNOTATE_TOOL,
  EDIT_TOOL,
  GET_IMAGE_TOOL,
  GET_STATE_TOOL,
  GUIDE_TOOL,
  RENDER_TOOL,
} from "./protocol";
import {
  AnnotateDiagramTool,
  GetDiagramImageTool,
  GetDiagramStateTool,
  RenderDiagramTool,
} from "./tools";
import { WebviewChannel } from "./webviewChannel";

export function activate(context: vscode.ExtensionContext): void {
  const panel = new DiagramPanel(context);

  context.subscriptions.push(
    panel,
    vscode.lm.registerTool(RENDER_TOOL, new RenderDiagramTool(panel)),
    vscode.lm.registerTool(EDIT_TOOL, new EditDiagramTool(panel)),
    vscode.lm.registerTool(GET_STATE_TOOL, new GetDiagramStateTool(panel)),
    vscode.lm.registerTool(GET_IMAGE_TOOL, new GetDiagramImageTool(panel)),
    vscode.lm.registerTool(ANNOTATE_TOOL, new AnnotateDiagramTool(panel)),
    vscode.lm.registerTool(GUIDE_TOOL, new DiagramGuideTool()),
    vscode.commands.registerCommand("diagram.show", () => panel.show()),
    vscode.commands.registerCommand("diagram.export", () => panel.exportDiagram()),
    vscode.commands.registerCommand("diagram.clearSelection", () => panel.clearSelection()),
    vscode.commands.registerCommand("diagram.help", () =>
      vscode.window.showInformationMessage("Diagram Help", {
        modal: true,
        detail:
          "Ask your chat agent to draw or change a diagram or chart, or open one from Markdown.\n\n" +
          "Click a linked node to open its code or URL; other items select on click (Ctrl/Cmd/Shift+click for several). Ask about the selection in the message field, edit the source with the view buttons, and export the drawing from the menu.",
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
