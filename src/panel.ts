import * as vscode from "vscode";
import { guessTitle } from "./blocks";
import { throwIfCancelled, unlessCancelled } from "./cancellation";
import {
  type ChartUpdateInput,
  chartControls,
  updatedChartSpec,
  withChartControls,
} from "./chartOptions";
import {
  assertChartPresentation,
  type ChartPresentation,
  captureChartPresentation,
  rebuildChart,
} from "./chartPresentation";
import { type ChartSpec, dataOrigin } from "./chartSpec";
import { chartTitle } from "./chartTools";
import { type DataTable, parseTable } from "./data";
import { loadTable, readAsks } from "./dataSource";
import { type Detail, describeDiagram, nodeList } from "./describe";
import {
  confirmWrite,
  type DocumentBinding,
  documentName,
  reportWriteFailure,
  writeFence,
} from "./documentDiagram";
import { exportDrawing, pngBytes } from "./export";
import { fileName, resolveFile } from "./files";
import { ItemNames, type Resolved } from "./itemNames";
import { linkTexts, type NodeLink, type NodeLinks, openLink, openUrl } from "./links";
import { StateStore } from "./panelState";
import {
  type Annotation,
  CHART_TOOL,
  type DiagramLanguage,
  type DiagramNode,
  diagramNoun,
  type ExportResult,
  errorMessage,
  type FromWebview,
  GET_STATE_TOOL,
  type ImageView,
  type ItemPage,
  type ItemQuery,
  RENDER_TOOL,
  type RepeatedName,
  type SourceRepair,
  type ToWebview,
  UPDATE_CHART_TOOL,
} from "./protocol";
import { formatOption, runsCode } from "./webview/optionSource";
import { WebviewChannel } from "./webviewChannel";

type DiagramOrigin = "tool" | "document";

/** "invalid" means a source error; "unavailable" means the panel closed or stopped responding. */
export type RenderOutcome =
  | { ok: true; diagramType: string; repair?: SourceRepair }
  | { ok: false; kind: "invalid" | "unavailable"; error: string };

/** Identifies the revision attempted, including failed renders and concurrent requests. */
export type Drawn = RenderOutcome & { revision: number };

type PickOutcome = { picked: true; nodes: DiagramNode[] } | { picked: false; reason: string };
type ItemsResult = Extract<FromWebview, { type: "items" | "itemsError" }>;

type AnnotateOutcome =
  | {
      ok: true;
      annotation: Annotation;
      /** Unmatched names, with reasons for unresolved relationship endpoints. */
      unknown: Resolved[];
      /** Names that several chart items go by, which were not marked. */
      repeated: RepeatedName[];
      /** Ambiguous relationship endpoints, which were not marked. */
      several: Resolved[];
      /** Original relationship names, keyed by the resolved item ids. */
      given: ReadonlyMap<string, string>;
      /** The items the marks were checked against, or undefined when the panel does not know them. */
      names: ItemNames | undefined;
    }
  | { ok: false; reason: string };

type RenderMessage = Extract<ToWebview, { type: "render" }>;

/** A request to the webview awaiting its answer. */
interface Pending<Type extends ToWebview["type"], Outcome> {
  message: Extract<ToWebview, { type: Type }>;
  resolve: (outcome: Outcome) => void;
}

export interface Diagram {
  language: DiagramLanguage;
  source: string;
  title: string;
  /** When set, a plain click on a node sends this request to chat; see {@link clickToAskQuery}. */
  clickPrompt?: string | undefined;
  /** Mermaid node locations. Links take precedence over clickPrompt on a plain click. */
  links?: NodeLinks | undefined;
  /** The original data request, retained for generated chart controls and refresh. */
  chart?: ChartSpec;
  /** Generated baseline and manual styling overrides, without a copy of the data. */
  chartPresentation?: ChartPresentation | undefined;
  /** Original Markdown block; Apply writes user edits back to it. */
  document?: DocumentBinding | undefined;
  /** Read-only source document URI; used to place exports beside it. */
  openedFrom?: string | undefined;
}

export interface DiagramState extends Omit<Diagram, "source"> {
  /**
   * Large generated chart options are omitted when saving, requiring Refresh after a reload.
   * Manual edits are always kept.
   */
  source?: string | undefined;
  origin: DiagramOrigin;
  /** Set when the user changed the source in the panel after it was last rendered by an agent. */
  editedByUser: boolean;
  /** Cumulative user edits since the last agent change, used to show the model a diff. */
  userEdit?: { from: string; to: string } | undefined;
  /** The last render error, if the current source fails to render. */
  error?: string | undefined;
}

const RENDER_TIMEOUT_MS = 15_000;

/**
 * Prevents automatic retries of potentially hung source after a reload. Webviews share a
 * process, so reopening the panel may not recover it; only an explicit edit or render retries it.
 */
const UNFINISHED =
  "The panel did not finish drawing it, so it is not drawn again on its own, as it may hang the panel. Edit and apply it, or render it again, to draw it anyway.";

/** The panel shared by document previews and language model tools. */
export class DiagramPanel implements vscode.Disposable {
  private readonly store: StateStore;
  private state: DiagramState | undefined;
  private selection: DiagramNode[] = [];
  /** Transient marks: cleared on replacement, never persisted. */
  private annotation: Annotation | undefined;

  private readonly webview: WebviewChannel;
  private nextRequestId = 1;
  /** Counts renders, to detect intervening ones. */
  private renderVersion = 0;
  /** Revision exposed to tools and Chart Options; unchanged by redraws or reloads. */
  private shownRevision: number;
  /** Counts the changes that the user or a document started, such as an Apply or a Refresh. */
  private userChanges = 0;
  /** Pending renders and picks are replayed when the webview reloads. */
  private pendingRender: Pending<"render", RenderOutcome> | undefined;
  private pendingPick: Pending<"startPick", PickOutcome> | undefined;
  private readonly pendingExports = new Map<number, (result: ExportResult) => void>();
  private readonly pendingItems = new Map<number, (result: ItemsResult) => void>();
  /** Ends the pending render if the page does not answer it in time; see {@link renderTimedOut}. */
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  /** The page draws this request, then lastSent, skipping any requests between them. */
  private drawing: RenderMessage | undefined;
  private lastSent: RenderMessage | undefined;
  /** Panel failure, separate from a source error. A late render may still succeed. */
  private unavailable: string | undefined;
  /**
   * Chart code can forge user messages. Reset only when the tab closes: messages from before
   * a reload may still arrive afterward.
   */
  private pageRanCode = false;
  /** Whether a confirmation that the page asked for is open; see {@link confirmForPage}. */
  private confirming = false;
  /** Whether the user declined what the page asked for while it held chart code. */
  private pageRefused = false;
  /**
   * Last successful render of the current source. Its request id ties exports and clicks to
   * that drawing, so messages from a replaced drawing can be ignored.
   */
  private drawn: Extract<FromWebview, { type: "rendered" }> | undefined;
  /** The names of the items {@link drawn}, made when first asked for. */
  private drawnNames: { drawn: object; names: ItemNames } | undefined;
  /** Identifies the editable source even when its render fails. */
  private sourceRequestId: number | undefined;
  /**
   * Identifies diagrams for viewport resets. Edits keep it; new diagrams, document opens and changes
   * of language or title advance it.
   */
  private diagrams = 0;

  private chartTable: DataTable | undefined;
  private chartOptionsVisible = false;
  private refreshing = false;
  /** Cancelled on panel close, diagram change, or a newer data load. */
  private reloading: vscode.CancellationTokenSource | undefined;
  private exporting = false;
  /** The last write to a document, which the next one waits for. */
  private writing: Promise<void> | undefined;
  /** Tracks bindings across block writes and file renames, including pending writes. */
  private readonly movedBindings = new WeakMap<DocumentBinding, DocumentBinding>();
  private readonly renames = vscode.workspace.onDidRenameFiles(({ files }) =>
    this.followRenames(files),
  );

  constructor(private readonly context: vscode.ExtensionContext) {
    this.store = new StateStore(context.workspaceState);
    this.webview = new WebviewChannel(
      context.extensionUri,
      (message) => this.onMessage(message),
      () => this.closed(),
    );
    const restored = this.store.load();
    this.state = restored?.state;
    this.shownRevision = restored?.revision ?? 0;
    this.updateContext();
  }

  /** The diagram currently shown, if any. */
  get current(): Readonly<DiagramState> | undefined {
    return this.state;
  }

  /** Optimistic concurrency token, exposed to tools along with the current source. */
  get revision(): number {
    return this.shownRevision;
  }

  /** Tools capture this counter to avoid overwriting later user or document changes. */
  get userChangeCount(): number {
    return this.userChanges;
  }

  /**
   * Known Mermaid node ids. Charts identify their items through their data instead.
   */
  get drawnIds(): readonly string[] | undefined {
    return this.drawn?.nodeIds;
  }

  /** Resolves tool-supplied node and relationship names against the current drawing. */
  get itemNames(): ItemNames | undefined {
    const drawn = this.drawn;
    if (!drawn?.nodeIds) return undefined;
    if (this.drawnNames?.drawn !== drawn) {
      const { nodeIds, relationships = [] } = drawn;
      this.drawnNames = { drawn, names: new ItemNames({ nodeIds, relationships }) };
    }
    return this.drawnNames.names;
  }

  /** Whether the panel waits for the page to draw the diagram, whose ids it does not know yet. */
  get rendering(): boolean {
    return this.pendingRender !== undefined;
  }

  /** What a model should know about parts of the source that the panel did not draw. */
  get warnings(): readonly string[] {
    return this.drawn?.warnings ?? [];
  }

  /**
   * Describes the current diagram and the user's interactions with it, for a language model.
   * `detail` limits long source and relationship lists.
   */
  describeForModel({ detail = "brief" }: { detail?: Detail } = {}): string | undefined {
    if (!this.state) return undefined;
    let chartTable: DataTable | undefined;
    try {
      chartTable = this.state.chart && this.loadedChartData;
    } catch {
      // Inline data that no longer parses has no units to tell.
    }
    const description = describeDiagram(this.state, {
      selection: this.selection,
      annotation: this.annotation,
      items: this.itemNames,
      repeatedNames: this.drawn?.repeatedNames ?? [],
      // A page busy with a large drawing may still show it.
      warnings: this.unavailable
        ? [...this.warnings, `The panel is not showing it yet: ${this.unavailable}`]
        : this.warnings,
      chartTable,
      detail,
    });
    return `Revision: ${this.shownRevision}.\n\n${description}`;
  }

  /** Opens and renders a diagram. */
  async render(
    diagram: Diagram,
    origin: DiagramOrigin,
    chartTable?: DataTable,
    {
      newDiagram = false,
      repairMermaid = false,
    }: { newDiagram?: boolean; repairMermaid?: boolean } = {},
  ): Promise<Drawn> {
    // Keep document bindings and export locations across same-language revisions.
    // Writing an agent replacement back to its document requires confirmation.
    const previous = origin === "document" || newDiagram ? undefined : this.state;
    // A changed title also resets the viewport for a new diagram.
    if (!previous || previous.language !== diagram.language || previous.title !== diagram.title) {
      this.diagrams++;
    }
    const kept = previous?.language === diagram.language ? previous : undefined;
    this.state = {
      ...diagram,
      document: diagram.document ?? (kept?.document && { ...kept.document, replaced: true }),
      openedFrom: diagram.openedFrom ?? kept?.openedFrom,
      origin,
      editedByUser: false,
      chartPresentation: diagram.chart
        ? (diagram.chartPresentation ?? captureChartPresentation(diagram.source))
        : undefined,
    };
    this.chartTable = diagram.chart ? chartTable : undefined;
    this.chartOptionsVisible = false;
    this.updateContext();
    this.selection = [];
    this.annotation = undefined;
    this.cancelPick("The diagram was replaced before the user picked.");
    if (origin === "document") this.userChanges++;
    this.webview.reveal(origin !== "document");
    return this.renderCurrent({ repairMermaid });
  }

  /** Shows and focuses the panel unless a background update asks to preserve focus. */
  show(preserveFocus = false): void {
    const opened = this.webview.reveal(preserveFocus);
    if ((opened || this.unavailable) && this.state) {
      void this.renderCurrent({ redraw: true, newPage: opened });
    }
  }

  /** Takes over a panel restored by VS Code after a reload. */
  restore(panel: vscode.WebviewPanel): void {
    if (!this.webview.adopt(panel)) {
      return;
    }
    if (this.state) {
      void this.renderCurrent({ redraw: true, newPage: true });
    } else {
      // The tab keeps the title of the diagram it showed before, which was not saved.
      panel.title = "Diagram";
    }
  }

  dispose(): void {
    this.webview.dispose();
    this.renames.dispose();
  }

  // The webview, and the requests waiting for its answers.

  /** Closing invalidates the drawing; later image or item requests must reopen and redraw. */
  private closed(): void {
    this.pageRanCode = false;
    this.pageRefused = false;
    this.reloading?.cancel();
    this.cancelExport("The diagram panel was closed before export finished.");
    this.cancelItems();
    this.selection = [];
    this.drawn = undefined;
    this.cancelPick("The user closed the diagram panel.");
    this.cancelRender("The diagram panel was closed before it finished rendering.");
    // A timed-out render may have started drawing after its caller stopped waiting.
    clearTimeout(this.renderTimer);
  }

  /** Sends a message to the webview, ending the request it makes if it does not arrive. */
  private post(message: ToWebview): void {
    if (message.type === "render") {
      // An untrusted workspace's page cannot evaluate code, and trust is not revoked while it runs.
      // A render that waits when trust is granted is sent again, to a page that can. A page that
      // ran code keeps it, so a large option need not be read for code again.
      const { language, source } = message;
      this.pageRanCode ||= language === "echarts" && vscode.workspace.isTrusted && runsCode(source);
      // A page that is not ready yet gets the render again once it is, with the full time for it.
      this.startRenderTimer(message);
      if (this.webview.isReady) {
        this.drawing ??= message;
        this.lastSent = message;
      }
    }
    void this.webview.post(message).then((error) => {
      if (error === undefined) {
        return;
      }
      if (message.type === "render") {
        this.finishRender(message.requestId, notShown(error));
      } else if (message.type === "export") {
        this.finishExport({ type: "exportError", requestId: message.requestId, message: error });
      } else if (message.type === "getItems") {
        this.finishItems({ type: "itemsError", requestId: message.requestId, message: error });
      } else if (message.type === "startPick") {
        this.finishPick(message.pickId, { picked: false, reason: error });
      }
    });
  }

  /**
   * Rejects messages about replaced source or drawings. Returns asynchronous work for callers
   * and tests to await.
   */
  private onMessage(message: FromWebview): Promise<void> | undefined {
    const requestId = "requestId" in message ? message.requestId : undefined;
    const ofShown = requestId === this.sourceRequestId;
    const ofDrawn = requestId === this.drawn?.requestId;
    switch (message.type) {
      case "items":
      case "itemsError":
        this.finishItems(message);
        return;
      case "ready":
        this.pageReady();
        return;
      case "rendered":
        this.pageRendered(message);
        return;
      case "renderError":
        this.pageAnswered(message.requestId);
        this.finishRender(message.requestId, {
          ok: false,
          kind: message.unavailable ? "unavailable" : "invalid",
          error: message.message,
        });
        return;
      case "warningsChanged":
        if (ofDrawn && this.drawn) this.drawn = { ...this.drawn, warnings: message.warnings };
        return;
      case "selectionChanged":
        if (ofShown) this.selection = message.nodes;
        return;
      case "sourceEdited":
        return ofShown
          ? this.applyEdit(message.source)
          : warn(
              "The diagram changed before your edit arrived. Your draft is kept in the source view; review it and apply again.",
            );
      case "writeToDocument":
        return ofShown
          ? this.writeShownToDocument()
          : warn("The diagram changed before it could be written. Review it and write it again.");
      case "ask":
        return this.askInChat(`${this.regarding(message.nodes)}${message.text}`, !ofShown);
      case "clickNode":
        return ofDrawn ? this.nodeClicked(message.node) : undefined;
      case "openUrl":
        return ofDrawn && this.state
          ? openUrl(message.url, diagramNoun(this.state.language), this.pageRanCode, (ask) =>
              this.confirmForPage(ask),
            )
          : undefined;
      case "closeChartOptions":
        this.chartOptionsVisible = false;
        return;
      case "applyChartOptions":
        return this.applyChartOptions(message);
      case "refresh":
        return this.refreshChart();
      case "exportImage":
      case "exportTheme":
      case "exportError":
        this.finishExport(message);
        return;
      case "picked":
        this.finishPick(message.pickId, { picked: true, nodes: message.nodes });
        return;
      case "pickCancelled":
        this.finishPick(message.pickId, {
          picked: false,
          reason: "The user cancelled without picking a node.",
        });
    }
    return undefined;
  }

  /**
   * Replays pending renders and picks after a page reload. Keeping their ids lets the original
   * callers receive the answers.
   */
  private pageReady(): void {
    this.cancelExport("The diagram panel reloaded before export finished. Try again.");
    this.cancelItems();
    this.selection = [];
    this.drawing = undefined;
    this.lastSent = undefined;
    if (this.pendingRender) {
      this.sendChartOptions();
      this.post(this.pendingRender.message);
      if (this.annotation) this.post({ type: "annotate", ...this.annotation });
    } else if (this.state) {
      void this.renderCurrent({ redraw: true, newPage: true });
    }
    if (this.pendingPick) this.post(this.pendingPick.message);
  }

  /** Keeps item identities only for the current render. */
  private pageRendered(message: Extract<FromWebview, { type: "rendered" }>): void {
    const request = this.pendingRender?.message ?? this.drawing;
    const repair =
      request?.requestId === message.requestId &&
      request.language === "mermaid" &&
      request.repairMermaid
        ? message.repair
        : undefined;
    this.pageAnswered(message.requestId);
    if (this.isCurrentRender(message.requestId)) {
      const relationships = message.relationships?.filter((node) => node.relationship);
      this.drawn = { ...message, relationships };
    }
    this.finishRender(message.requestId, {
      ok: true,
      diagramType: message.diagramType,
      ...(repair ? { repair } : {}),
    });
  }

  /**
   * Resolves clicks against host-validated links, never a path supplied by the webview.
   * Nodes without links use the click prompt, if set.
   */
  private nodeClicked(node: DiagramNode): Promise<void> | undefined {
    const link = this.linkOf(node);
    if (link) {
      return openLink(link, node.label, this.webview.tab?.viewColumn, (ask) =>
        this.confirmForPage(ask),
      );
    }
    const prompt = this.state?.clickPrompt;
    return prompt ? this.askInChat(clickToAskQuery(prompt, node.label)) : undefined;
  }

  /**
   * Renders and persists the current source and any error. Redraws keep the revision; a new page
   * does not retry a source marked UNFINISHED. Style edits can preserve the selection.
   */
  private async renderCurrent({
    redraw = false,
    newPage = false,
    keepSelection = false,
    repairMermaid = false,
  } = {}): Promise<Drawn> {
    const state = this.state;
    const tab = this.webview.tab;
    if (!redraw) {
      this.shownRevision++;
      // A refresh's data would no longer be drawn: stop its command and its progress.
      this.reloading?.cancel();
    }
    if (!state || !tab) {
      return {
        ...notShown("There is no diagram panel to render in."),
        revision: this.shownRevision,
      };
    }
    this.cancelExport("The diagram changed before export finished. Try again.");
    this.cancelItems();
    this.drawn = undefined;
    this.sourceRequestId = undefined;
    const version = ++this.renderVersion;
    const revision = this.shownRevision;
    this.sendChartOptions();
    const replaced = "The diagram was replaced before it finished rendering.";
    this.cancelRender(replaced);
    this.unavailable = undefined;
    // The title names the document a diagram was opened from, as an Apply then writes to that file.
    tab.title = state.document ? `${state.title} — ${documentName(state.document)}` : state.title;
    const { source, title } = state;
    const refreshFrom =
      state.chart && (state.chart.file || state.chart.command)
        ? dataOrigin(state.chart)
        : undefined;
    if (source === undefined) {
      this.post({ type: "needsRefresh", title, refreshFrom });
      return { ...notShown("The chart waits for the user to refresh it."), revision };
    }

    const message = {
      type: "render",
      requestId: this.nextRequestId++,
      language: state.language,
      source,
      title,
      repairMermaid,
      clickPrompt: state.clickPrompt,
      links: state.links && linkTexts(state.links),
      refreshFrom,
      writeTo: state.document && documentName(state.document),
      diagram: this.diagrams,
      notDrawn: newPage && state.error === UNFINISHED ? UNFINISHED : undefined,
      selection:
        keepSelection && this.selection.length > 0
          ? this.selection.map((node) => node.id)
          : undefined,
    } as const;
    this.sourceRequestId = message.requestId;
    // Preserve new source even if VS Code reloads before the webview answers.
    let saved = this.store.save(state, revision);
    const result = await new Promise<RenderOutcome>((resolve) => {
      this.pendingRender = { message, resolve };
      this.post(message);
      // Reloads and failed chart updates keep marks; replay them after the drawing they belong to.
      if (this.annotation) this.post({ type: "annotate", ...this.annotation });
    });

    // The diagram may have been replaced while rendering.
    if (version === this.renderVersion) saved = this.keepOutcome(result) ?? saved;
    await saved;
    return { ...(version === this.renderVersion ? result : notShown(replaced)), revision };
  }

  /**
   * Accepts answers to pending renders and late answers for the current source after a timeout.
   */
  private isCurrentRender(requestId: number): boolean {
    return this.pendingRender
      ? this.pendingRender.message.requestId === requestId
      : this.unavailable !== undefined && requestId === this.sourceRequestId;
  }

  /**
   * Marks source as potentially hung only if the page is actually drawing it, not while it is
   * loading or drawing an earlier request. A late answer clears the error.
   */
  private renderTimedOut(message: RenderMessage): void {
    const { state, drawing } = this;
    if (
      state?.source !== undefined &&
      state.error !== UNFINISHED &&
      this.webview.isReady &&
      drawing?.language === state.language &&
      drawing.source === state.source
    ) {
      this.state = { ...state, error: UNFINISHED };
      void this.store.save(this.state, this.shownRevision);
    }
    if (this.pendingRender?.message !== message) return;
    this.finishRender(
      message.requestId,
      notShown(
        `The diagram panel did not respond within ${RENDER_TIMEOUT_MS / 1000} seconds. It may still be drawing a large diagram. If it stays unresponsive, the diagram hangs it, and only restarting VS Code recovers it.`,
      ),
    );
  }

  private startRenderTimer(message: RenderMessage): void {
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => this.renderTimedOut(message), RENDER_TIMEOUT_MS);
  }

  /**
   * The page skips queued renders except the latest. Give that render a fresh timeout when the
   * preceding one finishes, even if its caller has already stopped waiting.
   */
  private pageAnswered(requestId: number): void {
    if (requestId === this.lastSent?.requestId) this.lastSent = undefined;
    if (requestId !== this.drawing?.requestId && this.lastSent) return;
    this.drawing = this.lastSent;
    if (this.drawing) this.startRenderTimer(this.drawing);
  }

  private finishRender(requestId: number, outcome: RenderOutcome): void {
    if (!this.isCurrentRender(requestId)) {
      return;
    }
    const pending = this.pendingRender;
    this.pendingRender = undefined;
    clearTimeout(this.renderTimer);
    this.unavailable = !outcome.ok && outcome.kind === "unavailable" ? outcome.error : undefined;
    if (pending) pending.resolve(outcome);
    else void this.keepOutcome(outcome);
  }

  /**
   * Persists source errors separately from panel availability failures.
   */
  private keepOutcome(result: RenderOutcome): Promise<void> | undefined {
    const state = this.state;
    if (!state) return undefined;
    if (!result.ok) {
      this.cancelPick(
        result.kind === "invalid" ? failsToRender(state.language, result.error) : result.error,
      );
      if (result.kind === "unavailable") return undefined;
    }
    const error = result.ok ? undefined : result.error;
    const source = result.ok && result.repair ? result.repair.source : state.source;
    if (state.error === error && state.source === source) return undefined;
    this.state = { ...state, source, error };
    return this.store.save(this.state, this.shownRevision);
  }

  private cancelRender(error: string): void {
    if (this.pendingRender) {
      this.finishRender(this.pendingRender.message.requestId, notShown(error));
    }
  }

  // Picking and marking nodes.

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
    const nothing = this.nothingTo("pick from");
    if (nothing) {
      return { picked: false, reason: nothing };
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

  /** Replaces marks without redrawing, reporting any unknown node ids. */
  annotate(annotation: Annotation): AnnotateOutcome {
    const nothing = this.nothingTo("mark");
    if (nothing) {
      return { ok: false, reason: nothing };
    }
    if (!this.drawn) {
      return {
        ok: false,
        reason:
          this.unavailable ??
          `The panel is still drawing the ${diagramNoun(this.state?.language ?? "mermaid")}. Wait for the current render and retry.`,
      };
    }
    // The tool reopens the panel before marking, so relationship aliases and repeated chart
    // names can be resolved against the completed drawing.
    const drawn = this.drawn;
    const names = this.itemNames;
    const claimed = new Set(annotation.marks.map((mark) => mark.id));
    const marks: Annotation["marks"] = [];
    const unknown: Resolved[] = [];
    const repeated: RepeatedName[] = [];
    const several: Resolved[] = [];
    const given = new Map<string, string>();
    for (const mark of annotation.marks) {
      // A name that several items of a series go by does not say which of them to mark.
      const named = drawn?.repeatedNames?.find(({ name }) => name === mark.id);
      if (named) {
        repeated.push(named);
        continue;
      }
      let id = mark.id;
      // Preserve exact chart names. Only repair padding for a known, unclaimed node.
      if (names && !names.has(id) && names.has(id.trim()) && !claimed.has(id.trim())) {
        id = id.trim();
        claimed.add(id);
      }
      if (!names || names.has(id)) {
        marks.push(id === mark.id ? mark : { ...mark, id });
        continue;
      }
      // An edge or message named by its ends, as one of several there, like a name that several
      // chart items go by, does not say which of them to mark.
      const resolved = { name: mark.id, ...names.resolve(mark.id) };
      const [only, ...others] = resolved.ids;
      if (only === undefined) {
        unknown.push(resolved);
      } else if (others.length > 0) {
        several.push(resolved);
      } else if (claimed.has(only)) {
        unknown.push({ ...resolved, why: `it is ${JSON.stringify(only)}, marked already` });
      } else {
        claimed.add(only);
        given.set(only, mark.id);
        marks.push({ ...mark, id: only });
      }
    }
    this.annotation = { ...annotation, marks };
    // Reveal a hidden panel without taking the focus from chat.
    this.show(true);
    this.post({ type: "annotate", ...this.annotation });
    return { ok: true, annotation: this.annotation, unknown, repeated, several, given, names };
  }

  /** Why there is no drawing to pick from or mark, if there is none. */
  private nothingTo(action: "pick from" | "mark"): string | undefined {
    const state = this.state;
    if (!state) {
      return `There is no diagram to ${action}. Render one with ${RENDER_TOOL} or ${CHART_TOOL} first.`;
    }
    if (state.source === undefined) {
      return `The chart is not drawn, as it was too large to keep when VS Code closed. Draw it again with ${CHART_TOOL} first.`;
    }
    if (state.error) {
      return failsToRender(state.language, state.error, action);
    }
    return undefined;
  }

  // Source edits, and writing them back to the document a diagram was opened from.

  /** Applies the user's source edit and writes it to its bound document, if any. */
  private async applyEdit(source: string): Promise<void> {
    const state = this.state;
    if (!state) {
      return;
    }
    // Update inferred titles with the source; keep explicit titles and the current viewport.
    const title =
      !state.chart &&
      state.source !== undefined &&
      state.title === guessTitle({ language: state.language, source: state.source })
        ? guessTitle({ language: state.language, source })
        : state.title;
    // Keep the original agent source across successive user edits.
    const { userEdit } = state;
    const from = userEdit && userEdit.to === state.source ? userEdit.from : state.source;
    const drawnByAgent = state.origin !== "document" && !state.chart;
    this.state = {
      ...state,
      source,
      error: undefined,
      title,
      editedByUser: true,
      userEdit:
        drawnByAgent && from !== undefined && from !== source ? { from, to: source } : undefined,
      chartPresentation: state.chart
        ? captureChartPresentation(source, state.chartPresentation)
        : undefined,
    };
    this.selection = [];
    this.annotation = undefined;
    this.cancelPick("The user edited the diagram source instead of picking.");
    this.userChanges++;
    const outcome = await this.renderCurrent();
    const binding = state.document && this.movedBinding(state.document);
    // An intervening render must not redirect this Apply to another document, even if the source
    // happens to match.
    if (binding && this.state?.document === binding && this.state.source === source) {
      if (!outcome.ok) {
        void vscode.window.showWarningMessage(
          `The ${diagramNoun(state.language)} was not written to ${documentName(binding)}: ${outcome.error} Your edits are kept in the panel.`,
        );
        return;
      }
      await this.writeToDocument(binding, source);
    }
  }

  /** Writes the current diagram without requiring a source edit first. */
  private async writeShownToDocument(): Promise<void> {
    const state = this.state;
    if (!state?.document || state.source === undefined) {
      return;
    }
    const noun = diagramNoun(state.language);
    let warning: string;
    if (this.pendingRender) {
      warning = `Wait for the ${noun} to finish rendering before writing it.`;
    } else if (this.unavailable) {
      warning = `The ${noun} was not written: ${this.unavailable} Reopen the panel and try again.`;
    } else if (state.error) {
      warning = `The ${noun} was not written, as it fails to render: ${state.error}`;
    } else {
      return this.writeToDocument(state.document, state.source);
    }
    void vscode.window.showWarningMessage(warning);
  }

  /**
   * Confirms writes that an agent replacement or chart code may have caused, and follows the
   * document block after a successful write.
   */
  private async writeToDocument(binding: DocumentBinding, source: string): Promise<void> {
    const revision = this.shownRevision;
    const isCurrent = (current: DocumentBinding) => () =>
      this.shownRevision === revision &&
      this.state?.document === current &&
      this.state.source === source;
    if (
      (binding.replaced || this.pageRanCode) &&
      !(await this.confirmForPage(() =>
        confirmWrite(binding, binding.replaced ? "replaced" : "code"),
      ))
    ) {
      return;
    }
    if (!isCurrent(this.movedBinding(binding))()) {
      void vscode.window.showWarningMessage(
        "The diagram changed while you were confirming the write. Review it and write it again.",
      );
      return;
    }
    // Serialize writes so each one uses the block's position after the preceding write.
    const previous = this.writing;
    const writing = (async () => {
      await previous;
      const current = this.movedBinding(binding);
      const outcome = await writeFence(current, source, isCurrent(current));
      if (!outcome.written) {
        // Not awaited: the message stays until dismissed, and the diagram can be edited meanwhile.
        void reportWriteFailure(current, outcome.reason, source);
        return;
      }
      // Follow the written block, unless another diagram acquired its own binding while writing.
      const moved = { uri: current.uri, fence: outcome.fence };
      this.movedBindings.set(current, moved);
      const state = this.state;
      const bound = state?.document;
      // Agent edits can copy this binding during the write. Move those copies too, preserving
      // their confirmation requirement.
      if (bound && bound.uri === current.uri && bound.fence === current.fence) {
        const followed = bound === current ? moved : { ...bound, fence: outcome.fence };
        if (bound !== current) this.movedBindings.set(bound, followed);
        this.state = { ...state, document: followed };
        await this.store.save(this.state, this.shownRevision);
      }
    })();
    this.writing = writing.catch(() => {});
    await writing;
  }

  /** The binding of the block as the panel last wrote it, or its document was last renamed. */
  private movedBinding(binding: DocumentBinding): DocumentBinding {
    const moved = this.movedBindings.get(binding);
    return moved ? this.movedBinding(moved) : binding;
  }

  /** Follows file and folder renames for document writes and export locations. */
  private followRenames(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): void {
    const renamed = (uri: string | undefined) => {
      if (uri === undefined) return undefined;
      for (const { oldUri, newUri } of files) {
        const old = oldUri.toString().replace(/\/$/, "");
        if (uri === old || uri.startsWith(`${old}/`)) {
          return newUri.toString().replace(/\/$/, "") + uri.slice(old.length);
        }
      }
      return undefined;
    };
    const state = this.state;
    const uri = state?.document && renamed(state.document.uri);
    const openedFrom = renamed(state?.openedFrom);
    if (!state || (uri === undefined && openedFrom === undefined)) return;
    const document = state.document && uri !== undefined ? { ...state.document, uri } : undefined;
    // A write that waits for its turn, or an Apply that waits for its render, follows it too.
    if (state.document && document) this.movedBindings.set(state.document, document);
    this.state = {
      ...state,
      ...(document && { document }),
      ...(openedFrom !== undefined && { openedFrom }),
    };
    void this.store.save(this.state, this.shownRevision);
    const tab = this.webview.tab;
    if (tab && document) {
      tab.title = `${state.title} — ${documentName(document)}`;
      this.post({ type: "writeTo", writeTo: documentName(document) });
    }
  }

  /** Reopens and redraws if needed to resolve item ids, keeping the current revision. */
  async itemIds(): Promise<readonly string[] | undefined> {
    const state = this.state;
    if (state && !this.drawn && !this.pendingRender && !state.error) {
      const opened = this.webview.reveal(true);
      await this.renderCurrent({ redraw: true, newPage: opened });
    }
    return this.drawnIds;
  }

  /** Reads identities from the renderer, including chart ids not kept by the host. */
  async readItems(query: ItemQuery): Promise<ItemPage | string> {
    if (this.pendingRender)
      return "The panel is still drawing. Await the render before reading items.";
    const revision = this.revision;
    await this.itemIds();
    if (revision !== this.revision)
      return "The diagram changed while reopening. Read its state and retry.";
    const renderRequestId = this.drawn?.requestId;
    if (renderRequestId === undefined || !this.webview.isReady) {
      return 'Items are unavailable. Read diagram_getState with detail:"summary" for render errors or missing chart data.';
    }
    const requestId = this.nextRequestId++;
    const result = await new Promise<ItemsResult>((resolve) => {
      const timeout = setTimeout(
        () =>
          this.finishItems({
            type: "itemsError",
            requestId,
            message: "The panel did not return items within 15 seconds. Try again.",
          }),
        RENDER_TIMEOUT_MS,
      );
      this.pendingItems.set(requestId, (result) => {
        clearTimeout(timeout);
        resolve(result);
      });
      this.post({ type: "getItems", requestId, renderRequestId, ...query });
    });
    return result.type === "items" ? result.page : result.message;
  }

  private finishItems(result: ItemsResult): void {
    const resolve = this.pendingItems.get(result.requestId);
    this.pendingItems.delete(result.requestId);
    resolve?.(result);
  }

  private cancelItems(): void {
    for (const requestId of this.pendingItems.keys()) {
      this.finishItems({
        type: "itemsError",
        requestId,
        message: "The diagram changed or closed while reading items. Read its state and retry.",
      });
    }
  }

  /**
   * Applies an agent edit, retaining invalid source so the agent can repair it. Surviving items
   * keep their selection and marks. Writing an agent edit back to a document needs confirmation.
   */
  async editByAgent(
    edit: Pick<DiagramState, "source"> &
      Partial<Pick<DiagramState, "title" | "links" | "chartPresentation">>,
    revision: number,
  ): Promise<Drawn> {
    const state = this.state;
    if (!state || revision !== this.shownRevision) {
      throw new Error(
        `The diagram changed. Read ${GET_STATE_TOOL} and retry with its current revision.`,
      );
    }
    if (this.pendingRender) {
      throw new Error("The diagram is still being drawn. Wait for the current render and retry.");
    }
    this.state = {
      ...state,
      ...edit,
      error: undefined,
      // An agent source edit ends the user diff; metadata-only edits keep it.
      userEdit: edit.source === state.source ? state.userEdit : undefined,
      document: state.document && { ...state.document, replaced: true },
      origin: "tool",
    };
    this.cancelPick("The diagram changed before the user picked.");
    this.webview.reveal(true);
    const outcome = await this.renderCurrent({ keepSelection: true });
    // Remove stale identities; the page only reports selection when some items remain.
    const { annotation, itemNames: known } = this;
    if (outcome.ok && known) {
      this.selection = this.selection.filter(({ id }) => known.has(id));
      const marks = annotation?.marks.filter(({ id }) => known.has(id));
      if (annotation && marks && marks.length < annotation.marks.length) {
        this.annotation = { ...annotation, marks };
        this.post({ type: "annotate", ...this.annotation });
      }
    }
    return outcome;
  }

  // Charts generated from data.

  /** The chart's table, from its inline data if need be; never reads a file or runs a command. */
  get loadedChartData(): DataTable | undefined {
    const chart = this.state?.chart;
    if (!this.chartTable && chart?.data !== undefined) {
      this.chartTable = parseTable(chart.data, chart.format);
    }
    return this.chartTable;
  }

  /** Changes the generated chart's settings, rebuilding it from the kept table and styling. */
  async updateChart(
    input: ChartUpdateInput,
    token: vscode.CancellationToken,
  ): Promise<Drawn & { summary?: string }> {
    throwIfCancelled(token);
    const state = this.state;
    if (!state?.chart) {
      throw new Error(
        `The current diagram is not a generated chart. Create one with ${CHART_TOOL} first.`,
      );
    }
    const chart = updatedChartSpec(state.chart, input);
    if (input.revision !== undefined && input.revision !== this.shownRevision) {
      throw new Error(
        `The chart changed. Read ${GET_STATE_TOOL} and retry with its current revision.`,
      );
    }
    if (this.pendingRender) {
      throw new Error("Wait for the current diagram to finish rendering before updating it.");
    }
    assertChartPresentation(state.chartPresentation);
    const table = this.loadedChartData;
    if (!table) {
      // The table of a file or command is not kept when VS Code restarts.
      throw new Error(
        `The chart's data is not loaded, and ${UPDATE_CHART_TOOL} never rereads files or reruns ` +
          `commands. Call ${CHART_TOOL} again with the same ${state.chart.command ? "command" : "file"} ` +
          "and the new settings, or ask the user to press Refresh in the diagram panel.",
      );
    }
    const { state: next, summary } = withRebuiltChart(state, chart, table, state.chartPresentation);
    this.webview.reveal(true);
    const outcome = await this.showOrKeep(
      {
        ...next,
        origin: "tool",
        document: state.document && { ...state.document, replaced: true },
      },
      { table, pickReason: "The chart changed before the user picked.", token },
    );
    throwIfCancelled(token);
    if (!outcome.ok) return outcome;
    return { ...outcome, summary };
  }

  /** Highlights the shortest path between the two nodes selected in the page, if any. */
  highlightPath(): void {
    this.post({ type: "highlightPath" });
  }

  /** Clears the user's selection and any marks or dimming an agent added. */
  clearSelection(): void {
    if (this.pendingPick) return;
    this.selection = [];
    this.annotation = undefined;
    this.post({ type: "clearSelection" });
    this.post({ type: "annotate", marks: [], dim: false });
  }

  /** Shows or hides Chart Options. Opening them never reads a file or runs a command. */
  toggleChartOptions(): void {
    if (!this.state?.chart) {
      void vscode.window.showInformationMessage(
        "Chart Options is available for charts created from data.",
      );
      return;
    }
    // The command palette can run it with the panel hidden, which then shows the options.
    this.chartOptionsVisible = !(this.chartOptionsVisible && this.webview.tab?.visible);
    this.show();
    this.sendChartOptions();
  }

  /** Shows the commands of the Command Palette that can act on the diagram now. */
  private updateContext(): void {
    const setContext = (key: string, value: boolean) =>
      void vscode.commands.executeCommand("setContext", key, value);
    setContext("diagram.hasDiagram", this.state !== undefined);
    setContext("diagram.chartOptionsAvailable", this.state?.chart !== undefined);
  }

  private sendChartOptions(): void {
    const state = this.state;
    const chart = state?.chart;
    // Hidden controls need neither a parsed table nor a column list sent to the webview.
    // In particular, reopening an inline chart can render its saved source immediately.
    if (!chart || !this.chartOptionsVisible) {
      this.post({ type: "chartOptions" });
      return;
    }
    let unavailable: string | undefined;
    let table: DataTable | undefined;
    try {
      table = this.loadedChartData;
    } catch (error) {
      unavailable = errorMessage(error);
    }
    this.post({
      type: "chartOptions",
      state: {
        revision: this.shownRevision,
        controls: chartControls(chart),
        columns: table?.columns ?? [],
        rowCount: table?.rows.length ?? 0,
        refreshable: Boolean(chart.file || chart.command),
        // Edits that the chart cannot keep when rebuilt from its data.
        edited: Boolean(state.chartPresentation?.blocked),
        unavailable:
          unavailable ??
          (table ? undefined : "Press Refresh to load the data before changing chart options."),
      },
    });
  }

  private async applyChartOptions(
    message: Extract<FromWebview, { type: "applyChartOptions" }>,
  ): Promise<void> {
    const state = this.state;
    const tab = this.webview.tab;
    try {
      if (!state?.chart || message.revision !== this.shownRevision) {
        throw new Error("The chart changed. Reopen Chart Options and try again.");
      }
      if (!message.replaceSource) assertChartPresentation(state.chartPresentation);
      const { controls } = message;
      const reset = controls === undefined;
      let table = this.chartTable;
      if (!table && reset) {
        const loaded = await this.reloadTable(
          state.chart,
          "Resetting chart styling and reloading data",
        );
        // Declined or cancelled, which ends the reset in the form, as the options do.
        if (!loaded) return this.sendChartOptions();
        if (message.revision !== this.shownRevision || this.webview.tab !== tab || !tab) return;
        table = loaded.table;
        if (loaded.warning) void vscode.window.showWarningMessage(loaded.warning);
      }
      if (!table) throw new Error("Press Refresh to load the chart data first.");
      const chart = reset ? state.chart : withChartControls(state.chart, controls);
      const kept = reset || message.replaceSource ? undefined : state.chartPresentation;
      this.userChanges++;
      const outcome = await this.showOrKeep(withRebuiltChart(state, chart, table, kept).state, {
        table,
        pickReason: "Chart options changed before the user picked.",
      });
      // Unless the chart was replaced or closed meanwhile, which says nothing about the options.
      if (!outcome.ok && this.state === state && this.webview.tab === tab) {
        throw new Error(`Could not apply the chart options: ${outcome.error}`);
      }
    } catch (error) {
      this.post({ type: "chartOptionsError", message: errorMessage(error) });
    }
  }

  /** Reloads chart data while retaining supported manual presentation edits. */
  private async refreshChart(): Promise<void> {
    const chart = this.state?.chart;
    const presentation = this.state?.chartPresentation;
    const revision = this.shownRevision;
    const tab = this.webview.tab;
    if (!chart || this.refreshing) {
      return;
    }
    this.refreshing = true;
    try {
      assertChartPresentation(presentation);
      const loaded = await this.reloadTable(chart, "Refreshing chart");
      if (!loaded) return;
      const { table, warning } = loaded;
      // Any intervening change wins, even if an edit restored the same source.
      const state = this.state;
      if (this.shownRevision !== revision || this.webview.tab !== tab || !tab || !state) {
        return;
      }
      if (warning) void vscode.window.showWarningMessage(warning);
      this.userChanges++;
      const outcome = await this.showOrKeep(
        withRebuiltChart(state, chart, table, presentation).state,
        { table, pickReason: "The chart data was refreshed before the user picked." },
      );
      if (!outcome.ok && this.state === state && this.webview.tab === tab) {
        void vscode.window.showErrorMessage(`Could not refresh the chart: ${outcome.error}`);
      }
    } catch (error) {
      if (this.shownRevision === revision && this.webview.tab === tab) {
        void vscode.window.showErrorMessage(`Could not refresh the chart: ${errorMessage(error)}`);
      }
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Reloads data, confirming file reads when needed and command reruns when chart code could
   * have forged the Refresh request.
   *
   * @returns undefined if the user declined or cancelled.
   */
  private async reloadTable(
    chart: ChartSpec,
    title: string,
  ): Promise<Awaited<ReturnType<typeof loadTable>> | undefined> {
    const tab = this.webview.tab;
    const revision = this.shownRevision;
    const code = this.pageRanCode
      ? "\n\nThe panel ran JavaScript code from a chart, which can press Refresh as if you had."
      : "";
    const confirm = (message: string, detail: string, action: string) =>
      this.confirmForPage(async () => {
        const options = { modal: true, detail: `${detail}${code}` };
        return (await vscode.window.showWarningMessage(message, options, action)) !== undefined;
      });
    let unasked: { retry: string } | undefined;
    if (chart.file !== undefined) {
      let uri: vscode.Uri | undefined;
      try {
        uri = resolveFile(chart.file);
      } catch {
        // Reported when loading.
      }
      if (uri && readAsks(uri)) {
        if (!(await confirm("Read the chart's data file again?", fileName(uri), "Read"))) return;
      } else {
        unasked = { retry: "Try again to be asked." };
      }
    } else if (chart.command !== undefined && code) {
      const message = "Run the chart's command again to reload its data?";
      if (!(await confirm(message, chart.command, "Run"))) return;
    }
    // Approval of an old chart must not start its command or read after the diagram changes.
    if (this.webview.tab !== tab || this.shownRevision !== revision) return;
    this.reloading?.cancel();
    const reloading = new vscode.CancellationTokenSource();
    this.reloading = reloading;
    try {
      return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: true },
        (_progress, token) => {
          token.onCancellationRequested(() => reloading.cancel());
          return loadTable(chart, reloading.token, unasked);
        },
      );
    } catch (error) {
      if (error instanceof vscode.CancellationError) return undefined;
      throw error;
    } finally {
      if (this.reloading === reloading) this.reloading = undefined;
      reloading.dispose();
    }
  }

  /**
   * Allows one confirmation at a time. After a refusal on a page that ran chart code, suppress
   * further requests so that code cannot flood the user with modal dialogs.
   */
  private async confirmForPage(ask: () => Thenable<boolean>): Promise<boolean> {
    if (this.confirming || this.pageRefused) return false;
    this.confirming = true;
    try {
      const confirmed = await ask();
      if (!confirmed && this.pageRanCode) this.pageRefused = true;
      return confirmed;
    } catch {
      // A question that VS Code does not show, as while the window closes, confirms nothing.
      return false;
    } finally {
      this.confirming = false;
    }
  }

  /**
   * Tries a chart update and restores the previous state on failure or cancellation, unless
   * another update has intervened. Chart updates clear selection and marks.
   */
  private async showOrKeep(
    next: DiagramState,
    {
      table,
      pickReason,
      token,
    }: {
      table: DataTable | undefined;
      pickReason: string;
      token?: vscode.CancellationToken | undefined;
    },
  ): Promise<Drawn> {
    const { state, chartTable, annotation } = this;
    const tab = this.webview.tab;
    const noun = diagramNoun(next.language);
    this.state = next;
    this.chartTable = table;
    this.selection = [];
    this.annotation = undefined;
    this.cancelPick(pickReason);
    const version = this.renderVersion + 1;
    const cancellation = token?.onCancellationRequested(() => {
      if (this.renderVersion === version) this.cancelRender(`The ${noun} update was cancelled.`);
    });
    let outcome: Drawn;
    try {
      outcome = await this.renderCurrent();
    } finally {
      cancellation?.dispose();
    }
    const cancelled = token?.isCancellationRequested ?? false;
    if ((outcome.ok && !cancelled) || this.renderVersion !== version || !state) return outcome;
    this.state = state;
    this.chartTable = chartTable;
    this.annotation = annotation;
    await this.store.save(state, this.shownRevision);
    if (this.renderVersion === version && tab && this.webview.tab === tab) {
      // Draw the kept chart again, also after a page that stopped responding, which may still draw
      // the abandoned chart. Only a chart that failed to render waits for the kept one.
      const restoring = this.renderCurrent();
      if (!cancelled && !outcome.ok && outcome.kind === "invalid") {
        await (token ? unlessCancelled(() => restoring, token) : restoring);
      }
    }
    return outcome.ok
      ? outcome
      : { ...outcome, error: `${outcome.error} The previous ${noun} is kept.` };
  }

  // Export.

  /**
   * Exports a snapshot through VS Code's format picker and save dialog, opening the panel to draw
   * the diagram first if it is closed, as when the Command Palette runs the export.
   */
  async exportDiagram(): Promise<void> {
    if (this.exporting) return;
    this.exporting = true;
    try {
      if (this.state && !this.webview.tab) {
        this.webview.reveal(true);
        await this.renderCurrent({ redraw: true, newPage: true });
      }
      await this.exportShown();
    } finally {
      this.exporting = false;
    }
  }

  private async exportShown(): Promise<void> {
    const state = this.state;
    const noun = state && diagramNoun(state.language);
    let warning: string | undefined;
    if (!state) {
      warning = "Open or draw a diagram before exporting it.";
    } else if (this.pendingRender) {
      warning = `Wait for the ${noun} to finish rendering before exporting it.`;
    } else if (state.source === undefined) {
      warning = "Press Refresh to draw the chart again, then export it.";
    } else if (state.error) {
      warning = `There is nothing to export, as the ${noun} fails to render: ${state.error}`;
    } else if (!this.webview.isReady || !this.drawn) {
      warning = `${this.unavailable ?? `The diagram panel is not showing the ${noun}.`} Use Diagram: Show Panel and try again.`;
    }
    if (warning || state?.source === undefined) {
      void vscode.window.showWarningMessage(warning ?? "There is no diagram to export.");
      return;
    }
    const revision = this.shownRevision;
    const openedFrom = state.document?.uri ?? state.openedFrom;
    await exportDrawing(
      {
        language: state.language,
        title: state.title,
        source: state.source,
        document: openedFrom === undefined ? undefined : vscode.Uri.parse(openedFrom),
      },
      (format) => {
        const rendered = this.drawn?.requestId;
        if (revision !== this.shownRevision || !this.webview.isReady || rendered === undefined) {
          throw new Error("The diagram changed or closed while choosing a format. Try again.");
        }
        return this.requestExport(
          { format, renderRequestId: rendered, forModel: false },
          `The diagram panel did not finish exporting within ${RENDER_TIMEOUT_MS / 1000} seconds. Try again or choose SVG.`,
        );
      },
      this.context.extensionUri,
    );
  }

  /**
   * Captures a bounded PNG for the model, optionally focused on item ids. Returns an error
   * string when capture fails.
   */
  async captureImage(
    limits: { maxSide: number; maxPixels: number },
    ids: string[] = [],
  ): Promise<{ png: Uint8Array; view: ImageView | undefined } | string> {
    const result = await this.captureDrawing({ format: "png", forModel: true, ...limits, ids });
    if (typeof result === "string") return result;
    const png = result.type === "exportImage" && result.format === "png" && pngBytes(result.data);
    return png
      ? { png, view: result.type === "exportImage" ? result.view : undefined }
      : "The diagram panel returned an invalid PNG image.";
  }

  /** Captures the current drawing's theme for HTML export. */
  async captureTheme(): Promise<Extract<ExportResult, { type: "exportTheme" }> | string> {
    const result = await this.captureDrawing({ format: "html", forModel: false });
    return typeof result === "string" || result.type === "exportTheme"
      ? result
      : "The diagram panel returned no theme for the export.";
  }

  private async captureDrawing(
    request: Omit<Extract<ToWebview, { type: "export" }>, "type" | "requestId" | "renderRequestId">,
  ): Promise<ExportResult | string> {
    const state = this.state;
    const revision = this.shownRevision;
    if (!state) {
      return "No diagram is shown.";
    }
    const noun = diagramNoun(state.language);
    if (this.pendingRender) {
      return `The panel is still drawing the ${noun}.`;
    }
    if (state.source === undefined) {
      return "The chart's data was not kept when VS Code restarted. The user can press Refresh to load it again.";
    }
    if (state.error) {
      return `The ${noun} fails to render. Render a working ${noun} first. The error is: ${state.error}`;
    }
    // Reopen without taking focus so the model captures the same drawing the user sees.
    if (!this.webview.tab || !this.drawn) {
      const opened = this.webview.reveal(true);
      await this.renderCurrent({ redraw: true, newPage: opened });
    }
    if (this.shownRevision !== revision) {
      return "The diagram changed while it was drawn. Try again.";
    }
    const rendered = this.drawn?.requestId;
    if (!this.webview.isReady || rendered === undefined) {
      return this.unavailable ?? `The diagram panel is not showing the ${noun} yet.`;
    }
    const result = await this.requestExport(
      { ...request, renderRequestId: rendered },
      `The diagram panel did not finish the image within ${RENDER_TIMEOUT_MS / 1000} seconds.`,
    );
    if (result.type === "exportError") {
      return result.message;
    }
    return result;
  }

  /** Asks the page for the drawing, answering with timedOut if it does not answer in time. */
  private requestExport(
    request: Omit<Extract<ToWebview, { type: "export" }>, "type" | "requestId">,
    timedOut: string,
  ): Promise<ExportResult> {
    const requestId = this.nextRequestId++;
    return new Promise((resolve) => {
      const timeout = setTimeout(
        () => this.finishExport({ type: "exportError", requestId, message: timedOut }),
        RENDER_TIMEOUT_MS,
      );
      this.pendingExports.set(requestId, (result) => {
        clearTimeout(timeout);
        resolve(result);
      });
      this.post({ type: "export", requestId, ...request });
    });
  }

  private finishExport(result: ExportResult): void {
    const resolve = this.pendingExports.get(result.requestId);
    this.pendingExports.delete(result.requestId);
    resolve?.(result);
  }

  private cancelExport(message: string): void {
    for (const requestId of this.pendingExports.keys()) {
      this.finishExport({ type: "exportError", requestId, message });
    }
  }

  // Clicks on nodes, and requests to chat.

  /** Where a node of the diagram shown links to in the code, if anywhere; an edge links nowhere. */
  private linkOf(node: DiagramNode): NodeLink | undefined {
    const links = this.state?.links;
    // Node ids are a model's words, so only the map's own entries count, not "constructor".
    return links && !node.relationship && Object.hasOwn(links, node.id)
      ? links[node.id]
      : undefined;
  }

  /** E.g. `Regarding "Parser", "Checker" in the diagram: `. */
  private regarding(nodes: DiagramNode[]): string {
    const noun = diagramNoun(this.state?.language ?? "mermaid");
    return nodes.length > 0
      ? `Regarding ${nodes.map((node) => (node.relationship ? nodeList([node]) : `"${node.label}"`)).join(", ")} in the ${noun}: `
      : `Regarding the ${noun}: `;
  }

  /**
   * Sends to the current chat, keeping selection available to its tools. Requests from chart code
   * or an old drawing only fill in the input for the user to review and send.
   */
  private async askInChat(text: string, review = false): Promise<void> {
    try {
      await vscode.commands.executeCommand("workbench.action.chat.open", {
        query: text,
        isPartialQuery: review || this.pageRanCode,
      });
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Could not send the request to chat: ${errorMessage(error)}`,
      );
    }
  }
}

/**
 * Rebuilds a chart while preserving manual styling. Automatically generated titles follow
 * the new settings; explicit titles are kept.
 */
function withRebuiltChart(
  state: DiagramState,
  chart: ChartSpec,
  table: DataTable,
  presentation: ChartPresentation | undefined,
): { state: DiagramState; summary: string } {
  const rebuilt = rebuildChart(chart, table, presentation);
  const made = state.chart !== undefined && state.title === chartTitle(state.chart);
  return {
    state: {
      ...state,
      title: made ? chartTitle(chart) : (chart.title ?? state.title),
      chart,
      source: formatOption(JSON.stringify(rebuilt.option)),
      error: undefined,
      chartPresentation: rebuilt.presentation,
      editedByUser: rebuilt.presentation.edits.length > 0,
    },
    summary: rebuilt.summary,
  };
}

function warn(message: string): undefined {
  void vscode.window.showWarningMessage(message);
}

/** The outcome of a render that the panel did not show, which says nothing about its source. */
function notShown(error: string): RenderOutcome {
  return { ok: false, kind: "unavailable", error };
}

function failsToRender(language: DiagramLanguage, error: string, action = "pick from"): string {
  const noun = diagramNoun(language);
  return `The ${noun} fails to render, so there is nothing to ${action}. Render a working ${noun} first. The error is: ${error}`;
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
