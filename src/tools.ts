import * as vscode from "vscode";
import { guessTitle } from "./blocks";
import type { ChartSpec } from "./chartSpec";
import { buildChartOption, validateChartSpec } from "./charts";
import { describeTable } from "./data";
import { loadTable, resolveFile } from "./dataSource";
import type { DiagramPanel } from "./panel";
import { DIAGRAM_LANGUAGES, type DiagramLanguage } from "./protocol";

export const RENDER_TOOL = "diagram_render";
export const CHART_TOOL = "diagram_chart";
export const GET_STATE_TOOL = "diagram_getState";
export const PICK_NODES_TOOL = "diagram_pickNodes";

interface RenderInput {
  source: string;
  language?: DiagramLanguage;
  title?: string;
  clickPrompt?: string;
}

interface PickNodesInput {
  prompt: string;
  multiple?: boolean;
}

function interactionHint(clickPrompt: string | undefined): string {
  const clicks = clickPrompt
    ? "Clicking a node sends your click prompt to the chat on the user's behalf."
    : `The user can select nodes and send follow-up requests about them; use ${PICK_NODES_TOOL} to ask them to click a node.`;
  return `${clicks} The user can also edit the source; use ${GET_STATE_TOOL} to see the current source and selection.`;
}

/** Lets any agent show a Mermaid diagram or an ECharts chart in the interactive diagram panel. */
export class RenderDiagramTool implements vscode.LanguageModelTool<RenderInput> {
  constructor(private readonly panel: DiagramPanel) {}

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<RenderInput>,
  ): vscode.PreparedToolInvocation {
    const { source, language = "mermaid", title } = options.input;
    const what = language === "echarts" ? "chart" : "diagram";
    return {
      invocationMessage: `Rendering ${what} "${title ?? guessTitle({ language, source })}"`,
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RenderInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    const { source, language = "mermaid", clickPrompt } = options.input;
    if (!DIAGRAM_LANGUAGES.includes(language)) {
      return textResult(
        `Unknown language "${language}": use "mermaid" for Mermaid source or "echarts" for an ECharts option as JSON.`,
      );
    }
    const title = options.input.title ?? guessTitle({ language, source });
    const outcome = await this.panel.render(
      { language, source, title, clickPrompt: clickPrompt || undefined },
      "tool",
    );
    const fix =
      language === "echarts"
        ? "Fix the ECharts option (it must be valid JSON, without functions)"
        : "Fix the Mermaid syntax";
    const text = outcome.ok
      ? `Rendered the ${outcome.diagramType} ${language === "echarts" ? "chart" : "diagram"} in the diagram panel next to the chat. ${interactionHint(clickPrompt)}`
      : `The ${language === "echarts" ? "chart" : "diagram"} failed to render with this error:\n\n${outcome.error}\n\n${fix} and call ${RENDER_TOOL} again with the complete corrected source.`;
    return textResult(text);
  }
}

type ChartInput = ChartSpec & { clickPrompt?: string };

/** Lets any agent render data, given inline, in a file or as a command's output, as a chart. */
export class ChartTool implements vscode.LanguageModelTool<ChartInput> {
  constructor(private readonly panel: DiagramPanel) {}

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<ChartInput>,
  ): vscode.PreparedToolInvocation {
    const { command, file, type } = options.input;
    const source = file ? ` from ${file}` : command ? " from a command's output" : "";
    const prepared: vscode.PreparedToolInvocation = {
      invocationMessage: `Drawing a ${type} chart${source}`,
    };
    if (command) {
      const folder = vscode.workspace.workspaceFolders?.[0];
      const message = new vscode.MarkdownString(
        `Run this command${folder ? ` in \`${folder.name}\`` : ""} and chart its output?`,
      );
      message.appendCodeblock(command, "shell");
      prepared.confirmationMessages = { title: "Run a command for a chart?", message };
    } else if (file) {
      // Like VS Code's own tools, ask before reading files outside a trusted workspace, as the
      // data is shown to the model.
      let uri: vscode.Uri | undefined;
      try {
        uri = resolveFile(file);
      } catch {
        // Reported when the tool is invoked.
      }
      if (uri && (!vscode.workspace.isTrusted || !vscode.workspace.getWorkspaceFolder(uri))) {
        const message = new vscode.MarkdownString("Read this file and chart its data?");
        message.appendCodeblock(uri.fsPath, "text");
        prepared.confirmationMessages = { title: "Read a file for a chart?", message };
      }
    }
    return prepared;
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ChartInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { clickPrompt, ...input } = options.input;
    let spec: ChartSpec;
    let source: string;
    let summary: string;
    let origin: string;
    try {
      spec = validateChartSpec(input);
      const loaded = await loadTable(spec, token);
      origin = loaded.origin;
      source = JSON.stringify(buildChartOption(spec, loaded.table), null, 2);
      summary = describeTable(loaded.table);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return textResult(
        `No chart was drawn: ${message}\n\nFix the input and call ${CHART_TOOL} again.`,
      );
    }

    const outcome = await this.panel.render(
      {
        language: "echarts",
        source,
        title: spec.title ?? defaultChartTitle(spec),
        clickPrompt: clickPrompt || undefined,
        chart: spec.file || spec.command ? spec : undefined,
      },
      "tool",
    );
    const text = outcome.ok
      ? `Rendered a ${spec.type} chart of ${origin} in the diagram panel next to the chat. The data was read as: ${summary}\n\nIf the columns were not read as intended, call ${CHART_TOOL} again with format, labelColumn or valueColumns. ${interactionHint(clickPrompt)}`
      : `The chart failed to render with this error:\n\n${outcome.error}\n\nThe data was read as: ${summary}`;
    return textResult(text);
  }
}

/** E.g. "Horizontal bar chart of sales.csv". */
function defaultChartTitle({ type, file, command }: ChartSpec): string {
  const words = type.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
  const name = `${words.charAt(0).toUpperCase()}${words.slice(1)} chart`;
  const of = file ? file.split(/[/\\]/).at(-1) : command;
  return of ? `${name} of ${of}` : name;
}

/** Lets any agent see the current diagram, including the user's edits and selection. */
export class GetDiagramStateTool implements vscode.LanguageModelTool<Record<string, never>> {
  constructor(private readonly panel: DiagramPanel) {}

  prepareInvocation(): vscode.PreparedToolInvocation {
    return { invocationMessage: "Reading the diagram panel" };
  }

  invoke(): vscode.LanguageModelToolResult {
    return textResult(
      this.panel.describeForModel() ??
        `No diagram has been rendered yet. Use the ${RENDER_TOOL} or ${CHART_TOOL} tool to show one.`,
    );
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
    return textResult(
      outcome.picked
        ? `The user picked: ${outcome.nodes.map((node) => `"${node.label}" (id: ${node.id})`).join(", ")}.`
        : `No node was picked: ${outcome.reason}`,
    );
  }
}

function textResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}
