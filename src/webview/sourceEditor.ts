// Source editing with drafts preserved across view changes, incoming diagrams and reloads.

import { isPlainObject } from "../protocol";
import type { Renderer } from "./renderer";

const VIEW_MODES = ["visual", "split", "source"] as const;

export type ViewMode = (typeof VIEW_MODES)[number];

/** Source editor state saved across webview reloads. */
export interface EditorState {
  view?: ViewMode;
  /** Unapplied edits, and the source they started from. */
  editor?: { source: string; base: string } | undefined;
}

interface Elements {
  panes: HTMLElement;
  input: HTMLTextAreaElement;
  apply: HTMLButtonElement;
  revert: HTMLButtonElement;
  staleNote: HTMLElement;
  viewButtons: Record<ViewMode, HTMLButtonElement>;
}

interface Diagram {
  renderer: Renderer;
  source: string;
  requestId: number;
  /** Cached lazily, since a chart's JSON can be large. */
  formatted?: string;
}

export class SourceEditor {
  /** Restored when a diagram becomes available. */
  view: ViewMode = "visual";
  private diagram: Diagram | undefined;
  private sourceShown = false;
  /** Source before the current edits. */
  private editedFrom = "";
  /** Recognizes the host's response to Apply. */
  private appliedSource: string | undefined;
  /** Restores the stale warning when Undo brings back a reverted draft. */
  private reverted: { source: string; base: string } | undefined;
  /** Reset the caret and scroll position when loading a different diagram. */
  private another = false;

  constructor(
    private readonly elements: Elements,
    private readonly onApply: (requestId: number, source: string) => void,
    /** Called when persisted state may have changed. */
    private readonly onChange: () => void,
  ) {
    const { input, apply, revert, viewButtons } = elements;
    for (const [mode, button] of Object.entries(viewButtons)) {
      button.addEventListener("click", () => {
        this.setView(mode as ViewMode);
        if (this.sourceShown) input.focus();
      });
    }
    input.addEventListener("input", () => this.edited());
    input.addEventListener("keydown", (event) => {
      if (!event.isComposing && (event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        this.apply();
      }
    });
    apply.addEventListener("click", () => this.apply());
    revert.addEventListener("click", () => {
      // Undo must restore the draft's original base, including its stale warning.
      if (this.editedFrom !== this.formatted()) {
        this.reverted = { source: input.value, base: this.editedFrom };
      }
      // The undoable replacement requires the editor to have focus.
      input.focus();
      this.load(true);
    });
  }

  state(): EditorState {
    const source = this.elements.input.value;
    return {
      view: this.view,
      editor: source === this.editedFrom ? undefined : { source, base: this.editedFrom },
    };
  }

  /** Ignores invalid or obsolete saved values. */
  restore({ view, editor }: Record<string, unknown>): void {
    if (VIEW_MODES.includes(view as ViewMode)) this.view = view as ViewMode;
    if (
      isPlainObject(editor) &&
      typeof editor.source === "string" &&
      typeof editor.base === "string"
    ) {
      this.elements.input.value = editor.source;
      this.editedFrom = editor.base;
      this.updateActions();
    }
  }

  /** The content to focus in the current view. */
  content(drawing: HTMLElement): HTMLElement {
    return this.view === "source" ? this.elements.input : drawing;
  }

  /**
   * Accepts a render from the host, preserving drafts and marking them stale when their base
   * differs. A new diagram resets the caret; a revision keeps the reading position.
   */
  diagramChanged(renderer: Renderer, source: string, requestId: number, another: boolean): void {
    this.diagram = { renderer, source, requestId };
    if (another) this.another = true;
    const { input, staleNote, viewButtons } = this.elements;
    // Icon-only buttons need accessible names.
    viewButtons.visual.title = `Show the ${renderer.noun}`;
    viewButtons.split.title = `Show the ${renderer.noun} and its source`;
    viewButtons.source.title = `Edit the ${renderer.sourceName}`;
    input.setAttribute("aria-label", renderer.sourceName);
    // Restore the preferred view once source is available.
    this.setView(this.view);
    const edited = input.value !== this.editedFrom;
    if (!this.sourceShown && !edited) {
      return;
    }
    if (source === this.appliedSource) {
      // Applying an edit is a revision, even if the host treated it as a new diagram.
      this.another = false;
      // Keep edits made while waiting for Apply to render.
      if (input.value === this.appliedSource) {
        this.load();
      } else {
        this.editedFrom = this.formatted();
        this.updateActions();
      }
      this.appliedSource = undefined;
    } else if (!edited || input.value === source) {
      this.load();
    } else {
      staleNote.hidden = this.formatted() === this.editedFrom;
      this.updateActions();
    }
  }

  /** Whether error locations in the current diagram also apply to this draft. */
  showsDiagram(): boolean {
    return this.diagram !== undefined && this.elements.staleNote.hidden === true;
  }

  /**
   * Selects an error location using one-based lines and columns. Without a column, selects the
   * line excluding indentation. Opens the split view if the source is hidden.
   */
  reveal(line: number, column: number | undefined): void {
    if (this.view === "visual") this.setView("split");
    const { input } = this.elements;
    const text = input.value;
    let start = 0;
    for (let each = 1; each < line && start >= 0; each++) {
      start = text.indexOf("\n", start);
      if (start >= 0) start++;
    }
    if (start < 0) start = text.length;
    const nextLine = text.indexOf("\n", start);
    const lineEnd = nextLine < 0 ? text.length : nextLine;
    const from =
      column === undefined
        ? start + (/^\s*/.exec(text.slice(start, lineEnd))?.[0].length ?? 0)
        : Math.min(start + column - 1, lineEnd);
    const to = column === undefined ? lineEnd : Math.min(from + 1, lineEnd);
    input.focus({ preventScroll: true });
    input.setSelectionRange(from, to);
    scrollToSelection(input);
  }

  /** Hides the source while preserving the draft and preferred view for the next diagram. */
  diagramGone(): void {
    this.diagram = undefined;
    this.elements.staleNote.hidden = true;
    this.setView(this.view);
  }

  /** Changes views without discarding unapplied edits. */
  setView(mode: ViewMode): void {
    this.view = mode;
    // Before the first diagram there is no source to show.
    const shown = this.diagram === undefined ? "visual" : mode;
    for (const [name, button] of Object.entries(this.elements.viewButtons)) {
      button.setAttribute("aria-pressed", String(name === shown));
    }
    this.elements.panes.className = `view-${shown}`;
    const opening = shown !== "visual" && !this.sourceShown;
    this.sourceShown = shown !== "visual";
    if (opening && this.elements.input.value === this.editedFrom) {
      this.load();
    }
    this.onChange();
  }

  /** Formats only when needed, once per diagram, even when switching views repeatedly. */
  private formatted(): string {
    const { diagram } = this;
    if (!diagram) return "";
    diagram.formatted ??= diagram.renderer.formatForEditing?.(diagram.source) ?? diagram.source;
    return diagram.formatted;
  }

  /** Replaces the draft with the rendered source. */
  private load(undoable = false): void {
    this.editedFrom = this.formatted();
    replaceText(this.elements.input, this.editedFrom, undoable, !this.another);
    this.another = false;
    this.elements.staleNote.hidden = true;
    this.updateActions();
  }

  /** Reconciles edits and Undo/Redo with the draft's base. */
  private edited(): void {
    const { input, staleNote } = this.elements;
    if (this.diagram && input.value === this.formatted()) {
      // Back to the diagram's source, as Redo reverts again.
      this.editedFrom = input.value;
      staleNote.hidden = true;
    } else if (input.value === this.reverted?.source) {
      this.editedFrom = this.reverted.base;
      staleNote.hidden = this.formatted() === this.editedFrom;
    }
    this.updateActions();
  }

  /**
   * A stale draft still differs after all its edits are undone: its base is an older diagram.
   */
  private differs(): boolean {
    return this.elements.input.value !== this.editedFrom || !this.elements.staleNote.hidden;
  }

  private updateActions(): void {
    const { apply, revert, input } = this.elements;
    // Disabling a focused button moves focus to the body. Return it to the editor, unless the
    // user has already switched to another part of VS Code.
    const actionFocused = document.activeElement === apply || document.activeElement === revert;
    apply.disabled = revert.disabled = !this.differs();
    if (actionFocused && apply.disabled && document.hasFocus()) input.focus();
    this.onChange();
  }

  private apply(): void {
    const source = this.elements.input.value;
    if (!this.diagram || !this.differs()) {
      return;
    }
    // The matching host response acknowledges this draft instead of marking it stale.
    this.appliedSource = source;
    this.elements.staleNote.hidden = true;
    this.onApply(this.diagram.requestId, source);
  }
}

/**
 * Bound undoable replacements by changed characters and inserted lines × total lines.
 * Chromium's line-by-line insertion can take seconds for large chart sources; above these
 * limits, assign the value directly and sacrifice undo history to keep the editor responsive.
 */
const UNDOABLE_CHANGE = 100_000;
const UNDOABLE_LINES = 200_000;

const lineCount = (text: string) => (text.match(/\n/g)?.length ?? 0) + 1;

/**
 * Replaces only the changed span when possible, so Revert can be undone. With keepPlace, adjusts
 * the selection for the replacement and preserves scrolling; otherwise starts at the top.
 */
function replaceText(
  input: HTMLTextAreaElement,
  text: string,
  undoable: boolean,
  keepPlace: boolean,
): void {
  const old = input.value;
  if (old === text) return;
  const shortest = Math.min(old.length, text.length);
  let prefix = 0;
  while (prefix < shortest && old.charCodeAt(prefix) === text.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    old.charCodeAt(old.length - 1 - suffix) === text.charCodeAt(text.length - 1 - suffix)
  ) {
    suffix++;
  }
  // An offset after the change moves with the text after it, and one within it to its end at most.
  const moved = (offset: number) =>
    offset >= old.length - suffix
      ? offset - old.length + text.length
      : Math.min(offset, text.length - suffix);
  const { selectionStart, selectionEnd, selectionDirection, scrollTop, scrollLeft } = input;
  const inserted = text.slice(prefix, text.length - suffix);
  const changed = old.length - suffix - prefix + inserted.length;
  if (
    undoable &&
    document.activeElement === input &&
    changed <= UNDOABLE_CHANGE &&
    lineCount(inserted) * lineCount(text) <= UNDOABLE_LINES
  ) {
    // execCommand preserves the textarea's undo history; assigning value clears it.
    input.setSelectionRange(prefix, old.length - suffix);
    document.execCommand(inserted ? "insertText" : "delete", false, inserted);
  }
  if (input.value !== text) input.value = text;
  if (keepPlace) {
    input.setSelectionRange(moved(selectionStart), moved(selectionEnd), selectionDirection);
  } else {
    input.setSelectionRange(0, 0);
  }
  input.scrollTop = keepPlace ? scrollTop : 0;
  input.scrollLeft = keepPlace ? scrollLeft : 0;
}

/**
 * Textarea selection APIs do not scroll to the selection. Measure its wrapped position in a
 * hidden copy, then center it if it is outside the visible area.
 */
function scrollToSelection(input: HTMLTextAreaElement): void {
  const style = getComputedStyle(input);
  const copy = document.createElement("div");
  for (const property of [
    "font",
    "letterSpacing",
    "wordSpacing",
    "lineHeight",
    "tabSize",
    "whiteSpace",
    "overflowWrap",
    "wordBreak",
  ] as const) {
    copy.style[property] = style[property];
  }
  const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
  Object.assign(copy.style, {
    position: "absolute",
    visibility: "hidden",
    top: "0",
    left: "0",
    width: `${input.clientWidth - padding}px`,
  });
  const mark = document.createElement("span");
  mark.textContent = input.value.slice(input.selectionStart, input.selectionEnd) || "​";
  copy.append(input.value.slice(0, input.selectionStart), mark);
  document.body.append(copy);
  const top = mark.offsetTop + Number.parseFloat(style.paddingTop);
  const height = mark.offsetHeight;
  copy.remove();
  if (top < input.scrollTop || top + height > input.scrollTop + input.clientHeight) {
    input.scrollTop = top - (input.clientHeight - height) / 2;
  }
}
