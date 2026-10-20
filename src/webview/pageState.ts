// Persist drafts and view settings across webview reloads.

import { isPlainObject } from "../protocol";
import type { EditorState } from "./sourceEditor";

export interface StateApi {
  /** May contain state saved by an older extension version. */
  getState(): unknown;
  setState(state: unknown): void;
}

export interface PageState {
  /** Callers validate individual fields when restoring them. */
  readonly restored: Record<string, unknown>;
  /** Saves changed state immediately, or after typing pauses for a large draft. */
  save(): void;
}

interface SavedState extends EditorState {
  draft: string;
  sourceSize: number;
}

/** Serialize small drafts immediately; debounce larger ones to keep typing responsive. */
const SAVE_AT_ONCE = 100_000;
const SAVE_DELAY = 500;

function same(a: SavedState, b: SavedState | undefined): boolean {
  return (
    b !== undefined &&
    a.draft === b.draft &&
    a.sourceSize === b.sourceSize &&
    a.view === b.view &&
    a.editor?.source === b.editor?.source &&
    a.editor?.base === b.editor?.base
  );
}

function size(state: SavedState): number {
  return (
    state.draft.length +
    (state.view?.length ?? 0) +
    (state.editor?.source.length ?? 0) +
    (state.editor?.base.length ?? 0)
  );
}

/**
 * Deduplicates saves because view and render updates can request them repeatedly. VS Code's
 * setState serializes and sends the entire snapshot, so large drafts wait for a typing pause.
 */
export function keepPageState(api: StateApi, read: () => SavedState): PageState {
  let saved: SavedState | undefined;
  let unsaved: SavedState | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    if (!unsaved) return;
    api.setState(unsaved);
    saved = unsaved;
    unsaved = undefined;
  };
  // Reload Window and moving the tab may destroy the page without a final notification.
  // Flush when focus leaves or a command key arrives, before the host can reload it.
  window.addEventListener("blur", flush);
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", flush);
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey || /^F\d+$/.test(event.key)) flush();
    },
    { capture: true },
  );
  const restored = api.getState();
  return {
    restored: isPlainObject(restored) ? restored : {},
    save() {
      const next = read();
      if (same(next, unsaved ?? saved)) return;
      unsaved = next;
      clearTimeout(timer);
      if (size(next) <= SAVE_AT_ONCE) flush();
      else timer = setTimeout(flush, SAVE_DELAY);
    },
  };
}
