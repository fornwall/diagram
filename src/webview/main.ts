import {
  type Annotation,
  type DiagramLanguage,
  type DiagramMark,
  type DiagramNode,
  errorMessage,
  type FromWebview,
  safeFileName,
  type ToWebview,
} from "../protocol";
import { ChartOptionsForm } from "./chartOptions";
import { toCss } from "./colors";
import { EChartsRenderer } from "./echartsRenderer";
import { type DiagramImage, pngDataUrl, svgDataUrl } from "./images";
import { MermaidRenderer } from "./mermaidRenderer";
import { enablePanning } from "./pan";
import { type Hit, type Renderer, UNMARKED, withModifier } from "./renderer";
import { enableSplitter } from "./splitter";
import "./style.css";
import { readThemeColors } from "./vscodeTheme";

type ViewMode = "visual" | "split" | "source";

interface State {
  draft: string;
  view?: ViewMode;
  editor?: { source: string; base: string };
}

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): State | undefined;
  setState(state: State): void;
};

const vscode = acquireVsCodeApi();
const post = (message: FromWebview) => vscode.postMessage(message);

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`Missing element #${id}`);
  }
  return found as T;
}

const titleElement = element("title");
const errorElement = element("error");
const emptyElement = element("empty");
const panes = element("panes");
const splitter = element("splitter");
const canvas = element("canvas");
const diagram = element("diagram");
const sourceInput = element<HTMLTextAreaElement>("source");
const applyButton = element<HTMLButtonElement>("apply");
const revertButton = element<HTMLButtonElement>("revert");
const selectionLabel = element("selection-label");
const highlightPathButton = element<HTMLButtonElement>("highlight-path");
const clearSelectionButton = element<HTMLButtonElement>("clear-selection");
const askForm = element<HTMLFormElement>("ask-form");
const askInput = element<HTMLInputElement>("ask-input");
const askSubmit = element<HTMLButtonElement>("ask-submit");
const zoomOutButton = element("zoom-out");
const zoomResetButton = element("zoom-reset");
const zoomInButton = element("zoom-in");
const refreshButton = element<HTMLButtonElement>("refresh");
const writeToButton = element<HTMLButtonElement>("write-to");
const dragOutHandle = element("drag-out");
const viewsGroup = element("views");
const viewButtons: Record<ViewMode, HTMLButtonElement> = {
  visual: element<HTMLButtonElement>("view-visual"),
  split: element<HTMLButtonElement>("view-split"),
  source: element<HTMLButtonElement>("view-source"),
};
const annotationBanner = element("annotation");
const annotationCaption = element("annotation-caption");
const annotationNotes = element("annotation-notes");
const pickBanner = element("pick");
const pickPrompt = element("pick-prompt");
const pickDoneButton = element<HTMLButtonElement>("pick-done");

const chartOptions = new ChartOptionsForm(element("chart-options"), post, focusContent);

// Register panning first so it can suppress clicks after a drag.
enablePanning(canvas);
enableSplitter(splitter, panes);

/** Last requested diagram, including failed renders. */
let current: { renderer: Renderer; source: string } | undefined;
/** Source baseline for detecting unapplied edits. */
let editedFrom = "";
/** Pending edit, recognized when the extension sends it back to render. */
let appliedSource: string | undefined;
/** Preferred view, restored once a diagram is available. */
let viewMode: ViewMode = "visual";
let sourceShown = false;
/** Selected nodes or chart items, by renderer key. */
const selection = new Map<string, DiagramNode>();
/** When set, a plain click on a node asks about it in chat. */
let clickPrompt: string | undefined;
/** Code links by node id. */
let links = new Map<string, string>();
let pick: { id: number; multiple: boolean } | undefined;
let labels = new Map<string, string>();

// Rendering.

const renderers: Record<DiagramLanguage, Renderer> = {
  mermaid: new MermaidRenderer(itemClicked, canvas, diagram, zoomResetButton),
  echarts: new EChartsRenderer(itemClicked, canvas),
};
let active: Renderer | undefined;
let renderedRequestId: number | undefined;

function showError(renderer: Renderer, message: string): void {
  // Details after the first line, like an excerpt of the source with a caret, need a fixed font.
  const [summary = "", ...details] = message.split("\n");
  errorElement.textContent = `This ${renderer.noun} failed to render: ${summary}`;
  if (details.length > 0) {
    const pre = document.createElement("pre");
    pre.textContent = details.join("\n");
    errorElement.append(pre);
  }
  errorElement.hidden = false;
}

async function render(message: Extract<ToWebview, { type: "render" }>): Promise<void> {
  forgetDragImage();
  renderedRequestId = undefined;
  const { language, source, requestId } = message;
  titleElement.textContent = message.title;
  clickPrompt = message.clickPrompt;
  links = new Map(Object.entries(message.links ?? {}));
  canvas.classList.toggle("click-to-ask", clickPrompt !== undefined);
  showRefresh(message.refreshFrom);
  writeToButton.hidden = message.writeTo === undefined;
  if (message.writeTo !== undefined) {
    writeToButton.textContent = `Write to ${message.writeTo}`;
    writeToButton.title = `Write the diagram as shown into the code block in ${message.writeTo}`;
  }
  const renderer = renderers[language];
  current = { renderer, source };
  // The first diagram makes the source available, and with it the view chosen before a reload.
  setViewMode(viewMode);
  sourceChanged(source);
  emptyElement.hidden = true;
  // The previous drawing may remain visible while rendering, but its actions are now stale.
  canvas.inert = true;
  try {
    const diagramType = await renderer.render(source, message.title);
    if (active !== renderer) {
      active?.hide();
    }
    active = renderer;
    renderedRequestId = requestId;
    renderer.showLinks?.(links);
    const drawn = renderer.drawnNodes?.();
    labels = new Map(drawn?.map((node) => [node.id, node.label]));
    errorElement.hidden = true;
    // The ids go along so that the extension host can tell a model when it names a node that is
    // not in the diagram, e.g. in a link or a mark.
    post({
      type: "rendered",
      requestId,
      diagramType,
      nodeIds: drawn?.filter((node) => !node.relationship).map((node) => node.id),
      relationships: drawn?.filter((node) => node.relationship),
    });
  } catch (error) {
    // Show only the error, as the title, Refresh, clicks and the source editor are now for the
    // diagram that failed, which is also the one the extension describes to the model.
    active?.hide();
    renderer.hide();
    active = undefined;
    const text = errorMessage(error);
    showError(renderer, text);
    post({ type: "renderError", requestId, message: text });
  } finally {
    canvas.inert = false;
  }
  // The extension forgets the selection and the marks when it sends a diagram, whether or not it
  // renders; the marks of this one, if an agent puts any on it, follow in their own message.
  clearSelection();
  showAnnotation(UNMARKED);
  for (const [button, description] of [
    [viewButtons.visual, `Show the ${renderer.noun}`],
    [viewButtons.split, `Show the ${renderer.noun} and its source`],
    [viewButtons.source, `Edit the ${renderer.sourceName}`],
  ] as const) {
    button.title = description;
    button.setAttribute("aria-label", description);
  }
  sourceInput.setAttribute("aria-label", renderer.sourceName);
  updateToolbar();
  updateSelectionUi();
}

function updateToolbar(): void {
  for (const button of [zoomOutButton, zoomResetButton, zoomInButton]) {
    button.hidden = !active?.zoomBy;
  }
  dragOutHandle.hidden = active?.toImage === undefined;
  viewsGroup.hidden = current === undefined;
}
updateToolbar();

function showRefresh(from: string | undefined): void {
  refreshButton.hidden = from === undefined;
  refreshButton.title = `Load the data again from ${from}`;
}

/** Shows the title of a chart that was not kept, and asks to draw it again. */
function showNeedsRefresh({ title, refreshFrom }: { title: string; refreshFrom?: string }): void {
  titleElement.textContent = title;
  showRefresh(refreshFrom);
  emptyElement.textContent =
    "This chart was too large to keep when VS Code closed. Press Refresh to draw it again.";
}

// Renders one at a time, in order, so that a slow render cannot overtake a later one.
let queue = Promise.resolve();
function enqueue(task: () => void | Promise<void>): void {
  queue = queue.then(task).catch((error: unknown) => console.error(error));
}

window.addEventListener("message", (event: MessageEvent<ToWebview>) => {
  const message = event.data;
  switch (message.type) {
    case "export":
      enqueue(() => exportDrawing(message));
      break;
    case "chartOptions":
      enqueue(() => chartOptions.update(message.state, message.visible));
      break;
    case "chartOptionsError":
      enqueue(() => chartOptions.showError(message.message));
      break;
    case "render":
      enqueue(() => render(message));
      break;
    case "needsRefresh":
      enqueue(() => showNeedsRefresh(message));
      break;
    case "clearSelection":
      clearSelection();
      break;
    case "annotate":
      // In the render queue, so that marks sent right after a diagram land on that diagram.
      enqueue(() => showAnnotation(message));
      break;
    case "startPick":
      startPick(message.pickId, message.prompt, message.multiple);
      break;
    case "endPick":
      if (pick?.id === message.pickId) {
        endPick();
      }
      break;
  }
});

// Render again when the VS Code color theme changes: VS Code updates the body class and data
// attributes (light, dark, high contrast; theme id), and the color variables on the root element.
let themeFrame = 0;
const themeObserver = new MutationObserver(() => {
  cancelAnimationFrame(themeFrame);
  themeFrame = requestAnimationFrame(() => {
    // The image prepared for a drag was drawn in the colors that are now gone.
    forgetDragImage();
    for (const renderer of Object.values(renderers)) {
      enqueue(() => renderer.themeChanged());
    }
  });
});
themeObserver.observe(document.body, {
  attributes: true,
  attributeFilter: ["class", "data-vscode-theme-kind", "data-vscode-theme-id"],
});
themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });

// Selection.

function updateSelectionUi(): void {
  active?.showSelection(new Set(selection.keys()));
  const { noun, itemNoun } = current?.renderer ?? renderers.mermaid;
  const labels = Array.from(selection.values(), (node) => `“${node.label}”`);
  selectionLabel.textContent =
    labels.length > 0 ? `Selected: ${labels.join(", ")}` : hint(itemNoun);
  clearSelectionButton.hidden = labels.length === 0 || pick !== undefined;
  highlightPathButton.hidden = !active?.supportsPaths || pick !== undefined;
  const endpoints = Array.from(selection.values());
  highlightPathButton.disabled =
    endpoints.length !== 2 || endpoints.some((node) => node.relationship);
  highlightPathButton.title = highlightPathButton.disabled
    ? "Select two flowchart nodes, first the start and then the destination"
    : `Highlight the shortest path from ${endpoints[0]?.label} to ${endpoints[1]?.label}`;
  pickDoneButton.disabled = labels.length === 0;
  askInput.placeholder =
    labels.length > 0 ? "Ask about or change the selection…" : `Ask about or change the ${noun}…`;
}

highlightPathButton.addEventListener("click", () => {
  const endpoints = Array.from(selection.values());
  const [from, to] = endpoints;
  if (!from || !to || endpoints.length !== 2 || from.relationship || to.relationship) return;
  const path = active?.findPath?.(from.id, to.id);
  if (!path) {
    transientHint(`No path from ${from.label} to ${to.label} following the arrows.`);
    return;
  }
  selection.clear();
  for (const node of path) selection.set(node.id, node);
  selectionChanged();
  canvas.focus();
  transientHint(
    `Highlighted the shortest path from ${from.label} to ${to.label} (${path.filter((node) => node.relationship).length} edges).`,
  );
});

function hint(noun: string): string {
  if (pick) {
    return pick.multiple
      ? `Click ${noun}s to pick them, then press Done.`
      : `Click a ${noun} to pick it.`;
  }
  const orSelect = `(Ctrl/Cmd/Shift+click to select ${noun}s)`;
  if (links.size > 0) {
    return clickPrompt
      ? `Click a linked ${noun} to open its code, any other to ask about it in chat ${orSelect}.`
      : `Click a linked ${noun} to open its code ${orSelect}.`;
  }
  if (clickPrompt) {
    return `Click a ${noun} to ask about it in chat ${orSelect}.`;
  }
  const parts = active?.drawnNodes?.().some((node) => node.relationship)
    ? "nodes or relationships"
    : `${noun}s`;
  return `Click ${parts} to select them (Ctrl/Cmd/Shift+click for several).`;
}

function selectionChanged(): void {
  forgetDragImage();
  updateSelectionUi();
  post({ type: "selectionChanged", nodes: Array.from(selection.values()) });
}

function clearSelection(): void {
  if (selection.size > 0) {
    selection.clear();
    selectionChanged();
  }
}

function itemClicked(hit: Hit | undefined, modifier: boolean): void {
  if (!hit) {
    if (!pick && !modifier) {
      clearSelection();
    }
    return;
  }
  // What a plain click does, in order: answer a pick the agent is waiting for, open the code the
  // node links to, ask the diagram's clickPrompt in chat, or select the node. A modified click
  // always selects, so that every node can be selected whatever else a click does.
  if (!pick && !modifier) {
    if (!hit.node.relationship && links.has(hit.node.id)) {
      post({ type: "clickToOpen", node: hit.node });
      return;
    }
    if (clickPrompt) {
      post({ type: "clickToAsk", node: hit.node });
      return;
    }
  }
  // A plain click selects only this item, or deselects it when nothing else is selected.
  const single = pick ? !pick.multiple : !modifier;
  if (single && !(selection.size === 1 && selection.has(hit.key))) {
    selection.clear();
  }
  if (!selection.delete(hit.key)) {
    selection.set(hit.key, hit.node);
  }
  selectionChanged();
  if (pick && !pick.multiple) {
    post({ type: "picked", pickId: pick.id, nodes: [hit.node] });
    endPick();
  }
}

canvas.addEventListener("click", (event) => {
  if (event.target === canvas) {
    itemClicked(undefined, withModifier(event));
  }
});

// Annotations.

function showAnnotation(next: Annotation): void {
  active?.showMarks(next);
  // An image prepared for a drag was made without these marks; a chart draws them into its SVG.
  forgetDragImage();
  const notes = next.marks.flatMap((mark) =>
    mark.note === undefined ? [] : [noteRow(mark, mark.note)],
  );
  annotationCaption.textContent = next.caption ?? "";
  annotationCaption.hidden = next.caption === undefined;
  annotationNotes.replaceChildren(...notes);
  annotationBanner.hidden = next.caption === undefined && notes.length === 0;
}

function noteRow({ id, kind }: DiagramMark, note: string): HTMLLIElement {
  const row = document.createElement("li");
  row.className = `diagram-mark-${kind}`;
  const dot = document.createElement("span");
  dot.className = "mark-dot";
  const name = document.createElement("b");
  // A chart item goes by the name a click gives it, which is the id itself.
  name.textContent = labels.get(id) ?? id;
  const text = document.createElement("span");
  text.append(name, document.createTextNode(` ${note}`));
  row.append(dot, text);
  return row;
}

// Picking nodes on request of an agent.

function startPick(id: number, prompt: string, multiple: boolean): void {
  // Reveal the nodes without discarding an unfinished source edit.
  if (viewMode === "source") {
    setViewMode("split");
  }
  pick = { id, multiple };
  clearSelection();
  pickPrompt.textContent = prompt;
  pickDoneButton.hidden = !multiple;
  pickBanner.hidden = false;
  canvas.classList.add("picking");
  updateSelectionUi();
  canvas.focus();
}

function endPick(): void {
  const restoreFocus = pickBanner.contains(document.activeElement);
  pick = undefined;
  pickBanner.hidden = true;
  canvas.classList.remove("picking");
  updateSelectionUi();
  if (restoreFocus) {
    focusContent();
  }
}

/** Keeps keyboard navigation in the visible content when a focused action disappears. */
function focusContent(): void {
  (viewMode === "source" ? sourceInput : canvas).focus();
}

pickDoneButton.addEventListener("click", () => {
  if (pick) {
    post({ type: "picked", pickId: pick.id, nodes: Array.from(selection.values()) });
    endPick();
  }
});

function cancelPick(): void {
  if (pick) {
    post({ type: "pickCancelled", pickId: pick.id });
    endPick();
  }
}

element("pick-cancel").addEventListener("click", cancelPick);
document.addEventListener("keydown", (event) => {
  // Escape in the source editor or message box is for the text, e.g. to close a completion.
  const typing =
    event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
  if (event.key === "Escape" && !typing) {
    cancelPick();
  }
});

clearSelectionButton.addEventListener("click", () => {
  const restoreFocus = document.activeElement === clearSelectionButton;
  clearSelection();
  if (restoreFocus) {
    focusContent();
  }
});

// Keep drafts when the webview reloads, e.g. when moved to another window.
function saveState(): void {
  vscode.setState({
    draft: askInput.value,
    view: viewMode,
    editor:
      sourceInput.value === editedFrom
        ? undefined
        : { source: sourceInput.value, base: editedFrom },
  });
}
const restored = vscode.getState();
askInput.value = restored?.draft ?? "";
viewMode = restored?.view ?? "visual";
if (restored?.editor) {
  sourceInput.value = restored.editor.source;
  editedFrom = restored.editor.base;
  updateEditorActions();
}
const updateAskSubmit = () => {
  askSubmit.disabled = askInput.value.trim().length === 0;
};
updateAskSubmit();
askInput.addEventListener("input", () => {
  updateAskSubmit();
  saveState();
});

askForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = askInput.value.trim();
  if (text) {
    post({ type: "ask", text, nodes: Array.from(selection.values()) });
    askInput.value = "";
    updateAskSubmit();
    askInput.focus();
    saveState();
  }
});

refreshButton.addEventListener("click", () => post({ type: "refresh" }));
writeToButton.addEventListener("click", () => post({ type: "writeToDocument" }));

/** Capture an image in the render queue; rasterization must not hold up later renders. */
async function exportDrawing(message: Extract<ToWebview, { type: "export" }>): Promise<void> {
  const { requestId, renderRequestId, format } = message;
  const failed = (error: unknown) =>
    post({ type: "exportError", requestId, message: errorMessage(error) });
  try {
    if (!active || renderedRequestId !== renderRequestId) {
      throw new Error("The diagram changed before it could be exported. Try again.");
    }
    if (format === "html") {
      if (active !== renderers.echarts)
        throw new Error("Interactive HTML is only available for charts.");
      post({ type: "exportTheme", requestId, colors: readThemeColors() });
      return;
    }
    if (!active.toImage) throw new Error("This drawing cannot be exported as an image.");
    const image = await active.toImage(imageBackground());
    if (format === "svg") {
      post({ type: "exportImage", requestId, format, data: image.svg });
    } else {
      void pngDataUrl(image).then(
        (data) => post({ type: "exportImage", requestId, format, data }),
        failed,
      );
    }
  } catch (error) {
    failed(error);
  }
}

// Dragging the drawing out of the panel as an image, e.g. into a chat or a document.

// dragstart is synchronous, so prepare the image before the drag begins.
let dragImage: { image: DiagramImage; png?: string; preview?: HTMLImageElement } | undefined;
/** Version currently being prepared; repeated hover events share the work. */
let preparingDragImage: number | undefined;
let imageVersion = 0;
let dragError: string | undefined;
/** Shift-drag requests SVG. */
let dragSvg = false;

/** The background an image is drawn on: an image dropped elsewhere has no theme behind it. */
const imageBackground = () => toCss(readThemeColors().background);

function forgetDragImage(): void {
  imageVersion++;
  dragImage = undefined;
  preparingDragImage = undefined;
  dragError = undefined;
}

function prepareDragImage(): void {
  const key = imageVersion;
  const toImage = active?.toImage?.bind(active);
  if (!toImage || dragImage || preparingDragImage === key) {
    return;
  }
  preparingDragImage = key;
  // Mermaid rendering and export both change its global configuration (notably HTML labels).
  enqueue(async () => {
    if (preparingDragImage !== key) {
      return;
    }
    try {
      const image = await toImage(imageBackground());
      if (preparingDragImage === key) {
        dragImage = { image };
        // Rasterization does not touch Mermaid's configuration or need to hold up rendering.
        void preparePng(dragImage);
      }
    } catch (error) {
      if (preparingDragImage === key) {
        dragError = `Could not prepare the image: ${errorMessage(error)}`;
      }
    } finally {
      if (preparingDragImage === key) {
        preparingDragImage = undefined;
      }
    }
  });
}

async function preparePng(ready: NonNullable<typeof dragImage>): Promise<void> {
  try {
    ready.png = await pngDataUrl(ready.image);
    const preview = new Image();
    preview.src = ready.png;
    await preview.decode();
    ready.preview = preview;
  } catch {
    // SVG is immediately usable, including while PNG decoding is pending or fails.
  }
}

// Hovering the handle is the earliest sign that a drag may be coming; pressing is the last.
dragOutHandle.addEventListener("pointerenter", () => {
  // Chart interactions and resizing can change its SVG without changing its source.
  forgetDragImage();
  prepareDragImage();
});
dragOutHandle.addEventListener("pointerdown", (event) => {
  dragSvg = event.shiftKey;
  prepareDragImage();
});

dragOutHandle.addEventListener("dragstart", (event) => {
  const ready = dragImage;
  if (!ready || !event.dataTransfer) {
    // Nothing can be dragged without an image, and the drag cannot wait for one.
    event.preventDefault();
    prepareDragImage();
    transientHint(dragError ?? "Preparing the image — start the drag again in a moment.");
    return;
  }
  const { dataTransfer } = event;
  const title = titleElement.textContent?.trim() ?? "";
  const name = safeFileName(title, "diagram");
  const useSvg = dragSvg || !ready.png;
  const url = useSvg ? svgDataUrl(ready.image.svg) : ready.png;
  if (!dragSvg && !ready.png) {
    transientHint("PNG is not ready. Dragging the drawing as SVG instead.");
  }
  dataTransfer.effectAllowed = "copy";
  // A file the drop target downloads from the data URL. This is what an application that takes
  // dropped files, such as a chat window, reads; the type it asks for decides the rest.
  dataTransfer.setData(
    "DownloadURL",
    `${useSvg ? "image/svg+xml" : "image/png"}:${name}.${useSvg ? "svg" : "png"}:${url}`,
  );
  // For a target that takes rich text instead of a file, and one that prefers vector over pixels.
  if (ready.png) {
    const image = document.createElement("img");
    image.src = ready.png;
    image.alt = title || name;
    dataTransfer.setData("text/html", image.outerHTML);
  }
  dataTransfer.setData("image/svg+xml", ready.image.svg);
  try {
    if (ready.preview) {
      dataTransfer.setDragImage(ready.preview, 12, 12);
    }
  } catch {
    // Not every build accepts an image that is not in the page; the default outline will do.
  }
});

let hintTimer: ReturnType<typeof setTimeout> | undefined;
function transientHint(text: string): void {
  selectionLabel.textContent = text;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(updateSelectionUi, 4000);
}

// The views, and source editing.

const staleNote = element("stale-note");

/** Shows the source of the diagram as rendered, as the editor's starting point. */
function loadSource(): void {
  editedFrom = current ? current.renderer.formatForEditing(current.source) : "";
  sourceInput.value = editedFrom;
  staleNote.hidden = true;
  updateEditorActions();
}

function updateEditorActions(): void {
  const edited = sourceInput.value !== editedFrom;
  applyButton.disabled = !edited;
  revertButton.disabled = !edited;
  saveState();
}

/** Changes views without discarding unapplied edits. */
function setViewMode(mode: ViewMode): void {
  viewMode = mode;
  // Before the first diagram there is no source to show.
  const shown = current === undefined ? "visual" : mode;
  for (const [name, button] of Object.entries(viewButtons)) {
    button.setAttribute("aria-pressed", String(name === shown));
  }
  // On the panes, not the body: a body class change would look like a theme change.
  panes.className = `view-${shown}`;
  const opening = shown !== "visual" && !sourceShown;
  sourceShown = shown !== "visual";
  if (opening && sourceInput.value === editedFrom) {
    loadSource();
  }
  saveState();
}

for (const [mode, button] of Object.entries(viewButtons)) {
  button.addEventListener("click", () => {
    setViewMode(mode as ViewMode);
    if (sourceShown) {
      sourceInput.focus();
    }
  });
}

/** Keeps drafts when the diagram changes, and warns before they replace newer source. */
function sourceChanged(source: string): void {
  if (!sourceShown && sourceInput.value === editedFrom) {
    return;
  }
  if (source === appliedSource) {
    // Keep edits made while waiting for Apply to render.
    if (sourceInput.value === appliedSource) {
      loadSource();
    } else {
      editedFrom = current?.renderer.formatForEditing(source) ?? source;
      updateEditorActions();
    }
    appliedSource = undefined;
  } else if (sourceInput.value === editedFrom || sourceInput.value === source) {
    loadSource();
  } else {
    staleNote.hidden = current?.renderer.formatForEditing(source) === editedFrom;
  }
}

function applySource(): void {
  if (sourceInput.value === editedFrom) {
    return;
  }
  // The diagram that comes back is this edit, and not a change to warn about.
  appliedSource = sourceInput.value;
  staleNote.hidden = true;
  post({ type: "sourceEdited", source: appliedSource });
}

sourceInput.addEventListener("input", updateEditorActions);
sourceInput.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    applySource();
  }
});
applyButton.addEventListener("click", applySource);
revertButton.addEventListener("click", () => {
  loadSource();
  sourceInput.focus();
});

// Zoom (Mermaid only; charts fit the panel).

zoomInButton.addEventListener("click", () => active?.zoomBy?.(1.25));
zoomOutButton.addEventListener("click", () => active?.zoomBy?.(1 / 1.25));
zoomResetButton.addEventListener("click", () => active?.zoomReset?.());
canvas.addEventListener(
  "wheel",
  (event) => {
    if ((event.ctrlKey || event.metaKey) && active?.zoomBy) {
      event.preventDefault();
      active.zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1);
    }
  },
  { passive: false },
);

post({ type: "ready" });
