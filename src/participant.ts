import * as vscode from "vscode";
import { codeFence, type DiagramBlock, DiagramBlockFilter, guessTitle } from "./blocks";
import { throwIfCancelled, unlessCancelled } from "./cancellation";
import { userChanges } from "./describe";
import type { DiagramPanel } from "./panel";
import {
  acceptsImages,
  escapeMarkdown,
  fitToolResults,
  promptMessages,
  ROOM_FIXES,
  toolResultBudget,
} from "./prompt";
import {
  ANNOTATE_TOOL,
  CHART_TOOL,
  type DiagramLanguage,
  diagramNoun,
  EDIT_TOOL,
  errorMessage,
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
import { joinWords, plural } from "./text";
import { revisionDrawn } from "./toolResults";
import { resolveWorkspaceFile } from "./workspaceTools";

export const PARTICIPANT_ID = "diagram.participant";

/** How many times to ask the model to fix a diagram that fails to render. */
const MAX_REPAIR_ATTEMPTS = 2;
/**
 * Rounds of tool calls to read the diagram and explore the workspace: find files, search them,
 * read them, then follow their imports and definitions, a hop a round.
 */
const EXPLORE_ROUNDS = 10;
/**
 * Rounds of tool calls to draw: render, view the image, fix what it or the render reports as many
 * times as a diagram block may be repaired, then mark items or have the user pick.
 */
const DRAW_ROUNDS = 3 + MAX_REPAIR_ATTEMPTS;
/** How many rounds of tool calls a single reply may take. */
const MAX_TOOL_ROUNDS = EXPLORE_ROUNDS + DRAW_ROUNDS;
/**
 * Shared across exploration and render repairs, including parallel call batches: a few a round, as
 * when reading the files that a search found, and one for each round of drawing.
 */
const MAX_TOOL_CALLS = 3 * MAX_TOOL_ROUNDS;

const READ_ONLY_TOOLS = new Set([
  GET_STATE_TOOL,
  GET_IMAGE_TOOL,
  FIND_FILES_TOOL,
  SEARCH_TEXT_TOOL,
  READ_FILE_TOOL,
  GUIDE_TOOL,
]);
const DEFAULT_TOOLS = new Set([
  ...READ_ONLY_TOOLS,
  RENDER_TOOL,
  EDIT_TOOL,
  CHART_TOOL,
  PICK_NODES_TOOL,
  ANNOTATE_TOOL,
  INSPECT_DATA_TOOL,
  UPDATE_CHART_TOOL,
  STYLE_TOOL,
]);
const DRAWING_TOOLS = new Set([RENDER_TOOL, EDIT_TOOL, CHART_TOOL, UPDATE_CHART_TOOL, STYLE_TOOL]);

/** What the tool calls of a request used and did, across its rounds and repairs. */
interface ToolUse {
  rounds: number;
  calls: number;
  /** A decline or exhausted budget applies to every subsequent round and repair. */
  notRun?: string;
  /** The revision that the last of the request's tool calls that drew in the panel drew. */
  drawn?: number;
  /** The workspace files that the request's tool calls read, which chat lists as references. */
  read: Set<string>;
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
      // Beside chat, which keeps the focus for the next request.
      panel.show(true);
      stream.markdown("Opened the diagram panel.");
      return;
    }

    const explain = request.command === "explain";

    // A model says whether it calls tools in capabilities, which is not part of the stable API.
    // One that does not call tools may reject a request with tools; it draws with a diagram block
    // instead. One that does not view images may reject a request with an image.
    const { capabilities } = request.model as { capabilities?: { supportsToolCalling?: boolean } };
    const callsTools = capabilities?.supportsToolCalling !== false;
    const viewsImages = acceptsImages(request.model);
    // Drawing may also use the tools the user attached; /explain only the read-only tools.
    const attachedNames = new Set(request.toolReferences.map((reference) => reference.name));
    const tools = callsTools
      ? vscode.lm.tools.filter(
          (tool) =>
            (viewsImages || tool.name !== GET_IMAGE_TOOL) &&
            (explain
              ? READ_ONLY_TOOLS.has(tool.name)
              : attachedNames.has(tool.name) || DEFAULT_TOOLS.has(tool.name)),
        )
      : [];
    const description =
      request.command === "new"
        ? undefined
        : panel.describeForModel({ tools: new Set(tools.map(({ name }) => name)) });
    const current =
      description === undefined || !panel.current
        ? undefined
        : {
            description,
            source: panel.current.source,
            edited: userChanges(panel.current)?.from,
          };
    // Until the request draws, or ends without drawing.
    panel.startsNew = request.command === "new";
    if (explain && !current) {
      stream.markdown("There is no diagram to explain yet. Describe what you want me to draw.");
      return;
    }

    const attached = tools.filter((tool) => attachedNames.has(tool.name));
    const leftOut = explain ? [...attachedNames].filter((name) => !READ_ONLY_TOOLS.has(name)) : [];
    if (!callsTools && attachedNames.size > 0) {
      stream.markdown(
        `${escapeMarkdown(request.model.name)} cannot call tools, so the attached tools are left out.\n\n`,
      );
    } else if (!viewsImages && attachedNames.has(GET_IMAGE_TOOL)) {
      stream.markdown(
        `${escapeMarkdown(request.model.name)} does not accept images, so it cannot view the diagram.\n\n`,
      );
    }
    if (callsTools && leftOut.length > 0) {
      const names = joinWords(
        leftOut.map((name) => `\`${name}\``),
        "and",
      );
      stream.markdown(
        `/explain uses only the tools that read the diagram and the workspace, so it leaves out the attached ${names}.\n\n`,
      );
    }

    // Protect edits made while attachments load, as well as during every reply and repair.
    const changesAtStart = panel.userChangeCount;
    try {
      const prompt = await unlessCancelled(
        () => promptMessages(request, context, explain, callsTools, current, token),
        token,
      );
      if (typeof prompt === "string") {
        return { errorDetails: { message: prompt } };
      }
      const { messages, notice } = prompt;
      if (notice) {
        stream.markdown(`${notice}\n\n`);
      }
      const toolUse: ToolUse = { rounds: 0, calls: 0, read: new Set() };
      const converse = async (required: readonly vscode.LanguageModelChatTool[]) => {
        const diagram = await unlessCancelled(
          () => streamReply(request, messages, tools, required, stream, token, panel, toolUse),
          token,
        );
        if (!diagram || panel.userChangeCount === changesAtStart) return diagram;
        stream.markdown(
          `\n\nI did not draw this ${diagramNoun(diagram.language)} over the change you made in the panel meanwhile. Ask again to draw it.`,
        );
        return undefined;
      };

      let block = await converse(attached);
      if (explain) {
        return;
      }

      let failure: { block: DiagramBlock; error: string } | undefined;
      /** A block that rendered with warnings, which stays drawn unless a fix of them renders. */
      let warned: DiagramBlock | undefined;
      const draw = (drawing: DiagramBlock) =>
        unlessCancelled(
          () => panel.render({ ...drawing, title: guessTitle(drawing) }, "participant"),
          token,
        );
      for (let attempt = 0; block && !token.isCancellationRequested; attempt++) {
        const noun = diagramNoun(block.language);
        stream.progress(`Rendering ${noun}…`);
        const outcome = await draw(block);
        if (token.isCancellationRequested) {
          return;
        }
        // Once, as a model may not be able to fix all, which it may say instead.
        const warnings =
          outcome.ok && !warned && attempt < MAX_REPAIR_ATTEMPTS ? panel.warnings : [];
        if (warnings.length > 0) {
          warned = block;
          // It repaired any render error before it, and is what the reply drew unless fixed.
          failure = undefined;
          stream.progress("Fixing rendering warnings…");
          stream.markdown("\n\n---\n\n");
          messages.push(
            vscode.LanguageModelChatMessage.User(
              `That ${noun} rendered, with these warnings:\n\n- ${warnings.join("\n- ")}\n\nFix what they warn about; ${ROOM_FIXES}. Reply with one sentence about what you fixed, followed by the corrected complete ${noun} in a single ${block.language} code block, or say why you leave it as it is, without a code block.`,
            ),
          );
          block = await converse([]);
          continue;
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
      const drawn = panel.adopt(toolUse.drawn);
      if (drawn) {
        showButton(stream, drawn.language);
        return {
          metadata: drawn.chart
            ? { chart: drawn.chart }
            : { language: drawn.language, source: drawn.source },
        };
      }
      // A reply that left the warnings, or whose fix failed to render, keeps the block that had
      // them, unless the user changed the diagram meanwhile.
      const shows = (shown: DiagramBlock) =>
        panel.current?.language === shown.language && panel.current.source === shown.source;
      if (warned && !failure && shows(warned)) {
        showButton(stream, warned.language);
        return { metadata: warned };
      }
      if (warned && failure && shows(failure.block) && !token.isCancellationRequested) {
        const kept = await draw(warned);
        if (kept.ok) {
          stream.markdown(
            `\n\nThe fix failed to render, so the ${diagramNoun(warned.language)} stays as it was.`,
          );
          showButton(stream, warned.language);
          return { metadata: warned };
        }
      }
      if (!failure) {
        return;
      }
      // As in the panel: details after the first line, like a source excerpt with a caret, in a
      // fixed font.
      const [summary = "", ...details] = failure.error.split("\n");
      const excerpt = details.length > 0 ? `\n\n${codeFence(details.join("\n"))}` : "";
      stream.markdown(
        `\n\nThe ${diagramNoun(failure.block.language)} failed to render: ${escapeMarkdown(summary)}${excerpt}\n\nYou can fix it in the source view of the diagram panel, which the \`</>\` button at its top right opens.`,
      );
      return { metadata: failure.block };
    } catch (error) {
      // E.g. a CancellationError from counting tokens or sending a request.
      if (token.isCancellationRequested) {
        return;
      }
      return { errorDetails: { message: errorMessage(error) } };
    } finally {
      panel.startsNew = false;
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
  toolUse: ToolUse,
): Promise<DiagramBlock | undefined> {
  let diagram: DiagramBlock | undefined;
  let drawnBeforeDiagram = toolUse.drawn;
  for (let round = 0; ; round++) {
    throwIfCancelled(token);
    // Some models only support a single tool when a tool call is required. The tools are passed
    // even when calls are no longer run, as some models reject requests whose messages contain
    // tool calls but no tools.
    const finalReply = toolUse.notRun !== undefined;
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
      throwIfCancelled(token);
      if (part instanceof vscode.LanguageModelTextPart) {
        reply += part.value;
        show(filter.push(part.value));
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        calls.push(part);
      }
    }
    throwIfCancelled(token);
    show(filter.flush());
    const block = filter.diagrams.at(-1);
    if (block) {
      diagram = block;
      drawnBeforeDiagram = toolUse.drawn;
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
        stream.markdown(`\n\nStopped tool use because ${toolUse.notRun}.`);
      }
      // Keep this request's tool rendering if it followed the block or is still shown; replacing
      // it would lose code links, chart data and styling. A block can repair a failed render or
      // replace another request's drawing.
      const drewAfter = toolUse.drawn !== drawnBeforeDiagram;
      const shown = toolUse.drawn === panel.revision && !panel.current?.error;
      return drewAfter || shown ? undefined : diagram;
    }
    if (toolUse.rounds++ >= MAX_TOOL_ROUNDS) {
      toolUse.notRun ??= "this request reached its tool round limit";
    }

    messages.push(
      vscode.LanguageModelChatMessage.Assistant([
        ...(reply ? [new vscode.LanguageModelTextPart(reply)] : []),
        ...calls,
      ]),
    );
    const text = (value: string) => [new vscode.LanguageModelTextPart(value)];
    const results: vscode.LanguageModelToolResultPart[] = [];
    // Tools that can, such as those with prompt-tsx results, fit their results to a share of the
    // room left.
    const share = (await toolResultBudget(request.model, messages, token)) / calls.length;
    const tokenizationOptions: vscode.LanguageModelToolTokenizationOptions = {
      tokenBudget: Math.max(1, Math.floor(share)),
      countTokens: (value, countToken) => request.model.countTokens(value, countToken),
    };
    for (const call of calls) {
      throwIfCancelled(token);
      let content: unknown[];
      if (toolUse.calls >= MAX_TOOL_CALLS) {
        toolUse.notRun ??= "this request reached its tool call limit";
      }
      if (toolUse.notRun) {
        // A diagram block is drawn still.
        const draw =
          diagram === undefined &&
          toolUse.drawn === undefined &&
          tools.some((tool) => DRAWING_TOOLS.has(tool.name));
        content = text(
          `Not run, as ${toolUse.notRun}. Answer without tools${draw ? ", and to draw, reply with the complete diagram in a mermaid or echarts code block" : ""}.`,
        );
      } else if (!options.tools?.some((tool) => tool.name === call.name)) {
        // invokeTool runs any registered tool, not only those the model was given. A required
        // round offers only the required tool, and the others in the next.
        const when = tools.some((tool) => tool.name === call.name) ? " in this round" : "";
        content = text(
          `The tool ${call.name} is not available${when}. Use only the tools you were given.`,
        );
      } else {
        try {
          toolUse.calls++;
          const invocation = {
            input: call.input,
            toolInvocationToken: request.toolInvocationToken,
            tokenizationOptions,
          };
          content = (await vscode.lm.invokeTool(call.name, invocation, token)).content;
          // Another chat request may draw in the panel meanwhile.
          const drawn = DRAWING_TOOLS.has(call.name) ? revisionDrawn(content) : undefined;
          if (drawn !== undefined) toolUse.drawn = drawn;
          const file = call.name === READ_FILE_TOOL ? fileRead(call.input, content) : undefined;
          if (file && !toolUse.read.has(file.toString())) {
            toolUse.read.add(file.toString());
            stream.reference(file);
          }
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
            toolUse.notRun = "the user declined an earlier tool call";
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
    // In a tool result, which any model accepts after its calls, unlike other text.
    const left = diagram === undefined ? budgetLeft(toolUse, tools) : undefined;
    const last = results.at(-1);
    if (left && last) {
      results[results.length - 1] = new vscode.LanguageModelToolResultPart(last.callId, [
        ...last.content,
        ...text(left),
      ]);
    }
    await fitToolResults(request.model, messages, results, token);
    throwIfCancelled(token);
    messages.push(vscode.LanguageModelChatMessage.User(results));
    if (reply && !reply.endsWith("\n")) {
      stream.markdown("\n\n");
    }
  }
}

/**
 * Tells a model that has not drawn yet that the tool rounds or calls left are down to those that
 * drawing takes, so that it draws with what it has rather than explore until none are left.
 */
function budgetLeft(
  { rounds, calls, notRun, drawn }: ToolUse,
  tools: readonly vscode.LanguageModelChatTool[],
): string | undefined {
  const roundsLeft = MAX_TOOL_ROUNDS - rounds;
  const callsLeft = MAX_TOOL_CALLS - calls;
  if (notRun !== undefined || drawn !== undefined) return undefined;
  if (roundsLeft > DRAW_ROUNDS && callsLeft > DRAW_ROUNDS) return undefined;
  const draws = tools.some((tool) => DRAWING_TOOLS.has(tool.name));
  if (roundsLeft <= 0 || callsLeft <= 0) {
    // Its diagram block is drawn still.
    return `No tool calls are left in this request: ${draws ? "reply with the complete diagram in a mermaid or echarts code block" : "answer with what you have"}.`;
  }
  const left = `This request has ${plural(roundsLeft, "round")} and ${plural(callsLeft, "call")} of tools left`;
  return draws
    ? `${left}: draw now with what you have, keeping the rest to check and fix the drawing.`
    : `${left}: answer now with what you have.`;
}

/** The file that a call of {@link READ_FILE_TOOL} read, unless it failed. */
function fileRead(input: object, content: readonly unknown[]): vscode.Uri | undefined {
  const [result] = content;
  if (!(result instanceof vscode.LanguageModelTextPart) || result.value.startsWith("Error:")) {
    return undefined;
  }
  try {
    const { file } = input as { file?: unknown };
    return resolveWorkspaceFile(file, vscode.workspace.workspaceFolders ?? []);
  } catch {
    return undefined;
  }
}
