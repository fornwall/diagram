// The tools for any diagram in the panel: diagram_render, diagram_getState, diagram_getImage,
// diagram_pickNodes and diagram_annotate.

import * as vscode from "vscode";
import { type AnnotateInput, hasText, validateAnnotation } from "./annotations";
import { guessTitle } from "./blocks";
import { throwIfCancelled, unlessCancelled } from "./cancellation";
import { nodeList, repeatedList } from "./describe";
import { isClosingFence, openingFence } from "./fences";
import { type ItemNames, type Resolved, resolvedList, severalList } from "./itemNames";
import { validateLinks, withoutMissingFiles } from "./links";
import type { Diagram, DiagramPanel } from "./panel";
import {
  ANNOTATE_TOOL,
  type Annotation,
  type DiagramLanguage,
  diagramNoun,
  EDIT_TOOL,
  errorMessage,
  GET_IMAGE_TOOL,
  type ImageView,
  isDiagramLanguage,
  isPlainObject,
  nodeNoun,
  RENDER_TOOL,
} from "./protocol";
import { renderRevision } from "./renderRevision";
import { errorContext } from "./sourceEdits";
import { parseStateInput, type StateInput, sourcePage } from "./stateSource";
import { givenProperties, nonBlank, plural, quoteAll, unknownProperties } from "./text";
import {
  drawnResult,
  drawnWarnings,
  idList,
  leftOutLinks,
  linksWithoutNodes,
  noDiagram,
  renderFailure,
  textResult,
} from "./toolResults";
import { formatOption } from "./webview/optionSource";

/** As declared in package.json, but a model may not follow the schema exactly. */
interface RenderInput {
  source: string;
  revision?: number;
  language?: string;
  title?: string;
  clickPrompt?: string;
  links?: Record<string, string>;
}

interface PickNodesInput {
  prompt: string;
  multiple?: boolean;
}

/** The question and whether several items may be picked, or what to fix in the input. */
function parsePickInput(value: unknown): { prompt: string; multiple: boolean } | string {
  const input = isPlainObject(value) ? givenProperties(value) : {};
  const prompt = nonBlank(input.prompt);
  if (!prompt) {
    return 'Give "prompt", the question to show the user.';
  }
  if (input.multiple !== undefined && typeof input.multiple !== "boolean") {
    return '"multiple" must be true or false.';
  }
  const unknown = unknownProperties(input, ["prompt", "multiple"]);
  return unknown ?? { prompt, multiple: input.multiple === true };
}

const RENDER_KEYS = [
  "source",
  "revision",
  "language",
  "title",
  "clickPrompt",
  "links",
] as const satisfies readonly (keyof RenderInput)[];

/**
 * Invalid links are reported in `problems`, and other invalid or unknown properties in `ignored`;
 * an invalid source prevents rendering.
 */
function parseRenderInput(
  value: RenderInput,
): { diagram: Diagram; problems: string[]; ignored: string[] } | string {
  // Some models send null for the properties they leave out.
  const input = isPlainObject(value) ? givenProperties(value) : {};
  // As a model may write it: "Mermaid", "ECharts".
  let language = input.language;
  if (typeof language === "string") language = language.toLowerCase();
  // Models sometimes send an ECharts option as an object despite the schema. Sending it again as a
  // string would cost as much.
  if (isPlainObject(input.source) && (language ?? "echarts") === "echarts") {
    input.source = formatOption(JSON.stringify(input.source));
  }
  if (typeof input.source !== "string") {
    return 'Give "source", the complete diagram, as a string.';
  }
  let source = input.source;
  // Models sometimes include a Markdown fence despite the schema. Use the same rules as chat.
  const trimmed = source.trim();
  const firstNewline = trimmed.indexOf("\n");
  const lastNewline = trimmed.lastIndexOf("\n");
  const opening = firstNewline < 0 ? undefined : openingFence(trimmed.slice(0, firstNewline));
  if (opening && isClosingFence(trimmed.slice(lastNewline + 1), opening)) {
    source = trimmed.slice(firstNewline + 1, lastNewline);
    language ??= opening.language;
  }
  if (!source.trim()) {
    return 'Give "source", the complete diagram, as a string.';
  }
  // Mermaid source never starts with "{", so a model that left out the language means ECharts.
  language ??= source.trimStart().startsWith("{") ? "echarts" : "mermaid";
  if (!isDiagramLanguage(language)) {
    return `Unknown language ${JSON.stringify(language)}: use "mermaid" for Mermaid source or "echarts" for an ECharts option as JSON or JavaScript.`;
  }
  const { links, problems } = validateLinks(input.links, language);
  // A misnamed or mistyped property, such as "clickprompt", would otherwise be lost without a word.
  const ignored = (["title", "clickPrompt"] as const)
    .filter((key) => input[key] !== undefined && typeof input[key] !== "string")
    .map((key) => `"${key}" must be a string, so it was ignored.`);
  const unknown = unknownProperties(input, RENDER_KEYS);
  if (unknown) {
    ignored.push(`${unknown} Unknown properties are ignored.`);
  }
  return {
    diagram: {
      language,
      source,
      title: nonBlank(input.title) ?? guessTitle({ language, source }),
      clickPrompt: nonBlank(input.clickPrompt),
      links,
    },
    problems,
    ignored,
  };
}

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
    throwIfCancelled(token);
    const changes = this.panel.userChangeCount;
    let revision: number;
    try {
      revision = renderRevision(options.input, this.panel.revision);
    } catch (error) {
      return textResult(`Nothing was rendered: ${errorMessage(error)}`);
    }
    const parsed = parseRenderInput(options.input);
    if (typeof parsed === "string") {
      return textResult(`Nothing was rendered: ${parsed}`);
    }
    const { diagram, problems } = parsed;
    const ignored = parsed.ignored.length > 0 ? `\n\n${parsed.ignored.join(" ")}` : "";
    const { links } = diagram;
    if (links) {
      const existing = await unlessCancelled(() => withoutMissingFiles(links), token);
      diagram.links = existing.links;
      problems.push(...existing.problems);
    }
    if (this.panel.userChangeCount !== changes || this.panel.revision !== revision) {
      return textResult(
        "Nothing was rendered because the diagram changed in the panel while its code links were checked. Read diagram_getState before making further changes.",
      );
    }
    const outcome = await unlessCancelled(() => this.panel.render(diagram, "tool"), token);
    const noun = diagramNoun(diagram.language);
    if (outcome.ok) {
      return drawnResult(
        [
          `Rendered the ${outcome.diagramType} ${noun} in the diagram panel next to the chat.`,
          ...drawnWarnings(this.panel),
        ].join("\n\n") +
          leftOutLinks(problems, diagram.language) +
          linksWithoutNodes(Object.keys(diagram.links ?? {}), this.panel.drawnIds) +
          ignored,
        outcome.revision,
      );
    }
    const fix =
      diagram.language === "echarts"
        ? "Fix the ECharts option (JSON, or a JavaScript object literal for callbacks such as renderItem)"
        : "Fix the Mermaid syntax";
    // The lines around the error, to fix with an edit of the source that the panel shows.
    const context = errorContext(diagram.source, outcome.error);
    return drawnResult(
      renderFailure(
        outcome,
        noun,
        RENDER_TOOL,
        `${context ? `${context}\n\n` : ""}${fix} with ${EDIT_TOOL}, or call ${RENDER_TOOL} again with the complete corrected source.`,
      ) +
        leftOutLinks(problems, diagram.language) +
        ignored,
      outcome.revision,
    );
  }
}

export class GetDiagramStateTool implements vscode.LanguageModelTool<StateInput> {
  constructor(private readonly panel: DiagramPanel) {}

  prepareInvocation(): vscode.PreparedToolInvocation {
    return { invocationMessage: "Reading the diagram panel" };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<StateInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    throwIfCancelled(token);
    let input: StateInput;
    try {
      input = parseStateInput(options.input);
    } catch (error) {
      return textResult(`The diagram was not read: ${errorMessage(error)}`);
    }
    const current = this.panel.current;
    if (!current) return textResult(noDiagram("read"));
    const { source: exactSource, language } = current;
    const revision = this.panel.revision;
    const room = options.tokenizationOptions;
    const fitting = async (text: string) =>
      room ? await fits(text, room, token) : text.length <= MAX_UNBUDGETED_LENGTH;
    const metadataTooLarge =
      `Revision: ${revision}. The diagram's metadata does not fit the available result budget. ` +
      'Use a larger tool result budget or a new chat. To read exact source lines instead, call diagram_getState with "startLine" and "endLine".';
    if (input.detail === "source") {
      return textResult(
        exactSource === undefined
          ? `Revision: ${revision}. The source was not kept when VS Code closed. The user can press Refresh to load the chart's data again.`
          : await sourcePage(exactSource, language, revision, input, fitting),
      );
    }
    // Snapshot every candidate before token counting yields: an edit during a slow count must
    // not mix one revision's full description with another revision's fallback source.
    if (input.detail === "summary") {
      const summary = this.panel.describeForModel({ detail: "metadata" }) ?? noDiagram("read");
      return textResult((await fitting(summary)) ? summary : metadataTooLarge);
    }
    // A source too long to repeat in every chat request is given in full here, as a model has to
    // read it to change it, unless it does not fit, as the caller would cut it short.
    const full = this.panel.describeForModel({ detail: "full" });
    if (full === undefined) {
      return textResult(noDiagram("read"));
    }
    const source = this.panel.describeForModel({ detail: "source" });
    const summary = this.panel.describeForModel({ detail: "summary" });
    const metadata = this.panel.describeForModel({ detail: "metadata" });
    if (await fitting(full)) return textResult(full);
    // The source, which a model needs to change the diagram, before a long list of relationships.
    if (source !== undefined && source !== full && (await fitting(source))) {
      return textResult(source);
    }
    if (summary !== undefined && (await fitting(summary))) return textResult(summary);
    // An elided chart option can still be large. Keep the selection, errors and other context
    // without source when those fit; never hand an oversized fallback to the caller to truncate.
    if (metadata !== undefined && metadata !== summary && (await fitting(metadata))) {
      return textResult(metadata);
    }
    return textResult(metadataTooLarge);
  }
}

/**
 * A description longer than this, as of a chart of much data, is given as a summary to a caller
 * that gives no token budget: about 30,000 tokens.
 */
const MAX_UNBUDGETED_LENGTH = 100_000;

/**
 * A token rarely stands for more than 10 characters, and typically for 3 or 4. Text longer than
 * this many characters for each token of the budget does not fit, without counting its tokens,
 * which takes long for megabytes of it.
 */
const MAX_CHARS_PER_TOKEN = 10;

/** Whether the text fits the token budget, counted only when its length does not tell. */
async function fits(
  text: string,
  { tokenBudget, countTokens }: vscode.LanguageModelToolTokenizationOptions,
  token: vscode.CancellationToken,
): Promise<boolean> {
  // A token takes at least a byte of UTF-8, which takes at most 3 for each UTF-16 code unit.
  if (text.length * 3 <= tokenBudget) return true;
  if (text.length > tokenBudget * MAX_CHARS_PER_TOKEN) return false;
  return (await unlessCancelled(async () => countTokens(text, token), token)) <= tokenBudget;
}

interface ImageInput {
  ids?: string[];
}

/** The ids of the items to show the part of the drawing around, or what to fix in the input. */
function parseImageInput(value: unknown): string[] | string {
  const input = isPlainObject(value) ? givenProperties(value) : {};
  const unknown = unknownProperties(input, ["ids"]);
  if (unknown) return unknown;
  // A model may give one id as it is.
  const ids = typeof input.ids === "string" ? [input.ids] : (input.ids ?? []);
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
    return '"ids" must be an array of item ids, such as ["A", "A --> B"].';
  }
  return [...new Set(ids)];
}

/**
 * The longest side of an image for a model, and the most pixels in all, as Claude takes them
 * without scaling them down, at about 1,500 tokens. Models of other vendors scale an image with a
 * side as long down further, but one that long only for a long and narrow drawing, such as a
 * flowchart from left to right.
 */
const IMAGE_LIMITS = { maxSide: 1568, maxPixels: 1_150_000 };
/** How many pixels high text must be in an image for a model to read it. */
const LEGIBLE_TEXT = 8;

export class GetDiagramImageTool implements vscode.LanguageModelTool<ImageInput> {
  constructor(private readonly panel: DiagramPanel) {}

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<ImageInput>,
  ): vscode.PreparedToolInvocation {
    const noun = diagramNoun(this.panel.current?.language ?? "mermaid");
    const ids = parseImageInput(options.input);
    return {
      invocationMessage:
        typeof ids === "string" || ids.length === 0
          ? `Viewing the ${noun}`
          : `Viewing ${ids.length <= 3 ? quoteAll(ids) : plural(ids.length, "item")} in the ${noun}`,
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ImageInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { current, revision } = this.panel;
    if (!current) {
      return textResult(noDiagram("view"));
    }
    const ids = parseImageInput(options.input);
    if (typeof ids === "string") {
      return textResult(`There is no image to view: ${ids}`);
    }
    // Reopening the panel redraws its items, including the ids behind relationship names.
    if (ids.length > 0) await unlessCancelled(() => this.panel.itemIds(), token);
    if (this.panel.revision !== revision) {
      return textResult(
        "There is no image to view. The diagram changed while it was drawn. Try again.",
      );
    }
    const noun = diagramNoun(current.language);
    // A model is told the items of a Mermaid diagram, which the panel knows, and may name an edge
    // or message by its ends, all of those between them; the page tells of the items of others.
    const names = this.panel.itemNames;
    const named = names?.resolveAll(ids) ?? ids.map((id) => ({ name: id, ids: [id] }));
    if (ids.length > 0 && names && named.every((item) => item.ids.length === 0)) {
      const items = names.names();
      return textResult(
        `There is no image to view: no item of the ${noun} has these ids: ${resolvedList(named)}. ` +
          (items.length > 0
            ? `Its items are ${idList(items)}.`
            : `It has no items to show alone: call ${GET_IMAGE_TOOL} without "ids".`),
      );
    }
    const drawn = [...new Set(named.flatMap((item) => item.ids))];
    const image = await unlessCancelled(() => this.panel.captureImage(IMAGE_LIMITS, drawn), token);
    if (typeof image === "string") {
      return textResult(`There is no image to view. ${image}`);
    }
    const about = `Revision ${revision} of the ${noun}`;
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        image.view
          ? describeImage(about, image.view, pngSize(image.png), current.language, named, names)
          : `${about}:`,
      ),
      vscode.LanguageModelDataPart.image(image.png, "image/png"),
    ]);
  }
}

/** The width and height of a PNG, from its header, if it has one. */
function pngSize(png: Uint8Array): { width: number; height: number } | undefined {
  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  return bytes.length >= 24 && bytes.toString("latin1", 12, 16) === "IHDR"
    ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
    : undefined;
}

/**
 * What an image shows a model: what part of the drawing at what scale, whether its text can be
 * read there, and how the user sees it in the panel. The size of the image is that of the PNG,
 * whose sides the page rounds down.
 */
function describeImage(
  about: string,
  view: ImageView,
  png: { width: number; height: number } | undefined,
  language: DiagramLanguage,
  named: readonly Resolved[],
  names: ItemNames | undefined,
): string {
  const size = ({ width, height }: { width: number; height: number }, scale = 1) =>
    `${Math.round(width * scale)}×${Math.round(height * scale)} px`;
  const percent = (scale: number) => `${Math.round(scale * 100)}%`;
  const { area, scale, textSize, panel } = view;
  const left = new Set(view.missing);
  const drawn = (item: Resolved) => item.ids.some((id) => !left.has(id));
  const missing = named.filter((item) => !drawn(item));
  const shown = named.filter(drawn);
  const what = area
    ? `the part around ${idList(shown.map(({ name }) => name))} (${size(area)} of the ${size(view)} drawing)`
    : language === "echarts"
      ? `all of it, laid out ${panel ? "for the panel " : ""}at ${size(view)}`
      : `all of its ${size(view)} drawing`;
  const sentences = [
    `${about}: ${what}, at ${percent(scale)} in this ${size(png ?? area ?? view, png ? 1 : scale)} image.`,
  ];
  const legible = (zoom: number) => textSize === undefined || textSize * zoom >= LEGIBLE_TEXT;
  if (textSize !== undefined && !legible(scale)) {
    const here = Math.round(textSize * scale * 10) / 10;
    sentences.push(
      `Its text, ${Math.round(textSize)} px, is ${here} px here: too small to read reliably. ` +
        (area
          ? 'To read it, give fewer "ids", of items close together.'
          : `To read it, call ${GET_IMAGE_TOOL} with the "ids" of a few items, to see the part around them.`),
    );
  }
  if (panel && language === "mermaid") {
    const unread = legible(panel.zoom) ? "" : ", too small to read without zooming in";
    // The panel fits a wide drawing only as far as its text reads, and scrolls it sideways.
    const shown = view.width * panel.zoom;
    const across =
      shown > panel.width + 1
        ? `, ${percent(panel.width / shown)} of its width at a time, scrolling sideways for the rest`
        : "";
    sentences.push(
      `The panel shows it at ${percent(panel.zoom)} in ${size(panel)}${unread}${across}.`,
    );
  } else if (panel && panel.height < view.height) {
    sentences.push(`The panel shows ${size(panel)} of it at a time, and scrolls the rest.`);
  }
  const text = sentences.join(" ");
  if (missing.length === 0) return text;
  const items = names?.names() ?? [];
  return (
    `${text}\n\nThese ids name nothing drawn, so the image leaves them out: ${resolvedList(missing)}.` +
    (items.length > 0 ? ` Its items are ${idList(items)}.` : "")
  );
}

export class PickDiagramNodesTool implements vscode.LanguageModelTool<PickNodesInput> {
  constructor(private readonly panel: DiagramPanel) {}

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<PickNodesInput>,
  ): vscode.PreparedToolInvocation {
    const parsed = parsePickInput(options.input);
    const question = typeof parsed === "string" ? "" : `: ${parsed.prompt}`;
    return { invocationMessage: `Waiting for you to pick in the diagram${question}` };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<PickNodesInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const parsed = parsePickInput(options.input);
    if (typeof parsed === "string") {
      return textResult(`No node was picked: ${parsed}`);
    }
    const outcome = await this.panel.pickNodes(parsed.prompt, parsed.multiple, token);
    return textResult(
      outcome.picked
        ? `The user picked: ${nodeList(outcome.nodes)}.`
        : `No node was picked: ${outcome.reason}`,
    );
  }
}

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
    throwIfCancelled(token);
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
    const { marks, dim } = outcome.annotation;
    const { names, given, several } = outcome;
    const sentences: string[] = [];
    if (marks.length > 0) {
      const includesRelationships =
        language === "mermaid" &&
        this.panel.drawnIds &&
        marks.some((mark) => !this.panel.drawnIds?.includes(mark.id));
      const marked = plural(marks.length, includesRelationships ? "item" : nodeNoun(language));
      // As the model named them, also an edge or message by its ends.
      const listed = marks
        .map(({ id, kind }) => `${JSON.stringify(given.get(id) ?? id)} (${kind})`)
        .join(", ");
      sentences.push(`Marked ${marked}: ${listed}.`);
      if (dim) {
        sentences.push("Unmarked items are faded.");
      }
      if (names === undefined) {
        sentences.push("Item ids could not be verified; unknown items will not show marks.");
      }
    } else if (
      outcome.unknown.length > 0 ||
      outcome.repeated.length > 0 ||
      outcome.several.length > 0
    ) {
      sentences.push(`Nothing was marked; the ${noun}'s previous marks are cleared.`);
    } else {
      sentences.push(`Cleared the ${noun}'s marks.`);
    }
    if (hasText(options.input)) {
      sentences.push("The panel shows no caption or notes: say them in your answer.");
    }
    const unknown =
      outcome.unknown.length > 0 && names
        ? `\n\nThese ids are not selectable items of the ${noun}, so nothing was marked for them: ` +
          `${resolvedList(outcome.unknown)}. Its items are ${idList(names.names())}.`
        : "";
    const ambiguous = [repeatedList(outcome.repeated), names ? severalList(several, names) : ""]
      .filter(Boolean)
      .join(", ");
    const repeated = ambiguous
      ? `\n\nThese names each name several items of the ${noun}, so nothing was marked for them: ` +
        `${ambiguous}. Mark the items you mean by their ids.`
      : "";
    return textResult(sentences.join(" ") + unknown + repeated);
  }
}

/** How marking reads in chat, e.g. `Marking "pay" in the diagram`. */
function markingMessage({ marks }: Annotation, language: DiagramLanguage): string {
  const noun = diagramNoun(language);
  if (marks.length === 0) {
    return `Clearing the marks in the ${noun}`;
  }
  // A few ids say more than their number; many of them would crowd the chat.
  const what =
    marks.length <= 3
      ? quoteAll(marks.map(({ id }) => id))
      : plural(marks.length, nodeNoun(language));
  return `Marking ${what} in the ${noun}`;
}
