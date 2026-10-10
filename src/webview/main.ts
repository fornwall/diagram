import {
  type Annotation,
  type DiagramLanguage,
  type DiagramMark,
  type DiagramNode,
  errorClause,
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
import { preloadLayout } from "./mermaidLayout";
import { enablePanning } from "./pan";
import { type Hit, type Renderer, UNMARKED, withModifier } from "./renderer";
import { type EditorState, SourceEditor } from "./sourceEditor";
import { enableSplitter } from "./splitter";
import "./style.css";
import { readThemeColors } from "./vscodeTheme";

interface State extends EditorState {
  draft: string;
  /** The source editor's share of the split view. */
  sourceSize: number;
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
const applyButton = element<HTMLButtonElement>("apply");
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
    (error: unknown) => {
      // Let the next time the form is shown try again.
      chartOptions = undefined;
      transientHint(
        `Could not load Chart Options: ${errorClause(error)}. Reload the window (Developer: Reload Window).`,
      );
      throw error;
    },
  ));

// Register panning first so it can suppress clicks after a drag.
enablePanning(canvas);
const split = enableSplitter(splitter, panes, element("editor"), saveState);
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
    apply: applyButton,
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
    return new MermaidRenderer(
      itemClicked,
      canvas,
      diagram,
      zoomResetButton,
      enqueue,
      () => tabHidden,
    );
  },
  echarts: async () => {
    // The library is a script of its own, without which there is no chart to draw.
    const [{ EChartsRenderer }] = await Promise.all([import("./echartsRenderer"), loadECharts()]);
    return new EChartsRenderer(itemClicked, canvas, readThemeColors, () => tabHidden);
  },
};
const renderers = new Map<DiagramLanguage, Promise<Renderer>>();
/** Whether the tab is hidden behind another, as the extension says: the page cannot tell. */
let tabHidden = false;
function loadRenderer(language: DiagramLanguage): Promise<Renderer> {
  let renderer = renderers.get(language);
  if (!renderer) {
    renderer = createRenderer[language]().catch((error: unknown) => {
      // Let a later render try again.
      renderers.delete(language);
      const name = language === "echarts" ? "ECharts" : "Mermaid";
      throw new Error(
        `Could not load the ${name} renderer: ${errorClause(error)}. ` +
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
  errorElement.textContent = `This ${renderer.noun} failed to render: `;
  // Where the error is, which the message names as "(line 3, column 5)", or as "on line 3":
  // a link to that place in the source, unless the editor holds edits of another diagram.
  const place = editor.showsDiagram()
    ? (/(?<=\()line (\d+), column (\d+)(?=\))/.exec(summary) ??
      /(?<=\bon )line (\d+)(?:, column (\d+))?/.exec(summary))
    : null;
  if (place) {
    const [text, line, column] = place;
    const link = document.createElement("button");
    link.className = "link";
    link.textContent = text;
    link.title = "Show this place in the source";
    link.addEventListener("click", () =>
      editor.reveal(Number(line), column === undefined ? undefined : Number(column)),
    );
    errorElement.append(
      summary.slice(0, place.index),
      link,
      summary.slice(place.index + text.length),
    );
  } else {
    errorElement.append(summary);
  }
  if (details.length > 0) {
    const pre = document.createElement("pre");
    pre.textContent = details.join("\n");
    errorElement.append(pre);
  }
  errorElement.hidden = false;
}

type RenderMessage = Extract<ToWebview, { type: "render" }>;

/** Sets up what clicks and the header's actions do for the diagram, or for none. */
function showActions({
  clickPrompt: prompt,
  links: linked,
  refreshFrom,
  writeTo,
}: Partial<RenderMessage>): void {
  clickPrompt = prompt;
  links = new Map(Object.entries(linked ?? {}));
  canvas.classList.toggle("click-to-ask", clickPrompt !== undefined);
  showRefresh(refreshFrom);
  writeToButton.hidden = writeTo === undefined;
  if (writeTo !== undefined) {
    writeToButton.textContent = `Write to ${writeTo}`;
    writeToButton.title = `Write the diagram as shown into the code block in ${writeTo}`;
  }
  // Apply writes the edits into the block too, which changes a file: say so before it does.
  applyButton.title =
    writeTo === undefined
      ? "Render your version (Ctrl/Cmd+Enter)"
      : `Render your version and write it into the code block in ${writeTo} (Ctrl/Cmd+Enter)`;
}

async function render(message: RenderMessage): Promise<void> {
  forgetDragImage();
  const { language, source, requestId } = message;
  titleElement.textContent = message.title;
  let renderer: Renderer;
  try {
    renderer = await loadRenderer(language);
  } catch (error) {
    // Nothing is drawn, and there is no source to fix: the extension reports the panel unavailable.
    // Nor is there a diagram for the views, the source editor and the actions to act on.
    active?.hide();
    active = undefined;
    current = undefined;
    renderedIdentity = undefined;
    showActions({});
    editor.diagramGone();
    const text = errorMessage(error);
    emptyElement.hidden = true;
    errorElement.textContent = text;
    errorElement.hidden = false;
    post({ type: "renderUnavailable", requestId, message: text });
    diagramReplaced();
    return;
  }
  showActions(message);
  current = { language, renderer, requestId };
  // A different diagram fits the panel again, where a revision keeps the zoom chosen for it.
  const identity = JSON.stringify([language, message.title, message.writeTo]);
  if (identity !== renderedIdentity) renderer.fitToPanel?.();
  renderedIdentity = identity;
  editor.diagramChanged(renderer, source, requestId);
  emptyElement.hidden = true;
  closeLinkMenu();
  // The previous drawing's actions are now stale, and the drawing of another renderer goes: a large
  // one, such as a chart of many thousand items, would slow every measurement that Mermaid makes in
  // the page several times over. That takes the focus from it, so give it back afterwards: to the
  // same node if there is one, or to the chart, which keeps its own focused item.
  const focused = canvas.contains(document.activeElement)
    ? (document.activeElement as HTMLElement | SVGElement)
    : undefined;
  if (active !== renderer) {
    active?.hide();
    active = undefined;
  }
  // Before rendering, which measures the canvas: the first diagram shows the views, which make the
  // header taller.
  updateToolbar();
  canvas.setAttribute("aria-busy", "true");
  errorElement.hidden = true;
  // Only for a slow render: the status line would shift a quick one down and back up, and a chart
  // measured meanwhile would not fit the canvas, as its resize observer may not see the change.
  const statusTimer = setTimeout(() => {
    renderStatus.textContent = `Rendering ${renderer.noun}…`;
  }, 300);
  try {
    if (message.notDrawn !== undefined) throw new Error(message.notDrawn);
    const diagramType = await inertUntil(renderer.render(source, message.title));
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
    renderer.hide();
    active = undefined;
    const text = errorMessage(error);
    showError(renderer, text);
    post({ type: "renderError", requestId, message: text });
  } finally {
    canvas.setAttribute("aria-busy", "false");
    clearTimeout(statusTimer);
    renderStatus.textContent = "";
  }
  // A drawing that replaces the one a pick was asked on is described by its question as well.
  if (pick) describeByPick(drawingFocus(), true);
  // Only while the page has the focus: focus() would take it from wherever the user went meanwhile.
  // The canvas, which a chart does not render inert, keeps it, but takes the keys only for Mermaid;
  // it also has it from a control that the new drawing hid, such as a zoom button.
  const lost = document.activeElement === document.body || document.activeElement === canvas;
  if ((focused || document.activeElement === canvas) && lost && document.hasFocus()) {
    const id = focused?.getAttribute("data-diagram-id");
    const node =
      id && canvas.querySelector<SVGElement>(`[data-diagram-id="${CSS.escape(id)}"][tabindex]`);
    (node || drawingFocus()).focus({ preventScroll: true });
  }
  diagramReplaced();
}

/**
 * Makes the canvas inert until the render settles, as the drawing's actions are stale meanwhile,
 * unless it settled already, as a chart's render does: no click or key can come in between then,
 * and making a drawing inert and back restyles each of its elements, which takes seconds for a
 * chart of a few hundred thousand items.
 */
async function inertUntil<T>(rendering: Promise<T>): Promise<T> {
  let settled = false;
  const settle = () => {
    settled = true;
  };
  rendering.then(settle, settle);
  // After the reactions to a settled promise, which run in the order they were added.
  queueMicrotask(() => {
    canvas.inert = !settled;
  });
  try {
    return await rendering;
  } finally {
    canvas.inert = false;
  }
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
    case "tabVisibility": {
      const shown = tabHidden && !message.hidden;
      tabHidden = message.hidden;
      if (shown) active?.tabShown?.();
      break;
    }
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
      if (message.language === "mermaid") preloadLayout(message.source);
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
    // In the render queue, so that a pick sent with a diagram focuses its drawing, and in order.
    case "startPick":
      enqueue(() => startPick(message.pickId, message.prompt, message.multiple));
      break;
    case "endPick":
      enqueue(() => {
        if (pick?.id === message.pickId) endPick();
      });
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
  focusContent();
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
  if (!pick && !modifier && current) {
    // The drawing clicked, which the host may have replaced while the click was on its way.
    const { requestId } = current;
    if (!hit.node.relationship && links.has(hit.node.id)) {
      post({ type: "clickToOpen", requestId, node: hit.node });
      return;
    }
    if (hit.links) {
      const { targets, anchor } = hit.links;
      const openUrl = (url: string) => post({ type: "openUrl", requestId, url });
      const [only] = targets;
      if (only && targets.length === 1) {
        openUrl(only.url);
      } else {
        showLinkMenu(canvas, anchor, `Links of ${hit.node.label}`, targets, openUrl);
      }
      return;
    }
    if (clickPrompt) {
      post({ type: "clickToAsk", requestId, node: hit.node });
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

// Links in HTML that a chart draws, such as in a tooltip, which even a JSON option can write: VS
// Code opens where a link clicked in the page leads, a vscode: URL among them, without the checks
// that the extension makes of a Mermaid diagram's links. Take the click, which a key also makes,
// before VS Code's listener on the window does, and have the extension open the link. A middle
// click opens nothing, as in VS Code. Mermaid's drawing keeps its links as data-href instead.
const XLINK = "http://www.w3.org/1999/xlink";
for (const type of ["click", "auxclick"] as const) {
  window.addEventListener(
    type,
    (event) => {
      const link = event
        .composedPath()
        .find(
          (target): target is Element =>
            target instanceof Element &&
            (target.localName === "a" || target.localName === "area") &&
            (target.hasAttribute("href") || target.hasAttributeNS(XLINK, "href")),
        );
      if (!link) return;
      event.preventDefault();
      event.stopPropagation();
      const url = (link.getAttribute("href") ?? link.getAttributeNS(XLINK, "href"))?.trim();
      // A link to a place in the page leads nowhere: the page does not scroll.
      if (type === "click" && current && url && !url.startsWith("#")) {
        post({ type: "openUrl", requestId: current.requestId, url });
      }
    },
    { capture: true },
  );
}

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

// VS Code focuses a panel by taking the focus out of the page and giving it back to the page alone,
// a while later, which leaves nothing in it focused (see WebviewElement._doFocus): give the focus
// back to what had it, such as the drawing that a pick revealing the panel just focused.
let lastFocused: HTMLElement | SVGElement | undefined;
document.addEventListener("focusin", ({ target }) => {
  if (target instanceof HTMLElement || target instanceof SVGElement) lastFocused = target;
});
window.addEventListener("focus", () => {
  if (document.activeElement !== document.body || !lastFocused) return;
  lastFocused.focus({ preventScroll: true });
  // What had the focus may have gone while the page had none, e.g. Clear for a new diagram.
  if (document.activeElement === document.body) focusContent();
});

// A control that goes, or is hidden or disabled, while it has the focus, such as Clear or the zoom
// buttons when another diagram comes, leaves the focus on the body, from where Tab starts over at
// the top of the panel: move it to the content instead, unless something else took it meanwhile.
// The drawing, which gets replaced, gives the focus back to its own items as it is drawn.
document.addEventListener("focusout", ({ target, relatedTarget }) => {
  if (relatedTarget || !(target instanceof HTMLElement) || canvas.contains(target)) return;
  queueMicrotask(() => {
    const gone = !target.isConnected || !target.checkVisibility() || target.matches(":disabled");
    if (gone && document.activeElement === document.body && document.hasFocus()) focusContent();
  });
});

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
  // Escape in a field is for the field, e.g. to close a completion or a select's list, and one
  // that a control already took, e.g. to close a menu, is not for the pick either.
  const field = event.target instanceof Element && event.target.matches("input, textarea, select");
  if (event.key === "Escape" && !field && !event.defaultPrevented) {
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
/** The size in characters of a state saved at once, which takes about a millisecond to send. */
const SAVE_AT_ONCE = 100_000;
/** How long typing pauses before a larger state is saved. */
const SAVE_DELAY = 500;
let savedState: State | undefined;
/** A larger state waiting for typing to pause. */
let unsavedState: State | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function saveState(): void {
  const next: State = { draft: askInput.value, sourceSize: split.fraction, ...editor.state() };
  // setState serializes the whole draft and sends it to the host. View and render updates can
  // reach here several times with the same state, including multi-megabyte source edits.
  const last = unsavedState ?? savedState;
  if (
    last?.draft === next.draft &&
    last.sourceSize === next.sourceSize &&
    last.view === next.view &&
    last.editor?.source === next.editor?.source &&
    last.editor?.base === next.editor?.base
  ) {
    return;
  }
  unsavedState = next;
  clearTimeout(saveTimer);
  const size =
    next.draft.length + (next.editor?.source.length ?? 0) + (next.editor?.base.length ?? 0);
  // Sending a source of megabytes, twice with its base, on every key would slow typing down.
  if (size <= SAVE_AT_ONCE) flushState();
  else saveTimer = setTimeout(flushState, SAVE_DELAY);
}
function flushState(): void {
  clearTimeout(saveTimer);
  if (!unsavedState) return;
  vscode.setState(unsavedState);
  savedState = unsavedState;
  unsavedState = undefined;
}
// VS Code takes the last state the page saved when it reloads the page, without warning the page
// first. What reloads it, such as Reload Window or dragging the tab to another window, takes the
// focus out of the page or is a key the page sees first, and the state sent then arrives before.
window.addEventListener("blur", flushState);
window.addEventListener("pagehide", flushState);
document.addEventListener("visibilitychange", flushState);
window.addEventListener(
  "keydown",
  (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || /^F\d+$/.test(event.key)) flushState();
  },
  { capture: true },
);
const restored = vscode.getState();
const saved = isPlainObject(restored) ? restored : {};
askInput.value = typeof saved.draft === "string" ? saved.draft : "";
editor.restore(saved);
split.restore(saved.sourceSize);
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
  const { requestId, renderRequestId, format, forModel, maxSide } = message;
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
      void pngDataUrl(image, maxSide).then(
        (data) => post({ type: "exportImage", requestId, format, data }),
        (error) => failed(forModel ? error : `${errorMessage(error)} Try exporting as SVG.`),
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
// The keys, which the buttons' titles name too, for screen readers to name with the buttons.
const primaryKey = isMac ? "Meta" : "Control";
zoomInButton.setAttribute("aria-keyshortcuts", `${primaryKey}+=`);
zoomOutButton.setAttribute("aria-keyshortcuts", `${primaryKey}+-`);
zoomResetButton.setAttribute("aria-keyshortcuts", `${primaryKey}+0`);
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
