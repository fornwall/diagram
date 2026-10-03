import * as vscode from "vscode";
import { type AnnotateInput, validateAnnotation } from "./annotations";
import { guessTitle, isClosingFence, openingFence } from "./blocks";
import { unlessCancelled } from "./cancellation";
import {
  type ChartSpec,
  type ChartType,
  dataOrigin,
  quoteAll,
  validateChartSpec,
} from "./chartSpec";
import { buildChart, describeTable } from "./charts";
import type { DataTable } from "./data";
import { loadTable, prepareDataInvocation } from "./dataSource";
import { nodeList } from "./describe";
import { LINK_SYNTAX, validateLinks } from "./links";
import { type Diagram, type DiagramPanel, type RenderOutcome, unknownNodeIds } from "./panel";
import {
  ANNOTATE_TOOL,
  type Annotation,
  CHART_TOOL,
  type DiagramLanguage,
  diagramNoun,
  errorMessage,
  isDiagramLanguage,
  isPlainObject,
  nodeNoun,
  RENDER_TOOL,
} from "./protocol";

/** As declared in package.json, but a model may not follow the schema exactly. */
interface RenderInput {
  source: string;
  language?: string;
  title?: string;
  clickPrompt?: string;
  links?: Record<string, string>;
}

interface PickNodesInput {
  prompt: string;
  multiple?: boolean;
}

/**
 * Returns the diagram to render, with the problems of any links that were left out, or what is
 * wrong with the input. A bad link is reported but does not keep the diagram from being drawn.
 */
function parseRenderInput(input: RenderInput): { diagram: Diagram; problems: string[] } | string {
  if (!isPlainObject(input) || typeof input.source !== "string") {
    return 'Give "source", the complete diagram, as a string.';
  }
  let { source, language } = input;
  // Models sometimes include a Markdown fence despite the schema. Use the same rules as chat.
  const trimmed = source.trim();
  const firstNewline = trimmed.indexOf("\n");
  const lastNewline = trimmed.lastIndexOf("\n");
  const opening = firstNewline < 0 ? undefined : openingFence(trimmed.slice(0, firstNewline));
  if (opening && isClosingFence(trimmed.slice(lastNewline + 1), opening.fence)) {
    source = trimmed.slice(firstNewline + 1, lastNewline);
    language ??= isDiagramLanguage(opening.language) ? opening.language : undefined;
  }
  if (!source.trim()) {
    return 'Give "source", the complete diagram, as a string.';
  }
  const { title, clickPrompt } = input;
  language ??= "mermaid";
  if (!isDiagramLanguage(language)) {
    return `Unknown language ${JSON.stringify(language)}: use "mermaid" for Mermaid source or "echarts" for an ECharts option as JSON or JavaScript.`;
  }
  const { links, problems } = validateLinks(input.links, language);
  return {
    diagram: {
      language,
      source,
      title: nonBlank(title) ?? guessTitle({ language, source }),
      clickPrompt: nonBlank(clickPrompt),
      links,
    },
    problems,
  };
}

/** Lets any agent show a Mermaid diagram or an ECharts chart in the interactive diagram panel. */
export class RenderDiagramTool implements vscode.LanguageModelTool<RenderInput> {
  constructor(private readonly panel: DiagramPanel) {}

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<RenderInput>,
  ): vscode.PreparedToolInvocation {
    const parsed = parseRenderInput(options.input);
    return {
      invocationMessage:
        typeof parsed === "string"
          ? "Rendering a diagram"
          : `Rendering ${diagramNoun(parsed.diagram.language)} "${parsed.diagram.title}"`,
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RenderInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const parsed = parseRenderInput(options.input);
    if (typeof parsed === "string") {
      return textResult(`Nothing was rendered: ${parsed}`);
    }
    const { diagram, problems } = parsed;
    const outcome = await unlessCancelled(
      () => this.panel.render(diagram, "tool", options.toolInvocationToken),
      token,
    );
    const noun = diagramNoun(diagram.language);
    if (outcome.ok) {
      return textResult(
        `Rendered the ${outcome.diagramType} ${noun} in the diagram panel next to the chat.` +
          leftOutLinks(problems) +
          linksWithoutNodes(Object.keys(diagram.links ?? {}), this.panel.drawnIds),
      );
    }
    const fix =
      diagram.language === "echarts"
        ? "Fix the ECharts option (JSON, or a JavaScript object literal for callbacks such as renderItem)"
        : "Fix the Mermaid syntax";
    return textResult(
      renderFailure(
        outcome,
        noun,
        RENDER_TOOL,
        `${fix} and call ${RENDER_TOOL} again with the complete corrected source.`,
      ) + leftOutLinks(problems),
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
    let spec: ChartSpec;

    try {
      spec = validateChartSpec(options.input);
    } catch {
      // Reported when the tool is invoked.
      return { invocationMessage: "Rendering a chart" };
    }
    return prepareDataInvocation(spec, `Rendering chart "${chartTitle(spec)}"`);
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ChartInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    let spec: ChartSpec;
    let chartTable: DataTable;
    let source: string;
    let report: string;
    let description: string | undefined;
    try {
      spec = validateChartSpec(options.input);
      const { table, warning } = await loadTable(spec, token);
      chartTable = table;
      description = `The data was read as: ${describeTable(table)}`;
      const { option, summary } = buildChart(spec, table);
      source = JSON.stringify(option, null, 2);
      report = [summary, warning, description].filter(Boolean).join("\n\n");
    } catch (error) {
      if (error instanceof vscode.CancellationError) {
        throw error;
      }
      return textResult(
        `No chart was rendered: ${errorMessage(error)}${description ? `\n\n${description}` : ""}\n\nFix the input and call ${CHART_TOOL} again.`,
      );
    }

    const outcome = await unlessCancelled(
      () =>
        this.panel.render(
          {
            language: "echarts",
            source,
            title: chartTitle(spec),
            clickPrompt: nonBlank(options.input.clickPrompt),
            chart: spec,
          },
          "tool",
          options.toolInvocationToken,
          chartTable,
        ),
      token,
    );
    if (outcome.ok) {
      return textResult(
        `Rendered the ${chartTypeName(spec.type)} chart of ${dataOrigin(spec)} in the diagram panel next to the chat. ${report}\n\nIf the columns were not read as intended, call ${CHART_TOOL} again with format, labelColumn or valueColumns.`,
      );
    }
    const fix = spec.options
      ? `"options" is the likely cause: fix or leave it out and call ${CHART_TOOL} again.`
      : `Try another chart type, or write the ECharts option yourself and render it with ${RENDER_TOOL}.`;
    return textResult(`${renderFailure(outcome, "chart", CHART_TOOL, fix)}\n\n${report}`);
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
    const prompt = nonBlank(options.input?.prompt);
    return {
      invocationMessage: prompt
        ? `Waiting for you to pick in the diagram: ${prompt}`
        : "Waiting for you to pick in the diagram",
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<PickNodesInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const prompt = nonBlank(options.input?.prompt);
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

/**
 * Lets any agent mark up the diagram already shown, to walk the user through it without drawing it
 * again. The drawing stays exactly where it is; only the marks on it change.
 */
export class AnnotateDiagramTool implements vscode.LanguageModelTool<AnnotateInput> {
  constructor(private readonly panel: DiagramPanel) {}

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<AnnotateInput>,
  ): vscode.PreparedToolInvocation {
    const language = this.panel.current?.language ?? "mermaid";
    try {
      return { invocationMessage: markingMessage(validateAnnotation(options.input), language) };
    } catch {
      // Reported when the tool is invoked.
      return { invocationMessage: `Marking the ${diagramNoun(language)}` };
    }
  }

  invoke(
    options: vscode.LanguageModelToolInvocationOptions<AnnotateInput>,
    token: vscode.CancellationToken,
  ): vscode.LanguageModelToolResult {
    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    let annotation: Annotation;
    try {
      annotation = validateAnnotation(options.input);
    } catch (error) {
      return textResult(
        `Nothing was marked: ${errorMessage(error)}\n\nFix the input and call ${ANNOTATE_TOOL} again.`,
      );
    }
    const outcome = this.panel.annotate(annotation);
    if (!outcome.ok) {
      return textResult(`Nothing was marked: ${outcome.reason}`);
    }
    const language = this.panel.current?.language ?? "mermaid";
    const noun = diagramNoun(language);
    const { marks, caption, dim } = outcome.annotation;
    const drawn = outcome.ids;
    const sentences: string[] = [];
    if (marks.length > 0) {
      const includesRelationships =
        language === "mermaid" &&
        this.panel.drawnIds &&
        marks.some((mark) => !this.panel.drawnIds?.includes(mark.id));
      const parts = `${includesRelationships ? "item" : nodeNoun(language)}${marks.length === 1 ? "" : "s"}`;
      const listed = marks.map(({ id, kind }) => `${id} (${kind})`).join(", ");
      sentences.push(`Marked ${marks.length} ${parts}: ${listed}.`);
      if (dim) {
        sentences.push("Unmarked items are faded.");
      }
      if (drawn === undefined) {
        sentences.push("Item ids could not be verified; unknown items will not show marks.");
      }
    } else {
      sentences.push(`Cleared the ${noun}'s marks.`);
    }
    if (caption !== undefined) {
      sentences.push(`Caption: ${JSON.stringify(caption)}.`);
    }
    const unknown =
      outcome.unknown.length > 0 && drawn
        ? `\n\nThese ids are not selectable items of the ${noun}, so nothing was marked for them: ` +
          `${quoteAll(outcome.unknown)}. Its ids are ${idList(drawn)}.`
        : "";
    return textResult(sentences.join(" ") + unknown);
  }
}

/** How marking reads in chat, e.g. `Marking "pay" in the diagram: Step 2 of 3`. */
function markingMessage({ marks, caption }: Annotation, language: DiagramLanguage): string {
  const noun = diagramNoun(language);
  if (marks.length === 0) {
    return caption === undefined
      ? `Clearing the marks in the ${noun}`
      : `Marking the ${noun}: ${caption}`;
  }
  // A few ids say more than their number; many of them would crowd the chat.
  const what =
    marks.length <= 3
      ? marks.map(({ id }) => `"${id}"`).join(", ")
      : `${marks.length} ${nodeNoun(language)}s`;
  const where = `Marking ${what} in the ${noun}`;
  return caption === undefined ? where : `${where}: ${caption}`;
}

/**
 * Tells the model which of its links name a node the diagram does not have, which only the diagram
 * as drawn can say: such a link is kept, but a click never finds it.
 */
function linksWithoutNodes(ids: readonly string[], drawn: readonly string[] | undefined): string {
  if (!drawn) {
    return "";
  }
  const unknown = unknownNodeIds(ids, drawn);
  if (unknown.length === 0) {
    return "";
  }
  return (
    `\n\nThese links name nodes the diagram does not have, so nothing opens from them: ${quoteAll(unknown)}. ` +
    `Its node ids are ${idList(drawn)}. Call ${RENDER_TOOL} again with the links corrected to add them.`
  );
}

/** As many ids as a model needs to correct one it got wrong, and no more. */
const MAX_LISTED_IDS = 40;

function idList(ids: readonly string[]): string {
  const listed = quoteAll(ids.slice(0, MAX_LISTED_IDS));
  const left = ids.length - MAX_LISTED_IDS;
  return left > 0 ? `${listed} and ${left} more` : listed;
}

/** Tells the model which of its links were left out and why, as the diagram is drawn without them. */
function leftOutLinks(problems: readonly string[]): string {
  if (problems.length === 0) {
    return "";
  }
  return (
    `\n\nThese links were left out:\n- ${problems.join("\n- ")}\n` +
    `A link is a path, absolute or relative to the first workspace folder, with an optional line: ` +
    `${LINK_SYNTAX}. Call ${RENDER_TOOL} again with the links corrected to add them.`
  );
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

/** The value, if it is a string with more than whitespace: a model may pass anything. */
function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function textResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}
