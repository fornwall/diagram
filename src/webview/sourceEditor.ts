// The views (drawing, split, source) and the source editor, which keeps unapplied edits across
// view changes, incoming diagrams and webview reloads.

import { isPlainObject } from "../protocol";
import type { Renderer } from "./renderer";

const VIEW_MODES = ["visual", "split", "source"] as const;

export type ViewMode = (typeof VIEW_MODES)[number];

/** What a reload of the webview restores. */
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
  /** The source as formatted for editing, once needed. */
  formatted?: string;
}

export class SourceEditor {
  /** The preferred view, shown once there is a diagram. */
  view: ViewMode = "visual";
  private diagram: Diagram | undefined;
  private sourceShown = false;
  /** The source the edits started from, for detecting unapplied edits. */
  private editedFrom = "";
  /** A pending edit, recognized when the extension sends it back to render. */
  private appliedSource: string | undefined;

  constructor(
    private readonly elements: Elements,
    private readonly onApply: (requestId: number, source: string) => void,
    /** Called when the state to restore after a reload may have changed. */
    private readonly onChange: () => void,
  ) {
    const { input, apply, revert, viewButtons } = elements;
    for (const [mode, button] of Object.entries(viewButtons)) {
      button.addEventListener("click", () => {
        this.setView(mode as ViewMode);
        if (this.sourceShown) input.focus();
      });
    }
    input.addEventListener("input", () => this.updateActions());
    input.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        this.apply();
      }
    });
    apply.addEventListener("click", () => this.apply());
    revert.addEventListener("click", () => {
      // First, as the edits that Revert discards stay in the editor's history, to undo it with.
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

  /** Restores what {@link state} saved, ignoring values that another version of the page saved. */
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

  /** The element that shows the content in the current view, for keyboard focus. */
  content(drawing: HTMLElement): HTMLElement {
    return this.view === "source" ? this.elements.input : drawing;
  }

  /** Takes a diagram the extension sent, keeping edits, and warns before they replace newer source. */
  diagramChanged(renderer: Renderer, source: string, requestId: number): void {
    this.diagram = { renderer, source, requestId };
    const { input, staleNote, viewButtons } = this.elements;
    // The buttons show only icons, so their titles also name them.
    viewButtons.visual.title = `Show the ${renderer.noun}`;
    viewButtons.split.title = `Show the ${renderer.noun} and its source`;
    viewButtons.source.title = `Edit the ${renderer.sourceName}`;
    input.setAttribute("aria-label", renderer.sourceName);
    // The first diagram makes the source available, and with it the view chosen before a reload.
    this.setView(this.view);
    const edited = input.value !== this.editedFrom;
    if (!this.sourceShown && !edited) {
      return;
    }
    if (source === this.appliedSource) {
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

  /** Whether the editor shows the diagram's source, or edits of it, rather than edits of another. */
  showsDiagram(): boolean {
    return this.diagram !== undefined && this.elements.staleNote.hidden === true;
  }

  /**
   * Selects a place in the source, from line and column 1, as an error names it: the character at
   * the column, or the line without its indentation. The drawing alone gives way to the split view.
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
    const lineEnd = text.indexOf("\n", start) < 0 ? text.length : text.indexOf("\n", start);
    const from =
      column === undefined
        ? start + (/^\s*/.exec(text.slice(start, lineEnd))?.[0].length ?? 0)
        : Math.min(start + column - 1, lineEnd);
    const to = column === undefined ? lineEnd : Math.min(from + 1, lineEnd);
    input.focus({ preventScroll: true });
    input.setSelectionRange(from, to);
    scrollToSelection(input);
  }

  /** Shows the drawing alone, as before the first diagram, keeping unapplied edits for the next. */
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

  /** Shows the source of the diagram as rendered, as the starting point for edits. */
  private load(undoable = false): void {
    this.editedFrom = this.formatted();
    replaceText(this.elements.input, this.editedFrom, undoable);
    this.elements.staleNote.hidden = true;
    this.updateActions();
  }

  /**
   * Whether the source shown is not the diagram's: edited, or, though the edits were undone, the
   * source they started from, which the diagram changed from since.
   */
  private differs(): boolean {
    return this.elements.input.value !== this.editedFrom || !this.elements.staleNote.hidden;
  }

  private updateActions(): void {
    const { apply, revert, input } = this.elements;
    // Disabling the focused action, as the diagram that Apply sent comes back, would leave the
    // focus on the page's body, from where Tab starts over: keep it in the source instead.
    const actionFocused = document.activeElement === apply || document.activeElement === revert;
    apply.disabled = revert.disabled = !this.differs();
    // Not from elsewhere in VS Code, where the user went meanwhile.
    if (actionFocused && apply.disabled && document.hasFocus()) input.focus();
    this.onChange();
  }

  private apply(): void {
    const source = this.elements.input.value;
    if (!this.diagram || !this.differs()) {
      return;
    }
    // The diagram that comes back is this edit, and not a change to warn about.
    this.appliedSource = source;
    this.elements.staleNote.hidden = true;
    this.onApply(this.diagram.requestId, source);
  }
}

/**
 * The most characters that an undoable replacement removes and inserts, which takes about a tenth
 * of a second, and as long to undo: a larger one, such as of a chart's data, is not undoable.
 */
const UNDOABLE_CHANGE = 100_000;

/**
 * Replaces the text, keeping the caret, the selection and the scroll position where the text around
 * them stays: a diagram that changes where the user is not reading leaves the place they were at.
 * An undoable replacement, of the focused editor, is an edit that Undo takes back.
 */
function replaceText(input: HTMLTextAreaElement, text: string, undoable: boolean): void {
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
  if (undoable && document.activeElement === input && changed <= UNDOABLE_CHANGE) {
    // An edit of the change alone, which the commands make to the selection. Assigning the value
    // would clear the history instead.
    input.setSelectionRange(prefix, old.length - suffix);
    document.execCommand(inserted ? "insertText" : "delete", false, inserted);
  }
  if (input.value !== text) input.value = text;
  input.setSelectionRange(moved(selectionStart), moved(selectionEnd), selectionDirection);
  input.scrollTop = scrollTop;
  input.scrollLeft = scrollLeft;
}

/**
 * Scrolls the selection into the middle of the editor, unless it shows already: neither selecting
 * nor focusing scrolls a textarea to its selection. Where the selection is, with lines wrapped as
 * the editor wraps them, is measured on a hidden copy of its text up to there.
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
