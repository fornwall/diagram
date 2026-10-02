import * as vscode from "vscode";
import { type DiagramBlock, DiagramBlockFilter, guessTitle } from "./blocks";
import { unlessCancelled } from "./cancellation";
import type { DiagramPanel } from "./panel";
import { fitToolResults, promptMessages } from "./prompt";
import {
  ANNOTATE_TOOL,
  CHART_TOOL,
  type DiagramLanguage,
  diagramNoun,
  errorMessage,
  FIND_FILES_TOOL,
  GET_STATE_TOOL,
  INSPECT_DATA_TOOL,
  PICK_NODES_TOOL,
  READ_FILE_TOOL,
  RENDER_TOOL,
  SEARCH_TEXT_TOOL,
  UPDATE_CHART_TOOL,
} from "./protocol";

export const PARTICIPANT_ID = "diagram.participant";

/** How many times to ask the model to fix a diagram that fails to render. */
const MAX_REPAIR_ATTEMPTS = 2;
/** How many rounds of tool calls a single reply may take. */
const MAX_TOOL_ROUNDS = 12;
/** Shared across exploration and render repairs, including parallel call batches. */
const MAX_TOOL_CALLS = 32;

const READ_ONLY_TOOLS = new Set([
  GET_STATE_TOOL,
  FIND_FILES_TOOL,
  SEARCH_TEXT_TOOL,
  READ_FILE_TOOL,
]);
const DEFAULT_TOOLS = new Set([
  ...READ_ONLY_TOOLS,
  RENDER_TOOL,
  CHART_TOOL,
  PICK_NODES_TOOL,
  ANNOTATE_TOOL,
  INSPECT_DATA_TOOL,
  UPDATE_CHART_TOOL,
]);

interface ToolBudget {
  rounds: number;
  calls: number;
  /** A decline or exhausted budget applies to every subsequent round and repair. */
  notRun?: string;
}

export function createParticipantHandler(panel: DiagramPanel): vscode.ChatRequestHandler {
  return async (request, context, stream, token) => {
    if (token.isCancellationRequested) {
      return;
    }
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

    // Keep the default surface deliberate. Explicit external attachments are supported for
    // drawing, but /explain only permits known read-only tools, even when others are attached.
    const attachedNames = new Set(request.toolReferences.map((reference) => reference.name));
    const tools = vscode.lm.tools.filter((tool) =>
      explain
        ? READ_ONLY_TOOLS.has(tool.name)
        : attachedNames.has(tool.name) || DEFAULT_TOOLS.has(tool.name),
    );
    const attached = tools.filter((tool) => attachedNames.has(tool.name));

    try {
      const messages = await unlessCancelled(
        () => promptMessages(request, context, explain, current, token),
        token,
      );
      if (typeof messages === "string") {
        return { errorDetails: { message: messages } };
      }
      const budget: ToolBudget = { rounds: 0, calls: 0 };
      const converse = (required: readonly vscode.LanguageModelChatTool[]) =>
        unlessCancelled(
          () => streamReply(request, messages, tools, required, stream, token, panel, budget),
          token,
        );

      let block = await converse(attached);
      if (explain) {
        return;
      }

      let failure: { block: DiagramBlock; error: string } | undefined;
      for (let attempt = 0; block && !token.isCancellationRequested; attempt++) {
        const noun = diagramNoun(block.language);
        stream.progress(`Rendering ${noun}…`);
        const diagram = { ...block, title: guessTitle(block) };
        const outcome = await unlessCancelled(() => panel.render(diagram, "participant"), token);
        if (token.isCancellationRequested) {
          return;
        }
        if (outcome.ok || outcome.kind === "unavailable") {
          if (!outcome.ok) {
            stream.markdown(`\n\n${outcome.error}`);
          }
          showButton(stream, block.language);
          return { metadata: block };
        }
        failure = { block, error: outcome.error };
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
      const drawn = panel.adopt(request.toolInvocationToken);
      if (drawn) {
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
      // E.g. a CancellationError from counting tokens or sending a request.
      if (token.isCancellationRequested) {
        return;
      }
      return { errorDetails: { message: errorMessage(error) } };
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
  panel: DiagramPanel,
  budget: ToolBudget,
): Promise<DiagramBlock | undefined> {
  const initialState = panel.current;
  let diagram: DiagramBlock | undefined;
  let diagramState = panel.current;
  for (let round = 0; ; round++) {
    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    // Some models only support a single tool when a tool call is required. The tools are passed
    // even when calls are no longer run, as some models reject requests whose messages contain
    // tool calls but no tools.
    const finalReply = budget.notRun !== undefined;
    const requiredTool = finalReply ? undefined : required[round];
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
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }
      if (part instanceof vscode.LanguageModelTextPart) {
        reply += part.value;
        show(filter.push(part.value));
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        calls.push(part);
      }
    }
    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    show(filter.flush());
    const block = filter.diagrams.at(-1);
    if (block) {
      diagram = block;
      diagramState = panel.current;
    }
    if (filter.unterminated) {
      stream.markdown(
        "\n\nThe reply ended before the diagram was complete. Try again, or ask for a smaller diagram.",
      );
    }
    if (calls.length === 0 || finalReply) {
      if (reply) {
        messages.push(vscode.LanguageModelChatMessage.Assistant(reply));
      }
      if (calls.length > 0) {
        stream.markdown(`\n\nStopped tool use because ${budget.notRun}.`);
      }
      // A successful tool render or manual edit remains authoritative, even when the model
      // emits a fresh fence in its final reply. Re-rendering that fence would lose code links,
      // chart data and presentation. A failed render may still be repaired by a fallback fence.
      const changed = panel.current !== initialState && !panel.current?.error;
      return !changed && panel.current === diagramState ? diagram : undefined;
    }
    if (budget.rounds++ >= MAX_TOOL_ROUNDS) {
      budget.notRun ??= "this request reached its tool round limit";
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
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }
      let content: unknown[];
      if (budget.calls >= MAX_TOOL_CALLS) {
        budget.notRun ??= "this request reached its tool call limit";
      }
      if (budget.notRun) {
        content = text(`Not run, as ${budget.notRun}. Answer without tools.`);
      } else if (!options.tools?.some((tool) => tool.name === call.name)) {
        // invokeTool runs any registered tool, not only those the model was given.
        content = text(
          `The tool ${call.name} is not available in this round. Use only the tools you were given.`,
        );
      } else {
        try {
          budget.calls++;
          const input = { input: call.input, toolInvocationToken: request.toolInvocationToken };
          content = (await vscode.lm.invokeTool(call.name, input, token)).content;
        } catch (error) {
          if (token.isCancellationRequested) {
            throw error;
          }
          // The user declined the tool call, e.g. to run a command: a CancellationError, though
          // not always an instance of one. Don't let the model ask again.
          if (
            error instanceof Error &&
            ["Canceled", "CancellationError", "AbortError"].includes(error.name)
          ) {
            budget.notRun = "the user declined an earlier tool call";
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
    await fitToolResults(request.model, messages, results, token);
    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    messages.push(vscode.LanguageModelChatMessage.User(results));
    if (reply && !reply.endsWith("\n")) {
      stream.markdown("\n\n");
    }
  }
}
