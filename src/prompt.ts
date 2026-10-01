// What the @diagram participant sends a language model: its instructions, the conversation so far
// and the user's attachments, as much as fits.

import * as vscode from "vscode";
import { codeFence } from "./blocks";
import { CHART_TOOL, isDiagramLanguage } from "./protocol";

/** Attached files are truncated to this many characters. */
const MAX_ATTACHMENT_LENGTH = 50_000;

const INSTRUCTIONS = `You are @diagram inside VS Code. Draw diagrams and charts in the interactive panel beside chat. Users can select nodes or chart items, edit the source and send follow-up requests.

Choose the format:
- Mermaid for structure and flow (flowchart, sequence, class, state, ER, Gantt, mind map, timeline, etc.): one \`\`\`mermaid code block.
- Apache ECharts 6 for quantitative data: one \`\`\`echarts code block containing the complete option as strict JSON, with inline data. No comments or functions; use string templates such as "{b}: {c}" for formatters.
- ${CHART_TOOL} for a file, shell command output or a large pasted table. It handles access confirmation, reads the data and renders the chart. Never invent file contents or command output.
- Honor an explicit format choice, including Mermaid pie and xychart diagrams.

Reply briefly, followed by one complete diagram block, never a diff. After using ${CHART_TOOL}, give only the explanation. The panel replaces code blocks in chat: do not refer to a diagram as "below" or repeat its contents.
Treat requests as edits to the current diagram unless the user asks for a new one. Preserve node ids, manual edits and unrelated content. "This", "these" and "the selection" refer to selected nodes or chart items.
Use short, stable Mermaid ids and readable labels. Quote labels with punctuation, e.g. A["parse(input)"]. Leave out click directives, HTML, colors, backgrounds, fonts and sizes; the panel handles theme and layout. Give ECharts a short title.text for the panel heading.
If the request is too ambiguous, ask one clarifying question without a diagram block.`;

const EXPLAIN_INSTRUCTIONS = `You are @diagram, an assistant inside VS Code that explains diagrams and charts.
Explain the current diagram or chart to the user, focusing on the nodes or items they have selected if any, and answer their question about it.
Do not output a mermaid or echarts code block: this request must not change the diagram.`;

/**
 * The share of the model's input tokens kept for what a request adds to its prompt in later rounds:
 * replies, tool results and requests to fix a diagram. Tool results may take half of it, and what
 * the prompt leaves.
 */
const RESERVED_SHARE = 1 / 4;
/** About the most tokens a message takes besides its text. */
const MESSAGE_TOKENS = 4;

/** An earlier request and its reply, which are given or left out together. */
interface Exchange {
  prompt: string;
  /** The attachments' text, as given to the model. */
  attachments: string[];
  reply: string;
  /** The diagram that the reply drew, as the chat does not show it, or how a tool drew it. */
  diagram: string;
}

/** A file, selection or text attached to a request. The text is left out for a non-text file. */
interface Attachment {
  name: string;
  text?: string;
}

/**
 * The messages asking the model to answer a request, to draw or, with `explain`, to explain
 * `current`: the description of the current diagram, if any.
 *
 * They are made to fit the model's input, leaving room for later rounds. The instructions, the
 * request and the current diagram are always given, then as much of the request's attachments as
 * fits, then the most recent earlier exchanges that fit, the older ones without their diagrams if
 * that helps. Returns why the request is too large if even the first don't fit.
 */
export async function promptMessages(
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
  explain: boolean,
  current: string | undefined,
  token: vscode.CancellationToken,
): Promise<vscode.LanguageModelChatMessage[] | string> {
  const { model } = request;
  const instructions = explain ? EXPLAIN_INSTRUCTIONS : INSTRUCTIONS;
  const attachments = await readAttachments(request);
  const exchanges = await pastExchanges(context.history);

  const budget = Math.floor(model.maxInputTokens * (1 - RESERVED_SHARE));
  const everything = [
    instructions,
    current ?? "",
    request.prompt,
    ...attachments.map((attachment) => attachmentText(attachment)),
    ...exchanges.flatMap((exchange) => [
      exchange.prompt,
      ...exchange.attachments,
      exchange.reply + exchange.diagram,
    ]),
  ];
  const tokens = tokenCounter(model, everything, budget, token);
  const tooLarge = (what: string) =>
    `This request is too large for ${model.name}, which takes ${budget} tokens here (${model.maxInputTokens} less room for its reply): ${what}. Shorten your message${current ? ", start over without the current diagram with /new" : ""} or pick a model that takes more.`;

  const [instructionTokens, promptTokens, currentTokens] = await Promise.all([
    tokens(instructions),
    tokens(request.prompt),
    current ? tokens(current) : 0,
  ]);
  let left = budget - sum([instructionTokens, promptTokens, currentTokens]);
  if (left < 0) {
    return tooLarge(
      `your message takes ${promptTokens} tokens${current ? ` and the current diagram ${currentTokens}` : ""}`,
    );
  }

  // Share what is left among the attachments, shortening those that don't fit.
  const attached = await fitTexts(
    attachments.map((attachment) => ({
      attachment,
      length: Math.min(attachment.text?.length ?? 0, MAX_ATTACHMENT_LENGTH),
      shorten: (length: number) => attachmentText(attachment, length),
    })),
    left,
    tokens,
  );
  if (attached.misfit) {
    const essentials = current
      ? "your message and the current diagram leave"
      : "your message leaves";
    return tooLarge(`${essentials} no room for the attachment ${attached.misfit.attachment.name}`);
  }
  left = attached.left;

  // The most recent exchanges that fit, giving up the diagrams of older ones first.
  const { User, Assistant } = vscode.LanguageModelChatMessage;
  const history: vscode.LanguageModelChatMessage[] = [];
  const given = new Set(attachments.map((attachment) => attachmentText(attachment)));
  let withDiagrams = true;
  for (const { prompt, attachments, reply, diagram } of exchanges.toReversed()) {
    const added = attachments.filter((text) => !given.has(text));
    const full = reply + diagram;
    const short = diagram ? `${reply}\n\n(I drew a diagram, left out here.)` : full;
    const [userTokens, fullTokens, shortTokens] = await Promise.all([
      Promise.all([prompt, ...added].map(tokens)).then(sum),
      full ? tokens(full) : 0,
      short === full ? 0 : tokens(short),
    ]);
    withDiagrams &&= userTokens + fullTokens <= left;
    const text = withDiagrams ? full : short;
    const size = userTokens + (withDiagrams || short === full ? fullTokens : shortTokens);
    if (size > left) {
      break;
    }
    left -= size;
    for (const attachment of added) {
      given.add(attachment);
    }
    history.unshift(
      User(prompt),
      ...added.map((attachment) => User(attachment)),
      ...(text ? [Assistant(text)] : []),
    );
  }

  return [
    User(instructions),
    ...history,
    ...attached.texts.map((text) => User(text)),
    ...(current ? [User(current)] : []),
    User(request.prompt),
  ];
}

/**
 * Shortens the text of tool results so that, added to `messages`, they leave half the reserved share
 * of the model's input for later rounds, saying so in them.
 */
export async function fitToolResults(
  model: vscode.LanguageModelChat,
  messages: readonly vscode.LanguageModelChatMessage[],
  results: readonly vscode.LanguageModelToolResultPart[],
  token: vscode.CancellationToken,
): Promise<void> {
  const budget = Math.floor(model.maxInputTokens * (1 - RESERVED_SHARE / 2));
  const earlier = messages.flatMap((message) => partTexts(message.content));
  const parts = results.flatMap((result) =>
    result.content.filter((part) => part instanceof vscode.LanguageModelTextPart),
  );
  const tokens = tokenCounter(
    model,
    [...earlier, ...parts.map((part) => part.value)],
    budget,
    token,
  );
  const room = budget - sum(await Promise.all(earlier.map(tokens)));
  const { texts, left } = await fitTexts(
    parts.map(({ value }) => ({
      length: value.length,
      shorten: (length: number) =>
        length < value.length
          ? `${value.slice(0, length)}\n\n[truncated: first ${length} of ${value.length} characters]`
          : value,
    })),
    room,
    tokens,
  );
  if (left < 0) {
    throw new Error(
      `The conversation is too large for ${model.name}, even with shortened tool results. Start a new chat or choose a model with a larger context.`,
    );
  }
  for (const [index, part] of parts.entries()) {
    part.value = texts[index] ?? part.value;
  }
}

/** The text of message parts, including tool calls and results. Images and other data are left out. */
function partTexts(parts: readonly unknown[]): string[] {
  return parts.flatMap((part) => {
    if (part instanceof vscode.LanguageModelTextPart) {
      return [part.value];
    }
    if (part instanceof vscode.LanguageModelToolCallPart) {
      return [JSON.stringify(part.input)];
    }
    if (part instanceof vscode.LanguageModelToolResultPart) {
      return partTexts(part.content);
    }
    return [];
  });
}

/**
 * Counts the tokens that a text takes in the model's input, where all of `texts` should fit in
 * `budget`. A tokenizer makes at most one token of each UTF-8 byte. So if their bytes fit, the tokens
 * do and need not be counted, which takes a call to the model's provider per text.
 */
function tokenCounter(
  model: vscode.LanguageModelChat,
  texts: string[],
  budget: number,
  token: vscode.CancellationToken,
): (text: string) => Promise<number> {
  const exact = sum(texts.map((text) => MESSAGE_TOKENS + Buffer.byteLength(text))) > budget;
  return async (text) =>
    MESSAGE_TOKENS + (exact ? await model.countTokens(text, token) : Buffer.byteLength(text));
}

/**
 * Shortens texts so that together they take at most `room` tokens, sharing it among them, the
 * smallest first, so that what a small one leaves goes to the larger ones. Each has `length`
 * characters of its own, and `shorten` gives it with fewer. Returns the texts, the tokens left and
 * the first one that does not fit even with none of its own.
 */
async function fitTexts<T extends { length: number; shorten: (length: number) => string }>(
  entries: T[],
  room: number,
  tokens: (text: string) => Promise<number>,
): Promise<{ texts: string[]; left: number; misfit?: T }> {
  const sized = await Promise.all(
    entries.map(async (entry) => {
      const text = entry.shorten(entry.length);
      return { entry, text, size: await tokens(text) };
    }),
  );
  let left = room;
  let misfit: T | undefined;
  for (const [rank, item] of sized.toSorted((a, b) => a.size - b.size).entries()) {
    const share = Math.floor(left / (sized.length - rank));
    let length = item.entry.length;
    while (item.size > share && length > 0) {
      // Tokens are not spread evenly over the text, so this may take a few tries.
      length = Math.max(0, Math.floor(length * Math.min(share / item.size, 0.9)));
      item.text = item.entry.shorten(length);
      item.size = await tokens(item.text);
    }
    if (item.size > share) {
      misfit ??= item.entry;
    }
    left -= item.size;
  }
  return { texts: sized.map(({ text }) => text), left, misfit };
}

function sum(numbers: number[]): number {
  return numbers.reduce((total, n) => total + n, 0);
}

async function pastExchanges(history: vscode.ChatContext["history"]): Promise<Exchange[]> {
  const exchanges: Exchange[] = [];
  const reads: Promise<void>[] = [];
  for (const turn of history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      const exchange: Exchange = { prompt: turn.prompt, attachments: [], reply: "", diagram: "" };
      exchanges.push(exchange);
      // Later requests often refer to the files, selections and text attached to earlier ones.
      reads.push(
        readAttachments(turn).then((attachments) => {
          exchange.attachments = attachments.map((attachment) => attachmentText(attachment));
        }),
      );
      continue;
    }
    const exchange = exchanges.at(-1);
    if (!exchange) {
      continue;
    }
    exchange.reply = turn.response
      .map((part) => (part instanceof vscode.ChatResponseMarkdownPart ? part.value.value : ""))
      .join("");
    // Diagrams are not shown in chat, so restore the one this turn produced.
    const source: unknown = turn.result.metadata?.source;
    const language: unknown = turn.result.metadata?.language;
    const chart: unknown = turn.result.metadata?.chart;
    if (typeof source === "string" && isDiagramLanguage(language)) {
      exchange.diagram = `\n\n${codeFence(source, language)}`;
    } else if (chart) {
      exchange.diagram = `\n\n(I drew a chart with ${CHART_TOOL}, with these parameters: ${JSON.stringify(chart)})`;
    }
  }
  await Promise.all(reads);
  return exchanges;
}

/** The files, selections and text attached to a request, in prompt order, each read again. */
async function readAttachments({
  references,
}: vscode.ChatRequest | vscode.ChatRequestTurn): Promise<Attachment[]> {
  // The references come in reverse order of their position in the prompt.
  const attachments = await Promise.all(references.toReversed().map(readAttachment));
  const unique = new Map<string, Attachment>();
  for (const attachment of attachments) {
    if (attachment) {
      unique.set(attachmentText(attachment), attachment);
    }
  }
  return [...unique.values()];
}

/** An attachment as given to the model, its text shortened to `length` characters. */
function attachmentText({ name, text }: Attachment, length = MAX_ATTACHMENT_LENGTH): string {
  const label = `Attached by the user: ${name}`;
  if (text === undefined) {
    return `${label}, which is not a text file.`;
  }
  const truncated =
    text.length > length
      ? `, truncated to the first ${length} of its ${text.length} characters`
      : "";
  return `${label}${truncated}\n\n${codeFence(text.slice(0, length))}`;
}

/**
 * The name and text of an attached file, selection or string. The text is left out for a folder or
 * binary file. Other values, such as images, are skipped.
 */
async function readAttachment({
  value,
  modelDescription,
}: vscode.ChatPromptReference): Promise<Attachment | undefined> {
  const description = modelDescription ? ` (${modelDescription})` : "";
  if (typeof value === "string") {
    return { name: `text${description}`, text: value };
  }
  const location = value instanceof vscode.Location ? value : undefined;
  const uri = location?.uri ?? (value instanceof vscode.Uri ? value : undefined);
  if (!uri) {
    return undefined;
  }
  const path = vscode.workspace.asRelativePath(uri);
  const name = `${location ? `${path}:${location.range.start.line + 1}` : path}${description}`;
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    return { name, text: document.getText(location?.range) };
  } catch {
    return { name };
  }
}
