import * as vscode from "vscode";
import { diagramFence } from "./blocks";
import type { ChartSpec } from "./chartSpec";
import { buildChartOption } from "./charts";
import { loadTable } from "./dataSource";
import {
  DIAGRAM_LANGUAGES,
  type DiagramLanguage,
  type DiagramNode,
  type FromWebview,
  type ToWebview,
} from "./protocol";

/** Who produced the diagram currently shown: the @diagram participant, or another agent through a tool. */
export type DiagramOrigin = "participant" | "tool";

export type RenderOutcome = { ok: true; diagramType: string } | { ok: false; error: string };

export type PickOutcome =
  | { picked: true; nodes: DiagramNode[] }
  | { picked: false; reason: string };

interface PendingPick {
  id: number;
  prompt: string;
  multiple: boolean;
  resolve: (outcome: PickOutcome) => void;
}

/** A diagram to show, as produced by an agent. */
export interface Diagram {
  language: DiagramLanguage;
  source: string;
  title: string;
  /** When set, a plain click on a node sends this request to chat; see {@link clickToAskQuery}. */
  clickPrompt?: string;
  /** For a chart of data from a file or command: how to load the data and draw it again. */
  chart?: ChartSpec;
}

interface DiagramState extends Diagram {
  origin: DiagramOrigin;
  /** Set when the user changed the source in the panel after it was last rendered by an agent. */
  editedByUser: boolean;
  /** The last render error, if the current source fails to render. */
  error?: string;
}

const STATE_KEY = "diagram.state";
/** Longer diagram sources are left out of the description for the model. */
const MAX_SOURCE_FOR_MODEL = 30_000;
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
  private pendingPick: PendingPick | undefined;

  /** Counts the diagrams rendered by agents, to tell whether a request rendered one. */
  private renders = 0;
  private refreshing = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    const state = context.workspaceState.get<DiagramState>(STATE_KEY);
    // State saved before charts were supported has no language.
    this.state = state && {
      ...state,
      language: DIAGRAM_LANGUAGES.includes(state.language) ? state.language : "mermaid",
    };
  }

  get hasDiagram(): boolean {
    return this.state !== undefined;
  }

  /** How many diagrams agents have rendered so far. */
  get renderCount(): number {
    return this.renders;
  }

  /** The diagram currently shown, if any. */
  get current(): Diagram | undefined {
    return this.state;
  }

  /** Renders a diagram produced by an agent, opening the panel if needed. */
  async render(diagram: Diagram, origin: DiagramOrigin): Promise<RenderOutcome> {
    this.renders++;
    this.state = { ...diagram, origin, editedByUser: false };
    this.selection = [];
    this.reveal();
    return this.renderCurrent();
  }

  /** Records who produced the current diagram, which decides where requests about it go. */
  setOrigin(origin: DiagramOrigin): void {
    if (this.state) {
      this.state = { ...this.state, origin };
      void this.context.workspaceState.update(STATE_KEY, this.state);
    }
  }

  /** Shows the panel with the current diagram, if any. */
  show(): void {
    this.reveal();
    if (this.state) {
      void this.renderCurrent();
    }
  }

  /**
   * Asks the user to click nodes in the current diagram, and waits until they do, cancel, or the
   * token is cancelled. A new pick ends any pick that is still waiting.
   */
  async pickNodes(
    prompt: string,
    multiple: boolean,
    token: vscode.CancellationToken,
  ): Promise<PickOutcome> {
    if (!this.state) {
      return { picked: false, reason: "There is no diagram to pick from." };
    }
    if (this.pendingPick) {
      this.finishPick(this.pendingPick.id, {
        picked: false,
        reason: "Another request to pick nodes replaced this one.",
      });
    }
    if (!this.panel) {
      this.reveal();
      void this.renderCurrent();
    } else {
      this.panel.reveal(undefined, true);
    }

    const id = this.nextRequestId++;
    const outcome = new Promise<PickOutcome>((resolve) => {
      const cancellation = token.onCancellationRequested(() =>
        this.finishPick(id, { picked: false, reason: "The request was cancelled." }),
      );
      this.pendingPick = {
        id,
        prompt,
        multiple,
        resolve: (outcome) => {
          cancellation.dispose();
          resolve(outcome);
        },
      };
    });
    await this.webviewReady;
    if (this.pendingPick?.id === id) {
      this.post({ type: "startPick", pickId: id, prompt, multiple });
    }
    return outcome;
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
    const what =
      state.language === "echarts" ? "chart, as an Apache ECharts option," : "Mermaid diagram";
    const lines = [`The ${what} currently shown in the diagram panel ("${state.title}"):`, ""];
    // A chart of a large file or command output can be too large for the model's context.
    if (state.source.length <= MAX_SOURCE_FOR_MODEL) {
      lines.push(diagramFence(state), "");
    } else {
      lines.push(
        `(The source is ${state.source.length} characters long, too long to show here.)`,
        "",
      );
    }
    if (state.chart) {
      const from = state.chart.file
        ? `file ${state.chart.file}`
        : `command \`${state.chart.command}\``;
      lines.push(
        `It was drawn with diagram_chart from ${from}, with these parameters: ${JSON.stringify(state.chart)}. The user can reload the data with Refresh. To change the chart, call diagram_chart again rather than editing the generated option.`,
      );
    }
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
      if (this.pendingPick) {
        this.finishPick(this.pendingPick.id, {
          picked: false,
          reason: "The user closed the diagram panel.",
        });
      }
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
          if (this.pendingPick) {
            const { id, prompt, multiple } = this.pendingPick;
            this.post({ type: "startPick", pickId: id, prompt, multiple });
          }
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
      case "refresh":
        void this.refreshChart();
        break;
      case "ask":
        void this.askInChat(`${regarding(message.nodes)}${message.text}`);
        break;
      case "clickToAsk":
        if (this.state?.clickPrompt) {
          void this.askInChat(clickToAskQuery(this.state.clickPrompt, message.node.label));
        }
        break;
      case "picked":
        this.finishPick(message.pickId, { picked: true, nodes: message.nodes });
        break;
      case "pickCancelled":
        this.finishPick(message.pickId, {
          picked: false,
          reason: "The user cancelled without picking a node.",
        });
        break;
    }
  }

  private finishPick(id: number, outcome: PickOutcome): void {
    if (this.pendingPick?.id !== id) {
      return;
    }
    const { resolve } = this.pendingPick;
    this.pendingPick = undefined;
    this.post({ type: "endPick", pickId: id });
    resolve(outcome);
  }

  /** Loads the data of the current chart again and redraws it, replacing manual edits. */
  private async refreshChart(): Promise<void> {
    const chart = this.state?.chart;
    if (!chart || this.refreshing) {
      return;
    }
    this.refreshing = true;
    const rendersBefore = this.renders;
    const cancellation = new vscode.CancellationTokenSource();
    try {
      const { table } = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Refreshing chart" },
        () => loadTable(chart, cancellation.token),
      );
      // An agent may have replaced the chart while its data was loading.
      if (!this.state || this.renders !== rendersBefore) {
        return;
      }
      const source = JSON.stringify(buildChartOption(chart, table), null, 2);
      this.state = { ...this.state, source, editedByUser: false };
      this.selection = [];
      await this.renderCurrent();
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Could not refresh the chart: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.refreshing = false;
      cancellation.dispose();
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
      this.post({
        type: "render",
        requestId,
        language: state.language,
        source: state.source,
        title: state.title,
        clickPrompt: state.clickPrompt,
        refreshable: state.chart !== undefined,
      });
    }
    const result = await outcome;

    // Only record the outcome if the diagram was not replaced while rendering.
    if (this.state?.source === state.source && this.state.language === state.language) {
      this.state = { ...this.state, error: result.ok ? undefined : result.error };
      await this.context.workspaceState.update(STATE_KEY, this.state);
    }
    return result;
  }

  /** Sends a request about the diagram to chat, routed to whoever produced the diagram. */
  private async askInChat(text: string): Promise<void> {
    const query = this.state?.origin === "tool" ? text : `@diagram ${text}`;
    await vscode.commands.executeCommand("workbench.action.chat.open", { query });
    this.post({ type: "clearSelection" });
  }

  private post(message: ToWebview): void {
    void this.panel?.webview.postMessage(message);
  }
}

function regarding(nodes: DiagramNode[]): string {
  return nodes.length > 0
    ? `Regarding ${nodes.map((node) => `"${node.label}"`).join(", ")} in the diagram: `
    : "Regarding the diagram: ";
}

/**
 * Builds the chat request sent when a node is clicked in click-to-ask mode: `{label}` in the prompt
 * is replaced by the node's label, which is otherwise appended.
 */
export function clickToAskQuery(clickPrompt: string, label: string): string {
  return clickPrompt.includes("{label}")
    ? clickPrompt.replaceAll("{label}", label)
    : `${clickPrompt} "${label}"`;
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
  // Mermaid injects <style> elements into the SVGs it generates, and ECharts styles its tooltips
  // inline, hence 'unsafe-inline' for styles.
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
      <button id="refresh" title="Load the chart's data again" hidden>Refresh</button>
      <button id="edit" title="Edit the Mermaid source">Edit source</button>
    </div>
  </header>
  <div id="pick" role="status" hidden>
    <span id="pick-prompt"></span>
    <div class="actions">
      <button id="pick-done" hidden>Done</button>
      <button id="pick-cancel" class="secondary">Cancel</button>
    </div>
  </div>
  <div id="error" role="alert" hidden></div>
  <section id="editor" hidden>
    <textarea id="source" spellcheck="false" aria-label="Diagram source"></textarea>
    <div class="actions">
      <button id="apply">Apply</button>
      <button id="cancel" class="secondary">Cancel</button>
    </div>
  </section>
  <main id="canvas">
    <div id="empty">No diagram yet. Ask <code>@diagram</code> in chat to draw a diagram or chart.</div>
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
  <script type="module" nonce="${nonce}" src="${asset("webview.js")}"></script>
</body>
</html>`;
}
