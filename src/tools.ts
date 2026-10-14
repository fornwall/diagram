// The tools for any diagram in the panel: diagram_render, diagram_getState, diagram_getImage,
// diagram_pickNodes and diagram_annotate.

import * as vscode from "vscode";
import { type AnnotateInput, validateAnnotation } from "./annotations";
import { guessTitle } from "./blocks";
import { throwIfCancelled, unlessCancelled } from "./cancellation";
import { nodeList, repeatedList } from "./describe";
import { isClosingFence, openingFence } from "./fences";
import { LINK_SYNTAX, validateLinks, withoutMissingFiles } from "./links";
import type { Diagram, DiagramPanel, RenderOutcome } from "./panel";
import {
  ANNOTATE_TOOL,
  type Annotation,
  CHART_TOOL,
  type DiagramLanguage,
  diagramNoun,
  EDIT_TOOL,
  errorMessage,
  GET_IMAGE_TOOL,
  GET_STATE_TOOL,
  type ImageView,
  isDiagramLanguage,
  isPlainObject,
  nodeNoun,
  RENDER_TOOL,
} from "./protocol";
import { errorContext } from "./sourceEdits";
import { formatCount, givenProperties, plural, quoteAll, unknownProperties } from "./text";
import { formatOption } from "./webview/optionSource";

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
  // Models sometimes send an ECharts option as an object despite the schema. Sending it again as a
  // string would cost as much.
  if (isPlainObject(input.source) && (input.language ?? "echarts") === "echarts") {
    input.source = formatOption(JSON.stringify(input.source));
  }
  if (typeof input.source !== "string") {
    return 'Give "source", the complete diagram, as a string.';
  }
  let source = input.source;
  let language = input.language;
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
    const outcome = await unlessCancelled(() => this.panel.render(diagram, "tool"), token);
    const noun = diagramNoun(diagram.language);
    if (outcome.ok) {
      return drawnResult(
        `Rendered the ${outcome.diagramType} ${noun} in the diagram panel next to the chat.` +
          this.panel.warnings.map((warning) => ` ${warning}`).join("") +
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

export class GetDiagramStateTool implements vscode.LanguageModelTool<Record<string, never>> {
  constructor(private readonly panel: DiagramPanel) {}

  prepareInvocation(): vscode.PreparedToolInvocation {
    return { invocationMessage: "Reading the diagram panel" };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    // A source too long to repeat in every chat request is given in full here, as a model has to
    // read it to change it, unless it does not fit, as the caller would cut it short.
    const full = this.panel.describeForModel({ detail: "full" });
    if (full === undefined) {
      return textResult(
        `No diagram has been rendered yet. Use the ${RENDER_TOOL} or ${CHART_TOOL} tool to show one.`,
      );
    }
    // A caller that gives no budget gets no more than a large Mermaid diagram's description takes.
    const room = options.tokenizationOptions;
    const fitting = async (text: string) =>
      room ? await fits(text, room, token) : text.length <= MAX_UNBUDGETED_LENGTH;
    if (await fitting(full)) return textResult(full);
    // The source, which a model needs to change the diagram, before a long list of relationships.
    const source = this.panel.describeForModel({ detail: "source" });
    if (source !== undefined && source !== full && (await fitting(source))) {
      return textResult(source);
    }
    return textResult(this.panel.describeForModel({ detail: "summary" }) ?? full);
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
  return (await countTokens(text, token)) <= tokenBudget;
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
    return '"ids" must be an array of item ids, such as ["A", "edge:A → B"].';
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
      return textResult(`No diagram is shown. Use ${RENDER_TOOL} or ${CHART_TOOL} to show one.`);
    }
    const ids = parseImageInput(options.input);
    if (typeof ids === "string") {
      return textResult(`There is no image to view: ${ids}`);
    }
    const noun = diagramNoun(current.language);
    // A model is told the ids of a Mermaid diagram, which the panel knows; the page tells of others.
    const known = this.panel.drawnItemIds;
    if (ids.length > 0 && known && !ids.some((id) => known.includes(id))) {
      return textResult(
        `There is no image to view: no item of the ${noun} has these ids: ${quoteAll(ids)}. ` +
          (known.length > 0
            ? `Its ids are ${idList(known)}.`
            : `It has no items to show alone: call ${GET_IMAGE_TOOL} without "ids".`),
      );
    }
    const image = await unlessCancelled(() => this.panel.captureImage(IMAGE_LIMITS, ids), token);
    if (typeof image === "string") {
      return textResult(`There is no image to view. ${image}`);
    }
    const about = `Revision ${revision} of the ${noun}`;
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        image.view
          ? describeImage(about, image.view, pngSize(image.png), current.language, ids, known)
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
  ids: readonly string[],
  known: readonly string[] | undefined,
): string {
  const size = ({ width, height }: { width: number; height: number }, scale = 1) =>
    `${Math.round(width * scale)}×${Math.round(height * scale)} px`;
  const percent = (scale: number) => `${Math.round(scale * 100)}%`;
  const { area, scale, textSize, panel, missing = [] } = view;
  const left = new Set(missing);
  const what = area
    ? `the part around ${idList(ids.filter((id) => !left.has(id)))} (${size(area)} of the ${size(view)} drawing)`
    : language === "echarts"
      ? `all of it, laid out ${panel ? "for the panel " : ""}at ${size(view)}`
      : `all of its ${size(view)} drawing`;
  const sentences = [
    `${about}: ${what}, at ${percent(scale)} in this ${size(png ?? area ?? view, png ? 1 : scale)} image.`,
  ];
  const legible = (zoom: number) => textSize === undefined || textSize * zoom >= LEGIBLE_TEXT;
  if (textSize !== undefined && !legible(scale)) {
    const shown = Math.round(textSize * scale * 10) / 10;
    sentences.push(
      `Its text, ${Math.round(textSize)} px, is ${shown} px here: too small to read reliably. ` +
        (area
          ? 'To read it, give fewer "ids", of items close together.'
          : `To read it, call ${GET_IMAGE_TOOL} with the "ids" of a few items, to see the part around them.`),
    );
  }
  if (panel && language === "mermaid") {
    const unread = legible(panel.zoom) ? "" : ", too small to read without zooming in";
    sentences.push(`The panel shows it at ${percent(panel.zoom)} in ${size(panel)}${unread}.`);
  } else if (panel && panel.height < view.height) {
    sentences.push(`The panel shows ${size(panel)} of it at a time, and scrolls the rest.`);
  }
  const text = sentences.join(" ");
  if (missing.length === 0) return text;
  return (
    `${text}\n\nThese ids name nothing drawn, so the image leaves them out: ${quoteAll(missing)}.` +
    (known && known.length > 0 ? ` Its ids are ${idList(known)}.` : "")
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
    const { marks, caption, dim } = outcome.annotation;
    const drawn = outcome.ids;
    const sentences: string[] = [];
    if (marks.length > 0) {
      const includesRelationships =
        language === "mermaid" &&
        this.panel.drawnIds &&
        marks.some((mark) => !this.panel.drawnIds?.includes(mark.id));
      const marked = plural(marks.length, includesRelationships ? "item" : nodeNoun(language));
      const listed = marks.map(({ id, kind }) => `${JSON.stringify(id)} (${kind})`).join(", ");
      sentences.push(`Marked ${marked}: ${listed}.`);
      if (dim) {
        sentences.push("Unmarked items are faded.");
      }
      if (drawn === undefined) {
        sentences.push("Item ids could not be verified; unknown items will not show marks.");
      }
    } else if (outcome.unknown.length > 0 || outcome.repeated.length > 0) {
      sentences.push(`Nothing was marked; the ${noun}'s previous marks are cleared.`);
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
    const repeated =
      outcome.repeated.length > 0
        ? `\n\nThese names each name several items of the ${noun}, so nothing was marked for them: ` +
          `${repeatedList(outcome.repeated)}. Mark the items you mean by their ids.`
        : "";
    return textResult(sentences.join(" ") + unknown + repeated);
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
      ? quoteAll(marks.map(({ id }) => id))
      : plural(marks.length, nodeNoun(language));
  const where = `Marking ${what} in the ${noun}`;
  return caption === undefined ? where : `${where}: ${caption}`;
}

/**
 * Warn about links to absent nodes. Keep the links in case a later edit adds those nodes. A model
 * corrects them without sending the source again.
 */
export function linksWithoutNodes(
  ids: readonly string[],
  drawn: readonly string[] | undefined,
): string {
  if (!drawn) {
    return "";
  }
  const known = new Set(drawn);
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length === 0) {
    return "";
  }
  return (
    `\n\nThese links name nodes the diagram does not have, so nothing opens from them: ${quoteAll(unknown)}. ` +
    `Its node ids are ${idList(drawn)}. Correct them with "links" in ${EDIT_TOOL}, e.g. {"newId": "src/file.ts#L3", "oldId": null}.`
  );
}

const MAX_LISTED_IDS = 40;

export function idList(ids: readonly string[]): string {
  const listed = quoteAll(ids.slice(0, MAX_LISTED_IDS));
  const left = ids.length - MAX_LISTED_IDS;
  return left > 0 ? `${listed} and ${formatCount(left)} more` : listed;
}

export function leftOutLinks(problems: readonly string[], language: DiagramLanguage): string {
  if (problems.length === 0) {
    return "";
  }
  // A chart takes no links, which no correction adds.
  if (language === "echarts") {
    return `\n\nThe links were left out. ${problems.join(" ")}`;
  }
  return (
    `\n\nThese links were left out:\n- ${problems.join("\n- ")}\n` +
    `A link is a path, absolute or relative to the first workspace folder, with an optional line: ` +
    `${LINK_SYNTAX}. Correct them with "links" in ${EDIT_TOOL}.`
  );
}

export function renderFailure(
  outcome: Extract<RenderOutcome, { ok: false }>,
  noun: string,
  tool: string,
  fix: string,
): string {
  return outcome.kind === "invalid"
    ? `The ${noun} failed to render with this error:\n\n${outcome.error}\n\n${fix}`
    : `The ${noun} could not be shown: ${outcome.error} This is not a problem with the ${noun}, and the panel may still be drawing it: ${GET_STATE_TOOL} says whether it is shown. Call ${tool} again only to reopen a closed panel, if the user still wants to see it.`;
}

export function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function textResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

/**
 * The result of a tool call that drew in the panel, also if the drawing failed, ending with the
 * revision drawn: the model can pass it to the tools that take one, such as diagram_updateChart,
 * and @diagram tells by it the drawings of its own tool calls from those of other chat requests
 * meanwhile.
 */
export function drawnResult(text: string, revision: number): vscode.LanguageModelToolResult {
  return textResult(`${text}\n\nRevision: ${revision}.`);
}

/** The revision that a {@link drawnResult} says its tool call drew. */
export function revisionDrawn(content: readonly unknown[]): number | undefined {
  const [result] = content;
  const match =
    result instanceof vscode.LanguageModelTextPart && /\n\nRevision: (\d+)\.$/.exec(result.value);
  return match ? Number(match[1]) : undefined;
}
