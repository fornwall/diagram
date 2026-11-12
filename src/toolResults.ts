import * as vscode from "vscode";
import { LINK_SYNTAX } from "./links";
import type { DiagramPanel, RenderOutcome } from "./panel";
import { type DiagramLanguage, EDIT_TOOL, RENDER_TOOL } from "./protocol";
import { errorContext } from "./sourceEdits";
import { formatCount, quoteAll } from "./text";

/** Links to absent nodes are kept, in case a later edit adds those nodes. */
export function linksWithoutNodes(
  ids: readonly string[],
  drawn: readonly string[] | undefined,
): string {
  const known = new Set(drawn);
  const unknown = drawn ? ids.filter((id) => !known.has(id)) : [];
  return unknown.length === 0
    ? ""
    : `\n\nThese links name nodes the diagram does not have: ${quoteAll(unknown)}. Its node ids are ${idList(drawn ?? [])}.`;
}

export function idList(ids: readonly string[]): string {
  const listed = quoteAll(ids.slice(0, 40));
  return ids.length > 40 ? `${listed} and ${formatCount(ids.length - 40)} more` : listed;
}

export function leftOutLinks(problems: readonly string[], language: DiagramLanguage): string {
  if (problems.length === 0) return "";
  if (language === "echarts") return `\n\nThe links were left out. ${problems.join(" ")}`;
  return `\n\nThese links were left out:\n- ${problems.join("\n- ")}\nA link is a workspace path with an optional line: ${LINK_SYNTAX}.`;
}

export function warningsText(panel: DiagramPanel): string {
  return panel.warnings.map((warning) => `\n\n${warning}`).join("");
}

/** A render failure, with the lines around a source error. */
export function failureText(
  outcome: Extract<RenderOutcome, { ok: false }>,
  noun: string,
  source: string,
  previous?: string,
): string {
  if (outcome.kind === "unavailable") {
    return `The panel could not show the ${noun}: ${outcome.error} The panel may still be drawing it.`;
  }
  const context = errorContext(source, outcome.error, previous);
  return `The ${noun} fails to render:\n\n${outcome.error}${context ? `\n\n${context}` : ""}\n\nThe panel shows the error. Fix it with ${EDIT_TOOL} or ${RENDER_TOOL}.`;
}

export function noDiagram(action: string): string {
  return `There is no diagram to ${action}. Render one with ${RENDER_TOOL} first.`;
}

export function textResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}
