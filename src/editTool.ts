// diagram_edit: exact text replacements in the current source.

import * as vscode from "vscode";
import { guessTitle } from "./blocks";
import { unlessCancelled } from "./cancellation";
import { type NodeLinks, validateLinks, withoutMissingFiles } from "./links";
import type { DiagramPanel } from "./panel";
import { diagramNoun, errorMessage, isPlainObject } from "./protocol";
import { applySourceEdits, type SourceEdit } from "./sourceEdits";
import { nonBlank } from "./text";
import {
  failureText,
  leftOutLinks,
  linksWithoutNodes,
  noDiagram,
  textResult,
  warningsText,
} from "./toolResults";

interface EditInput {
  edits?: { oldText: string; newText: string; replaceAll?: boolean }[];
  title?: string;
  links?: Record<string, string | null>;
}

function parseEdits(value: unknown): SourceEdit[] {
  let given = isPlainObject(value) ? value.edits : undefined;
  // Some models send the array as a JSON string, or a single edit without one.
  if (typeof given === "string") {
    try {
      given = JSON.parse(given);
    } catch {}
  }
  if (isPlainObject(given)) given = [given];
  if (given == null) return [];
  if (!Array.isArray(given)) throw new Error('"edits" must be an array of {oldText, newText}.');
  return given.map((edit, index) => {
    const { oldText, newText, replaceAll } = isPlainObject(edit) ? edit : {};
    if (typeof oldText !== "string" || oldText === "" || typeof newText !== "string") {
      throw new Error(`Edit ${index + 1} needs a non-empty "oldText" and a "newText" string.`);
    }
    return { oldText, newText, replaceAll: replaceAll === true };
  });
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

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<EditInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const state = this.panel.current;
    if (!state) return textResult(noDiagram("edit"));
    const { language, source } = state;
    const noun = diagramNoun(language);
    const input = isPlainObject(options.input) ? options.input : {};
    let edits: SourceEdit[];
    try {
      edits = parseEdits(input);
    } catch (error) {
      return textResult(`Nothing was changed: ${errorMessage(error)}`);
    }
    const edited = applySourceEdits(source, edits);
    if (!edited.ok) {
      return textResult(["Nothing was changed:", ...edited.problems].join("\n\n"));
    }

    const problems: string[] = [];
    let links = state.links;
    if (isPlainObject(input.links)) {
      const entries = Object.entries(input.links);
      const given = Object.fromEntries(entries.filter(([, location]) => location !== null));
      const removed = new Set(entries.filter(([, l]) => l === null).map(([id]) => id.trim()));
      let added: NodeLinks = {};
      const { links: valid, problems: invalid } = validateLinks(given, language);
      problems.push(...invalid);
      if (valid) {
        const existing = await unlessCancelled(() => withoutMissingFiles(valid), token);
        problems.push(...existing.problems);
        added = existing.links ?? {};
      }
      const kept = Object.entries(state.links ?? {}).filter(
        ([id]) => !removed.has(id) && !Object.hasOwn(added, id),
      );
      const all = [...kept, ...Object.entries(added)];
      links = all.length > 0 ? Object.fromEntries(all) : undefined;
    }
    const title =
      nonBlank(input.title) ??
      (state.title === guessTitle(state)
        ? guessTitle({ language, source: edited.source })
        : state.title);

    let outcome: Awaited<ReturnType<DiagramPanel["editByAgent"]>>;
    try {
      outcome = await unlessCancelled(
        () => this.panel.editByAgent({ source: edited.source, title, links }, this.panel.revision),
        token,
      );
    } catch (error) {
      if (error instanceof vscode.CancellationError) throw error;
      return textResult(`Nothing was changed: ${errorMessage(error)}`);
    }
    const text = outcome.ok
      ? `Edited the ${outcome.diagramType} ${noun}.${warningsText(this.panel)}`
      : failureText(outcome, noun, edited.source, source);
    return textResult(
      text +
        leftOutLinks(problems, language) +
        linksWithoutNodes(Object.keys(links ?? {}), this.panel.drawnIds),
    );
  }
}
