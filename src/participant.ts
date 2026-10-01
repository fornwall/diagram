import * as vscode from "vscode";
import { codeFence, type DiagramBlock, DiagramBlockFilter, guessTitle } from "./blocks";
import type { DiagramPanel } from "./panel";
import {
  CHART_TOOL,
  type DiagramLanguage,
  diagramNoun,
  errorMessage,
  isDiagramLanguage,
} from "./protocol";

export const PARTICIPANT_ID = "diagram.participant";

/** How many times to ask the model to fix a diagram that fails to render. */
const MAX_REPAIR_ATTEMPTS = 2;
/** Attached files are truncated to this many characters. */
const MAX_REFERENCE_LENGTH = 50_000;
/** How many rounds of tool calls a single reply may take. */
const MAX_TOOL_ROUNDS = 4;

const INSTRUCTIONS = `You are @diagram, an assistant inside VS Code that draws diagrams and charts.
They are rendered in an interactive panel next to the chat, where the user can select nodes or chart items, edit the source by hand and send follow-up requests.

Pick what fits the content:
- Mermaid, for structure and flow: flowchart, sequenceDiagram, classDiagram, stateDiagram-v2, erDiagram, gantt, mindmap, timeline, gitGraph and so on, in a \`\`\`mermaid code block.
- Apache ECharts 6, for quantitative data: pie, bar, line, area, scatter, radar, funnel, gauge, heatmap, treemap, sunburst, sankey and so on. Reply with an \`\`\`echarts code block containing the complete ECharts option object as strict JSON (double quotes, no comments, no functions; use string templates such as "{b}: {c}" for formatters). Put the data inline.
- The ${CHART_TOOL} tool, to chart data in a file or the output of a shell command (e.g. "pie chart of the disk usage per folder": command "du -s *"), or larger inline data such as a pasted table. It loads and parses the data, renders the chart itself and tells you how the data was read; then reply with a short explanation and no code block. Prefer it over an echarts block whenever the data comes from a file or a command, and never invent data that a file or command would give.
- If the user explicitly asks for Mermaid (or gives Mermaid source), use Mermaid, e.g. a Mermaid pie or xychart-beta chart; if they ask for ECharts, use ECharts.

Rules:
- Unless you used ${CHART_TOOL}, reply with a short explanation (a few sentences at most) followed by exactly one \`\`\`mermaid or \`\`\`echarts code block containing the complete diagram or chart. Never send partial diagrams or diffs.
- The code block is not shown in the chat: the diagram appears in the panel instead. So do not refer to it as "below" or repeat its contents in the explanation; describe what the diagram shows or what you changed.
- When a current diagram is given, treat the request as a change to it unless the user clearly asks for something new. Preserve node ids, the user's manual edits and everything the request does not touch.
- When the user refers to "this", "these" or "the selection", they mean the nodes or chart items they have selected in the panel.
- Mermaid: use short, stable node ids with human-readable labels. Quote labels that contain punctuation, e.g. A["parse(input)"].
- Do not use click directives, HTML, hard-coded colors, backgrounds, fonts or sizes: the panel follows the user's VS Code theme and fits charts to the panel. Give an ECharts chart a short title.text; the panel shows it as its heading.
- If the request is too ambiguous to draw, ask one clarifying question instead of guessing, without a code block.`;

const EXPLAIN_INSTRUCTIONS = `You are @diagram, an assistant inside VS Code that explains diagrams and charts.
Explain the current diagram or chart to the user, focusing on the nodes or items they have selected if any, and answer their question about it.
Do not output a mermaid or echarts code block: this request must not change the diagram.`;

export function createParticipantHandler(panel: DiagramPanel): vscode.ChatRequestHandler {
  return async (request, context, stream, token) => {
    if (request.command === "show") {
      if (!panel.current) {
        stream.markdown("There is no diagram yet. Describe what you want me to draw.");
        return;
      }
      panel.show();
      stream.markdown("Opened the diagram panel.");
      return;
    }

    const explain = request.command === "explain";
    const current = request.command === "new" ? undefined : panel.describeForModel();
    if (explain && !current) {
      stream.markdown("There is no diagram to explain yet. Describe what you want me to draw.");
      return;
    }

    const messages = [
      vscode.LanguageModelChatMessage.User(explain ? EXPLAIN_INSTRUCTIONS : INSTRUCTIONS),
      ...historyMessages(context),
      ...(await referenceMessages(context, request)),
    ];
    if (current) {
      messages.push(vscode.LanguageModelChatMessage.User(current));
    }
    messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

    // Tools the user attached with #, which the model is made to call first. Charts of files and
    // command output are drawn by the chart tool, which asks the user before running a command.
    const attached = vscode.lm.tools.filter((tool) =>
      request.toolReferences.some((reference) => reference.name === tool.name),
    );
    const tools = vscode.lm.tools.filter(
      (tool) => attached.includes(tool) || (!explain && tool.name === CHART_TOOL),
    );
    let rendersBefore = panel.renderCount;
    const converse = (required: readonly vscode.LanguageModelChatTool[]) =>
      streamReply(request, messages, tools, required, stream, token);

    try {
      let block = await converse(attached);
      if (explain) {
        return;
      }

      let failure: { block: DiagramBlock; error: string } | undefined;
      for (let attempt = 0; block && !token.isCancellationRequested; attempt++) {
        const noun = diagramNoun(block.language);
        stream.progress(`Rendering ${noun}…`);
        const outcome = await panel.render({ ...block, title: guessTitle(block) }, "participant");
        if (outcome.ok || outcome.kind === "unavailable") {
          if (!outcome.ok) {
            stream.markdown(`\n\n${outcome.error}`);
          }
          showButton(stream, block.language);
          return { metadata: block };
        }
        failure = { block, error: outcome.error };
        rendersBefore = panel.renderCount;
        if (attempt === MAX_REPAIR_ATTEMPTS) {
          break;
        }
        stream.progress("Fixing a rendering error…");
        stream.markdown("\n\n---\n\n");
        messages.push(
          vscode.LanguageModelChatMessage.User(
            `That ${noun} failed to render with this error:\n\n${outcome.error}\n\nReply with one sentence about what you fixed, followed by the corrected complete ${noun} in a single ${block.language} code block.`,
          ),
        );
        block = await converse([]);
      }

      // A tool, such as the chart tool, may have drawn the diagram. Remember it for later requests'
      // history, by how it was drawn if it charts a file or command, as its data may be large.
      const drawn = panel.renderCount !== rendersBefore && panel.current;
      if (drawn) {
        panel.setOrigin("participant");
        showButton(stream, drawn.language);
        return {
          metadata: drawn.chart
            ? { chart: drawn.chart }
            : { language: drawn.language, source: drawn.source },
        };
      }
      if (failure) {
        stream.markdown(
          `\n\nThe ${diagramNoun(failure.block.language)} failed to render: ${failure.error}\n\nYou can fix it with **Edit source** in the diagram panel.`,
        );
        return { metadata: failure.block };
      }
    } catch (error) {
      if (error instanceof vscode.LanguageModelError) {
        return { errorDetails: { message: error.message } };
      }
      throw error;
    }
  };
}

function showButton(stream: vscode.ChatResponseStream, language: DiagramLanguage): void {
  stream.button({
    command: "diagram.show",
    title: language === "echarts" ? "Show Chart" : "Show Diagram",
  });
}

/**
 * Streams the model's reply to the chat without its diagram blocks, calling the tools it asks for,
 * the required ones first. Extends the messages with the reply and tool calls, and returns the
 * reply's last diagram block.
 */
async function streamReply(
  request: vscode.ChatRequest,
  messages: vscode.LanguageModelChatMessage[],
  tools: vscode.LanguageModelChatTool[],
  required: readonly vscode.LanguageModelChatTool[],
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<DiagramBlock | undefined> {
  const lastToolRound = required.length + MAX_TOOL_ROUNDS;
  let diagram: DiagramBlock | undefined;
  /** Why further tool calls are answered without running them. */
  let notRun: string | undefined;
  for (let round = 0; ; round++) {
    // Some models only support a single tool when a tool call is required. The tools are passed
    // even when calls are no longer run, as some models reject requests whose messages contain
    // tool calls but no tools.
    const requiredTool = required[round];
    const options: vscode.LanguageModelChatRequestOptions = requiredTool
      ? { tools: [requiredTool], toolMode: vscode.LanguageModelChatToolMode.Required }
      : { tools };
    const response = await request.model.sendRequest(messages, options, token);
    // The diagram is shown in the panel, so keep its source out of the chat. This also keeps VS
    // Code from rendering a second, non-interactive copy of it inline.
    const filter = new DiagramBlockFilter();
    let reply = "";
    const calls: vscode.LanguageModelToolCallPart[] = [];
    const show = (markdown: string) => markdown && stream.markdown(markdown);
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        reply += part.value;
        show(filter.push(part.value));
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        calls.push(part);
      }
    }
    show(filter.flush());
    diagram = filter.diagrams.at(-1) ?? diagram;
    if (token.isCancellationRequested) {
      return diagram;
    }
    if (filter.unterminated) {
      stream.markdown(
        "\n\nThe reply ended before the diagram was complete. Try again, or ask for a smaller diagram.",
      );
    }
    if (calls.length === 0 || round > lastToolRound) {
      if (reply) {
        messages.push(vscode.LanguageModelChatMessage.Assistant(reply));
      }
      return diagram;
    }
    if (round === lastToolRound) {
      notRun ??= "this request has made too many tool calls";
    }

    messages.push(
      vscode.LanguageModelChatMessage.Assistant([
        ...(reply ? [new vscode.LanguageModelTextPart(reply)] : []),
        ...calls,
      ]),
    );
    const text = (value: string) => [new vscode.LanguageModelTextPart(value)];
    const results: vscode.LanguageModelToolResultPart[] = [];
    for (const call of calls) {
      let content: unknown[];
      if (notRun) {
        content = text(`Not run, as ${notRun}. Answer without tools.`);
      } else if (!tools.some((tool) => tool.name === call.name)) {
        // invokeTool runs any registered tool, not only those the model was given.
        content = text(`There is no tool named ${call.name}. Use only the tools you were given.`);
      } else {
        try {
          const input = { input: call.input, toolInvocationToken: request.toolInvocationToken };
          content = (await vscode.lm.invokeTool(call.name, input, token)).content;
        } catch (error) {
          if (token.isCancellationRequested) {
            return diagram;
          }
          // The user declined the tool call, e.g. to run a command: a CancellationError, though
          // not always an instance of one. Don't let the model ask again.
          if (error instanceof Error && error.name === "Canceled") {
            notRun = "the user declined an earlier tool call";
            content = text(
              "The user declined this tool call. Do not try it again, and do not make up its result: tell the user briefly what you would have done with it.",
            );
          } else {
            content = text(`The tool call failed: ${errorMessage(error)}`);
          }
        }
      }
      results.push(new vscode.LanguageModelToolResultPart(call.callId, content));
    }
    messages.push(vscode.LanguageModelChatMessage.User(results));
    if (reply && !reply.endsWith("\n")) {
      stream.markdown("\n\n");
    }
  }
}

function historyMessages(context: vscode.ChatContext): vscode.LanguageModelChatMessage[] {
  const messages: vscode.LanguageModelChatMessage[] = [];
  for (const turn of context.history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
    } else {
      let text = turn.response
        .map((part) => (part instanceof vscode.ChatResponseMarkdownPart ? part.value.value : ""))
        .join("");
      // Diagrams are not shown in chat, so restore the one this turn produced.
      const source: unknown = turn.result.metadata?.source;
      const language: unknown = turn.result.metadata?.language;
      const chart: unknown = turn.result.metadata?.chart;
      if (typeof source === "string" && isDiagramLanguage(language)) {
        text += `\n\n${codeFence(source, language)}`;
      } else if (chart) {
        text += `\n\n(I drew a chart with ${CHART_TOOL}, with these parameters: ${JSON.stringify(chart)})`;
      }
      if (text) {
        messages.push(vscode.LanguageModelChatMessage.Assistant(text));
      }
    }
  }
  return messages;
}

/**
 * The files, selections and text attached to this request and earlier ones, as later requests often
 * refer to them. Each is read again, and given once.
 */
async function referenceMessages(
  context: vscode.ChatContext,
  request: vscode.ChatRequest,
): Promise<vscode.LanguageModelChatMessage[]> {
  const attachments = new Set<string>();
  for (const turn of [...context.history, request]) {
    if (turn instanceof vscode.ChatResponseTurn) {
      continue;
    }
    // The references come in reverse order of their position in the prompt.
    for (const { value, modelDescription } of [...turn.references].reverse()) {
      const content = await referenceContent(value);
      if (!content) {
        continue;
      }
      const { name, text } = content;
      const label = modelDescription ? `${name} (${modelDescription})` : name;
      if (text === undefined) {
        attachments.add(`Attached by the user: ${label}, which is not a text file.`);
        continue;
      }
      const truncated =
        text.length > MAX_REFERENCE_LENGTH
          ? `, truncated to the first ${MAX_REFERENCE_LENGTH} of its ${text.length} characters`
          : "";
      attachments.add(
        `Attached by the user: ${label}${truncated}\n\n${codeFence(text.slice(0, MAX_REFERENCE_LENGTH))}`,
      );
    }
  }
  return Array.from(attachments, (text) => vscode.LanguageModelChatMessage.User(text));
}

/**
 * The name and text of an attached file, selection or string. The text is left out for a folder or
 * binary file. Other values, such as images, are skipped.
 */
async function referenceContent(
  value: unknown,
): Promise<{ name: string; text?: string } | undefined> {
  if (typeof value === "string") {
    return { name: "text", text: value };
  }
  const location = value instanceof vscode.Location ? value : undefined;
  const uri = location?.uri ?? (value instanceof vscode.Uri ? value : undefined);
  if (!uri) {
    return undefined;
  }
  const path = vscode.workspace.asRelativePath(uri);
  const name = location ? `${path}:${location.range.start.line + 1}` : path;
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    return { name, text: document.getText(location?.range) };
  } catch {
    return { name };
  }
}
