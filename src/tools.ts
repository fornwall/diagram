import * as vscode from "vscode";
import { guessTitle } from "./blocks";
import { type ChartSpec, type ChartType, dataOrigin, validateChartSpec } from "./chartSpec";
import { type LoadedChart, loadChart, resolveFile } from "./dataSource";
import { nodeList } from "./describe";
import type { Diagram, DiagramPanel, RenderOutcome } from "./panel";
import { CHART_TOOL, diagramNoun, errorMessage, isDiagramLanguage, RENDER_TOOL } from "./protocol";

/** As declared in package.json, but a model may not follow the schema exactly. */
interface RenderInput {
  source: string;
  language?: string;
  title?: string;
  clickPrompt?: string;
}

interface PickNodesInput {
  prompt: string;
  multiple?: boolean;
}

/** Returns the diagram to render, or what is wrong with the input. */
function parseRenderInput(input: RenderInput): Diagram | string {
  const { source, language = "mermaid", title, clickPrompt } = input;
  if (typeof source !== "string" || !source.trim()) {
    return 'Give "source", the complete diagram, as a string.';
  }
  if (!isDiagramLanguage(language)) {
    return `Unknown language ${JSON.stringify(language)}: use "mermaid" for Mermaid source or "echarts" for an ECharts option as JSON.`;
  }
  return {
    language,
    source,
    title: nonBlank(title) ?? guessTitle({ language, source }),
    clickPrompt: nonBlank(clickPrompt),
  };
}

/** Lets any agent show a Mermaid diagram or an ECharts chart in the interactive diagram panel. */
export class RenderDiagramTool implements vscode.LanguageModelTool<RenderInput> {
  constructor(private readonly panel: DiagramPanel) {}

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<RenderInput>,
  ): vscode.PreparedToolInvocation {
    const diagram = parseRenderInput(options.input);
    return {
      invocationMessage:
        typeof diagram === "string"
          ? "Rendering a diagram"
          : `Rendering ${diagramNoun(diagram.language)} "${diagram.title}"`,
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RenderInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const diagram = parseRenderInput(options.input);
    if (typeof diagram === "string") {
      return textResult(`Nothing was rendered: ${diagram}`);
    }
    const outcome = await unlessCancelled(this.panel.render(diagram, "tool"), token);
    const noun = diagramNoun(diagram.language);
    if (outcome.ok) {
      return textResult(
        `Rendered the ${outcome.diagramType} ${noun} in the diagram panel next to the chat.`,
      );
    }
    const fix =
      diagram.language === "echarts"
        ? "Fix the ECharts option (it must be valid JSON, without functions)"
        : "Fix the Mermaid syntax";
    return textResult(
      renderFailure(
        outcome,
        noun,
        RENDER_TOOL,
        `${fix} and call ${RENDER_TOOL} again with the complete corrected source.`,
      ),
    );
  }
}

type ChartInput = ChartSpec & { clickPrompt?: string };

/** Lets any agent render data, given inline, in a file or as a command's output, as a chart. */
export class ChartTool implements vscode.LanguageModelTool<ChartInput> {
  constructor(private readonly panel: DiagramPanel) {}

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<ChartInput>,
  ): vscode.PreparedToolInvocation {
    const { clickPrompt: _, ...input } = options.input;
    const { command, file } = input;
    let invocationMessage = "Rendering a chart";
    try {
      invocationMessage = `Rendering chart "${chartTitle(validateChartSpec(input))}"`;
    } catch {
      // Reported when the tool is invoked.
    }
    const prepared: vscode.PreparedToolInvocation = { invocationMessage };
    // In an untrusted workspace, the command is not run and invoke says so.
    if (command && vscode.workspace.isTrusted) {
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
    let chart: LoadedChart;
    try {
      spec = validateChartSpec(input);
      chart = await loadChart(spec, token);
    } catch (error) {
      if (error instanceof vscode.CancellationError) {
        throw error;
      }
      return textResult(
        `No chart was rendered: ${errorMessage(error)}\n\nFix the input and call ${CHART_TOOL} again.`,
      );
    }

    const outcome = await unlessCancelled(
      this.panel.render(
        {
          language: "echarts",
          source: JSON.stringify(chart.option, null, 2),
          title: chartTitle(spec),
          clickPrompt: nonBlank(clickPrompt),
          chart: spec.file || spec.command ? spec : undefined,
        },
        "tool",
      ),
      token,
    );
    if (outcome.ok) {
      return textResult(
        `Rendered the ${chartTypeName(spec.type)} chart of ${dataOrigin(spec)} in the diagram panel next to the chat. ${chart.report}\n\nIf the columns were not read as intended, call ${CHART_TOOL} again with format, labelColumn or valueColumns.`,
      );
    }
    const fix = spec.options
      ? `"options" is the likely cause: fix or leave it out and call ${CHART_TOOL} again.`
      : `Try another chart type, or write the ECharts option yourself and render it with ${RENDER_TOOL}.`;
    return textResult(`${renderFailure(outcome, "chart", CHART_TOOL, fix)}\n\n${chart.report}`);
  }
}

/** E.g. "horizontal bar" for "horizontalBar". */
function chartTypeName(type: ChartType): string {
  return type.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
}

/** The chart's title, by default e.g. "Horizontal bar chart of sales.csv". */
function chartTitle({ type, title, file, command }: ChartSpec): string {
  const words = chartTypeName(type);
  const name = `${words.charAt(0).toUpperCase()}${words.slice(1)} chart`;
  const of = file ? file.split(/[/\\]/).at(-1) : command;
  return nonBlank(title) ?? (of ? `${name} of ${of}` : name);
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
    const prompt = nonBlank(options.input.prompt);
    if (!prompt) {
      return textResult('No node was picked: Give "prompt", the question to show the user.');
    }
    const outcome = await this.panel.pickNodes(prompt, options.input.multiple === true, token);
    return textResult(
      outcome.picked
        ? `The user picked: ${nodeList(outcome.nodes)}.`
        : `No node was picked: ${outcome.reason}`,
    );
  }
}

/** Explains to the model why a diagram was not shown, and what to do next. */
function renderFailure(
  outcome: Extract<RenderOutcome, { ok: false }>,
  noun: string,
  tool: string,
  fix: string,
): string {
  return outcome.kind === "invalid"
    ? `The ${noun} failed to render with this error:\n\n${outcome.error}\n\n${fix}`
    : `The ${noun} could not be shown: ${outcome.error} This is not a problem with the ${noun}; if the user still wants to see it, call ${tool} again to reopen the panel.`;
}

/** Settles like the promise, but rejects with a CancellationError once the token is cancelled. */
function unlessCancelled<T>(promise: Promise<T>, token: vscode.CancellationToken): Promise<T> {
  return new Promise((resolve, reject) => {
    const listener = token.onCancellationRequested(() => reject(new vscode.CancellationError()));
    promise.then(resolve, reject).finally(() => listener.dispose());
  });
}

/** The value, if it is a string with more than whitespace: a model may pass anything. */
function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function textResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}
