import {
  type Annotation,
  type DiagramLanguage,
  type DiagramNode,
  errorClause,
  errorMessage,
  type FromWebview,
  type ToWebview,
} from "../protocol";
import { quoteAll } from "../text";
import { AnnotationView } from "./annotationView";
import { toCss } from "./colors";
import { loadECharts } from "./echartsLoader";
import { keepFocusInContent } from "./focus";
import { MODEL_TEXT_SIZE, pngDataUrl, pngScale } from "./images";
import { closeLinkMenu, showLinkMenu } from "./linkMenu";
import { preloadLayout } from "./mermaidLayout";
import { renderWithRecovery } from "./mermaidRecovery";
import { keepPageState, type StateApi } from "./pageState";
import { enablePanning } from "./pan";
import { showRenderError } from "./renderError";
import { type Hit, type Renderer, UNMARKED, WARNINGS_CHANGED, withModifier } from "./renderer";
import { SourceEditor } from "./sourceEditor";
import { enableSplitter } from "./splitter";
import "./style.css";
import { hrefOf } from "./svgImage";
import { readThemeColors } from "./vscodeTheme";
import { enableZoom } from "./zoom";

declare function acquireVsCodeApi(): StateApi & { postMessage(message: unknown): void };

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
const selectionStatus = element("selection");
const selectionLabel = element("selection-label");
const clearSelectionButton = element<HTMLButtonElement>("clear-selection");
const askForm = element<HTMLFormElement>("ask-form");
const askInput = element<HTMLInputElement>("ask-input");
const askSubmit = element<HTMLButtonElement>("ask-submit");
const zoomGroup = element("zoom");
const zoomOutButton = element("zoom-out");
const zoomResetButton = element("zoom-reset");
const zoomInButton = element("zoom-in");
const writeToButton = element<HTMLButtonElement>("write-to");
const applyButton = element<HTMLButtonElement>("apply");
const viewsGroup = element("views");

// Register panning first so it can suppress clicks after a drag.
enablePanning(canvas);
const split = enableSplitter(splitter, panes, element("editor"), saveState);

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
let hasMarks = false;

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
    return new EChartsRenderer(itemClicked, canvas, () => tabHidden);
  },
};
const renderers = new Map<DiagramLanguage, Promise<Renderer>>();
/** Whether the tab is hidden behind another, as the extension says: the page cannot tell. */
let tabHidden = false;
function loadRenderer(language: DiagramLanguage): Promise<Renderer> {
  let renderer = renderers.get(language);
  if (!renderer) {
    renderer = createRenderer[language]().catch((error: unknown) => {
      // Let a later render try again, which loads the ECharts script anew. A module that did not
      // load, such as a chunk of Mermaid when VS Code gave up on reading it after 30 seconds,
      // fails again at once: the browser keeps the failure until the page is loaded anew.
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
const explanations = new AnnotationView(
  canvas,
  panes,
  () => active,
  (frame) => {
    active?.showMarks(frame);
    updateMenuContext();
  },
  () => {
    if (editor.view === "source") editor.setView("split");
  },
  focusContent,
);
/** The render that the drawing shown answered, and the warnings that the extension has of it. */
let warned: { requestId: number; warnings: string } | undefined;
/** How long the warnings of a drawing stay the same before the extension hears of a change. */
const WARNINGS_DELAY = 250;
let warningsTimer: ReturnType<typeof setTimeout> | undefined;
// A drawing laid out again for a new size of the panel, or measured against it, can warn of other
// things than when it was drawn: tell the extension once they settle.
canvas.addEventListener(WARNINGS_CHANGED, () => {
  clearTimeout(warningsTimer);
  warningsTimer = setTimeout(() => {
    if (!active || !warned) return;
    const warnings = active.warnings?.() ?? [];
    const json = JSON.stringify(warnings);
    if (json === warned.warnings) return;
    warned = { requestId: warned.requestId, warnings: json };
    post({ type: "warningsChanged", requestId: warned.requestId, warnings });
  }, WARNINGS_DELAY);
});
/** The last diagram rendered, which its revisions are too. */
let renderedDiagram: number | undefined;

type RenderMessage = Extract<ToWebview, { type: "render" }>;

/** Sets up what clicks and the header's actions do for the diagram, or for none. */
function showActions(
  { clickPrompt: prompt, links: linked, writeTo }: Partial<RenderMessage>,
  noun = "diagram",
): void {
  clickPrompt = prompt;
  links = new Map(Object.entries(linked ?? {}));
  canvas.classList.toggle("click-to-ask", clickPrompt !== undefined);
  showWriteTo(writeTo, noun);
}

/** Names the document that Write to and Apply write the diagram, or chart, to, if any. */
function showWriteTo(writeTo: string | undefined, noun: string): void {
  writeToButton.hidden = writeTo === undefined;
  if (writeTo !== undefined) {
    writeToButton.textContent = `Write to ${writeTo}`;
    writeToButton.title = `Write the ${noun} as shown into the code block in ${writeTo}`;
  }
  // Apply writes the edits into the block too, which changes a file: say so before it does.
  applyButton.title =
    writeTo === undefined
      ? "Render your version (Ctrl/Cmd+Enter)"
      : `Render your version and write it into the code block in ${writeTo} (Ctrl/Cmd+Enter)`;
}

async function render(message: RenderMessage): Promise<void> {
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
    renderedDiagram = undefined;
    showActions({});
    editor.diagramGone();
    const text = errorMessage(error);
    emptyElement.hidden = true;
    errorElement.textContent = text;
    errorElement.hidden = false;
    post({ type: "renderError", requestId, message: text, unavailable: true });
    diagramReplaced();
    return;
  }
  showActions(message, renderer.noun);
  current = { language, renderer, requestId };
  // A different diagram fits the panel again, where a revision keeps the zoom chosen for it.
  const another = renderedDiagram === undefined || message.diagram !== renderedDiagram;
  if (another) renderer.fitToPanel();
  renderedDiagram = message.diagram;
  editor.diagramChanged(renderer, source, requestId, another);
  emptyElement.hidden = true;
  closeLinkMenu();
  // The previous drawing's actions are now stale, and the drawing of another renderer goes: a large
  // one, such as a chart of many thousand items, would slow every measurement that Mermaid makes in
  // the page several times over. That takes the focus from it, so give it back afterwards: to the
  // same node if there is one, or to the chart, which keeps its own focused item.
  const focused = canvas.contains(document.activeElement)
    ? (document.activeElement as HTMLElement | SVGElement)
    : undefined;
  const focusedSelection = selectionStatus.contains(document.activeElement);
  if (active !== renderer) {
    active?.hide();
    active = undefined;
  }
  // Before rendering, which measures the canvas: the first diagram shows the views, which make the
  // header taller, and the new drawing starts without a selection in the footer.
  updateToolbar();
  selectionLabel.textContent = "";
  clearSelectionButton.hidden = true;
  canvas.setAttribute("aria-busy", "true");
  updateMenuContext();
  errorElement.hidden = true;
  // Only for a slow render, over the top of the drawing: a quick one would flash it.
  const statusTimer = setTimeout(() => {
    renderStatus.textContent = `Rendering ${renderer.noun}…`;
  }, 300);
  let answer: Extract<FromWebview, { type: "rendered" }> | undefined;
  try {
    if (message.notDrawn !== undefined) throw new Error(message.notDrawn);
    const { diagramType, repair } = await renderWithRecovery(
      source,
      (text) => inertUntil(renderer.render(text, message.title)),
      language === "mermaid" && message.repairMermaid === true,
    );
    if (repair) editor.diagramChanged(renderer, repair.source, requestId, false);
    active = renderer;
    renderer.showLinks?.(links);
    const drawn = renderer.drawnNodes?.();
    // The ids go along so that the extension host can tell a model when it names a node that is
    // not in the diagram, e.g. in a link or a mark.
    answer = {
      type: "rendered",
      requestId,
      diagramType,
      repair,
      nodeIds: drawn?.filter((node) => !node.relationship).map((node) => node.id),
      nodes:
        drawn && drawn.length <= 10_000 && JSON.stringify(drawn).length <= 1_000_000
          ? drawn.filter((node) => !node.relationship)
          : undefined,
      relationships: drawn?.filter((node) => node.relationship),
      repeatedNames: renderer.repeatedNames?.(),
    };
  } catch (error) {
    // Show only the error, as the title, clicks and the source editor are now for the
    // diagram that failed, which is also the one the extension describes to the model.
    renderer.hide();
    active = undefined;
    warned = undefined;
    const text = errorMessage(error);
    // The places it names link to the source, unless the editor holds edits of another diagram.
    showRenderError(
      errorElement,
      renderer.noun,
      text,
      editor.showsDiagram() ? (line, column) => editor.reveal(line, column) : undefined,
    );
    post({ type: "renderError", requestId, message: text });
  } finally {
    canvas.setAttribute("aria-busy", "false");
    clearTimeout(statusTimer);
    renderStatus.textContent = "";
  }
  try {
    // Only while the page has the focus: focus() would take it from wherever the user went
    // meanwhile. The canvas, which a chart does not render inert, keeps it, but takes the keys
    // only for Mermaid; it also has it from a control that the new drawing hid, such as a zoom
    // button.
    const lost = document.activeElement === document.body || document.activeElement === canvas;
    if (focusedSelection && lost && document.hasFocus()) {
      focusContent();
    } else if ((focused || document.activeElement === canvas) && lost && document.hasFocus()) {
      const id = focused?.getAttribute("data-diagram-id");
      const node =
        id && canvas.querySelector<SVGElement>(`[data-diagram-id="${CSS.escape(id)}"][tabindex]`);
      (node || drawingFocus()).focus({ preventScroll: true });
    }
    diagramReplaced();
    // A revision that keeps its items, such as one that colors them, keeps their selection.
    // In the order selected, which tells the start of a path from its destination.
    // A chart's items are selected by their place in its data, the nodes of a diagram by id.
    const kept = message.selection && active?.drawnNodes?.();
    if (message.selection && active?.hitsOf) {
      for (const { key, node } of active.hitsOf(message.selection)) selection.set(key, node);
    } else if (message.selection && kept) {
      const byId = new Map(kept.map((node) => [node.id, node]));
      for (const id of message.selection) {
        const node = byId.get(id);
        if (node) selection.set(node.id, node);
      }
    }
    if (selection.size > 0) selectionChanged();
  } finally {
    // What the drawing warns of, read once the toolbar and the footer are those of the drawing,
    // and so the room that the panel fits it to, by its height too. A check that fails leaves
    // them unsaid, rather than the render unanswered, which the extension would wait for.
    if (answer) {
      let warnings: string[] | undefined;
      try {
        warnings = active?.warnings?.();
      } catch (error) {
        console.error(error);
      }
      warned = { requestId, warnings: JSON.stringify(warnings ?? []) };
      post({ ...answer, warnings });
    }
  }
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
  zoomGroup.hidden = !active?.zoomBy;
  viewsGroup.hidden = current === undefined;
}
updateToolbar();

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
      if (shown) active?.tabShown();
      break;
    }
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
    case "writeTo": {
      // After the renders sent before, which name the document as it was then.
      const revision = renderRevision;
      enqueue(() => {
        if (revision === renderRevision && current) {
          showWriteTo(message.writeTo, current.renderer.noun);
        }
      });
      break;
    }
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
  const noun = current?.renderer.noun ?? "diagram";
  const labels = Array.from(selection.values(), (node) => `“${node.label}”`);
  selectionLabel.textContent = labels.length > 0 ? `Selected: ${labels.join(", ")}` : "";
  clearSelectionButton.hidden = labels.length === 0;
  updateMenuContext();
  askInput.placeholder =
    labels.length > 0 ? "Ask about or change the selection…" : `Ask about or change the ${noun}…`;
}

function updateMenuContext(): void {
  document.body.dataset.vscodeContext = JSON.stringify({
    "diagram.canClearSelection": selection.size > 0 || hasMarks,
  });
}

function selectionChanged(): void {
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
    if (!modifier) clearSelection();
    return;
  }
  // What a plain click does, in order: open the code the
  // node links to, open the URL that the source links it to (or offer a menu of several), ask the
  // diagram's clickPrompt in chat, or select the node. A modified click always selects, so that
  // every node can be selected whatever else a click does.
  if (!modifier && current) {
    // The drawing clicked, which the host may have replaced while the click was on its way.
    const { requestId } = current;
    if (!hit.node.relationship && links.has(hit.node.id)) {
      post({ type: "clickNode", requestId, node: hit.node });
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
      post({ type: "clickNode", requestId, node: hit.node });
      return;
    }
  }
  // A plain click selects only this item, or deselects it when nothing else is selected.
  if (!modifier && !(selection.size === 1 && selection.has(hit.key))) {
    selection.clear();
  }
  if (!selection.delete(hit.key)) {
    selection.set(hit.key, hit.node);
  }
  selectionChanged();
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
            hrefOf(target) !== null,
        );
      if (!link) return;
      event.preventDefault();
      event.stopPropagation();
      const url = hrefOf(link)?.trim();
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
  hasMarks = next.marks.length > 0 || next.dim;
  explanations.show(next);
}

/** Keeps keyboard navigation in the visible content when a focused action disappears. */
function focusContent(): void {
  editor.content(drawingFocus()).focus();
}

keepFocusInContent(canvas, focusContent);

clearSelectionButton.addEventListener("click", () => {
  const restoreFocus = document.activeElement === clearSelectionButton;
  clearSelection();
  if (restoreFocus) {
    focusContent();
  }
});

// Keep drafts when the webview reloads, e.g. when moved to another window: the message being
// typed, the source editor's share of the split view, and the editor's view and unapplied edits.
const state = keepPageState(vscode, () => ({
  draft: askInput.value,
  sourceSize: split.fraction,
  ...editor.state(),
}));
function saveState(): void {
  state.save();
}
const { restored } = state;
askInput.value = typeof restored.draft === "string" ? restored.draft : "";
// Before the editor, which saves the state as it restores its edits.
split.restore(restored.sourceSize);
editor.restore(restored);
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
    post({
      type: "ask",
      requestId: current?.requestId,
      text,
      nodes: Array.from(selection.values()),
    });
    askInput.value = "";
    updateAskSubmit();
    askInput.focus();
    saveState();
  }
});

writeToButton.addEventListener("click", () => {
  if (current) post({ type: "writeToDocument", requestId: current.requestId });
});

/** Exports the drawing from the render queue, but rasterizes a PNG outside it, not to hold it up. */
async function exportDrawing(message: Extract<ToWebview, { type: "export" }>): Promise<void> {
  const { requestId, renderRequestId, format, forModel, maxSide, maxPixels, ids } = message;
  const failed = (error: unknown) =>
    post({ type: "exportError", requestId, message: errorMessage(error) });
  try {
    if (!active || current?.requestId !== renderRequestId) {
      throw new Error("The diagram changed before it could be exported. Try again.");
    }
    const limits = { maxSide, maxPixels };
    if (forModel && format === "png") {
      const { image, view } = await active.modelImage(imageBackground(), ids ?? []);
      if (ids && ids.length > 0 && view.area === undefined) {
        throw new Error(`Nothing drawn has these ids: ${quoteAll(ids)}.`);
      }
      const { textSize } = view;
      const sized = { ...limits, maxScale: textSize && Math.max(1, MODEL_TEXT_SIZE / textSize) };
      void pngDataUrl(image, sized).then(
        (data) =>
          post({
            type: "exportImage",
            requestId,
            format,
            data,
            view: { ...view, scale: pngScale(image, sized) },
          }),
        failed,
      );
      return;
    }
    const image = await active.toImage(imageBackground());
    if (format === "svg") {
      post({ type: "exportImage", requestId, format, data: image.svg });
    } else {
      void pngDataUrl(image, limits).then(
        (data) => post({ type: "exportImage", requestId, format, data }),
        (error) => failed(`${errorMessage(error)} Try exporting as SVG.`),
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

// Not in the source view, which shows no drawing, nor the buttons, to zoom.
enableZoom({ in: zoomInButton, out: zoomOutButton, reset: zoomResetButton }, () =>
  editor.view === "source" ? undefined : active,
);

post({ type: "ready" });
