import * as vscode from "vscode";
import { mermaidFence } from "./mermaid";
import type { DiagramNode, FromWebview, ToWebview } from "./protocol";

/** Who produced the diagram currently shown: the @diagram participant, or another agent through a tool. */
export type DiagramOrigin = "participant" | "tool";

export type RenderOutcome = { ok: true; diagramType: string } | { ok: false; error: string };

interface DiagramState {
  source: string;
  title: string;
  origin: DiagramOrigin;
  /** Set when the user changed the source in the panel after it was last rendered by an agent. */
  editedByUser: boolean;
  /** The last render error, if the current source fails to render. */
  error?: string;
}

const STATE_KEY = "diagram.state";
const RENDER_TIMEOUT_MS = 15_000;

/**
 * The single interactive diagram panel shared by the @diagram participant and the language model
 * tools. It owns the current diagram and the user's interactions with it.
 */
export class DiagramPanel implements vscode.Disposable {
  static readonly viewType = "diagram.panel";

  private panel: vscode.WebviewPanel | undefined;
  private webviewReady: Promise<void> = Promise.resolve();
  private resolveWebviewReady: () => void = () => {};
  private webviewLoadedBefore = false;
  private state: DiagramState | undefined;
  private selection: DiagramNode[] = [];
  private nextRequestId = 1;
  private readonly pendingRenders = new Map<number, (outcome: RenderOutcome) => void>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.state = context.workspaceState.get<DiagramState>(STATE_KEY);
  }

  get hasDiagram(): boolean {
    return this.state !== undefined;
  }

  /** Renders a diagram produced by an agent, opening the panel if needed. */
  async render(source: string, title: string, origin: DiagramOrigin): Promise<RenderOutcome> {
    this.state = { source, title, origin, editedByUser: false };
    this.selection = [];
    this.reveal();
    return this.renderCurrent();
  }

  /** Shows the panel with the current diagram, if any. */
  show(): void {
    this.reveal();
    if (this.state) {
      void this.renderCurrent();
    }
  }

  /** Takes over a panel restored by VS Code after a reload. */
  restore(panel: vscode.WebviewPanel): void {
    if (this.panel) {
      panel.dispose();
      return;
    }
    this.attach(panel);
    if (this.state) {
      void this.renderCurrent();
    }
  }

  /** Describes the current diagram and the user's interactions with it, for a language model. */
  describeForModel(): string | undefined {
    const state = this.state;
    if (!state) {
      return undefined;
    }
    const lines = [`The diagram currently shown in the diagram panel ("${state.title}"):`, ""];
    lines.push(mermaidFence(state.source), "");
    if (state.error) {
      lines.push(`It currently fails to render with this error: ${state.error}`);
    }
    if (state.editedByUser) {
      lines.push(
        "The user has edited this source by hand since it was last generated. Keep their edits unless asked otherwise.",
      );
    }
    if (this.selection.length > 0) {
      const nodes = this.selection.map((node) => `"${node.label}" (id: ${node.id})`).join(", ");
      lines.push(`The user has selected these nodes in the panel: ${nodes}.`);
    } else {
      lines.push("The user has no nodes selected in the panel.");
    }
    return lines.join("\n");
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private reveal(): void {
    if (this.panel) {
      this.panel.reveal(undefined, true);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      DiagramPanel.viewType,
      "Diagram",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      webviewOptions(this.context.extensionUri),
    );
    this.attach(panel);
  }

  private attach(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    panel.iconPath = new vscode.ThemeIcon("type-hierarchy");
    panel.webview.options = webviewOptions(this.context.extensionUri);
    this.webviewLoadedBefore = false;
    this.webviewReady = new Promise((resolve) => {
      this.resolveWebviewReady = resolve;
    });
    panel.webview.html = webviewHtml(panel.webview, this.context.extensionUri);
    if (this.state) {
      panel.title = this.state.title;
    }

    const messageListener = panel.webview.onDidReceiveMessage((message: FromWebview) =>
      this.onMessage(message),
    );
    panel.onDidDispose(() => {
      messageListener.dispose();
      this.panel = undefined;
      this.selection = [];
      this.resolveWebviewReady();
      for (const resolve of this.pendingRenders.values()) {
        resolve({ ok: false, error: "The diagram panel was closed before the diagram rendered." });
      }
      this.pendingRenders.clear();
    });
  }

  private onMessage(message: FromWebview): void {
    switch (message.type) {
      case "ready":
        this.resolveWebviewReady();
        // The webview lost its content (e.g. it was moved to another window): render again.
        if (this.webviewLoadedBefore && this.state) {
          void this.renderCurrent();
        }
        this.webviewLoadedBefore = true;
        break;
      case "rendered":
        this.pendingRenders.get(message.requestId)?.({
          ok: true,
          diagramType: message.diagramType,
        });
        this.pendingRenders.delete(message.requestId);
        break;
      case "renderError":
        this.pendingRenders.get(message.requestId)?.({ ok: false, error: message.message });
        this.pendingRenders.delete(message.requestId);
        break;
      case "selectionChanged":
        this.selection = message.nodes;
        break;
      case "sourceEdited":
        if (this.state) {
          this.state = { ...this.state, source: message.source, editedByUser: true };
          this.selection = [];
          void this.renderCurrent();
        }
        break;
      case "ask":
        void this.askInChat(message.text, message.nodes);
        break;
    }
  }

  private async renderCurrent(): Promise<RenderOutcome> {
    const state = this.state;
    const panel = this.panel;
    if (!state || !panel) {
      return { ok: false, error: "There is no diagram to render." };
    }
    panel.title = state.title;

    const requestId = this.nextRequestId++;
    const outcome = new Promise<RenderOutcome>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.pendingRenders.delete(requestId)) {
          resolve({ ok: false, error: "Timed out waiting for the diagram panel to render." });
        }
      }, RENDER_TIMEOUT_MS);
      this.pendingRenders.set(requestId, (outcome) => {
        clearTimeout(timeout);
        resolve(outcome);
      });
    });
    await this.webviewReady;
    // The render may have timed out, or the panel closed, while the webview was loading.
    if (this.pendingRenders.has(requestId)) {
      this.post({ type: "render", requestId, source: state.source, title: state.title });
    }
    const result = await outcome;

    // Only record the outcome if the diagram was not replaced while rendering.
    if (this.state?.source === state.source) {
      this.state = { ...this.state, error: result.ok ? undefined : result.error };
      await this.context.workspaceState.update(STATE_KEY, this.state);
    }
    return result;
  }

  /** Sends a request about the diagram to chat, routed to whoever produced the diagram. */
  private async askInChat(text: string, nodes: DiagramNode[]): Promise<void> {
    const about =
      nodes.length > 0
        ? `Regarding ${nodes.map((node) => `"${node.label}"`).join(", ")} in the diagram: `
        : "Regarding the diagram: ";
    const query = this.state?.origin === "tool" ? `${about}${text}` : `@diagram ${about}${text}`;
    await vscode.commands.executeCommand("workbench.action.chat.open", { query });
    this.post({ type: "clearSelection" });
  }

  private post(message: ToWebview): void {
    void this.panel?.webview.postMessage(message);
  }
}

export function webviewOptions(
  extensionUri: vscode.Uri,
): vscode.WebviewPanelOptions & vscode.WebviewOptions {
  return {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
  };
}

function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const asset = (name: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", name));
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  // Mermaid injects <style> elements into the SVGs it generates, hence 'unsafe-inline' for styles.
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset("webview.css")}">
  <title>Diagram</title>
</head>
<body>
  <header>
    <h1 id="title">Diagram</h1>
    <div class="actions">
      <button id="zoom-out" title="Zoom out" aria-label="Zoom out">&minus;</button>
      <button id="zoom-reset" title="Reset zoom">100%</button>
      <button id="zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
      <button id="edit" title="Edit the Mermaid source">Edit source</button>
    </div>
  </header>
  <div id="error" role="alert" hidden></div>
  <section id="editor" hidden>
    <textarea id="source" spellcheck="false" aria-label="Mermaid source"></textarea>
    <div class="actions">
      <button id="apply">Apply</button>
      <button id="cancel" class="secondary">Cancel</button>
    </div>
  </section>
  <main id="canvas">
    <div id="empty">No diagram yet. Ask <code>@diagram</code> in chat to draw one.</div>
    <div id="diagram"></div>
  </main>
  <footer>
    <div id="selection">
      <span id="selection-label">Click nodes to select them (Ctrl/Cmd+click for several).</span>
      <button id="clear-selection" class="link" hidden>Clear</button>
    </div>
    <form id="ask-form">
      <input id="ask-input" type="text" placeholder="Ask about or change the diagram…" aria-label="Message">
      <button type="submit">Send to chat</button>
    </form>
  </footer>
  <script nonce="${nonce}" src="${asset("webview.js")}"></script>
</body>
</html>`;
}
