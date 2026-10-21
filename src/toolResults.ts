// Shared responses for diagram, chart, guide and workspace tools.

import * as vscode from "vscode";
import { throwIfCancelled } from "./cancellation";
import { LINK_SYNTAX } from "./links";
import type { DiagramPanel, RenderOutcome } from "./panel";
import {
  CHART_TOOL,
  type DiagramLanguage,
  EDIT_TOOL,
  errorMessage,
  GET_STATE_TOOL,
  RENDER_TOOL,
  UPDATE_CHART_TOOL,
} from "./protocol";
import { errorContext } from "./sourceEdits";
import { formatCount, quoteAll } from "./text";

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

/** Render warnings, with advice to use chart settings for changes that regeneration would undo. */
export function drawnWarnings(panel: DiagramPanel): string[] {
  const { warnings } = panel;
  if (warnings.length === 0) return [];
  return panel.current?.chart ? [...warnings, GENERATED_CHART_FIXES] : [...warnings];
}

const GENERATED_CHART_FIXES =
  `As ${CHART_TOOL} made this chart, fix these by its settings with ${UPDATE_CHART_TOOL} where ` +
  'they do it: "type": "horizontalBar" for category names too long for the width. Change its ' +
  `styling, such as "grid", "dataZoom" or label wrapping, with ${EDIT_TOOL}. Preserve all ` +
  'requested categories and series; use a "limit", fewer "valueColumns" or aggregated data ' +
  "only when the user wants that subset or summary, not just to fit the panel.";

/**
 * Distinguishes invalid source from a panel failure. Invalid edits remain in the panel, so include
 * source context for a follow-up fix. `changed` describes the edit, e.g. "edited" or "colored".
 */
export function editFailure(
  outcome: Extract<RenderOutcome, { ok: false }>,
  noun: string,
  changed: string,
  edited: string,
  previous: string,
): [string, ...string[]] {
  if (outcome.kind === "unavailable") {
    return [
      `The ${noun} was ${changed}, but the panel could not show it: ${outcome.error} This is not a problem with the change, and the panel may still be drawing it: ${GET_STATE_TOOL} says whether it is shown.`,
    ];
  }
  return [
    `The ${changed} ${noun} failed to render with this error:`,
    outcome.error,
    errorContext(edited, outcome.error, previous),
    `The panel shows it with this error. Fix it with ${EDIT_TOOL}.`,
  ];
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

export function noDiagram(action: string): string {
  return `There is no diagram to ${action}. Render one with ${RENDER_TOOL} or ${CHART_TOOL} first.`;
}

export function textResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

/**
 * Append the revision for subsequent edits. The participant also reads this suffix to identify
 * its own renders, including failed ones, among concurrent requests (see {@link revisionDrawn}).
 */
export function drawnResult(text: string, revision: number): vscode.LanguageModelToolResult {
  return textResult(`${text}\n\nRevision: ${revision}.`);
}

/** A change summary, with the rendered revision when the tool drew something. */
export interface Answer {
  paragraphs: [string, ...string[]];
  drawn?: number | undefined;
}

/**
 * Validate and apply a change, turning failures into tool responses while propagating cancellation.
 * Every response includes a revision, but only renders use the suffix recognized by revisionDrawn.
 */
export async function changeResult<T>(
  panel: DiagramPanel,
  token: vscode.CancellationToken,
  nothing: string,
  tool: string,
  parse: () => T,
  change: (input: T) => Promise<Answer>,
): Promise<vscode.LanguageModelToolResult> {
  throwIfCancelled(token);
  let input: T;
  try {
    input = parse();
  } catch (error) {
    return textResult(
      `${nothing}, as the input is invalid. Fix it and call ${tool} again. Revision: ${panel.revision}.\n\n${errorMessage(error)}`,
    );
  }
  let answer: Answer;
  try {
    answer = await change(input);
  } catch (error) {
    if (error instanceof vscode.CancellationError) throw error;
    answer = { paragraphs: [`${nothing}: ${errorMessage(error)}`] };
  }
  const [first, ...rest] = answer.paragraphs.filter(Boolean);
  return answer.drawn === undefined
    ? textResult([`${first} Revision: ${panel.revision}.`, ...rest].join("\n\n"))
    : drawnResult([first, ...rest].join("\n\n"), answer.drawn);
}

/** The revision that a {@link drawnResult} says its tool call drew. */
export function revisionDrawn(content: readonly unknown[]): number | undefined {
  const [result] = content;
  const match =
    result instanceof vscode.LanguageModelTextPart && /\n\nRevision: (\d+)\.$/.exec(result.value);
  return match ? Number(match[1]) : undefined;
}
