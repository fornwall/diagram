import * as os from "node:os";
import * as vscode from "vscode";
import { type ChartSpec, dataOrigin } from "./chartSpec";
import { buildChart } from "./charts";
import { loadTable, resolveFile } from "./dataSource";
import { describeDiagram } from "./describe";
import {
  confirmReplacedWrite,
  type DocumentBinding,
  documentName,
  reportWriteFailure,
  writeFence,
} from "./documentDiagram";
import { linkSelection, linkTexts, type NodeLink, type NodeLinks } from "./links";
import {
  type Annotation,
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
import { savedChartFileName, savedChartHtml } from "./savedChart";
import type { ThemeColors } from "./webview/colors";
import { loadWebview } from "./webviewHtml";

/**
 * Who produced the diagram currently shown: the @diagram participant, another agent through a tool,
 * or the user, by opening a diagram that is written in a document.
 */
type DiagramOrigin = "participant" | "tool" | "document";

/**
 * A render fails as "invalid" when the source has an error, and as "unavailable" when the panel
 * was closed or did not respond, which says nothing about the source.
 */
export type RenderOutcome =
  | { ok: true; diagramType: string }
  | { ok: false; kind: "invalid" | "unavailable"; error: string };

type PickOutcome = { picked: true; nodes: DiagramNode[] } | { picked: false; reason: string };

/**
 * What came of marking up the diagram shown: the marks it now carries, and the ids among them that
 * it has no node for, which are left unmarked.
 */
export type AnnotateOutcome =
  | {
      ok: true;
      annotation: Annotation;
      unknown: string[];
      /** The ids the marks were checked against, or undefined when the panel does not know them. */
      ids?: readonly string[];
    }
  | { ok: false; reason: string };

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
  /**
   * Where the Mermaid nodes are in the code, by node id: a plain click on such a node opens its
   * location, ahead of {@link clickPrompt}, while a pick and a modified click come first; see
   * itemClicked in src/webview/main.ts.
   */
  links?: NodeLinks;
  /** For a chart of data from a file or command: how to load the data and draw it again. */
  chart?: ChartSpec;
  /**
   * For a diagram opened from a fenced code block in a document: the block it came from, which the
   * user's Apply writes their edits back into; see {@link applyEdit}.
   */
  document?: DocumentBinding;
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
  /**
   * The ids of the nodes of the rendering shown, as the webview reported them, or undefined when
   * they are not known: nothing is drawn, or the rendering names no parts; see {@link drawnIds}.
   */
  private nodeIds: string[] | undefined;
  /**
   * How an agent marked up the diagram shown, if it did. Kept only while that diagram is shown,
   * never saved: the marks are commentary on the moment, not part of the diagram.
   */
  private annotation: Annotation | undefined;
  private nextRequestId = 1;
  private pendingRender: Pending<"render", RenderOutcome> | undefined;
  private renderVersion = 0;
  private pendingPick: Pending<"startPick", PickOutcome> | undefined;
  private refreshing = false;
  private saving = false;
  private saveFailed = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.state = context.workspaceState.get<DiagramState>(STATE_KEY);
  }

  /** The diagram currently shown, if any. */
  get current(): Readonly<DiagramState> | undefined {
    return this.state;
  }

  /**
   * The ids of the nodes the panel has drawn, when it knows them, so that a model can be told that
   * a node it named is not there. A chart reports none: its items are its data, not a list of ids.
   */
  get drawnIds(): readonly string[] | undefined {
    return this.nodeIds;
  }

  /**
   * Renders a diagram produced by an agent, or one the user opened from a document, opening the
   * panel if needed. A tool passes the tool invocation token it was given, which tells which chat
   * request the diagram is for.
   */
  async render(
    diagram: Diagram,
    origin: DiagramOrigin,
    toolInvocationToken?: unknown,
  ): Promise<RenderOutcome> {
    this.toolRequestId = requestId(toolInvocationToken);
    // A diagram opened from a document keeps its binding when an agent replaces it, so that the user
    // can still write what they end up with back to the file. Rendering never writes anything itself:
    // the next write is the user's Apply, which asks them first; see DocumentBinding.replaced.
    const document =
      diagram.document ?? (this.state?.document && { ...this.state.document, replaced: true });
    this.state = { ...diagram, document, origin, editedByUser: false };
    this.selection = [];
    // Another diagram is not the one an agent marked up, just as it is not the one the user selected in.
    this.annotation = undefined;
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

  /**
   * Marks up the diagram shown without drawing it again, replacing the marks from the call before:
   * the webview puts the marks on the rendering that is already there. Ids the diagram has no node
   * for are reported back rather than marked, so that an agent learns about its typo.
   */
  annotate(annotation: Annotation): AnnotateOutcome {
    const state = this.state;
    if (!state) {
      return {
        ok: false,
        reason: `There is no diagram to mark. Render one with ${RENDER_TOOL} or ${CHART_TOOL} first.`,
      };
    }
    if (state.source === undefined) {
      return {
        ok: false,
        reason: `The chart is not drawn, as it was too large to keep when VS Code closed. Draw it again with ${CHART_TOOL} first.`,
      };
    }
    if (state.error) {
      return { ok: false, reason: failsToRender(state.language, state.error, "mark") };
    }
    // The ids of the diagram as it is drawn now: opening the panel below draws it again.
    const ids = this.nodeIds;
    const unknown = unknownNodeIds(
      annotation.marks.map((mark) => mark.id),
      ids,
    );
    const marks =
      unknown.length > 0
        ? annotation.marks.filter((mark) => !unknown.includes(mark.id))
        : annotation.marks;
    this.annotation = { ...annotation, marks };
    // Showing the panel may have to open it, which renders the diagram again; the marks follow on
    // the webview's ready message either way.
    this.show();
    this.post({ type: "annotate", ...this.annotation });
    return { ok: true, annotation: this.annotation, unknown, ids };
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
    return this.state && describeDiagram(this.state, this.selection, this.annotation);
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
        if (this.annotation) {
          // The webview lost the marks with its content; they go back on the rendering it draws again.
          this.post({ type: "annotate", ...this.annotation });
        }
        break;
      case "rendered":
        // The ids of what was drawn, for telling a model that a node it names is not there. A late
        // answer to a replaced render says nothing about the diagram now shown.
        if (this.pendingRender?.message.requestId === message.requestId) {
          this.nodeIds = message.nodeIds;
        }
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
        void this.applyEdit(message.source);
        break;
      case "refresh":
        void this.refreshChart();
        break;
      case "save":
        void this.saveChart(message.colors);
        break;
      case "writeToDocument":
        void this.writeShownToDocument();
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
      case "clickToOpen": {
        // The message names the node; its location comes from the links validated here, so that
        // the webview, which shows what a model wrote, cannot open a path of its own choosing.
        const link = this.linkOf(message.node);
        if (link) {
          void this.openLink(link, message.node.label);
        }
        break;
      }
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
    // What was drawn before says nothing about the rendering being drawn now.
    this.nodeIds = undefined;
    const replaced = {
      ok: false,
      kind: "unavailable",
      error: "The diagram was replaced before it finished rendering.",
    } as const;
    if (this.pendingRender) {
      this.finishRender(this.pendingRender.message.requestId, replaced);
    }
    // The title names the document a diagram was opened from, as an Apply then writes to that file.
    this.panel.title = state.document
      ? `${state.title} — ${documentName(state.document)}`
      : state.title;
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
      links: state.links && linkTexts(state.links),
      refreshFrom,
      writeTo: state.document && documentName(state.document),
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
    if (latest && version === this.renderVersion) {
      if (result.ok || result.kind === "invalid") {
        this.state = { ...latest, error: result.ok ? undefined : result.error };
      }
      if (!result.ok) {
        this.cancelPick(
          result.kind === "invalid" ? failsToRender(latest.language, result.error) : result.error,
        );
      }
    }
    await this.save();
    return version === this.renderVersion ? result : replaced;
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

  /**
   * Shows an edit the user applied in the panel, and writes it back to the document a diagram was
   * opened from. Their Apply is the one action that changes that file: a diagram an agent renders,
   * or a chart it refreshes, only ever replaces what the panel shows.
   */
  private async applyEdit(source: string): Promise<void> {
    const state = this.state;
    if (!state) {
      return;
    }
    this.state = { ...state, source, editedByUser: true };
    this.selection = [];
    this.annotation = undefined;
    this.cancelPick("The user edited the diagram source instead of picking.");
    await this.renderCurrent();
    const binding = this.state?.document;
    // An agent may have replaced the diagram while it rendered; only what is shown is written.
    if (binding && this.state?.source === source) {
      await this.writeToDocument(binding, source);
    }
  }

  /**
   * Writes the diagram as it is shown into the block it was opened from, which Apply does for an
   * edit of the user's own. This is how a diagram an agent drew reaches the document: there is
   * nothing to apply then, as the source in the editor is the one that is rendered.
   */
  private async writeShownToDocument(): Promise<void> {
    const state = this.state;
    if (!state?.document) {
      return;
    }
    if (state.source === undefined || !state.source.trim()) {
      void vscode.window.showWarningMessage(
        "There is nothing to write: the diagram is not drawn. Press Refresh to draw it again.",
      );
      return;
    }
    if (state.error) {
      void vscode.window.showWarningMessage(
        `The diagram is not written, as it fails to render: ${state.error}`,
      );
      return;
    }
    await this.writeToDocument(state.document, state.source);
  }

  /** Writes the diagram shown back into the block it was opened from, or says why it was not. */
  private async writeToDocument(binding: DocumentBinding, source: string): Promise<void> {
    if (binding.replaced && !(await confirmReplacedWrite(binding))) {
      return;
    }
    const outcome = await writeFence(binding, source);
    if (!outcome.written) {
      // Not awaited: the message stays until dismissed, and the diagram can be edited meanwhile.
      void reportWriteFailure(binding, outcome.reason);
      return;
    }
    // The block now holds this diagram, and may have moved, so the binding follows it and no longer
    // counts as replaced. A diagram rendered while writing has a binding of its own to keep.
    const state = this.state;
    if (state?.document === binding) {
      this.state = { ...state, document: { uri: binding.uri, fence: outcome.fence } };
      await this.save();
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
      this.annotation = undefined;
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

  /** Saves the chart shown as a self-contained HTML file, at a path the user picks. */
  private async saveChart(colors: ThemeColors): Promise<void> {
    const state = this.state;
    if (state?.language !== "echarts" || this.saving) {
      return;
    }
    if (state.source === undefined) {
      void vscode.window.showWarningMessage(
        "The chart is not drawn, as it was too large to keep when VS Code closed. " +
          "Press Refresh to draw it again, then save it.",
      );
      return;
    }
    if (state.error) {
      void vscode.window.showWarningMessage(
        `There is nothing to save, as the chart fails to render: ${state.error}`,
      );
      return;
    }
    this.saving = true;
    try {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
      const target = await vscode.window.showSaveDialog({
        title: "Save Chart as HTML",
        defaultUri: vscode.Uri.joinPath(folder, savedChartFileName(state.title)),
        filters: { "HTML file": ["html", "htm"] },
      });
      if (!target) {
        return;
      }
      const chart = { title: state.title, source: state.source, colors };
      const html = await savedChartHtml(chart, this.context.extensionUri);
      await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(html));
      // Not awaited: the message stays until dismissed, and the next chart can be saved meanwhile.
      void offerToOpen(target);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not save the chart: ${errorMessage(error)}`);
    } finally {
      this.saving = false;
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

  /** Where a node of the diagram shown links to in the code, if anywhere. */
  private linkOf(node: DiagramNode): NodeLink | undefined {
    const links = this.state?.links;
    // A diagram that fails to render has no nodes: the click was on the one it replaced. Node ids
    // are a model's words, so only the map's own entries count, not "constructor" and the like.
    if (!links || this.state?.error || this.pendingRender || !Object.hasOwn(links, node.id)) {
      return undefined;
    }
    return links[node.id];
  }

  /**
   * Opens the code a node links to, selecting the lines it points at. The link was written by a
   * language model, so a file outside the workspace, or any file in an untrusted workspace, is
   * confirmed first; inside a trusted workspace the click is the user's own action.
   */
  private async openLink(link: NodeLink, label: string): Promise<void> {
    try {
      const uri = resolveFile(link.file);
      if (!vscode.workspace.isTrusted || !vscode.workspace.getWorkspaceFolder(uri)) {
        const open = await vscode.window.showWarningMessage(
          `Open the file that "${label}" links to?`,
          { modal: true, detail: `${uri.fsPath}\n\nThe diagram's links were written by a model.` },
          "Open",
        );
        if (open === undefined) {
          return;
        }
      }
      const document = await vscode.workspace.openTextDocument(uri);
      // The click made the panel's tab group active, so show the code in another one, leaving the
      // diagram visible beside it.
      const column = this.panel?.viewColumn;
      const elsewhere = vscode.window.tabGroups.all.find((group) => group.viewColumn !== column);
      await vscode.window.showTextDocument(document, {
        selection: linkSelection(link, document),
        viewColumn: elsewhere?.viewColumn ?? vscode.ViewColumn.Beside,
      });
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Could not open the code that "${label}" links to: ${errorMessage(error)}`,
      );
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

  private async post(message: ToWebview): Promise<void> {
    if (!this.webviewReady || !this.panel) {
      return;
    }
    let error: string;
    try {
      if (await this.panel.webview.postMessage(message)) {
        return;
      }
      error = "The diagram panel is unavailable. Reopen it and try again.";
    } catch (cause) {
      error = `Could not contact the diagram panel: ${errorMessage(cause)}`;
    }
    if (message.type === "render") {
      this.finishRender(message.requestId, { ok: false, kind: "unavailable", error });
    } else if (message.type === "startPick") {
      this.finishPick(message.pickId, { picked: false, reason: error });
    }
  }
}

/** The last segment of a path, as the file the user picked is named in the panel's messages. */
function basename(uri: vscode.Uri): string {
  return uri.path.split("/").pop() || uri.path;
}

/** Says where a chart was saved, and opens it in the user's browser if they ask. */
async function offerToOpen(target: vscode.Uri): Promise<void> {
  const open = await vscode.window.showInformationMessage(
    `Saved the chart to ${basename(target)}.`,
    "Open",
  );
  if (open) {
    await vscode.env.openExternal(target);
  }
}

function failsToRender(language: DiagramLanguage, error: string, action = "pick from"): string {
  const noun = diagramNoun(language);
  return `The ${noun} fails to render, so there is nothing to ${action}. Render a working ${noun} first. The error is: ${error}`;
}

/**
 * Which of the ids a model gave the panel has no node for, e.g. the nodes its links or its marks
 * name. Empty while the ids of the rendering are unknown, as nothing can be said about them then;
 * see {@link DiagramPanel.drawnIds}.
 */
export function unknownNodeIds(
  ids: readonly string[],
  drawn: readonly string[] | undefined,
): string[] {
  if (!drawn) {
    return [];
  }
  const known = new Set(drawn);
  return ids.filter((id) => !known.has(id));
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
