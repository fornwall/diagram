// The state that VS Code gives back to the page when it loads it anew, as when the tab moves to
// another window: drafts, the view and the size of the source pane.

import { isPlainObject } from "../protocol";

/** VS Code's API to the page, as far as its state goes. */
export interface StateApi {
  /** What the page saved with setState, possibly a page of another version of the extension. */
  getState(): unknown;
  setState(state: unknown): void;
}

export interface PageState {
  /** What the page saved before it was loaded anew: of any shape, as another version may have saved it. */
  readonly restored: Record<string, unknown>;
  /** Saves the state as it is now, unless that is saved already: at once, or once typing pauses for a large one. */
  save(): void;
}

/** The size in characters of a state saved at once, which takes about a millisecond to send. */
const SAVE_AT_ONCE = 100_000;
/** How long typing pauses before a larger state is saved. */
const SAVE_DELAY = 500;

/** Whether the states hold the same values, as strings, numbers, booleans and objects of them. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!same(a[key], b[key])) return false;
  }
  return true;
}

/** How many characters of text the state holds, which is about how long it takes to send. */
function size(state: unknown): number {
  if (typeof state === "string") return state.length;
  if (!isPlainObject(state)) return 0;
  let sum = 0;
  for (const value of Object.values(state)) sum += size(value);
  return sum;
}

/**
 * Keeps the state that `read` gives saved with VS Code. setState serializes the whole state and
 * sends it to the host: view and render updates reach `save` several times with the same state,
 * which is saved once, and a source of megabytes, which typing changes on every key, once typing
 * pauses, rather than slow it down.
 */
export function keepPageState(api: StateApi, read: () => Record<string, unknown>): PageState {
  let saved: unknown;
  /** A larger state waiting for typing to pause. */
  let unsaved: Record<string, unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    if (!unsaved) return;
    api.setState(unsaved);
    saved = unsaved;
    unsaved = undefined;
  };
  // VS Code takes the last state the page saved when it reloads the page, without warning the page
  // first. What reloads it, such as Reload Window or dragging the tab to another window, takes the
  // focus out of the page or is a key the page sees first, and the state sent then arrives before.
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
