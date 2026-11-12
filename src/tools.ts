// diagram_render, diagram_getState, diagram_getImage and diagram_annotate.

import * as vscode from "vscode";
import { type AnnotateInput, validateAnnotation } from "./annotations";
import { guessTitle } from "./blocks";
import { throwIfCancelled, unlessCancelled } from "./cancellation";
import { repeatedList } from "./describe";
import { isClosingFence, openingFence } from "./fences";
import { decodeFile, inWorkspace, resolveFile } from "./files";
import { type ItemNames, type Resolved, resolvedList, severalList } from "./itemNames";
import { validateLinks, withoutMissingFiles } from "./links";
import type { Diagram, DiagramPanel } from "./panel";
import {
  ANNOTATE_TOOL,
  type Annotation,
  type DiagramLanguage,
  diagramNoun,
  errorMessage,
  GET_IMAGE_TOOL,
  type ImageView,
  isDiagramLanguage,
  isPlainObject,
  nodeNoun,
} from "./protocol";
import { nonBlank, plural, quoteAll } from "./text";
import {
  failureText,
  idList,
  leftOutLinks,
  linksWithoutNodes,
  noDiagram,
  textResult,
  warningsText,
} from "./toolResults";
import { formatOption } from "./webview/optionSource";

interface RenderInput {
  source?: string;
  file?: string;
  language?: string;
  title?: string;
  clickPrompt?: string;
  links?: Record<string, string>;
}

/** The diagram to render, with any problems with its links, or what to fix in the input. */
async function parseRenderInput(
  value: unknown,
): Promise<{ diagram: Diagram; problems: string[] } | string> {
  const input = isPlainObject(value) ? value : {};
  // As a model may write it: "Mermaid", "ECharts".
  let language = typeof input.language === "string" ? input.language.toLowerCase() : undefined;
  let source = input.source;
  const file = nonBlank(input.file);
  if (file) {
    try {
      const uri = resolveFile(file);
      source = await decodeFile(await vscode.workspace.fs.readFile(uri), uri);
    } catch (error) {
      return `Could not read ${file}: ${errorMessage(error)}`;
    }
    if (/\.(?:mmd|mermaid)$/i.test(file)) language ??= "mermaid";
  }
  // Models sometimes send an ECharts option as an object despite the schema.
  if (isPlainObject(source) && (language ?? "echarts") === "echarts") {
    source = formatOption(JSON.stringify(source));
  }
  let text = typeof source === "string" ? source : "";
  // Models sometimes include a Markdown fence despite the schema.
  const trimmed = text.trim();
  const firstNewline = trimmed.indexOf("\n");
  const lastNewline = trimmed.lastIndexOf("\n");
  const opening = firstNewline < 0 ? undefined : openingFence(trimmed.slice(0, firstNewline));
  if (opening && isClosingFence(trimmed.slice(lastNewline + 1), opening)) {
    text = trimmed.slice(firstNewline + 1, lastNewline);
    language ??= opening.language;
  }
  if (!text.trim()) {
    return 'Give "source", the complete diagram as a string, or "file", a file with it.';
  }
  // Mermaid source never starts with "{".
  language ??= text.trimStart().startsWith("{") ? "echarts" : "mermaid";
  if (!isDiagramLanguage(language)) {
    return `Unknown language ${JSON.stringify(language)}: use "mermaid" or "echarts".`;
  }
  const { links, problems } = validateLinks(input.links, language);
  return {
    diagram: {
      language,
      source: text,
      title: nonBlank(input.title) ?? guessTitle({ language, source: text }),
      clickPrompt: nonBlank(input.clickPrompt),
      links,
    },
    problems,
  };
}

export class RenderDiagramTool implements vscode.LanguageModelTool<RenderInput> {
  constructor(private readonly panel: DiagramPanel) {}

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<RenderInput>,
  ): vscode.PreparedToolInvocation {
    const title = nonBlank(options.input?.title);
    const invocationMessage = title ? `Rendering "${title}"` : "Rendering a diagram";
    const file = nonBlank(options.input?.file);
    let outside = false;
    try {
      outside = file !== undefined && !inWorkspace(resolveFile(file));
    } catch {}
    return outside
      ? {
          invocationMessage,
          confirmationMessages: {
            title: "Render a file outside the workspace?",
            message: `Read ${file} to render it in the diagram panel.`,
          },
        }
      : { invocationMessage };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RenderInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const changes = this.panel.userChangeCount;
    const parsed = await unlessCancelled(() => parseRenderInput(options.input), token);
    if (typeof parsed === "string") return textResult(`Nothing was rendered: ${parsed}`);
    const { diagram, problems } = parsed;
    if (diagram.links) {
      const existing = await unlessCancelled(() => withoutMissingFiles(diagram.links ?? {}), token);
      diagram.links = existing.links;
      problems.push(...existing.problems);
    }
    if (this.panel.userChangeCount !== changes) {
      return textResult(
        "Nothing was rendered, as the user changed the diagram meanwhile. Read diagram_getState first.",
      );
    }
    const outcome = await unlessCancelled(
      () => this.panel.render(diagram, "tool", { repairMermaid: true }),
      token,
    );
    const noun = diagramNoun(diagram.language);
    const text = outcome.ok
      ? `Rendered the ${outcome.diagramType} ${noun} in the diagram panel.` +
        (outcome.repair ? `\n\nAutomatic repair: ${outcome.repair.description}` : "") +
        warningsText(this.panel)
      : failureText(outcome, noun, diagram.source);
    return textResult(
      text +
        leftOutLinks(problems, diagram.language) +
        (outcome.ok
          ? linksWithoutNodes(Object.keys(diagram.links ?? {}), this.panel.drawnIds)
          : ""),
    );
  }
}

export class GetDiagramStateTool implements vscode.LanguageModelTool<unknown> {
  constructor(private readonly panel: DiagramPanel) {}

  prepareInvocation(): vscode.PreparedToolInvocation {
    return { invocationMessage: "Reading the diagram panel" };
  }

  invoke(): vscode.LanguageModelToolResult {
    return textResult(this.panel.describeForModel() ?? noDiagram("read"));
  }
}

interface ImageInput {
  ids?: string[];
}

/** A model may give one id as it is. */
function imageIds(input: unknown): string[] {
  const ids = isPlainObject(input) ? input.ids : undefined;
  const given = typeof ids === "string" ? [ids] : Array.isArray(ids) ? ids : [];
  return [...new Set(given.filter((id): id is string => typeof id === "string"))];
}

/** About 1,500 tokens, which Claude takes without scaling down. */
const IMAGE_LIMITS = { maxSide: 1568, maxPixels: 1_150_000 };
/** How many pixels high text must be in an image for a model to read it. */
const LEGIBLE_TEXT = 8;

export class GetDiagramImageTool implements vscode.LanguageModelTool<ImageInput> {
  constructor(private readonly panel: DiagramPanel) {}

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<ImageInput>,
  ): vscode.PreparedToolInvocation {
    const noun = diagramNoun(this.panel.current?.language ?? "mermaid");
    const ids = imageIds(options.input);
    return {
      invocationMessage:
        ids.length === 0
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
    const ids = imageIds(options.input);
    // Reopening the panel redraws its items, including the ids behind relationship names.
    if (ids.length > 0) await unlessCancelled(() => this.panel.itemIds(), token);
    if (this.panel.revision !== revision) {
      return textResult(
        "There is no image to view. The diagram changed while it was drawn. Try again.",
      );
    }
    const noun = diagramNoun(current.language);
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
    if (this.panel.revision !== revision) {
      return textResult(
        "There is no image to view. The diagram changed during capture. Try again.",
      );
    }
    const about = `The ${noun}`;
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
  }
  const text = sentences.join(" ");
  if (missing.length === 0) return text;
  const items = names?.names() ?? [];
  return (
    `${text}\n\nThese ids name nothing drawn, so the image leaves them out: ${resolvedList(missing)}.` +
    (items.length > 0 ? ` Its items are ${idList(items)}.` : "")
  );
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

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<AnnotateInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    throwIfCancelled(token);
    let annotation: Annotation;
    try {
      annotation = validateAnnotation(options.input);
    } catch (error) {
      return textResult(
        `Nothing was marked: ${errorMessage(error)}\n\nFix the input and call ${ANNOTATE_TOOL} again.`,
      );
    }
    // Closing or reloading the panel forgets its item identities. Resolve aliases only after
    // drawing them again, and never apply these marks to a replacement that arrived meanwhile.
    const revision = this.panel.revision;
    await unlessCancelled(() => this.panel.itemIds(), token);
    throwIfCancelled(token);
    if (revision !== this.panel.revision) {
      return textResult("Nothing was marked: the diagram changed while it was drawn. Try again.");
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
function markingMessage(annotation: Annotation, language: DiagramLanguage): string {
  const noun = diagramNoun(language);
  const { marks } = annotation;
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
