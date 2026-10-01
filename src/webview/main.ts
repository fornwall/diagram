import {
  type DiagramLanguage,
  type DiagramNode,
  errorMessage,
  type FromWebview,
  type ToWebview,
} from "../protocol";
import { EChartsRenderer } from "./echartsRenderer";
import { MermaidRenderer } from "./mermaidRenderer";
import type { Hit, Renderer, RendererHost } from "./renderer";
import "./style.css";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

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
const canvas = element("canvas");
const diagram = element("diagram");
const editor = element("editor");
const sourceInput = element<HTMLTextAreaElement>("source");
const selectionLabel = element("selection-label");
const clearSelectionButton = element<HTMLButtonElement>("clear-selection");
const askForm = element<HTMLFormElement>("ask-form");
const askInput = element<HTMLInputElement>("ask-input");
const zoomButtons = ["zoom-out", "zoom-reset", "zoom-in"].map((id) => element(id));
const zoomResetButton = element<HTMLButtonElement>("zoom-reset");
const refreshButton = element<HTMLButtonElement>("refresh");
const editButton = element<HTMLButtonElement>("edit");
const pickBanner = element("pick");
const pickPrompt = element("pick-prompt");
const pickDoneButton = element<HTMLButtonElement>("pick-done");

/** The last diagram the extension asked to render, whether or not it rendered. */
let current: { renderer: Renderer; source: string } | undefined;
/** The source shown in the editor when it was opened. */
let editedFrom = "";
/** Selected nodes or chart items, by renderer key. */
const selection = new Map<string, DiagramNode>();
/** When set, a plain click on a node asks about it in chat. */
let clickPrompt: string | undefined;
/** The pick the user is asked to answer by clicking nodes, if any. */
let pick: { id: number; multiple: boolean } | undefined;

// Rendering.

const host: RendererHost = { itemClicked };
const renderers: Record<DiagramLanguage, Renderer> = {
  mermaid: new MermaidRenderer(host, canvas, diagram, zoomResetButton),
  echarts: new EChartsRenderer(host, canvas),
};
/** The renderer whose rendering is shown, once anything rendered. */
let active: Renderer | undefined;

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

function updateLanguageUi(renderer: Renderer): void {
  editButton.title = `Edit the ${renderer.sourceName}`;
  sourceInput.setAttribute("aria-label", renderer.sourceName);
  const zoomable = (active ?? renderer).zoomBy !== undefined;
  for (const button of zoomButtons) {
    button.hidden = !zoomable;
  }
}

async function render(message: Extract<ToWebview, { type: "render" }>): Promise<void> {
  const { language, source, requestId } = message;
  titleElement.textContent = message.title;
  clickPrompt = message.clickPrompt;
  canvas.classList.toggle("click-to-ask", clickPrompt !== undefined);
  refreshButton.hidden = !message.refreshable;
  const renderer = renderers[language] as Renderer | undefined;
  if (!renderer) {
    post({ type: "renderError", requestId, message: `Unknown diagram language "${language}".` });
    return;
  }
  const changed = current?.source !== source;
  current = { renderer, source };
  if (changed) {
    sourceChanged();
  }
  const previous = active;
  try {
    const diagramType = await renderer.render(source, message.title);
    if (previous !== renderer) {
      previous?.hide();
    }
    active = renderer;
    emptyElement.hidden = true;
    errorElement.hidden = true;
    clearSelection();
    post({ type: "rendered", requestId, diagramType });
  } catch (error) {
    if (renderer !== previous) {
      renderer.hide();
    }
    const text = errorMessage(error);
    showError(renderer, text);
    post({ type: "renderError", requestId, message: text });
  }
  updateLanguageUi(renderer);
  updateSelectionUi();
}

// Renders one at a time, in order, so that a slow render cannot overtake a later one.
let queue = Promise.resolve();
function enqueue(task: () => Promise<void>): void {
  queue = queue.then(task).catch((error: unknown) => console.error(error));
}

window.addEventListener("message", (event: MessageEvent<ToWebview>) => {
  const message = event.data;
  switch (message.type) {
    case "render":
      enqueue(() => render(message));
      break;
    case "clearSelection":
      clearSelection();
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
  pickDoneButton.disabled = labels.length === 0;
  askInput.placeholder =
    labels.length > 0 ? "Ask about or change the selection…" : `Ask about or change the ${noun}…`;
}

function hint(noun: string): string {
  if (pick) {
    return pick.multiple
      ? `Click ${noun}s to pick them, then press Done.`
      : `Click a ${noun} to pick it.`;
  }
  if (clickPrompt) {
    return `Click a ${noun} to ask about it in chat (Ctrl/Cmd+click to select ${noun}s).`;
  }
  return `Click ${noun}s to select them (Ctrl/Cmd+click for several).`;
}

function selectionChanged(): void {
  updateSelectionUi();
  post({ type: "selectionChanged", nodes: Array.from(selection.values()) });
}

function clearSelection(): void {
  if (selection.size > 0) {
    selection.clear();
    selectionChanged();
  }
}

function toggleSelected(hit: Hit): void {
  if (selection.has(hit.key)) {
    selection.delete(hit.key);
  } else {
    selection.set(hit.key, hit.node);
  }
}

function itemClicked(hit: Hit | undefined, modifier: boolean): void {
  if (pick) {
    if (!hit) {
      return;
    }
    if (pick.multiple) {
      toggleSelected(hit);
      selectionChanged();
    } else {
      selection.clear();
      selection.set(hit.key, hit.node);
      selectionChanged();
      post({ type: "picked", pickId: pick.id, nodes: [hit.node] });
      endPick();
    }
    return;
  }

  if (clickPrompt && hit && !modifier) {
    post({ type: "clickToAsk", node: hit.node });
    return;
  }

  if (!hit) {
    if (!modifier) {
      clearSelection();
    }
    return;
  }
  if (modifier) {
    toggleSelected(hit);
  } else {
    const onlyThisSelected = selection.size === 1 && selection.has(hit.key);
    selection.clear();
    if (!onlyThisSelected) {
      selection.set(hit.key, hit.node);
    }
  }
  selectionChanged();
}

canvas.addEventListener("click", (event) => {
  if (event.target === canvas) {
    itemClicked(undefined, event.ctrlKey || event.metaKey || event.shiftKey);
  }
});

// Picking nodes on request of an agent.

function startPick(id: number, prompt: string, multiple: boolean): void {
  pick = { id, multiple };
  clearSelection();
  pickPrompt.textContent = prompt;
  pickDoneButton.hidden = !multiple;
  pickBanner.hidden = false;
  canvas.classList.add("picking");
  updateSelectionUi();
}

function endPick(): void {
  pick = undefined;
  pickBanner.hidden = true;
  canvas.classList.remove("picking");
  updateSelectionUi();
}

pickDoneButton.addEventListener("click", () => {
  if (pick && selection.size > 0) {
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
  if (event.key === "Escape") {
    cancelPick();
  }
});

clearSelectionButton.addEventListener("click", clearSelection);

askForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = askInput.value.trim();
  if (text) {
    post({ type: "ask", text, nodes: Array.from(selection.values()) });
    askInput.value = "";
  }
});

refreshButton.addEventListener("click", () => post({ type: "refresh" }));

// Source editing.

const staleNote = document.createElement("p");
staleNote.className = "note";
staleNote.textContent =
  "The diagram changed since you started editing. Apply replaces it with your version.";
staleNote.hidden = true;
sourceInput.after(staleNote);

function openEditor(): void {
  editedFrom = current ? current.renderer.formatForEditing(current.source) : "";
  sourceInput.value = editedFrom;
  staleNote.hidden = true;
  editor.hidden = false;
}

/** Keeps an open editor from silently replacing a diagram that changed while editing. */
function sourceChanged(): void {
  if (editor.hidden) {
    return;
  }
  if (sourceInput.value === editedFrom) {
    openEditor();
  } else {
    staleNote.hidden = false;
  }
}

editButton.addEventListener("click", () => {
  openEditor();
  sourceInput.focus();
});

element("apply").addEventListener("click", () => {
  editor.hidden = true;
  if (sourceInput.value !== editedFrom) {
    post({ type: "sourceEdited", source: sourceInput.value });
  }
});

element("cancel").addEventListener("click", () => {
  editor.hidden = true;
});

// Zoom (Mermaid only; charts fit the panel).

element("zoom-in").addEventListener("click", () => active?.zoomBy?.(1.25));
element("zoom-out").addEventListener("click", () => active?.zoomBy?.(1 / 1.25));
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
