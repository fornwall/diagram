// Persist the panel's diagram across window reloads and VS Code restarts.

import * as vscode from "vscode";
import type { ChartPresentation } from "./chartPresentation";
import { type ChartSpec, validateChartSpec } from "./chartSpec";
import type { DocumentBinding } from "./documentDiagram";
import { isDiagramFence } from "./fences";
import type { NodeLinks } from "./links";
import type { DiagramState } from "./panel";
import { errorClause, isDiagramLanguage, isPlainObject } from "./protocol";

const STATE_KEY = "diagram.state";
/** Large generated chart options can be reloaded; manual edits must be kept. */
const MAX_SAVED_CHART_SOURCE = 1_000_000;

export class StateStore {
  /** State is replaced on every edit; weak identity avoids retaining an old large chart. */
  private lastSave: { state: WeakRef<DiagramState>; promise: Promise<void> } | undefined;
  private failed = false;

  constructor(private readonly memento: vscode.Memento) {}

  load(): DiagramState | undefined {
    const state = restoredState(this.memento.get(STATE_KEY));
    if (state) this.lastSave = { state: new WeakRef(state), promise: Promise.resolve() };
    return state;
  }

  /**
   * Saving the state already saved, or being saved, shares that write: reloads and reopening the
   * panel render the same state, and serializing a large chart source again is costly.
   */
  save(state: DiagramState): Promise<void> {
    if (this.lastSave?.state.deref() === state) return this.lastSave.promise;
    const saved =
      state.chart &&
      (state.chart.file !== undefined || state.chart.command !== undefined) &&
      !state.editedByUser &&
      state.source !== undefined &&
      state.source.length > MAX_SAVED_CHART_SOURCE
        ? { ...state, source: undefined, error: undefined }
        : state;
    const saving = { state: new WeakRef(state), promise: Promise.resolve() };
    this.lastSave = saving;
    saving.promise = (async () => {
      try {
        await this.memento.update(STATE_KEY, saved);
        this.failed = false;
      } catch (error) {
        // Failed writes must remain retryable, including when the state has not changed.
        if (this.lastSave === saving) this.lastSave = undefined;
        if (!this.failed) {
          void vscode.window.showWarningMessage(
            `Could not save the diagram: ${errorClause(error)}. Changes may be lost when VS Code closes.`,
          );
        }
        this.failed = true;
      }
    })();
    return saving.promise;
  }
}

/**
 * The saved state, keeping what this version can use. A state saved by another version of the
 * extension, or damaged, must not break the panel: the parts that do not fit are left out, and a
 * state with nothing left to show is dropped.
 */
function restoredState(saved: unknown): DiagramState | undefined {
  if (!isPlainObject(saved) || typeof saved.title !== "string") return undefined;
  // The first versions drew only Mermaid, and did not save the language.
  const language = saved.language ?? "mermaid";
  if (!isDiagramLanguage(language)) return undefined;
  const { origin, source } = saved;
  const state: DiagramState = {
    language,
    title: saved.title,
    origin: origin === "participant" || origin === "document" ? origin : "tool",
    editedByUser: saved.editedByUser === true,
  };
  if (typeof source === "string") state.source = source;
  if (typeof saved.error === "string") state.error = saved.error;
  if (typeof saved.clickPrompt === "string") state.clickPrompt = saved.clickPrompt;
  if (isNodeLinks(saved.links)) state.links = saved.links;
  if (isDocumentBinding(saved.document)) state.document = saved.document;
  const chart = language === "echarts" ? chartSpec(saved.chart) : undefined;
  const presentation = isChartPresentation(saved.chartPresentation)
    ? saved.chartPresentation
    : undefined;
  // Without its presentation, a refresh could not tell manual styling from generated styling and
  // would discard it, so the option is kept as it is, without the chart it was generated from.
  if (chart && (presentation || state.source === undefined)) {
    state.chart = chart;
    if (presentation) state.chartPresentation = presentation;
  }
  // A large chart of a file or command is saved without its option, to be drawn again from them.
  if (state.source === undefined && !state.chart?.file && !state.chart?.command) {
    return undefined;
  }
  return state;
}

function chartSpec(value: unknown): ChartSpec | undefined {
  try {
    return validateChartSpec(value);
  } catch {
    return undefined;
  }
}

function isChartPresentation(value: unknown): value is ChartPresentation {
  return (
    isPlainObject(value) &&
    isPlainObject(value.baseline) &&
    typeof value.dataHash === "string" &&
    Array.isArray(value.edits) &&
    value.edits.every((edit) => isPlainObject(edit) && Array.isArray(edit.path)) &&
    (value.blocked === undefined || typeof value.blocked === "string")
  );
}

function isNodeLinks(value: unknown): value is NodeLinks {
  return (
    isPlainObject(value) &&
    Object.values(value).every(
      (link) =>
        isPlainObject(link) &&
        typeof link.file === "string" &&
        (link.line === undefined || Number.isSafeInteger(link.line)) &&
        (link.endLine === undefined || Number.isSafeInteger(link.endLine)),
    )
  );
}

/** Older versions saved fences with other properties, which a write to the document cannot use. */
function isDocumentBinding(value: unknown): value is DocumentBinding {
  return isPlainObject(value) && typeof value.uri === "string" && isDiagramFence(value.fence);
}
