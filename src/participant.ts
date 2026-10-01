import * as vscode from "vscode";
import { extractMermaidBlocks, guessTitle, MermaidBlockFilter, mermaidFence } from "./mermaid";
import type { DiagramPanel } from "./panel";

export const PARTICIPANT_ID = "diagram.participant";

/** How many times to ask the model to fix a diagram that fails to render. */
const MAX_REPAIR_ATTEMPTS = 2;
/** Attached files are truncated to this many characters. */
const MAX_REFERENCE_LENGTH = 50_000;

const INSTRUCTIONS = `You are @diagram, an assistant inside VS Code that draws Mermaid diagrams.
The diagrams you produce are rendered in an interactive panel next to the chat, where the user can select nodes, edit the source by hand and send follow-up requests.

Rules:
- Reply with a short explanation (a few sentences at most) followed by exactly one \`\`\`mermaid code block containing the complete diagram. Never send partial diagrams or diffs.
- The code block is not shown in the chat: the diagram appears in the panel instead. So do not refer to it as "below" or repeat its contents in the explanation; describe what the diagram shows or what you changed.
- When a current diagram is given, treat the request as a change to it unless the user clearly asks for something new. Preserve node ids, the user's manual edits and everything the request does not touch.
- When the user refers to "this", "these" or "the selection", they mean the nodes they have selected in the panel.
- Pick the diagram type that fits the content: flowchart, sequenceDiagram, classDiagram, stateDiagram-v2, erDiagram, gantt, mindmap, timeline, gitGraph and so on.
- Use short, stable node ids with human-readable labels. Quote labels that contain punctuation, e.g. A["parse(input)"].
- Do not use click directives, HTML or hard-coded colors: the panel follows the user's VS Code theme.
- If the request is too ambiguous to draw, ask one clarifying question instead of guessing, without a code block.`;

const EXPLAIN_INSTRUCTIONS = `You are @diagram, an assistant inside VS Code that explains Mermaid diagrams.
Explain the current diagram to the user, focusing on the nodes they have selected if any, and answer their question about it.
Do not output a mermaid code block: this request must not change the diagram.`;

export function createParticipantHandler(panel: DiagramPanel): vscode.ChatRequestHandler {
  return async (request, context, stream, token) => {
    if (request.command === "show") {
      if (!panel.hasDiagram) {
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
      ...(await referenceMessages(request.references)),
    ];
    if (current) {
      messages.push(vscode.LanguageModelChatMessage.User(current));
    }
    messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

    try {
      let reply = await streamReply(request.model, messages, stream, token);
      if (explain) {
        return;
      }

      for (let attempt = 0; ; attempt++) {
        const source = extractMermaidBlocks(reply).at(-1);
        if (!source || token.isCancellationRequested) {
          return;
        }
        stream.progress("Rendering diagram…");
        const outcome = await panel.render(source, guessTitle(source), "participant");
        if (outcome.ok) {
          stream.button({ command: "diagram.show", title: "Show Diagram" });
          return { metadata: { source } };
        }
        if (attempt >= MAX_REPAIR_ATTEMPTS) {
          stream.markdown(
            `\n\nThe diagram failed to render: ${outcome.error}\n\nYou can fix it with **Edit source** in the diagram panel.`,
          );
          return { metadata: { source } };
        }

        stream.progress("Fixing a rendering error…");
        stream.markdown("\n\n---\n\n");
        messages.push(
          vscode.LanguageModelChatMessage.Assistant(reply),
          vscode.LanguageModelChatMessage.User(
            `That diagram failed to render with this error:\n\n${outcome.error}\n\nReply with one sentence about what you fixed, followed by the corrected complete diagram in a single mermaid code block.`,
          ),
        );
        reply = await streamReply(request.model, messages, stream, token);
      }
    } catch (error) {
      if (error instanceof vscode.LanguageModelError) {
        return { errorDetails: { message: error.message } };
      }
      throw error;
    }
  };
}

async function streamReply(
  model: vscode.LanguageModelChat,
  messages: vscode.LanguageModelChatMessage[],
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<string> {
  const response = await model.sendRequest(messages, {}, token);
  // The diagram is shown in the panel, so keep its source out of the chat. This also keeps VS Code
  // from rendering a second, non-interactive copy of it inline.
  const filter = new MermaidBlockFilter();
  let reply = "";
  for await (const fragment of response.text) {
    reply += fragment;
    const visible = filter.push(fragment);
    if (visible) {
      stream.markdown(visible);
    }
  }
  const rest = filter.flush();
  if (rest) {
    stream.markdown(rest);
  }
  return reply;
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
      if (typeof source === "string") {
        text += `\n\n${mermaidFence(source)}`;
      }
      if (text) {
        messages.push(vscode.LanguageModelChatMessage.Assistant(text));
      }
    }
  }
  return messages;
}

async function referenceMessages(
  references: readonly vscode.ChatPromptReference[],
): Promise<vscode.LanguageModelChatMessage[]> {
  const messages: vscode.LanguageModelChatMessage[] = [];
  for (const reference of references) {
    const content = await referenceContent(reference.value);
    if (content) {
      const description = reference.modelDescription ?? content.name;
      messages.push(
        vscode.LanguageModelChatMessage.User(
          `Attached by the user (${description}):\n\n\`\`\`\n${content.text.slice(0, MAX_REFERENCE_LENGTH)}\n\`\`\``,
        ),
      );
    }
  }
  return messages;
}

async function referenceContent(
  value: unknown,
): Promise<{ name: string; text: string } | undefined> {
  try {
    if (value instanceof vscode.Uri) {
      const document = await vscode.workspace.openTextDocument(value);
      return { name: vscode.workspace.asRelativePath(value), text: document.getText() };
    }
    if (value instanceof vscode.Location) {
      const document = await vscode.workspace.openTextDocument(value.uri);
      return {
        name: `${vscode.workspace.asRelativePath(value.uri)}:${value.range.start.line + 1}`,
        text: document.getText(value.range),
      };
    }
    if (typeof value === "string") {
      return { name: "text", text: value };
    }
  } catch {
    // Binary files, missing files and the like are skipped.
  }
  return undefined;
}
