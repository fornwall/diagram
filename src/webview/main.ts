import {
  type Annotation,
  type DiagramLanguage,
  type DiagramMark,
  type DiagramNode,
  errorMessage,
  type FromWebview,
  isPlainObject,
  type ToWebview,
} from "../protocol";
import type { ChartOptionsForm } from "./chartOptions";
import { toCss } from "./colors";
import { enableDragOut } from "./dragOut";
import { loadECharts } from "./echartsLoader";
import { pngDataUrl } from "./images";
import { closeLinkMenu, showLinkMenu } from "./linkMenu";
import { enablePanning } from "./pan";
import { type Hit, type Renderer, UNMARKED, withModifier } from "./renderer";
import { type EditorState, SourceEditor } from "./sourceEditor";
import { enableSplitter } from "./splitter";
import "./style.css";
import { readThemeColors } from "./vscodeTheme";

interface State extends EditorState {
  draft: string;
}

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  /** What the page saved with setState, possibly a page of another version of the extension. */
  getState(): unknown;
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
const renderStatus = element("render-status");
const emptyElement = element("empty");
const panes = element("panes");
const splitter = element("splitter");
const canvas = element("canvas");
const diagram = element("diagram");
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
const annotationCaption = element("annotation-caption");
const annotationNotes = element("annotation-notes");
const pickBanner = element("pick");
const pickPrompt = element("pick-prompt");
const pickDoneButton = element<HTMLButtonElement>("pick-done");

/** The chart options form, loaded when first shown. */
let chartOptions: Promise<ChartOptionsForm> | undefined;
const loadChartOptions = () =>
  (chartOptions ??= import("./chartOptions").then(
    ({ ChartOptionsForm }) => new ChartOptionsForm(element("chart-options"), post, focusContent),
  ));

// Register panning first so it can suppress clicks after a drag.
enablePanning(canvas);
enableSplitter(splitter, panes);
const forgetDragImage = enableDragOut(dragOutHandle, {
  imageMaker: () => {
    const toImage = active?.toImage?.bind(active);
    return toImage && (() => toImage(imageBackground()));
  },
  changesInPlace: () => active?.changesInPlace === true,
  enqueue,
  title: () => titleElement.textContent?.trim() ?? "",
  noun: () => active?.noun ?? "diagram",
  hint: transientHint,
});

const editor = new SourceEditor(
  {
    panes,
    input: element("source"),
    apply: element("apply"),
    revert: element("revert"),
    staleNote: element("stale-note"),
    viewButtons: {
      visual: element("view-visual"),
      split: element("view-split"),
      source: element("view-source"),
    },
  },
  (requestId, source) => post({ type: "sourceEdited", requestId, source }),
  saveState,
);

/** Last requested diagram, including failed renders. */
let current: { language: DiagramLanguage; renderer: Renderer; requestId: number } | undefined;
/** Selected nodes or chart items, by renderer key. */
const selection = new Map<string, DiagramNode>();
/** When set, a plain click on a node asks about it in chat. */
let clickPrompt: string | undefined;
/** Code links by node id. */
let links = new Map<string, string>();
let pick: { id: number; multiple: boolean } | undefined;

// Rendering.

// Each renderer's code loads with its first diagram, so that a panel showing only diagrams or only
// charts does not load the code of the other.
const createRenderer: Record<DiagramLanguage, () => Promise<Renderer>> = {
  mermaid: async () => {
    // Mermaid loads beside its renderer instead of on its first render, after it.
    const [{ MermaidRenderer }] = await Promise.all([
      import("./mermaidRenderer"),
      import("mermaid"),
    ]);
    return new MermaidRenderer(itemClicked, canvas, diagram, zoomResetButton, enqueue);
  },
  echarts: async () => {
    // The library is a script of its own, without which there is no chart to draw.
    const [{ EChartsRenderer }] = await Promise.all([import("./echartsRenderer"), loadECharts()]);
    return new EChartsRenderer(itemClicked, canvas);
  },
};
const renderers = new Map<DiagramLanguage, Promise<Renderer>>();
function loadRenderer(language: DiagramLanguage): Promise<Renderer> {
  let renderer = renderers.get(language);
  if (!renderer) {
    renderer = createRenderer[language]().catch((error: unknown) => {
      // Let a later render try again.
      renderers.delete(language);
      const name = language === "echarts" ? "ECharts" : "Mermaid";
      throw new Error(
        `Could not load the ${name} renderer: ${errorMessage(error).replace(/\.$/, "")}. ` +
          "Reload the window (Developer: Reload Window).",
      );
    });
    renderers.set(language, renderer);
  }
  return renderer;
}
/** The renderer that shows the last requested diagram, unless that failed to render. */
let active: Renderer | undefined;
/** The language, title and document of the last diagram rendered, which a revision keeps. */
let renderedIdentity: string | undefined;

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
  const { language, source, requestId } = message;
  let renderer: Renderer;
  try {
    renderer = await loadRenderer(language);
  } catch (error) {
    // Nothing is drawn, and there is no source to fix: the extension reports the panel unavailable.
    active?.hide();
    active = undefined;
    const text = errorMessage(error);
    titleElement.textContent = message.title;
    emptyElement.hidden = true;
    errorElement.textContent = text;
    errorElement.hidden = false;
    post({ type: "renderUnavailable", requestId, message: text });
    diagramReplaced();
    return;
  }
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
  current = { language, renderer, requestId };
  // A different diagram fits the panel again, where a revision keeps the zoom chosen for it.
  const identity = JSON.stringify([language, message.title, message.writeTo]);
  if (identity !== renderedIdentity) renderer.fitToPanel?.();
  renderedIdentity = identity;
  editor.diagramChanged(renderer, source, requestId);
  emptyElement.hidden = true;
  closeLinkMenu();
  // The previous drawing may remain visible while rendering, but its actions are now stale.
  // That takes the focus from it, so give it back afterwards: to the same node if there is one, or
  // to the chart, which keeps its own focused item.
  const focused = canvas.contains(document.activeElement)
    ? (document.activeElement as HTMLElement | SVGElement)
    : undefined;
  canvas.inert = true;
  canvas.setAttribute("aria-busy", "true");
  errorElement.hidden = true;
  // Only for a slow render: the status line would shift a quick one down and back up, and a chart
  // measured meanwhile would not fit the canvas, as its resize observer may not see the change.
  const statusTimer = setTimeout(() => {
    renderStatus.textContent = `Rendering ${renderer.noun}…`;
  }, 300);
  try {
    const diagramType = await renderer.render(source, message.title);
    if (active !== renderer) {
      active?.hide();
    }
    active = renderer;
    renderer.showLinks?.(links);
    const drawn = renderer.drawnNodes?.();
    // The ids go along so that the extension host can tell a model when it names a node that is
    // not in the diagram, e.g. in a link or a mark.
    post({
      type: "rendered",
      requestId,
      diagramType,
      nodeIds: drawn?.filter((node) => !node.relationship).map((node) => node.id),
      relationships: drawn?.filter((node) => node.relationship),
      repeatedNames: renderer.repeatedNames?.(),
      warnings: renderer.warnings?.(),
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
    canvas.setAttribute("aria-busy", "false");
    clearTimeout(statusTimer);
    renderStatus.textContent = "";
  }
  if (focused && document.activeElement === document.body) {
    const id = focused.getAttribute("data-diagram-id");
    const node = id
      ? canvas.querySelector<SVGElement>(`[data-diagram-id="${CSS.escape(id)}"][tabindex]`)
      : focused;
    node?.focus({ preventScroll: true });
    if (document.activeElement === document.body) drawingFocus().focus({ preventScroll: true });
  }
  diagramReplaced();
}

function diagramReplaced(): void {
  // The extension forgets the selection and the marks when it sends a diagram, whether or not it
  // renders; the marks of this one, if an agent puts any on it, follow in their own message.
  clearSelection();
  showAnnotation(UNMARKED);
  updateToolbar();
  updateSelectionUi();
  // The canvas is a tab stop to scroll a diagram with the keys; a chart is a tab stop of its own.
  canvas.tabIndex = active && !active.focusTarget ? 0 : -1;
  const noun = active?.noun ?? "diagram";
  canvas.setAttribute("aria-label", `${noun.charAt(0).toUpperCase()}${noun.slice(1)} preview`);
}

/** The element that takes the keys for the drawing. */
function drawingFocus(): HTMLElement {
  return active?.focusTarget ?? canvas;
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
function showNeedsRefresh({
  title,
  refreshFrom,
}: Extract<ToWebview, { type: "needsRefresh" }>): void {
  titleElement.textContent = title;
  showRefresh(refreshFrom);
  emptyElement.textContent =
    "This chart was too large to keep when VS Code closed. Press Refresh to draw it again.";
}

// Renders one at a time, in order, so that a slow render cannot overtake a later one.
let queue = Promise.resolve();
// Counts render requests, so that a render that a later one superseded while it waited is skipped:
// the host has already cancelled it.
let renderRevision = 0;
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
      // The form starts hidden, so there is nothing to hide before it is loaded.
      if (message.visible || chartOptions !== undefined) {
        const form = loadChartOptions();
        enqueue(async () => (await form).update(message.state, message.visible));
      }
      break;
    case "chartOptionsError":
      if (chartOptions !== undefined) {
        const form = chartOptions;
        enqueue(async () => (await form).showError(message.message));
      }
      break;
    case "render": {
      const revision = ++renderRevision;
      // Load the renderer meanwhile if the queue is busy.
      loadRenderer(message.language).catch(() => {
        // The render reports it.
      });
      enqueue(async () => {
        if (revision === renderRevision) await render(message);
      });
      break;
    }
    case "needsRefresh":
      enqueue(() => showNeedsRefresh(message));
      break;
    case "clearSelection":
      clearSelection();
      break;
    case "annotate": {
      // In the render queue, so that marks sent right after a diagram land on that diagram.
      const revision = renderRevision;
      enqueue(() => {
        if (revision === renderRevision) showAnnotation(message);
      });
      break;
    }
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

// Render again when the VS Code color theme changes: VS Code updates the body's data attributes
// (light, dark, high contrast; theme id) and the color variables on the root element. Not when the
// body class changes, as it does while VS Code shows its context menu: the redraw would move the
// focus back into the page, closing the export format picker that the menu opened.
let themeFrame = 0;
const themeObserver = new MutationObserver(() => {
  cancelAnimationFrame(themeFrame);
  themeFrame = requestAnimationFrame(() => {
    // The image prepared for a drag was drawn in the colors that are now gone.
    forgetDragImage();
    closeLinkMenu();
    for (const renderer of renderers.values()) {
      enqueue(async () => (await renderer).themeChanged());
    }
  });
});
themeObserver.observe(document.body, {
  attributes: true,
  attributeFilter: ["data-vscode-theme-kind", "data-vscode-theme-id"],
});
themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });

// Selection.

function updateSelectionUi(): void {
  active?.showSelection(new Set(selection.keys()));
  const { noun, itemNoun } = current?.renderer ?? { noun: "diagram", itemNoun: "node" };
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
  // Enabled only for two selected nodes.
  const [from, to] = selection.values();
  if (!from || !to) return;
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
  if (links.size > 0 || active?.hasWebLinks) {
    const open = active?.hasWebLinks ? "open its link" : "open its code";
    return clickPrompt
      ? `Click a linked ${noun} to ${open}, any other to ask about it in chat ${orSelect}.`
      : `Click a linked ${noun} to ${open} ${orSelect}.`;
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
  if (current) {
    post({
      type: "selectionChanged",
      requestId: current.requestId,
      nodes: [...selection.values()],
    });
  }
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
  // node links to, open the URL that the source links it to (or offer a menu of several), ask the
  // diagram's clickPrompt in chat, or select the node. A modified click always selects, so that
  // every node can be selected whatever else a click does.
  if (!pick && !modifier) {
    if (!hit.node.relationship && links.has(hit.node.id)) {
      post({ type: "clickToOpen", node: hit.node });
      return;
    }
    if (hit.links) {
      const { targets, anchor } = hit.links;
      const openUrl = (url: string) => post({ type: "openUrl", url });
      const [only] = targets;
      if (only && targets.length === 1) {
        openUrl(only.url);
      } else {
        showLinkMenu(canvas, anchor, `Links of ${hit.node.label}`, targets, openUrl);
      }
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
}

function noteRow({ id, kind }: DiagramMark, note: string): HTMLLIElement {
  const row = document.createElement("li");
  row.className = `diagram-mark-${kind}`;
  const dot = document.createElement("span");
  dot.className = "mark-dot";
  const name = document.createElement("b");
  name.textContent = active?.labelOf(id) ?? id;
  const text = document.createElement("span");
  text.append(name, document.createTextNode(` ${note}`));
  row.append(dot, text);
  return row;
}

// Picking nodes on request of an agent.

function startPick(id: number, prompt: string, multiple: boolean): void {
  // Reveal the nodes without discarding an unfinished source edit.
  if (editor.view === "source") {
    editor.setView("split");
  }
  pick = { id, multiple };
  clearSelection();
  pickPrompt.textContent = prompt;
  pickDoneButton.hidden = !multiple;
  pickBanner.hidden = false;
  canvas.classList.add("picking");
  // A screen reader reads the question with the drawing that the focus moves to, as the banner
  // that shows it appears only now and so is no live region yet.
  const drawing = drawingFocus();
  describeByPick(drawing, true);
  updateSelectionUi();
  drawing.focus();
}

/** Adds the pick question to, or removes it from, what describes the element. */
function describeByPick(element: Element, add: boolean): void {
  const ids = (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter((id) => id && id !== pickPrompt.id);
  if (add) ids.unshift(pickPrompt.id);
  if (ids.length > 0) element.setAttribute("aria-describedby", ids.join(" "));
  else element.removeAttribute("aria-describedby");
}

function endPick(): void {
  const restoreFocus = pickBanner.contains(document.activeElement);
  pick = undefined;
  pickBanner.hidden = true;
  canvas.classList.remove("picking");
  // A rendering while picking may have moved the focus to another element.
  for (const element of document.querySelectorAll(`[aria-describedby~="${pickPrompt.id}"]`)) {
    describeByPick(element, false);
  }
  updateSelectionUi();
  if (restoreFocus) {
    focusContent();
  }
}

/** Keeps keyboard navigation in the visible content when a focused action disappears. */
function focusContent(): void {
  editor.content(drawingFocus()).focus();
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
let savedState: State | undefined;
function saveState(): void {
  const next: State = { draft: askInput.value, ...editor.state() };
  // setState serializes the whole draft and sends it to the host. View and render updates can
  // reach here several times with the same state, including multi-megabyte source edits.
  if (
    savedState?.draft === next.draft &&
    savedState.view === next.view &&
    savedState.editor?.source === next.editor?.source &&
    savedState.editor?.base === next.editor?.base
  ) {
    return;
  }
  vscode.setState(next);
  savedState = next;
}
const restored = vscode.getState();
const saved = isPlainObject(restored) ? restored : {};
askInput.value = typeof saved.draft === "string" ? saved.draft : "";
editor.restore(saved);
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
writeToButton.addEventListener("click", () => {
  if (current) post({ type: "writeToDocument", requestId: current.requestId });
});

/** Exports the drawing from the render queue, but rasterizes a PNG outside it, not to hold it up. */
async function exportDrawing(message: Extract<ToWebview, { type: "export" }>): Promise<void> {
  const { requestId, renderRequestId, format } = message;
  const failed = (error: unknown) =>
    post({ type: "exportError", requestId, message: errorMessage(error) });
  try {
    if (!active || current?.requestId !== renderRequestId) {
      throw new Error("The diagram changed before it could be exported. Try again.");
    }
    if (format === "html") {
      if (current.language !== "echarts")
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

/** The background an image is drawn on: an image dropped elsewhere has no theme behind it. */
function imageBackground(): string {
  return toCss(readThemeColors().background);
}

let hintTimer: ReturnType<typeof setTimeout> | undefined;
function transientHint(text: string): void {
  selectionLabel.textContent = text;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(updateSelectionUi, 4000);
}

// Zoom (Mermaid only; charts fit the panel).

const zoomIn = () => active?.zoomBy?.(1.25);
const zoomOut = () => active?.zoomBy?.(1 / 1.25);
const zoomReset = () => active?.zoomReset?.();
zoomInButton.addEventListener("click", zoomIn);
zoomOutButton.addEventListener("click", zoomOut);
zoomResetButton.addEventListener("click", zoomReset);

// Cmd (macOS) or Ctrl with +, - and 0, as in browsers, while the panel has the focus. VS Code sees
// every key the page does, so the event stops in the capture phase, before VS Code's listener on
// the window passes it on to zoom the window or focus the side bar as well.
const ZOOM_KEYS: Partial<Record<string, () => void>> = {
  "=": zoomIn,
  "+": zoomIn,
  "-": zoomOut,
  "0": zoomReset,
};
const isMac = navigator.userAgent.includes("Mac");
window.addEventListener(
  "keydown",
  (event) => {
    const zoom = ZOOM_KEYS[event.key];
    const primary = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (zoom && primary && !event.altKey && active?.zoomBy) {
      event.preventDefault();
      event.stopPropagation();
      zoom();
    }
  },
  { capture: true },
);

post({ type: "ready" });
