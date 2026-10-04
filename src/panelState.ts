// Persist the panel's diagram across window reloads and VS Code restarts.

import * as vscode from "vscode";
import { captureChartPresentation } from "./chartPresentation";
import type { DiagramState } from "./panel";
import { errorMessage } from "./protocol";

const STATE_KEY = "diagram.state";
/** Large generated chart options can be reloaded; manual edits must be kept. */
const MAX_SAVED_CHART_SOURCE = 1_000_000;

export class StateStore {
  /** State is replaced on every edit; weak identity avoids retaining an old large chart. */
  private lastSave: { state: WeakRef<DiagramState>; promise: Promise<void> } | undefined;
  private failed = false;

  constructor(private readonly memento: vscode.Memento) {}

  load(): DiagramState | undefined {
    let state = this.memento.get<DiagramState>(STATE_KEY);
    // Older saved states have no baseline against which manual changes can be distinguished.
    if (state?.chart && !state.chartPresentation && state.source !== undefined) {
      state = {
        ...state,
        chartPresentation: state.editedByUser
          ? {
              baseline: {},
              // No source edit can establish which data was originally generated.
              dataHash: "",
              edits: [],
              blocked:
                "This saved chart has manual edits without a generated baseline. " +
                "Your source is kept. Use Reset Styling in Chart Options to return to the generated chart.",
            }
          : captureChartPresentation(state.source),
      };
    }
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
            `Could not save the diagram: ${errorMessage(error)}. Changes may be lost when VS Code closes.`,
          );
        }
        this.failed = true;
      }
    })();
    return saving.promise;
  }
}
