// diagram_edit: changes the current diagram with exact text replacements in its source, keeping
// what a model would otherwise have to send again: the rest of the source, the title, the code
// links and the click prompt.

import { isDeepStrictEqual } from "node:util";
import type * as vscode from "vscode";
import { guessTitle } from "./blocks";
import { unlessCancelled } from "./cancellation";
import { type ChartPresentation, captureChartPresentation } from "./chartPresentation";
import { documentName } from "./documentDiagram";
import { type NodeLinks, validateLinks, withoutMissingFiles } from "./links";
import type { DiagramPanel } from "./panel";
import {
  CHART_TOOL,
  diagramNoun,
  EDIT_TOOL,
  errorClause,
  GET_STATE_TOOL,
  isPlainObject,
  RENDER_TOOL,
  UPDATE_CHART_TOOL,
} from "./protocol";
import {
  applySourceEdits,
  changedLines,
  editCount,
  errorContext,
  linesAround,
  type SourceEdit,
} from "./sourceEdits";
import { formatCount, givenProperties, lineAndColumn, unknownProperties } from "./text";
import {
  type Answer,
  changeResult,
  drawnWarnings,
  editFailure,
  idList,
  leftOutLinks,
  linksWithoutNodes,
  noDiagram,
  nonBlank,
} from "./tools";

/** As declared in package.json, but a model may not follow the schema exactly. */
interface EditInput {
  edits?: { oldText: string; newText: string; replaceAll?: boolean }[];
  revision?: number;
  title?: string;
  links?: Record<string, string | null>;
}

interface EditChange {
  edits: SourceEdit[];
  revision?: number | undefined;
  title?: string | undefined;
  /** Locations to link by node id, as given, and the node ids to unlink. */
  links?: { given: Record<string, unknown>; removed: string[] } | undefined;
}

const INPUT_KEYS = ["edits", "revision", "title", "links"] as const;
const EDIT_KEYS = ["oldText", "newText", "replaceAll"] as const;
const MAX_EDITS = 50;
const EXAMPLE = '{"edits": [{"oldText": "A --> B", "newText": "A --> C --> B"}]}';

/** Rejects malformed input with a list of problems. */
function validateEditInput(value: unknown): EditChange {
  if (!isPlainObject(value)) {
    throw new Error(`The input must be an object, e.g. ${EXAMPLE}.`);
  }
  // Some models send null for the properties they leave out.
  const input = givenProperties(value);
  const problems: string[] = [];
  const unknown = unknownProperties(input, INPUT_KEYS);
  if (unknown !== undefined) {
    problems.push(unknown);
  }

  let given = input.edits ?? [];
  // Some models send an array as a JSON string, or a single item without one.
  if (typeof given === "string") {
    try {
      given = JSON.parse(given);
    } catch {
      // Reported below.
    }
  }
  if (isPlainObject(given)) given = [given];
  const edits: SourceEdit[] = [];
  if (!Array.isArray(given)) {
    problems.push(`"edits" must be an array of objects, e.g. ${EXAMPLE}.`);
  } else if (given.length > MAX_EDITS) {
    problems.push(`"edits" has ${formatCount(given.length)} items, more than ${MAX_EDITS}.`);
  } else {
    for (const [index, item] of given.entries()) {
      const edit = parseEdit(item);
      if (typeof edit === "string") {
        problems.push(`Edit ${index + 1}: ${edit}`);
      } else {
        edits.push(edit);
      }
    }
  }

  const { revision, title, links } = input;
  if (
    revision !== undefined &&
    (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)
  ) {
    problems.push(`"revision" must be a nonnegative integer from ${GET_STATE_TOOL}.`);
  }
  if (title !== undefined && !nonBlank(title)) {
    problems.push('"title" must be a non-empty string.');
  }
  let linkChange: EditChange["links"];
  if (links !== undefined) {
    if (isPlainObject(links)) {
      const entries = Object.entries(links);
      linkChange = {
        given: Object.fromEntries(entries.filter(([, location]) => location !== null)),
        removed: entries.filter(([, location]) => location === null).map(([id]) => id.trim()),
      };
    } else {
      problems.push(
        '"links" must be an object mapping node ids to locations, or to null to remove a link, e.g. {"parse": "src/parser.ts#L42", "old": null}.',
      );
    }
  }
  if (problems.length === 0 && edits.length === 0 && title === undefined && !linkChange) {
    problems.push(`Give "edits", e.g. ${EXAMPLE}.`);
  }
  if (problems.length > 0) {
    throw new Error(`Invalid input:\n- ${problems.join("\n- ")}`);
  }
  return {
    edits,
    revision: revision as number | undefined,
    title: title as string | undefined,
    links: linkChange,
  };
}

function parseEdit(value: unknown): SourceEdit | string {
  if (!isPlainObject(value)) {
    return 'An edit must be an object, e.g. {"oldText": "A --> B", "newText": "A --> C --> B"}.';
  }
  const unknown = unknownProperties(givenProperties(value), EDIT_KEYS);
  if (unknown !== undefined) {
    return unknown;
  }
  const { oldText, newText, replaceAll = false } = givenProperties(value);
  if (typeof oldText !== "string" || oldText === "") {
    return '"oldText" must be the exact text to replace, as a non-empty string. To add lines, replace a line next to where they go with that line and them.';
  }
  if (typeof newText !== "string") {
    return '"newText" must be a string, empty to delete oldText.';
  }
  if (typeof replaceAll !== "boolean") {
    return '"replaceAll" must be true or false.';
  }
  return { oldText, newText, replaceAll };
}

export class EditDiagramTool implements vscode.LanguageModelTool<EditInput> {
  constructor(private readonly panel: DiagramPanel) {}

  prepareInvocation(): vscode.PreparedToolInvocation {
    const state = this.panel.current;
    return {
      invocationMessage: state
        ? `Editing the ${diagramNoun(state.language)} "${state.title}"`
        : "Editing the diagram",
    };
  }

  invoke(
    options: vscode.LanguageModelToolInvocationOptions<EditInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    return changeResult(
      this.panel,
      token,
      "Nothing was changed",
      EDIT_TOOL,
      () => validateEditInput(options.input),
      (change) => this.edit(change, token),
    );
  }

  private async edit(change: EditChange, token: vscode.CancellationToken): Promise<Answer> {
    const state = this.panel.current;
    if (!state) {
      throw new Error(noDiagram("edit"));
    }
    const { language, source } = state;
    const noun = diagramNoun(language);
    if (source === undefined) {
      throw new Error(
        `The chart's source was not kept when VS Code restarted. Ask the user to press Refresh in the diagram panel, or draw it again with ${CHART_TOOL}.`,
      );
    }
    const revision = this.panel.revision;
    if (change.revision !== undefined && change.revision !== revision) {
      throw new Error(
        `The ${noun} changed since revision ${change.revision}. Read ${GET_STATE_TOOL} and make the edits to its current source.`,
      );
    }
    if (this.panel.rendering) {
      throw new Error(`The ${noun} is still being drawn. Wait for the current render and retry.`);
    }
    if (state.chart && change.title !== undefined) {
      throw new Error(
        `Change the title of a chart made by ${CHART_TOOL} with ${UPDATE_CHART_TOOL}.`,
      );
    }

    const edited = applySourceEdits(source, change.edits);
    if (!edited.ok) {
      const failed = edited.problems.length;
      const total = change.edits.length;
      return {
        paragraphs: [
          total === 1
            ? "Nothing was changed, as the edit does not apply."
            : `Nothing was changed, as ${failed} of ${total} edits ${failed === 1 ? "does" : "do"} not apply. Send them all again, with ${failed === 1 ? "it" : "those"} corrected.`,
          ...edited.problems,
        ],
      };
    }

    let chartPresentation = state.chartPresentation;
    if (state.chart && edited.source !== source) {
      const presentation = chartEdit(edited.source, {
        source,
        presentation: state.chartPresentation,
      });
      if (!("baseline" in presentation)) return presentation;
      chartPresentation = presentation;
    }

    const problems: string[] = [];
    let links = state.links;
    if (change.links) {
      const { given, removed } = change.links;
      let added: NodeLinks = {};
      if (Object.keys(given).length > 0) {
        const { links: valid, problems: invalid } = validateLinks(given, language);
        problems.push(...invalid);
        if (valid) {
          const existing = await unlessCancelled(() => withoutMissingFiles(valid), token);
          problems.push(...existing.problems);
          added = existing.links ?? {};
        }
      }
      const kept = Object.entries(state.links ?? {}).filter(
        ([id]) => !removed.includes(id) && !Object.hasOwn(added, id),
      );
      const entries = [...kept, ...Object.entries(added)];
      links = entries.length > 0 ? Object.fromEntries(entries) : undefined;
    }
    const leftOut = leftOutLinks(problems, language).trim();

    // A title taken from the source, rather than given, follows it, as when the user edits it.
    const title =
      change.title ??
      (!state.chart && state.title === guessTitle({ language, source })
        ? guessTitle({ language, source: edited.source })
        : state.title);
    const linksChanged = !isDeepStrictEqual(links ?? {}, state.links ?? {});
    if (edited.source === source && title === state.title && !linksChanged) {
      return {
        paragraphs: [`Nothing was changed, as the edits leave the ${noun} as it is.`, leftOut],
      };
    }

    const before = this.panel.drawnIds;
    const outcome = await unlessCancelled(
      () =>
        this.panel.editByAgent(
          { source: edited.source, title, links, chartPresentation },
          revision,
        ),
      token,
    );
    const linkIds = Object.keys(links ?? {});
    const notes = [leftOut, linksWithoutNodes(linkIds, this.panel.drawnIds).trim()];
    if (state.document) {
      notes.push(
        `The ${noun} was opened from a code block in ${documentName(state.document)}. The change is in the panel only, until the user writes it to that file with Apply or Write to.`,
      );
    }
    if (!outcome.ok) {
      const failure = editFailure(outcome, noun, "edited", edited.source, source);
      return { paragraphs: [...failure, ...notes], drawn: outcome.revision };
    }

    const sentences = [
      edited.source === source
        ? `Updated the ${outcome.diagramType} ${noun}.`
        : `Edited the ${outcome.diagramType} ${noun} with ${editCount(edited.replaced)}, in ${lineRange(source, edited.source)}.`,
    ];
    if (title !== state.title) sentences.push(`It is titled ${JSON.stringify(title)}.`);
    if (linksChanged) {
      sentences.push(
        linkIds.length > 0
          ? `Its code links are on ${idList(linkIds)}.`
          : "It has no code links any more.",
      );
    }
    if (language === "mermaid") sentences.push(...nodeChanges(before, this.panel.drawnIds));
    if (state.chart && !chartPresentation?.blocked && edited.source !== source) {
      sentences.push(
        `As an edit of its styling, it stays when ${UPDATE_CHART_TOOL} or Refresh rebuilds the chart.`,
      );
    }
    return {
      paragraphs: [sentences.join(" "), ...drawnWarnings(this.panel), ...notes],
      drawn: outcome.revision,
    };
  }
}

/** E.g. "line 4 of 30" or "lines 4-7 of 30": where the edited source differs. */
function lineRange(before: string, after: string): string {
  const { from, to } = changedLines(before, after);
  const total = lineAndColumn(after, after.length).line;
  return `${from === to ? `line ${from}` : `lines ${from}-${to}`} of ${formatCount(total)}`;
}

/** The nodes an edit added and removed, when the panel knows them before and after. */
function nodeChanges(
  before: readonly string[] | undefined,
  after: readonly string[] | undefined,
): string[] {
  if (!before || !after) return [];
  const had = new Set(before);
  const has = new Set(after);
  const added = after.filter((id) => !had.has(id));
  const removed = before.filter((id) => !has.has(id));
  return [
    ...(added.length > 0 ? [`Nodes added: ${idList(added)}.`] : []),
    ...(removed.length > 0 ? [`Nodes removed: ${idList(removed)}.`] : []),
  ];
}

/**
 * The styling of a chart that diagram_chart made, with the edited source, as when the user applies
 * an edit of it; or, for an edit that Refresh and diagram_updateChart could not keep, as it is not
 * JSON or changes the chart's data or structure, why it is refused. Those rebuild such a chart from
 * its data, so changes to that go through them, and edits of its styling stay.
 */
function chartEdit(
  source: string,
  previous: { source: string; presentation: ChartPresentation | undefined },
): ChartPresentation | Answer {
  try {
    JSON.parse(source);
  } catch (error) {
    // Without the excerpt of the source that V8 quotes after an unexpected token, as the lines
    // around it follow.
    const message = errorClause(error).replace(/, (?:\.\.\.)?".*" is not valid JSON$/s, "");
    const position = /\bat position (\d+)/.exec(message)?.[1];
    return {
      paragraphs: [
        `Nothing was changed, as a chart made by ${CHART_TOOL} must stay JSON, for Refresh and ${UPDATE_CHART_TOOL} to rebuild it, and the edited option is not JSON: ${message}.`,
        position === undefined
          ? errorContext(source, "", previous.source)
          : linesAround(source, lineAndColumn(source, Number(position)).line, "edited option"),
        `Correct the edits. For callbacks, write the whole option with ${RENDER_TOOL}.`,
      ],
    };
  }
  const presentation = captureChartPresentation(source, previous.presentation);
  if (presentation.blocked && !previous.presentation?.blocked) {
    const reason =
      /because (.*?)\. Your source is kept/s.exec(presentation.blocked)?.[1] ??
      "the chart could not keep it";
    return {
      paragraphs: [
        `Nothing was changed, as ${reason}: Refresh and ${UPDATE_CHART_TOOL} rebuild this chart from its data, keeping only edits of its styling. Change its type, columns, grouping, sort, limit or filters with ${UPDATE_CHART_TOOL}, and its data with ${CHART_TOOL}. To draw what they cannot, write the whole option with ${RENDER_TOOL}.`,
      ],
    };
  }
  return presentation;
}
