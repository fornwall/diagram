import mermaid from "mermaid";
import type { DiagramNode, FromWebview, ToWebview } from "../protocol";
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
const zoomResetButton = element<HTMLButtonElement>("zoom-reset");
const pickBanner = element("pick");
const pickPrompt = element("pick-prompt");
const pickDoneButton = element<HTMLButtonElement>("pick-done");

let currentSource = "";
let renderCounter = 0;
let zoom = 1;
const selection = new Map<Element, DiagramNode>();
/** When set, a plain click on a node asks about it in chat. */
let clickPrompt: string | undefined;
/** The pick the user is asked to answer by clicking nodes, if any. */
let pick: { id: number; multiple: boolean } | undefined;

// Rendering.

function mermaidTheme(): "dark" | "default" {
  const classes = document.body.classList;
  return classes.contains("vscode-dark") ||
    (classes.contains("vscode-high-contrast") && !classes.contains("vscode-high-contrast-light"))
    ? "dark"
    : "default";
}

function initializeMermaid(): void {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: mermaidTheme(),
    fontFamily: getComputedStyle(document.body).getPropertyValue("--vscode-font-family"),
  });
}

async function render(source: string): Promise<{ diagramType: string }> {
  const id = `diagram-svg-${++renderCounter}`;
  try {
    // Parse first, so that syntax errors do not leave Mermaid's error graphic in the DOM.
    await mermaid.parse(source);
    const { svg, diagramType, bindFunctions } = await mermaid.render(id, source);
    diagram.innerHTML = svg;
    bindFunctions?.(diagram);
    currentSource = source;
    emptyElement.hidden = true;
    errorElement.hidden = true;
    clearSelection();
    return { diagramType };
  } catch (error) {
    // Remove the temporary elements Mermaid leaves behind when rendering fails.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
    throw error;
  }
}

function showError(message: string): void {
  errorElement.textContent = `This diagram failed to render: ${message}`;
  errorElement.hidden = false;
}

function errorMessage(error: unknown): string {
  // Mermaid parse errors are not always Error instances, but carry a message.
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

window.addEventListener("message", async (event: MessageEvent<ToWebview>) => {
  const message = event.data;
  switch (message.type) {
    case "render": {
      titleElement.textContent = message.title;
      clickPrompt = message.clickPrompt;
      diagram.classList.toggle("click-to-ask", clickPrompt !== undefined);
      updateSelectionUi();
      try {
        const { diagramType } = await render(message.source);
        post({ type: "rendered", requestId: message.requestId, diagramType });
      } catch (error) {
        currentSource = message.source;
        showError(errorMessage(error));
        post({ type: "renderError", requestId: message.requestId, message: errorMessage(error) });
      }
      break;
    }
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

// Re-render when the VS Code color theme changes.
new MutationObserver(() => {
  initializeMermaid();
  if (currentSource && errorElement.hidden) {
    render(currentSource).catch((error: unknown) => showError(errorMessage(error)));
  }
}).observe(document.body, { attributes: true, attributeFilter: ["class"] });

// Selection.

const NODE_SELECTOR = [
  "g.node", // flowchart, class, state, ER, mindmap, ...
  "g.actor-man", // sequence diagram actors
  "rect.actor",
  "text.actor",
  "g.mindmap-node",
  "g.eventWrapper", // timeline
  "g.task", // gantt
].join(", ");

function nodeFor(target: Element): { element: Element; node: DiagramNode } | undefined {
  const element = target.closest(NODE_SELECTOR);
  if (!element || !diagram.contains(element)) {
    return undefined;
  }
  // Sequence diagram actors consist of a box and a text that are siblings; select by name.
  const label = (
    element.matches("rect.actor")
      ? element.parentElement?.querySelector("text.actor")?.textContent
      : element.textContent
  )
    ?.replace(/\s+/g, " ")
    .trim();
  const dataId = element.getAttribute("data-id");
  const generatedId = /(?:flowchart|state|classId|entity)-(.+)-\d+$/.exec(element.id)?.[1];
  const id = dataId ?? generatedId ?? label ?? element.id;
  return { element, node: { id, label: label || id } };
}

function updateSelectionUi(): void {
  for (const element of diagram.querySelectorAll(".diagram-selected")) {
    if (!selection.has(element)) {
      element.classList.remove("diagram-selected");
    }
  }
  for (const element of selection.keys()) {
    element.classList.add("diagram-selected");
  }
  const labels = Array.from(selection.values(), (node) => `“${node.label}”`);
  selectionLabel.textContent = labels.length > 0 ? `Selected: ${labels.join(", ")}` : hint();
  clearSelectionButton.hidden = labels.length === 0 || pick !== undefined;
  pickDoneButton.disabled = labels.length === 0;
  askInput.placeholder =
    labels.length > 0 ? "Ask about or change the selection…" : "Ask about or change the diagram…";
}

function hint(): string {
  if (pick) {
    return pick.multiple
      ? "Click nodes to pick them, then press Done."
      : "Click a node to pick it.";
  }
  if (clickPrompt) {
    return "Click a node to ask about it in chat (Ctrl/Cmd+click to select nodes).";
  }
  return "Click nodes to select them (Ctrl/Cmd+click for several).";
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

function toggleSelected(found: { element: Element; node: DiagramNode }): void {
  // Treat nodes with the same id (e.g. an actor shown at the top and bottom) as one.
  const existing = Array.from(selection).find(([, node]) => node.id === found.node.id);
  if (existing) {
    selection.delete(existing[0]);
  } else {
    selection.set(found.element, found.node);
  }
}

diagram.addEventListener("click", (event) => {
  const found = event.target instanceof Element ? nodeFor(event.target) : undefined;
  const modifier = event.ctrlKey || event.metaKey || event.shiftKey;

  if (pick) {
    if (!found) {
      return;
    }
    if (pick.multiple) {
      toggleSelected(found);
      selectionChanged();
    } else {
      selection.clear();
      selection.set(found.element, found.node);
      selectionChanged();
      post({ type: "picked", pickId: pick.id, nodes: [found.node] });
      endPick();
    }
    return;
  }

  if (clickPrompt && found && !modifier) {
    post({ type: "clickToAsk", node: found.node });
    return;
  }

  if (!found) {
    if (!modifier) {
      clearSelection();
    }
    return;
  }
  if (modifier) {
    toggleSelected(found);
  } else {
    const onlyThisSelected =
      selection.size === 1 && Array.from(selection.values())[0]?.id === found.node.id;
    selection.clear();
    if (!onlyThisSelected) {
      selection.set(found.element, found.node);
    }
  }
  selectionChanged();
});

canvas.addEventListener("click", (event) => {
  if (event.target === canvas && !pick) {
    clearSelection();
  }
});

// Picking nodes on request of an agent.

function startPick(id: number, prompt: string, multiple: boolean): void {
  pick = { id, multiple };
  clearSelection();
  pickPrompt.textContent = prompt;
  pickDoneButton.hidden = !multiple;
  pickBanner.hidden = false;
  diagram.classList.add("picking");
  updateSelectionUi();
}

function endPick(): void {
  pick = undefined;
  pickBanner.hidden = true;
  diagram.classList.remove("picking");
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

// Source editing.

element("edit").addEventListener("click", () => {
  sourceInput.value = currentSource;
  editor.hidden = false;
  sourceInput.focus();
});

element("apply").addEventListener("click", () => {
  editor.hidden = true;
  if (sourceInput.value !== currentSource) {
    post({ type: "sourceEdited", source: sourceInput.value });
  }
});

element("cancel").addEventListener("click", () => {
  editor.hidden = true;
});

// Zoom.

function setZoom(value: number): void {
  zoom = Math.min(4, Math.max(0.25, value));
  diagram.style.zoom = String(zoom);
  zoomResetButton.textContent = `${Math.round(zoom * 100)}%`;
}

element("zoom-in").addEventListener("click", () => setZoom(zoom * 1.25));
element("zoom-out").addEventListener("click", () => setZoom(zoom / 1.25));
zoomResetButton.addEventListener("click", () => setZoom(1));
canvas.addEventListener(
  "wheel",
  (event) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      setZoom(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
    }
  },
  { passive: false },
);

initializeMermaid();
post({ type: "ready" });
