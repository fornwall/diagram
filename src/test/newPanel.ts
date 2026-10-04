import * as assert from "node:assert";
import * as vscode from "vscode";
import { DiagramPanel } from "../panel";
import type { FromWebview, ToWebview } from "../protocol";

type Render = Extract<ToWebview, { type: "render" }>;

/** Workspace state that is only kept in the given map. */
export function memento(values: Map<string, unknown>): vscode.Memento {
  return {
    keys: () => [...values.keys()],
    get: <T>(key: string, defaultValue?: T) => (values.get(key) as T | undefined) ?? defaultValue,
    update: async (key, value) => void values.set(key, value),
  };
}

/** A panel of its own, with state that is only saved in the given map or memento. */
export function newPanel(
  state: Map<string, unknown> | vscode.Memento = new Map<string, unknown>(),
): DiagramPanel {
  const extension = vscode.extensions.getExtension("fornwall.diagram");
  assert.ok(extension);
  const workspaceState = state instanceof Map ? memento(state) : state;
  const context = { extensionUri: extension.extensionUri, workspaceState };
  return new DiagramPanel(context as unknown as vscode.ExtensionContext);
}

/**
 * Stands in for the page in a panel's webview: records what the panel posts, and answers as the
 * test says, so that a test drives the panel through its messages alone, without the page's timing.
 */
export class FakeWebview {
  readonly sent: ToWebview[] = [];
  /** Answers each posted message, by default drawing every render; undefined answers nothing. */
  answer: ((message: ToWebview) => FromWebview | undefined) | undefined = (message) =>
    message.type === "render"
      ? { type: "rendered", requestId: message.requestId, diagramType: "test" }
      : undefined;
  /** Whether a posted message reaches the page, as postMessage resolves. */
  deliver: (message: ToWebview) => boolean | Promise<boolean> = () => true;
  readonly panel: vscode.WebviewPanel;
  private readonly listeners = new Set<(message: unknown) => unknown>();
  private readonly disposeListeners = new Set<() => void>();
  private disposed = false;
  private onNextRender: ((render: Render) => unknown) | undefined;

  constructor() {
    const subscribe =
      <Listener>(listeners: Set<Listener>) =>
      (listener: Listener): vscode.Disposable => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      };
    const webview = {
      html: "",
      options: {},
      cspSource: "vscode-resource:",
      asWebviewUri: (uri: vscode.Uri) => uri,
      onDidReceiveMessage: subscribe(this.listeners),
      postMessage: async (message: ToWebview) => {
        this.sent.push(message);
        if (!(await this.deliver(message))) return false;
        const next = this.onNextRender;
        if (message.type === "render" && next) {
          this.onNextRender = undefined;
          // Asynchronously, as the page answers.
          queueMicrotask(() => void next(message));
          return true;
        }
        const answer = this.answer?.(message);
        if (answer) queueMicrotask(() => void this.receive(answer));
        return true;
      },
    };
    this.panel = {
      viewType: DiagramPanel.viewType,
      title: "Diagram",
      webview,
      options: {},
      viewColumn: vscode.ViewColumn.One,
      active: true,
      visible: true,
      reveal: () => {},
      onDidChangeViewState: subscribe(new Set()),
      onDidDispose: subscribe(this.disposeListeners),
      dispose: () => {
        if (this.disposed) return;
        this.disposed = true;
        for (const listener of this.disposeListeners) listener();
      },
    } as unknown as vscode.WebviewPanel;
  }

  /** Sends a message from the page, and waits for the work the panel starts on it. */
  async receive(message: FromWebview): Promise<void> {
    await Promise.all([...this.listeners].map((listener) => listener(message)));
  }

  /** Handles the next render delivered instead of {@link answer}, e.g. to fail it. */
  nextRender(handle: (render: Render) => unknown): void {
    this.onNextRender = handle;
  }

  /** The latest render request, which identifies the source the page shows. */
  get render(): Render {
    const render = this.sent.findLast((message) => message.type === "render");
    assert.ok(render, "The panel posted no render.");
    return render;
  }

  /** Answers the latest render, as drawn or failing with the error. */
  finishRender(error?: string): Promise<void> {
    const { requestId } = this.render;
    return this.receive(
      error === undefined
        ? { type: "rendered", requestId, diagramType: "test" }
        : { type: "renderError", requestId, message: error },
    );
  }
}

/** Shows the panel in a fake webview that is ready, with any diagram it has drawn. */
export async function showInFake(panel: DiagramPanel): Promise<FakeWebview> {
  const webview = new FakeWebview();
  panel.restore(webview.panel);
  await webview.receive({ type: "ready" });
  // The answers to its render use no I/O, so they are in by the next task.
  await new Promise((resolve) => setImmediate(resolve));
  return webview;
}

/** A new panel shown in a fake webview: see {@link FakeWebview}. */
export async function newFakePanel(
  state?: Map<string, unknown> | vscode.Memento,
): Promise<{ panel: DiagramPanel; webview: FakeWebview }> {
  const panel = newPanel(state);
  return { panel, webview: await showInFake(panel) };
}

/** Shows the panel, returning the webview panel that it opens. */
export function openWebviewPanel(panel: DiagramPanel, preserveFocus = false): vscode.WebviewPanel {
  const create = vscode.window.createWebviewPanel;
  let opened: vscode.WebviewPanel | undefined;
  vscode.window.createWebviewPanel = (...args) => {
    opened = create(...args);
    return opened;
  };
  try {
    panel.show(preserveFocus);
  } finally {
    vscode.window.createWebviewPanel = create;
  }
  assert.ok(opened, "The panel was already open.");
  return opened;
}
