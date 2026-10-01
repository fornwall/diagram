import * as vscode from "vscode";
import { codeFence } from "./blocks";
import type { ChartSpec } from "./chartSpec";
import { buildChart } from "./charts";
import { loadTable } from "./dataSource";
import {
  CHART_TOOL,
  type DiagramLanguage,
  type DiagramNode,
  diagramNoun,
  errorMessage,
  type FromWebview,
  RENDER_TOOL,
  type ToWebview,
} from "./protocol";

/** Who produced the diagram currently shown: the @diagram participant, or another agent through a tool. */
export type DiagramOrigin = "participant" | "tool";

/**
 * A render fails as "invalid" when the source has an error, and as "unavailable" when the panel
 * was closed or did not respond, which says nothing about the source.
 */
export type RenderOutcome =
  | { ok: true; diagramType: string }
  | { ok: false; kind: "invalid" | "unavailable"; error: string };

export type PickOutcome =
  | { picked: true; nodes: DiagramNode[] }
  | { picked: false; reason: string };

type RenderMessage = Extract<ToWebview, { type: "render" }>;

interface PendingRender {
  message: RenderMessage;
  resolve: (outcome: RenderOutcome) => void;
}

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

  /** How many diagrams agents have rendered, to tell whether a request rendered one. */
  renderCount = 0;

  private panel: vscode.WebviewPanel | undefined;
  private webviewReady: Promise<void> = Promise.resolve();
  private resolveWebviewReady: () => void = () => {};
  private webviewLoadedBefore = false;
  private state: DiagramState | undefined;
  private selection: DiagramNode[] = [];
  private nextRequestId = 1;
  private readonly pendingRenders = new Map<number, PendingRender>();
  private pendingPick: PendingPick | undefined;
  private refreshing = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    const state = context.workspaceState.get<DiagramState>(STATE_KEY);
    // State saved before charts were supported has no language.
    this.state = state && { ...state, language: state.language ?? "mermaid" };
  }

  /** The diagram currently shown, if any. */
  get current(): Diagram | undefined {
    return this.state;
  }

  /** Renders a diagram produced by an agent, opening the panel if needed. */
  async render(diagram: Diagram, origin: DiagramOrigin): Promise<RenderOutcome> {
    this.renderCount++;
    this.state = { ...diagram, origin, editedByUser: false };
    this.selection = [];
    this.cancelPick("The diagram was replaced before the user picked.");
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

  /** Shows the panel, opening it with the current diagram if it was closed. */
  show(): void {
    if (this.reveal() && this.state) {
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
    const state = this.state;
    if (!state) {
      return {
        picked: false,
        reason: `There is no diagram to pick from. Render one with ${RENDER_TOOL} or ${CHART_TOOL} first.`,
      };
    }
    if (state.error) {
      const noun = diagramNoun(state.language);
      return {
        picked: false,
        reason: `The ${noun} fails to render, so there is nothing to pick from. Render a working ${noun} first. The error is: ${state.error}`,
      };
    }
    this.cancelPick("Another request to pick nodes replaced this one.");
    this.show();

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
      lines.push(codeFence(state.source, state.language), "");
    } else {
      lines.push(
        `(The source is ${state.source.length} characters long, too long to show here.)`,
        "",
      );
    }
    if (state.chart) {
      lines.push(
        `It was drawn with ${CHART_TOOL} from ${dataOrigin(state.chart)}, with these parameters: ${JSON.stringify(state.chart)}. The user can reload the data with Refresh. To change the chart, call ${CHART_TOOL} again rather than editing the generated option.`,
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

  /** Reveals the panel, or creates it, in which case this returns true. */
  private reveal(): boolean {
    if (this.panel) {
      this.panel.reveal(undefined, true);
      return false;
    }
    const panel = vscode.window.createWebviewPanel(
      DiagramPanel.viewType,
      "Diagram",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      webviewOptions(this.context.extensionUri),
    );
    this.attach(panel);
    return true;
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
      this.cancelPick("The user closed the diagram panel.");
      for (const requestId of this.pendingRenders.keys()) {
        this.finishRender(requestId, {
          ok: false,
          kind: "unavailable",
          error: "The diagram panel was closed before it finished rendering.",
        });
      }
    });
  }

  private onMessage(message: FromWebview): void {
    switch (message.type) {
      case "ready":
        this.resolveWebviewReady();
        // The webview lost its content (e.g. it was moved to another window): render again,
        // under the original request ids so that pending renders are answered.
        if (this.webviewLoadedBefore) {
          if (this.pendingRenders.size > 0) {
            for (const pending of this.pendingRenders.values()) {
              this.post(pending.message);
            }
          } else if (this.state) {
            void this.renderCurrent();
          }
          if (this.pendingPick) {
            const { id, prompt, multiple } = this.pendingPick;
            this.post({ type: "startPick", pickId: id, prompt, multiple });
          }
        }
        this.webviewLoadedBefore = true;
        break;
      case "rendered":
        this.finishRender(message.requestId, { ok: true, diagramType: message.diagramType });
        break;
      case "renderError":
        this.finishRender(message.requestId, {
          ok: false,
          kind: "invalid",
          error: message.message,
        });
        break;
      case "selectionChanged":
        this.selection = message.nodes;
        break;
      case "sourceEdited":
        if (this.state) {
          this.state = { ...this.state, source: message.source, editedByUser: true };
          this.selection = [];
          this.cancelPick("The user edited the diagram source instead of picking.");
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

  private finishRender(requestId: number, outcome: RenderOutcome): void {
    this.pendingRenders.get(requestId)?.resolve(outcome);
    this.pendingRenders.delete(requestId);
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

  private cancelPick(reason: string): void {
    if (this.pendingPick) {
      this.finishPick(this.pendingPick.id, { picked: false, reason });
    }
  }

  /** Loads the data of the current chart again and redraws it, replacing manual edits. */
  private async refreshChart(): Promise<void> {
    const chart = this.state?.chart;
    if (!chart || this.refreshing) {
      return;
    }
    this.refreshing = true;
    const rendersBefore = this.renderCount;
    try {
      const { table, warning } = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Refreshing chart" },
        (_progress, token) => loadTable(chart, token),
      );
      // An agent may have replaced the chart while its data was loading.
      if (!this.state || this.renderCount !== rendersBefore) {
        return;
      }
      const source = JSON.stringify(buildChart(chart, table).option, null, 2);
      this.state = { ...this.state, source, editedByUser: false };
      this.selection = [];
      if (warning) {
        void vscode.window.showWarningMessage(warning);
      }
      await this.renderCurrent();
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not refresh the chart: ${errorMessage(error)}`);
    } finally {
      this.refreshing = false;
    }
  }

  private async renderCurrent(): Promise<RenderOutcome> {
    const state = this.state;
    if (!state || !this.panel) {
      return { ok: false, kind: "unavailable", error: "There is no diagram panel to render in." };
    }
    this.panel.title = state.title;

    const message: RenderMessage = {
      type: "render",
      requestId: this.nextRequestId++,
      language: state.language,
      source: state.source,
      title: state.title,
      clickPrompt: state.clickPrompt,
      refreshFrom: state.chart && dataOrigin(state.chart),
    };
    const outcome = new Promise<RenderOutcome>((resolve) => {
      const timeout = setTimeout(
        () =>
          this.finishRender(message.requestId, {
            ok: false,
            kind: "unavailable",
            error: `The diagram panel did not respond within ${RENDER_TIMEOUT_MS / 1000} seconds.`,
          }),
        RENDER_TIMEOUT_MS,
      );
      this.pendingRenders.set(message.requestId, {
        message,
        resolve: (outcome) => {
          clearTimeout(timeout);
          resolve(outcome);
        },
      });
    });
    await this.webviewReady;
    // The render may have timed out, or the panel closed, while the webview was loading.
    if (this.pendingRenders.has(message.requestId)) {
      this.post(message);
    }
    const result = await outcome;

    // An unavailable panel says nothing about the source, and the diagram may have been replaced
    // while rendering.
    const latest = this.state;
    const replaced = latest?.source !== state.source || latest.language !== state.language;
    if (latest && !replaced && (result.ok || result.kind === "invalid")) {
      this.state = { ...latest, error: result.ok ? undefined : result.error };
    }
    await this.context.workspaceState.update(STATE_KEY, this.state);
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

/** Where a chart's data comes from, e.g. "file sales.csv" or "command `du -s *`". */
function dataOrigin({ file, command }: ChartSpec): string {
  return file ? `file ${file}` : `command \`${command}\``;
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
      <button id="refresh" hidden>Refresh</button>
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
