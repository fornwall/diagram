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
  RENDER_TOOL,
  type RepeatedName,
  type ToWebview,
  UPDATE_CHART_TOOL,
} from "./protocol";
import { runsCode } from "./webview/optionSource";
import { WebviewChannel } from "./webviewChannel";

/** Routes follow-up questions to the participant or the agent that invoked a tool. */
type DiagramOrigin = "participant" | "tool" | "document";

/** "invalid" means a source error; "unavailable" means the panel closed or stopped responding. */
export type RenderOutcome =
  | { ok: true; diagramType: string }
  | { ok: false; kind: "invalid" | "unavailable"; error: string };

/**
 * A render's outcome and the revision it drew, which the panel shows until its next change, also
 * when the render failed, and which tells it from a render for another request meanwhile.
 */
export type Drawn = RenderOutcome & { revision: number };

type PickOutcome = { picked: true; nodes: DiagramNode[] } | { picked: false; reason: string };

type AnnotateOutcome =
  | {
      ok: true;
      annotation: Annotation;
      unknown: string[];
      /** Names that several chart items go by, which were not marked. */
      repeated: RepeatedName[];
      /** The ids the marks were checked against, or undefined when the panel does not know them. */
      ids: readonly string[] | undefined;
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
  /**
   * The read-only document that the diagram was opened from without a binding, as
   * vscode.Uri.toString(), beside which it is exported as one with a binding is.
   */
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
  /** The last render error, if the current source fails to render. */
  error?: string | undefined;
}

const RENDER_TIMEOUT_MS = 15_000;

/**
 * The error of a source that the page did not finish drawing, until it does. It may hang the page,
 * which neither reloading its HTML nor reopening the panel recovers, as the webviews of a window
 * share a process; so that VS Code does not hang again once restarted, a new page does not draw it.
 */
const UNFINISHED =
  "The panel did not finish drawing it, so it is not drawn again on its own, as it may hang the panel. Edit and apply it, or render it again, to draw it anyway.";

/** The panel shared by the chat participant and language model tools. */
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
  /**
   * Counts changes to the diagram shown, which tools and Chart Options see as its revision. Drawing
   * the same diagram again, as when the page reloads, is no change.
   */
  private shownRevision = 0;
  /** Counts the changes that the user or a document started, such as an Apply or a Refresh. */
  private userChanges = 0;
  /** Pending renders and picks are replayed when the webview reloads. */
  private pendingRender: Pending<"render", RenderOutcome> | undefined;
  private pendingPick: Pending<"startPick", PickOutcome> | undefined;
  /** How to answer each export request that the page has yet to answer, by its id. */
  private readonly pendingExports = new Map<number, (result: ExportResult) => void>();
  /** Ends the pending render if the page does not answer it in time; see {@link renderTimedOut}. */
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The render that the page is drawing, which it took up as soon as it got it or once done with
   * the one before, and the last render sent to the page, until it answers that. The page skips
   * the renders sent between them.
   */
  private drawing: RenderMessage | undefined;
  private lastSent: RenderMessage | undefined;
  /** Why the last render did not finish, if the panel closed or stopped responding. */
  private unavailable: string | undefined;
  /**
   * Whether the page was sent a chart option with JavaScript code, which can post any message as
   * if the user had acted, and stays in the page. Reset only when the tab closes, as messages the
   * old page sent before a reload may still arrive after it.
   */
  private pageRanCode = false;
  /** Whether a confirmation that the page asked for is open; see {@link confirmForPage}. */
  private confirming = false;
  /** Whether the user declined what the page asked for while it held chart code. */
  private pageRefused = false;
  /**
   * The request that drew the current diagram, which is what an export captures and what a click
   * on the drawing names. One that fails to render has no drawing, and a click on the drawing of an
   * earlier render, sent just before the page drew the next, was on the diagram it replaced.
   */
  private renderedRequestId: number | undefined;
  /** Identifies the editable source even when its render fails. */
  private sourceRequestId: number | undefined;
  /** Rendered node ids, or undefined when unavailable. */
  private nodeIds: string[] | undefined;
  private relationships: DiagramNode[] = [];
  /** Names that several items of the chart go by, which marks must not use. */
  private repeatedNames: RepeatedName[] = [];
  private renderWarnings: string[] = [];
  /** The title of the diagram before the user's edits of its source changed it, if they did. */
  private firstTitle: string | undefined;

  private chartTable: DataTable | undefined;
  private chartOptionsVisible = false;
  private refreshing = false;
  /**
   * Ends the data load of a refresh or reset, as the panel closes, the diagram changes or another
   * load starts.
   */
  private reloading: vscode.CancellationTokenSource | undefined;
  private exporting = false;
  /** The last write to a document, which the next one waits for. */
  private writing: Promise<void> | undefined;
  /** Where a binding moved once its block was written, as the panel follows the written block. */
  private readonly movedBindings = new WeakMap<DocumentBinding, DocumentBinding>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.store = new StateStore(context.workspaceState);
    this.webview = new WebviewChannel(
      context.extensionUri,
      (message) => this.onMessage(message),
      () => this.closed(),
    );
    this.state = this.store.load();
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

  /**
   * How many changes to the diagram the user or a document has started, which a chat reply that
   * sees this change while it streams must not draw over.
   */
  get userChangeCount(): number {
    return this.userChanges;
  }

  /**
   * The ids of the nodes the panel has drawn, when it knows them, so that a model can be told that
   * a node it named is not there. A chart reports none: its items are its data, not a list of ids.
   */
  get drawnIds(): readonly string[] | undefined {
    return this.nodeIds;
  }

  /** What a model should know about parts of the source that the panel did not draw. */
  get warnings(): readonly string[] {
    return this.renderWarnings;
  }

  /**
   * Describes the current diagram and the user's interactions with it, for a language model.
   * `detail` says how much of a long source and relationship list to give. Without `callsTools`, the
   * model is not told to call a tool for them, nor the revision, which only diagram_updateChart
   * takes.
   */
  describeForModel({
    detail = "brief",
    callsTools = true,
  }: {
    detail?: Detail;
    callsTools?: boolean;
  } = {}): string | undefined {
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
      relationships: this.relationships,
      repeatedNames: this.repeatedNames,
      // A page busy with a large drawing may still show it.
      warnings: this.unavailable
        ? [...this.renderWarnings, `The panel is not showing it yet: ${this.unavailable}`]
        : this.renderWarnings,
      chartTable,
      detail,
      callsTools,
    });
    return callsTools ? `Revision: ${this.shownRevision}.\n\n${description}` : description;
  }

  /** Opens and renders a diagram. */
  async render(diagram: Diagram, origin: DiagramOrigin, chartTable?: DataTable): Promise<Drawn> {
    // Keep document bindings across agent replacements; a later Apply requires confirmation. A
    // diagram opened from a document without one, as it is read-only, is not written anywhere,
    // but is still exported beside it.
    const previous = origin === "document" ? undefined : this.state;
    const previousBinding = previous?.document;
    const document =
      diagram.document ??
      (previousBinding?.fence.language === diagram.language
        ? { ...previousBinding, replaced: true }
        : undefined);
    this.state = {
      ...diagram,
      document,
      openedFrom:
        diagram.openedFrom ??
        (previous?.language === diagram.language ? previous.openedFrom : undefined),
      origin,
      editedByUser: false,
      chartPresentation: diagram.chart
        ? (diagram.chartPresentation ?? captureChartPresentation(diagram.source))
        : undefined,
    };
    this.chartTable = diagram.chart ? chartTable : undefined;
    this.chartOptionsVisible = false;
    this.updateContext();
    this.firstTitle = undefined;
    this.selection = [];
    this.annotation = undefined;
    this.cancelPick("The diagram was replaced before the user picked.");
    if (origin === "document") this.userChanges++;
    this.webview.reveal(origin !== "document");
    return this.renderCurrent();
  }

  /**
   * Takes the diagram that the participant's tool call drew, at `revision`, as the participant's,
   * unless something changed it since.
   */
  adopt(revision: number | undefined): Readonly<DiagramState> | undefined {
    if (!this.state || revision !== this.shownRevision) {
      return undefined;
    }
    this.state = { ...this.state, origin: "participant" };
    void this.store.save(this.state);
    return this.state;
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
  }

  // The webview, and the requests waiting for its answers.

  private closed(): void {
    this.pageRanCode = false;
    this.pageRefused = false;
    this.reloading?.cancel();
    this.cancelExport("The diagram panel was closed before export finished.");
    this.selection = [];
    this.cancelPick("The user closed the diagram panel.");
    this.cancelRender("The diagram panel was closed before it finished rendering.");
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
      } else if (message.type === "startPick") {
        this.finishPick(message.pickId, { picked: false, reason: error });
      }
    });
  }

  /** Handles a message from the webview, returning any work it starts, for tests to await. */
  private onMessage(message: FromWebview): Promise<void> | undefined {
    switch (message.type) {
      case "ready":
        this.cancelExport("The diagram panel reloaded before export finished. Try again.");
        // The webview loaded, or lost its content and loaded again (e.g. when moved to another
        // window). Keep the pending request id so its caller is answered.
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
        if (this.pendingPick) {
          this.post(this.pendingPick.message);
        }
        break;
      case "rendered":
        this.pageAnswered(message.requestId);
        // The ids of what was drawn, for telling a model that a node it names is not there. A late
        // answer to a replaced render says nothing about the diagram now shown.
        if (this.isCurrentRender(message.requestId)) {
          this.nodeIds = message.nodeIds;
          this.relationships = message.relationships?.filter((node) => node.relationship) ?? [];
          this.repeatedNames = message.repeatedNames ?? [];
          this.renderWarnings = message.warnings ?? [];
        }
        this.finishRender(message.requestId, { ok: true, diagramType: message.diagramType });
        break;
      case "renderError":
        this.pageAnswered(message.requestId);
        this.finishRender(message.requestId, {
          ok: false,
          kind: message.unavailable ? "unavailable" : "invalid",
          error: message.message,
        });
        break;
      case "selectionChanged":
        if (message.requestId === this.sourceRequestId) this.selection = message.nodes;
        break;
      case "sourceEdited":
        if (message.requestId === this.sourceRequestId) {
          return this.applyEdit(message.source);
        }
        void vscode.window.showWarningMessage(
          "The diagram changed before your edit arrived. Your draft is kept in the source view; review it and apply again.",
        );
        break;
      case "closeChartOptions":
        this.chartOptionsVisible = false;
        break;
      case "resetChartStyling":
      case "applyChartOptions":
        return this.applyChartOptions(message);
      case "refresh":
        return this.refreshChart();
      case "exportImage":
      case "exportTheme":
      case "exportError":
        this.finishExport(message);
        break;
      case "writeToDocument":
        if (message.requestId === this.sourceRequestId) {
          return this.writeShownToDocument();
        }
        void vscode.window.showWarningMessage(
          "The diagram changed before it could be written. Review it and write it again.",
        );
        break;
      case "ask":
        return this.askInChat(
          `${this.regarding(message.nodes)}${message.text}`,
          message.requestId !== this.sourceRequestId,
        );
      case "clickToAsk":
        if (this.state?.clickPrompt && message.requestId === this.renderedRequestId) {
          return this.askInChat(clickToAskQuery(this.state.clickPrompt, message.node.label));
        }
        break;
      case "clickToOpen": {
        // The message names the node; its location comes from the links validated here, so that
        // the webview, which shows what a model wrote, cannot open a path of its own choosing.
        const link =
          message.requestId === this.renderedRequestId ? this.linkOf(message.node) : undefined;
        return (
          link &&
          openLink(link, message.node.label, this.webview.tab?.viewColumn, (ask) =>
            this.confirmForPage(ask),
          )
        );
      }
      case "openUrl":
        if (this.state && message.requestId === this.renderedRequestId) {
          return openUrl(message.url, diagramNoun(this.state.language), this.pageRanCode, (ask) =>
            this.confirmForPage(ask),
          );
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
    return undefined;
  }

  /**
   * Shows the current diagram in the webview, and keeps its render error, if any, for later
   * requests. A redraw shows the diagram shown before, in the same revision; to a new page, it
   * shows a diagram that the page did not finish drawing as failing instead.
   */
  private async renderCurrent({ redraw = false, newPage = false } = {}): Promise<Drawn> {
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
    this.renderedRequestId = undefined;
    this.sourceRequestId = undefined;
    const version = ++this.renderVersion;
    const revision = this.shownRevision;
    this.sendChartOptions();
    // What was drawn before says nothing about the rendering being drawn now.
    this.nodeIds = undefined;
    this.relationships = [];
    this.repeatedNames = [];
    this.renderWarnings = [];
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
      clickPrompt: state.clickPrompt,
      links: state.links && linkTexts(state.links),
      refreshFrom,
      writeTo: state.document && documentName(state.document),
      firstTitle: this.firstTitle,
      notDrawn: newPage && state.error === UNFINISHED ? UNFINISHED : undefined,
    } as const;
    this.sourceRequestId = message.requestId;
    // Preserve new source even if VS Code reloads before the webview answers.
    let saved = this.store.save(state);
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
   * Whether the page's answer is to the render the panel waits for, or else to the render of the
   * current source that the panel stopped waiting for, which a page busy with a large drawing can
   * still finish.
   */
  private isCurrentRender(requestId: number): boolean {
    return this.pendingRender
      ? this.pendingRender.message.requestId === requestId
      : this.unavailable !== undefined && requestId === this.sourceRequestId;
  }

  /**
   * Ends the render if it is pending, as the page did not answer it in time. The current source
   * may hang the page if the page is drawing it, also after its render ended so, but not if the
   * page is busy with another source or is not ready yet.
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
      // A late answer replaces the error.
      this.state = { ...state, error: UNFINISHED };
      void this.store.save(this.state);
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
   * Notes that the page answered a render: once it answers the last one, it is done with all. Done
   * with the one it was drawing, it skips the renders sent meanwhile but the last, which it takes
   * up now, with the full time for it, even if the panel stopped waiting for it.
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
    this.renderedRequestId = outcome.ok ? requestId : undefined;
    this.unavailable = !outcome.ok && outcome.kind === "unavailable" ? outcome.error : undefined;
    if (pending) pending.resolve(outcome);
    else void this.keepOutcome(outcome);
  }

  /**
   * Keeps the render error of the current source, if any, for later requests, and saves it if it
   * changed. An unavailable panel says nothing about the source.
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
    if (state.error === error) return undefined;
    this.state = { ...state, error };
    return this.store.save(this.state);
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
    // The ids of the diagram as it is drawn now: opening the panel below draws it again.
    const ids = this.nodeIds && [...this.nodeIds, ...this.relationships.map((node) => node.id)];
    const known = ids && new Set(ids);
    const claimed = new Set(annotation.marks.map((mark) => mark.id));
    const marks: Annotation["marks"] = [];
    const unknown: string[] = [];
    const repeated: RepeatedName[] = [];
    for (const mark of annotation.marks) {
      // A name that several items of a series go by does not say which of them to mark.
      const named = this.repeatedNames.find(({ name }) => name === mark.id);
      if (named) {
        repeated.push(named);
        continue;
      }
      let id = mark.id;
      // Preserve exact chart names. Only repair padding for a known, unclaimed node.
      if (known && !known.has(id) && known.has(id.trim()) && !claimed.has(id.trim())) {
        id = id.trim();
        claimed.add(id);
      }
      if (known && !known.has(id)) {
        unknown.push(mark.id);
      } else {
        marks.push(id === mark.id ? mark : { ...mark, id });
      }
    }
    this.annotation = { ...annotation, marks };
    // Showing the panel may have to open it, which renders the diagram again; the marks follow on
    // the webview's ready message either way.
    this.show(true);
    this.post({ type: "annotate", ...this.annotation });
    return { ok: true, annotation: this.annotation, unknown, repeated, ids };
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
    // A title taken from the source, rather than given by a model or the chart's settings, follows
    // it, as when the user writes a title into it. The page still takes it for the same diagram.
    const title =
      !state.chart &&
      state.source !== undefined &&
      state.title === guessTitle({ language: state.language, source: state.source })
        ? guessTitle({ language: state.language, source })
        : state.title;
    if (title !== state.title) this.firstTitle ??= state.title;
    this.state = {
      ...state,
      source,
      title,
      editedByUser: true,
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
    // Write names the request of a drawn source, and writeFence refuses an empty one.
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
    // One write at a time, so that e.g. a second click on Write finds the block where the first
    // write left it.
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
      if (state?.document === current) {
        this.state = { ...state, document: moved };
        await this.store.save(this.state);
      }
    })();
    this.writing = writing.catch(() => {});
    await writing;
  }

  /** The binding of the block as the panel last wrote it. */
  private movedBinding(binding: DocumentBinding): DocumentBinding {
    const moved = this.movedBindings.get(binding);
    return moved ? this.movedBinding(moved) : binding;
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
    const outcome = await this.showChart(
      { ...next, title: chart.title ?? state.title, origin: "tool" },
      table,
      "The chart changed before the user picked.",
      token,
    );
    throwIfCancelled(token);
    if (!outcome.ok) return outcome;
    return { ...outcome, summary };
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
      this.post({ type: "chartOptions", visible: false });
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
      visible: true,
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
    message: Extract<FromWebview, { type: "applyChartOptions" | "resetChartStyling" }>,
  ): Promise<void> {
    const state = this.state;
    const tab = this.webview.tab;
    try {
      if (!state?.chart || message.revision !== this.shownRevision) {
        throw new Error("The chart changed. Reopen Chart Options and try again.");
      }
      if (!message.replaceSource) assertChartPresentation(state.chartPresentation);
      const reset = message.type === "resetChartStyling";
      let table = this.chartTable;
      if (!table && reset) {
        const loaded = await this.reloadTable(
          state.chart,
          "Resetting chart styling and reloading data",
        );
        if (!loaded) return;
        if (message.revision !== this.shownRevision || this.webview.tab !== tab || !tab) return;
        table = loaded.table;
        if (loaded.warning) void vscode.window.showWarningMessage(loaded.warning);
      }
      if (!table) throw new Error("Press Refresh to load the chart data first.");
      const chart = reset ? state.chart : withChartControls(state.chart, message.controls);
      const kept = reset || message.replaceSource ? undefined : state.chartPresentation;
      this.userChanges++;
      const outcome = await this.showChart(
        withRebuiltChart(state, chart, table, kept).state,
        table,
        "Chart options changed before the user picked.",
      );
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
      const outcome = await this.showChart(
        withRebuiltChart(state, chart, table, presentation).state,
        table,
        "The chart data was refreshed before the user picked.",
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
   * Loads the chart's data again, asking first, as its first load did, before reading a data file
   * outside the workspace, and, once chart code could have pressed Refresh, before rerunning its
   * command.
   *
   * @returns undefined if the user declined or cancelled.
   */
  private async reloadTable(
    chart: ChartSpec,
    title: string,
  ): Promise<Awaited<ReturnType<typeof loadTable>> | undefined> {
    const tab = this.webview.tab;
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
    // A panel closed while the user was asked takes the load with it.
    if (this.webview.tab !== tab) return;
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
   * Asks the user to confirm what a message from the page requests, one question at a time. Once
   * the user declines one while the page holds chart code, the rest are declined unasked, as the
   * code could otherwise post messages that open modal dialogs without end.
   */
  private async confirmForPage(ask: () => Thenable<boolean>): Promise<boolean> {
    if (this.confirming || this.pageRefused) return false;
    this.confirming = true;
    try {
      const confirmed = await ask();
      if (!confirmed && this.pageRanCode) this.pageRefused = true;
      return confirmed;
    } finally {
      this.confirming = false;
    }
  }

  /**
   * Shows a chart rebuilt from the table, keeping the current chart if it fails to render or the
   * token is cancelled, in which case the outcome's error says so.
   */
  private async showChart(
    next: DiagramState,
    table: DataTable,
    pickReason: string,
    token?: vscode.CancellationToken,
  ): Promise<Drawn> {
    const { state, chartTable, annotation } = this;
    const tab = this.webview.tab;
    this.state = next;
    this.chartTable = table;
    this.selection = [];
    this.annotation = undefined;
    this.cancelPick(pickReason);
    const version = this.renderVersion + 1;
    const cancellation = token?.onCancellationRequested(() => {
      if (this.renderVersion === version) this.cancelRender("The chart update was cancelled.");
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
    await this.store.save(state);
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
      : { ...outcome, error: `${outcome.error} The previous chart is kept.` };
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
    } else if (this.unavailable || !this.webview.isReady || this.renderedRequestId === undefined) {
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
        const rendered = this.renderedRequestId;
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
   * A PNG of the drawing shown, at most maxSide pixels wide and high, for a model to check its
   * layout with, or why there is none.
   */
  async captureImage(maxSide: number): Promise<Uint8Array | string> {
    const state = this.state;
    const rendered = this.renderedRequestId;
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
      return `The ${noun} fails to render: ${state.error}`;
    }
    if (!this.webview.tab) {
      return "The diagram panel is closed. The user can open it again with Diagram: Show Panel.";
    }
    if (this.unavailable || !this.webview.isReady || rendered === undefined) {
      return this.unavailable ?? `The diagram panel is not showing the ${noun} yet.`;
    }
    const result = await this.requestExport(
      { format: "png", renderRequestId: rendered, forModel: true, maxSide },
      `The diagram panel did not finish the image within ${RENDER_TIMEOUT_MS / 1000} seconds.`,
    );
    if (result.type === "exportError") {
      return result.message;
    }
    return (
      (result.type === "exportImage" && result.format === "png" && pngBytes(result.data)) ||
      "The diagram panel returned an invalid PNG image."
    );
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

  /** Where a node of the diagram shown links to in the code, if anywhere. */
  private linkOf(node: DiagramNode): NodeLink | undefined {
    const links = this.state?.links;
    // Node ids are a model's words, so only the map's own entries count, not "constructor".
    return links && Object.hasOwn(links, node.id) ? links[node.id] : undefined;
  }

  /** E.g. `Regarding "Parser", "Checker" in the diagram: `. */
  private regarding(nodes: DiagramNode[]): string {
    const noun = diagramNoun(this.state?.language ?? "mermaid");
    return nodes.length > 0
      ? `Regarding ${nodes.map((node) => (node.relationship ? nodeList([node]) : `"${node.label}"`)).join(", ")} in the ${noun}: `
      : `Regarding the ${noun}: `;
  }

  /**
   * Sends a request about the diagram to chat, routed to whoever produced the diagram. Once chart
   * code could have sent it, or to review, it only fills in the chat input, for the user to send.
   */
  private async askInChat(text: string, review = false): Promise<void> {
    const query = this.state?.origin === "tool" ? text : `@diagram ${text}`;
    const selection = this.selection;
    try {
      await vscode.commands.executeCommand("workbench.action.chat.open", {
        query,
        isPartialQuery: review || this.pageRanCode,
      });
    } catch (error) {
      // E.g. chat is disabled. The selection is kept, to try again.
      void vscode.window.showErrorMessage(
        `Could not send the request to chat: ${errorMessage(error)}`,
      );
      return;
    }
    // Opening chat can take time; keep any selection made while it was opening.
    if (this.selection === selection) {
      this.selection = [];
      this.post({ type: "clearSelection" });
    }
  }
}

/** The state with the chart rebuilt from the table, keeping the manual styling of presentation. */
function withRebuiltChart(
  state: DiagramState,
  chart: ChartSpec,
  table: DataTable,
  presentation: ChartPresentation | undefined,
): { state: DiagramState; summary: string } {
  const rebuilt = rebuildChart(chart, table, presentation);
  return {
    state: {
      ...state,
      chart,
      source: JSON.stringify(rebuilt.option, null, 2),
      chartPresentation: rebuilt.presentation,
      editedByUser: rebuilt.presentation.edits.length > 0,
    },
    summary: rebuilt.summary,
  };
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
