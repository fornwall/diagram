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
      this.load();
      input.focus();
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
    }
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
  private load(): void {
    this.editedFrom = this.formatted();
    if (this.elements.input.value !== this.editedFrom) this.elements.input.value = this.editedFrom;
    this.elements.staleNote.hidden = true;
    this.updateActions();
  }

  private updateActions(): void {
    const edited = this.elements.input.value !== this.editedFrom;
    this.elements.apply.disabled = !edited;
    this.elements.revert.disabled = !edited;
    this.onChange();
  }

  private apply(): void {
    const source = this.elements.input.value;
    if (!this.diagram || source === this.editedFrom) {
      return;
    }
    // The diagram that comes back is this edit, and not a change to warn about.
    this.appliedSource = source;
    this.elements.staleNote.hidden = true;
    this.onApply(this.diagram.requestId, source);
  }
}
