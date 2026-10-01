// What the @diagram participant sends a language model: its instructions, the conversation so far
// and the user's attachments.

import * as vscode from "vscode";
import { codeFence } from "./blocks";
import { CHART_TOOL, isDiagramLanguage } from "./protocol";

/** Attached files are truncated to this many characters. */
const MAX_REFERENCE_LENGTH = 50_000;

const INSTRUCTIONS = `You are @diagram, an assistant inside VS Code that draws diagrams and charts.
They are rendered in an interactive panel next to the chat, where the user can select nodes or chart items, edit the source by hand and send follow-up requests.

Pick what fits the content:
- Mermaid, for structure and flow: flowchart, sequenceDiagram, classDiagram, stateDiagram-v2, erDiagram, gantt, mindmap, timeline, gitGraph and so on, in a \`\`\`mermaid code block.
- Apache ECharts 6, for quantitative data: pie, bar, line, area, scatter, radar, funnel, gauge, heatmap, treemap, sunburst, sankey and so on, in an \`\`\`echarts code block holding the complete option object as strict JSON (double quotes, no comments, no functions; use string templates such as "{b}: {c}" for formatters), with the data inline.
- The ${CHART_TOOL} tool, for data in a file or a shell command's output (e.g. "pie chart of the disk usage per folder": command "du -s *"), or larger inline data such as a pasted table. It reads the data, renders the chart and tells you how it read the data. Prefer it over an echarts block for data from a file or command, and never invent data that they would give.
- If the user asks for Mermaid (or gives Mermaid source), use Mermaid, e.g. a Mermaid pie or xychart; if they ask for ECharts, use ECharts.

Rules:
- Reply with a short explanation (a few sentences at most) followed by exactly one \`\`\`mermaid or \`\`\`echarts code block with the complete diagram or chart, never a partial one or a diff. After using ${CHART_TOOL}, reply with the explanation alone.
- The code block is not shown in the chat: the diagram appears in the panel instead. So do not refer to it as "below" or repeat its contents; describe what the diagram shows or what you changed.
- When a current diagram is given, treat the request as a change to it unless the user clearly asks for something new. Preserve node ids, the user's manual edits and everything the request does not touch.
- When the user refers to "this", "these" or "the selection", they mean the nodes or chart items they have selected in the panel.
- Mermaid: use short, stable node ids with human-readable labels. Quote labels that contain punctuation, e.g. A["parse(input)"].
- Leave out click directives, HTML, colors, backgrounds, fonts and sizes: the panel follows the user's VS Code theme and fits charts to its size. Give an ECharts chart a short title.text, which the panel shows as its heading.
- If the request is too ambiguous to draw, ask one clarifying question instead of guessing, without a code block.`;

const EXPLAIN_INSTRUCTIONS = `You are @diagram, an assistant inside VS Code that explains diagrams and charts.
Explain the current diagram or chart to the user, focusing on the nodes or items they have selected if any, and answer their question about it.
Do not output a mermaid or echarts code block: this request must not change the diagram.`;

/**
 * The messages asking the model to answer a request, to draw or, with `explain`, to explain
 * `current`: the description of the current diagram, if any.
 */
export async function promptMessages(
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
  explain: boolean,
  current: string | undefined,
): Promise<vscode.LanguageModelChatMessage[]> {
  return [
    vscode.LanguageModelChatMessage.User(explain ? EXPLAIN_INSTRUCTIONS : INSTRUCTIONS),
    ...historyMessages(context),
    ...(await referenceMessages(context, request)),
    ...(current ? [vscode.LanguageModelChatMessage.User(current)] : []),
    vscode.LanguageModelChatMessage.User(request.prompt),
  ];
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
  // The references come in reverse order of their position in the prompt.
  const references = [...context.history, request].flatMap((turn) =>
    turn instanceof vscode.ChatResponseTurn ? [] : [...turn.references].reverse(),
  );
  const attachments = await Promise.all(references.map(describeReference));
  return Array.from(new Set(attachments.filter((text) => text !== undefined)), (text) =>
    vscode.LanguageModelChatMessage.User(text),
  );
}

async function describeReference({
  value,
  modelDescription,
}: vscode.ChatPromptReference): Promise<string | undefined> {
  const content = await referenceContent(value);
  if (!content) {
    return undefined;
  }
  const { name, text } = content;
  const label = `Attached by the user: ${name}${modelDescription ? ` (${modelDescription})` : ""}`;
  if (text === undefined) {
    return `${label}, which is not a text file.`;
  }
  const truncated =
    text.length > MAX_REFERENCE_LENGTH
      ? `, truncated to the first ${MAX_REFERENCE_LENGTH} of its ${text.length} characters`
      : "";
  return `${label}${truncated}\n\n${codeFence(text.slice(0, MAX_REFERENCE_LENGTH))}`;
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
