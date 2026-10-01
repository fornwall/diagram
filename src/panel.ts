import * as vscode from "vscode";
import { type ChartSpec, dataOrigin } from "./chartSpec";
import { buildChart } from "./charts";
import { loadTable } from "./dataSource";
import { describeDiagram } from "./describe";
import {
  CHART_TOOL,
  type DiagramLanguage,
  type DiagramNode,
  diagramNoun,
  errorMessage,
  type FromWebview,
  isFromWebview,
  isPlainObject,
  RENDER_TOOL,
  type ToWebview,
} from "./protocol";
import { loadWebview } from "./webviewHtml";

/** Who produced the diagram currently shown: the @diagram participant, or another agent through a tool. */
type DiagramOrigin = "participant" | "tool";

/**
 * A render fails as "invalid" when the source has an error, and as "unavailable" when the panel
 * was closed or did not respond, which says nothing about the source.
 */
export type RenderOutcome =
  | { ok: true; diagramType: string }
  | { ok: false; kind: "invalid" | "unavailable"; error: string };

type PickOutcome = { picked: true; nodes: DiagramNode[] } | { picked: false; reason: string };

/** A request to the webview awaiting its answer, sent again if the webview reloads. */
interface Pending<Type extends ToWebview["type"], Outcome> {
  message: Extract<ToWebview, { type: Type }>;
  resolve: (outcome: Outcome) => void;
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

export interface DiagramState extends Omit<Diagram, "source"> {
  /**
   * Large generated chart options are omitted when saving, requiring Refresh after a reload.
   * Manual edits are always kept.
   */
  source?: string;
  origin: DiagramOrigin;
  /** Set when the user changed the source in the panel after it was last rendered by an agent. */
  editedByUser: boolean;
  /** The last render error, if the current source fails to render. */
  error?: string;
}

const STATE_KEY = "diagram.state";
/** Large generated chart options can be reloaded; manual edits must be kept. */
const MAX_SAVED_CHART_SOURCE = 1_000_000;
const RENDER_TIMEOUT_MS = 15_000;

/**
 * The single interactive diagram panel shared by the @diagram participant and the language model
 * tools. It owns the current diagram and the user's interactions with it.
 */
export class DiagramPanel implements vscode.Disposable {
  static readonly viewType = "diagram.panel";

  /** The id of the chat request that a tool rendered the current diagram for; see {@link adopt}. */
  private toolRequestId: unknown;

  private panel: vscode.WebviewPanel | undefined;
  /**
   * Whether the webview listens to messages. Until it does, messages are dropped, and once it does
   * (again, after a reload), it is sent the pending render and pick.
   */
  private webviewReady = false;
  private state: DiagramState | undefined;
  private selection: DiagramNode[] = [];
  private nextRequestId = 1;
  private pendingRender: Pending<"render", RenderOutcome> | undefined;
  private renderVersion = 0;
  private pendingPick: Pending<"startPick", PickOutcome> | undefined;
  private refreshing = false;
  private saveFailed = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.state = context.workspaceState.get<DiagramState>(STATE_KEY);
  }

  /** The diagram currently shown, if any. */
  get current(): Readonly<DiagramState> | undefined {
    return this.state;
  }

  /**
   * Renders a diagram produced by an agent, opening the panel if needed. A tool passes the tool
   * invocation token it was given, which tells which chat request the diagram is for.
   */
  async render(
    diagram: Diagram,
    origin: DiagramOrigin,
    toolInvocationToken?: unknown,
  ): Promise<RenderOutcome> {
    this.toolRequestId = requestId(toolInvocationToken);
    this.state = { ...diagram, origin, editedByUser: false };
    this.selection = [];
    this.cancelPick("The diagram was replaced before the user picked.");
    this.reveal();
    return this.renderCurrent();
  }

  /**
   * If a tool rendered the current diagram for the participant's chat request with this tool
   * invocation token, makes it the participant's, so that requests about it go to the participant,
   * and returns it. Another agent may render at the same time.
   */
  adopt(toolInvocationToken: unknown): Readonly<DiagramState> | undefined {
    const id = requestId(toolInvocationToken);
    if (!this.state || id === undefined || id !== this.toolRequestId) {
      return undefined;
    }
    this.state = { ...this.state, origin: "participant" };
    void this.save();
    return this.state;
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
    if (token.isCancellationRequested) {
      return { picked: false, reason: "The request was cancelled." };
    }
    const state = this.state;
    if (!state) {
      return {
        picked: false,
        reason: `There is no diagram to pick from. Render one with ${RENDER_TOOL} or ${CHART_TOOL} first.`,
      };
    }
    if (state.source === undefined) {
      return {
        picked: false,
        reason: `The chart is not drawn, as it was too large to keep when VS Code closed. Draw it again with ${CHART_TOOL} first.`,
      };
    }
    if (state.error) {
      return { picked: false, reason: failsToRender(state.language, state.error) };
    }
    this.cancelPick("Another request to pick nodes replaced this one.");
    this.show();

    const message = { type: "startPick", pickId: this.nextRequestId++, prompt, multiple } as const;
    return new Promise<PickOutcome>((resolve) => {
      const cancellation = token.onCancellationRequested(() =>
        this.finishPick(message.pickId, { picked: false, reason: "The request was cancelled." }),
      );
      this.pendingPick = {
        message,
        resolve: (outcome) => {
          cancellation.dispose();
          resolve(outcome);
        },
      };
      this.post(message);
    });
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
    return this.state && describeDiagram(this.state, this.selection);
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
    // After a window reload, VS Code restores a panel in a background tab only once the tab is
    // shown. Replace such a tab rather than open a second one.
    const leftovers = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter(
        (tab) =>
          tab.input instanceof vscode.TabInputWebview &&
          tab.input.viewType.endsWith(DiagramPanel.viewType),
      );
    const panel = vscode.window.createWebviewPanel(
      DiagramPanel.viewType,
      "Diagram",
      {
        viewColumn: leftovers[0]?.group.viewColumn ?? vscode.ViewColumn.Beside,
        preserveFocus: true,
      },
      // Keeps the webview while hidden behind another tab, so that it can still render and be
      // asked to pick, and keeps its zoom and source editor.
      { retainContextWhenHidden: true },
    );
    this.attach(panel);
    void vscode.window.tabGroups.close(leftovers, true);
    return true;
  }

  private attach(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    panel.iconPath = new vscode.ThemeIcon("type-hierarchy");
    this.webviewReady = false;
    loadWebview(panel.webview, this.context.extensionUri);

    const messageListener = panel.webview.onDidReceiveMessage((message: unknown) => {
      // The webview renders content written by a model, so do not trust what it sends.
      if (isFromWebview(message)) {
        this.onMessage(message);
      }
    });
    panel.onDidDispose(() => {
      messageListener.dispose();
      this.panel = undefined;
      this.webviewReady = false;
      this.selection = [];
      this.cancelPick("The user closed the diagram panel.");
      if (this.pendingRender) {
        this.finishRender(this.pendingRender.message.requestId, {
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
        // The webview loaded, or lost its content and loaded again (e.g. when moved to another
        // window). Keep the pending request id so its caller is answered.
        this.webviewReady = true;
        this.selection = [];
        if (this.pendingRender) {
          this.post(this.pendingRender.message);
        } else if (this.state) {
          void this.renderCurrent();
        }
        if (this.pendingPick) {
          this.post(this.pendingPick.message);
        }
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
        void this.askInChat(`${this.regarding(message.nodes)}${message.text}`);
        break;
      case "clickToAsk":
        // A diagram that fails to render has no nodes: the click was on the one it replaced.
        if (this.state?.clickPrompt && !this.state.error && !this.pendingRender) {
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

  /** Shows the current diagram in the webview, and keeps its render error, if any, for later requests. */
  private async renderCurrent(): Promise<RenderOutcome> {
    const state = this.state;
    if (!state || !this.panel) {
      return { ok: false, kind: "unavailable", error: "There is no diagram panel to render in." };
    }
    const version = ++this.renderVersion;
    if (this.pendingRender) {
      this.finishRender(this.pendingRender.message.requestId, {
        ok: false,
        kind: "unavailable",
        error: "The diagram was replaced before it finished rendering.",
      });
    }
    this.panel.title = state.title;
    const { source, title } = state;
    const refreshFrom = state.chart && dataOrigin(state.chart);
    if (source === undefined) {
      this.post({ type: "needsRefresh", title, refreshFrom });
      return {
        ok: false,
        kind: "unavailable",
        error: "The chart waits for the user to refresh it.",
      };
    }

    const message = {
      type: "render",
      requestId: this.nextRequestId++,
      language: state.language,
      source,
      title,
      clickPrompt: state.clickPrompt,
      refreshFrom,
    } as const;
    const result = await new Promise<RenderOutcome>((resolve) => {
      const timeout = setTimeout(
        () =>
          this.finishRender(message.requestId, {
            ok: false,
            kind: "unavailable",
            error: `The diagram panel did not respond within ${RENDER_TIMEOUT_MS / 1000} seconds.`,
          }),
        RENDER_TIMEOUT_MS,
      );
      this.pendingRender = {
        message,
        resolve: (outcome) => {
          clearTimeout(timeout);
          resolve(outcome);
        },
      };
      this.post(message);
    });

    // An unavailable panel says nothing about the source, and the diagram may have been replaced
    // while rendering.
    const latest = this.state;
    if (latest && version === this.renderVersion && (result.ok || result.kind === "invalid")) {
      this.state = { ...latest, error: result.ok ? undefined : result.error };
      if (!result.ok) {
        this.cancelPick(failsToRender(latest.language, result.error));
      }
    }
    await this.save();
    return result;
  }

  private finishRender(requestId: number, outcome: RenderOutcome): void {
    if (this.pendingRender?.message.requestId !== requestId) {
      return;
    }
    const { resolve } = this.pendingRender;
    this.pendingRender = undefined;
    resolve(outcome);
  }

  private finishPick(id: number, outcome: PickOutcome): void {
    if (this.pendingPick?.message.pickId !== id) {
      return;
    }
    const { resolve } = this.pendingPick;
    this.pendingPick = undefined;
    this.post({ type: "endPick", pickId: id });
    resolve(outcome);
  }

  private cancelPick(reason: string): void {
    if (this.pendingPick) {
      this.finishPick(this.pendingPick.message.pickId, { picked: false, reason });
    }
  }

  /** Loads the data of the current chart again and redraws it, replacing earlier manual edits. */
  private async refreshChart(): Promise<void> {
    const chart = this.state?.chart;
    const before = this.state?.source;
    if (!chart || this.refreshing) {
      return;
    }
    this.refreshing = true;
    try {
      const { table, warning } = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Refreshing chart" },
        (_progress, token) => loadTable(chart, token),
      );
      // While loading, an agent may have replaced the chart, or the user may have edited it (an
      // edit made after pressing Refresh wins) or closed the panel.
      if (this.state?.chart !== chart || this.state.source !== before || !this.panel) {
        return;
      }
      const source = JSON.stringify(buildChart(chart, table).option, null, 2);
      this.cancelPick("The chart data was refreshed before the user picked.");
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

  private async save(): Promise<void> {
    const state = this.state;
    const saved =
      state?.chart &&
      !state.editedByUser &&
      state.source !== undefined &&
      state.source.length > MAX_SAVED_CHART_SOURCE
        ? { ...state, source: undefined, editedByUser: false, error: undefined }
        : state;
    try {
      await this.context.workspaceState.update(STATE_KEY, saved);
      this.saveFailed = false;
    } catch (error) {
      if (!this.saveFailed) {
        void vscode.window.showWarningMessage(
          `Could not save the diagram: ${errorMessage(error)}. Changes may be lost when VS Code closes.`,
        );
      }
      this.saveFailed = true;
    }
  }

  /** E.g. `Regarding "Parser", "Checker" in the diagram: `. */
  private regarding(nodes: DiagramNode[]): string {
    const noun = diagramNoun(this.state?.language ?? "mermaid");
    return nodes.length > 0
      ? `Regarding ${nodes.map((node) => `"${node.label}"`).join(", ")} in the ${noun}: `
      : `Regarding the ${noun}: `;
  }

  /** Sends a request about the diagram to chat, routed to whoever produced the diagram. */
  private async askInChat(text: string): Promise<void> {
    const query = this.state?.origin === "tool" ? text : `@diagram ${text}`;
    try {
      await vscode.commands.executeCommand("workbench.action.chat.open", { query });
    } catch (error) {
      // E.g. chat is disabled. The selection is kept, to try again.
      void vscode.window.showErrorMessage(
        `Could not send the request to chat: ${errorMessage(error)}`,
      );
      return;
    }
    this.post({ type: "clearSelection" });
  }

  private post(message: ToWebview): void {
    if (this.webviewReady) {
      void this.panel?.webview.postMessage(message);
    }
  }
}

function failsToRender(language: DiagramLanguage, error: string): string {
  const noun = diagramNoun(language);
  return `The ${noun} fails to render, so there is nothing to pick from. Render a working ${noun} first. The error is: ${error}`;
}

/**
 * Builds the chat request sent when a node is clicked in click-to-ask mode: `{label}` in the prompt
 * is replaced by the node's label, which is otherwise appended.
 */
export function clickToAskQuery(clickPrompt: string, label: string): string {
  return clickPrompt.includes("{label}")
    ? clickPrompt.replaceAll("{label}", () => label)
    : `${clickPrompt} "${label}"`;
}

/**
 * The id of the chat request that a tool invocation token is for. The token is opaque, and a tool
 * is given a copy of the one passed to vscode.lm.invokeTool, so tokens are compared by this id.
 */
function requestId(toolInvocationToken: unknown): unknown {
  return isPlainObject(toolInvocationToken) ? toolInvocationToken.requestId : undefined;
}
