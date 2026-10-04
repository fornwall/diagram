import * as vscode from "vscode";
import { unlessCancelled } from "./cancellation";
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
import { loadTable } from "./dataSource";
import { describeDiagram, nodeList } from "./describe";
import {
  confirmWrite,
  type DocumentBinding,
  documentName,
  reportWriteFailure,
  writeFence,
} from "./documentDiagram";
import { exportDrawing } from "./export";
import { linkTexts, type NodeLink, type NodeLinks, openLink } from "./links";
import { StateStore } from "./panelState";
import {
  type Annotation,
  CHART_TOOL,
  type DiagramLanguage,
  type DiagramNode,
  diagramNoun,
  type ExportFormat,
  type ExportResult,
  errorMessage,
  type FromWebview,
  GET_STATE_TOOL,
  isPlainObject,
  RENDER_TOOL,
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

type PickOutcome = { picked: true; nodes: DiagramNode[] } | { picked: false; reason: string };

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

export interface Diagram {
  language: DiagramLanguage;
  source: string;
  title: string;
  /** When set, a plain click on a node sends this request to chat; see {@link clickToAskQuery}. */
  clickPrompt?: string;
  /** Mermaid node locations. Links take precedence over clickPrompt on a plain click. */
  links?: NodeLinks;
  /** The original data request, retained for generated chart controls and refresh. */
  chart?: ChartSpec;
  /** Generated baseline and manual styling overrides, without a copy of the data. */
  chartPresentation?: ChartPresentation;
  /** Original Markdown block; Apply writes user edits back to it. */
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

const RENDER_TIMEOUT_MS = 15_000;

/** The panel shared by the chat participant and language model tools. */
export class DiagramPanel implements vscode.Disposable {
  private readonly store: StateStore;
  private state: DiagramState | undefined;
  /** The id of the chat request that a tool rendered the current diagram for; see {@link adopt}. */
  private toolRequestId: unknown;
  private selection: DiagramNode[] = [];
  /** Transient marks: cleared on replacement, never persisted. */
  private annotation: Annotation | undefined;

  private readonly webview: WebviewChannel;
  private nextRequestId = 1;
  /** Counts renders, to detect intervening ones; tools see it as the revision. */
  private renderVersion = 0;
  /** Pending renders and picks are replayed when the webview reloads. */
  private pendingRender: Pending<"render", RenderOutcome> | undefined;
  private pendingPick: Pending<"startPick", PickOutcome> | undefined;
  private pendingExport: Pending<"export", ExportResult> | undefined;
  /** Why the last render did not finish, if the panel closed or stopped responding. */
  private unavailable: string | undefined;
  /**
   * Whether the page was sent a chart option with JavaScript code, which can post any message as
   * if the user had acted, and stays in the page. Reset only when the tab closes, as messages the
   * old page sent before a reload may still arrive after it.
   */
  private pageRanCode = false;
  /** The request that drew the current diagram, which is what an export captures. */
  private renderedRequestId: number | undefined;
  /** Identifies the editable source even when its render fails. */
  private sourceRequestId: number | undefined;
  /** Rendered node ids, or undefined when unavailable. */
  private nodeIds: string[] | undefined;
  private relationships: DiagramNode[] = [];

  private chartTable: DataTable | undefined;
  private chartOptionsVisible = false;
  private refreshing = false;
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
    this.updateChartOptionsContext();
  }

  /** The diagram currently shown, if any. */
  get current(): Readonly<DiagramState> | undefined {
    return this.state;
  }

  /** Optimistic concurrency token, exposed to tools along with the current source. */
  get revision(): number {
    return this.renderVersion;
  }

  /**
   * The ids of the nodes the panel has drawn, when it knows them, so that a model can be told that
   * a node it named is not there. A chart reports none: its items are its data, not a list of ids.
   */
  get drawnIds(): readonly string[] | undefined {
    return this.nodeIds;
  }

  /** Describes the current diagram and the user's interactions with it, for a language model. */
  describeForModel(): string | undefined {
    return (
      this.state &&
      `Revision: ${this.renderVersion}.\n\n${describeDiagram(this.state, this.selection, this.annotation, this.relationships)}`
    );
  }

  /** Opens and renders a diagram, tracking the originating tool request for adoption. */
  async render(
    diagram: Diagram,
    origin: DiagramOrigin,
    toolInvocationToken?: unknown,
    chartTable?: DataTable,
  ): Promise<RenderOutcome> {
    this.toolRequestId = requestId(toolInvocationToken);
    // Keep document bindings across agent replacements; a later Apply requires confirmation.
    const previousBinding = this.state?.document;
    const document =
      diagram.document ??
      (previousBinding?.fence.language === diagram.language
        ? { ...previousBinding, replaced: true }
        : undefined);
    this.state = {
      ...diagram,
      document,
      origin,
      editedByUser: false,
      chartPresentation: diagram.chart
        ? (diagram.chartPresentation ?? captureChartPresentation(diagram.source))
        : undefined,
    };
    this.chartTable = diagram.chart ? chartTable : undefined;
    this.chartOptionsVisible = false;
    this.updateChartOptionsContext();
    this.selection = [];
    this.annotation = undefined;
    this.cancelPick("The diagram was replaced before the user picked.");
    this.webview.reveal(origin !== "document");
    return this.renderCurrent();
  }

  /** Adopts a tool render only if it belongs to this participant request. */
  adopt(toolInvocationToken: unknown): Readonly<DiagramState> | undefined {
    const id = requestId(toolInvocationToken);
    if (!this.state || id === undefined || id !== this.toolRequestId) {
      return undefined;
    }
    this.state = { ...this.state, origin: "participant" };
    void this.store.save(this.state);
    return this.state;
  }

  /** Shows and focuses the panel unless a background update asks to preserve focus. */
  show(preserveFocus = false): void {
    if ((this.webview.reveal(preserveFocus) || this.unavailable) && this.state) {
      void this.renderCurrent();
    }
  }

  /** Takes over a panel restored by VS Code after a reload. */
  restore(panel: vscode.WebviewPanel): void {
    if (!this.webview.adopt(panel)) {
      return;
    }
    if (this.state) {
      void this.renderCurrent();
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
    this.cancelExport("The diagram panel was closed before export finished.");
    this.selection = [];
    this.cancelPick("The user closed the diagram panel.");
    if (this.pendingRender) {
      this.finishRender(this.pendingRender.message.requestId, {
        ok: false,
        kind: "unavailable",
        error: "The diagram panel was closed before it finished rendering.",
      });
    }
  }

  /** Sends a message to the webview, ending the request it makes if it does not arrive. */
  private async post(message: ToWebview): Promise<void> {
    const error = await this.webview.post(message);
    if (error === undefined) {
      return;
    }
    if (message.type === "render") {
      this.finishRender(message.requestId, { ok: false, kind: "unavailable", error });
    } else if (message.type === "export") {
      this.finishExport({ type: "exportError", requestId: message.requestId, message: error });
    } else if (message.type === "startPick") {
      this.finishPick(message.pickId, { picked: false, reason: error });
    }
  }

  /** Handles a message from the webview, returning any work it starts, for tests to await. */
  private onMessage(message: FromWebview): Promise<void> | undefined {
    switch (message.type) {
      case "ready":
        this.cancelExport("The diagram panel reloaded before export finished. Try again.");
        // The webview loaded, or lost its content and loaded again (e.g. when moved to another
        // window). Keep the pending request id so its caller is answered.
        this.selection = [];
        if (this.pendingRender) {
          this.sendChartOptions();
          this.post(this.pendingRender.message);
          if (this.annotation) this.post({ type: "annotate", ...this.annotation });
        } else if (this.state) {
          void this.renderCurrent();
        }
        if (this.pendingPick) {
          this.post(this.pendingPick.message);
        }
        break;
      case "rendered":
        // The ids of what was drawn, for telling a model that a node it names is not there. A late
        // answer to a replaced render says nothing about the diagram now shown.
        if (this.pendingRender?.message.requestId === message.requestId) {
          this.nodeIds = message.nodeIds;
          this.relationships = message.relationships?.filter((node) => node.relationship) ?? [];
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
        if (message.requestId === this.sourceRequestId) this.selection = message.nodes;
        break;
      case "sourceEdited":
        if (message.requestId === this.sourceRequestId) {
          return this.applyEdit(message.source);
        }
        void vscode.window.showWarningMessage(
          "The diagram changed before your edit arrived. Your draft is kept in Edit source; review it and apply again.",
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
        return this.askInChat(`${this.regarding(message.nodes)}${message.text}`);
      case "clickToAsk":
        // A diagram that fails to render has no nodes: the click was on the one it replaced.
        if (
          this.state?.clickPrompt &&
          !this.state.error &&
          !this.pendingRender &&
          !this.unavailable
        ) {
          return this.askInChat(clickToAskQuery(this.state.clickPrompt, message.node.label));
        }
        break;
      case "clickToOpen": {
        // The message names the node; its location comes from the links validated here, so that
        // the webview, which shows what a model wrote, cannot open a path of its own choosing.
        const link = this.linkOf(message.node);
        return link && openLink(link, message.node.label, this.webview.tab?.viewColumn);
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
    const tab = this.webview.tab;
    if (!state || !tab) {
      return { ok: false, kind: "unavailable", error: "There is no diagram panel to render in." };
    }
    this.cancelExport("The diagram changed before export finished. Try again.");
    this.renderedRequestId = undefined;
    this.sourceRequestId = undefined;
    const version = ++this.renderVersion;
    this.sendChartOptions();
    // What was drawn before says nothing about the rendering being drawn now.
    this.nodeIds = undefined;
    this.relationships = [];
    const replaced = {
      ok: false,
      kind: "unavailable",
      error: "The diagram was replaced before it finished rendering.",
    } as const;
    if (this.pendingRender) {
      this.finishRender(this.pendingRender.message.requestId, replaced);
    }
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
    this.sourceRequestId = message.requestId;
    // An untrusted workspace's page cannot evaluate code, and trust is not revoked while it runs.
    if (state.language === "echarts" && vscode.workspace.isTrusted && runsCode(source)) {
      this.pageRanCode = true;
    }
    // Preserve new source even if VS Code reloads before the webview answers.
    let saved = this.store.save(state);
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
      // Reloads and failed chart updates keep marks; replay them after the drawing they belong to.
      if (this.annotation) this.post({ type: "annotate", ...this.annotation });
    });

    // An unavailable panel says nothing about the source, and the diagram may have been replaced
    // while rendering.
    const latest = this.state;
    if (latest && version === this.renderVersion) {
      if (result.ok || result.kind === "invalid") {
        const error = result.ok ? undefined : result.error;
        if (latest.error !== error) {
          this.state = { ...latest, error };
          saved = this.store.save(this.state);
        }
      }
      if (!result.ok) {
        this.cancelPick(
          result.kind === "invalid" ? failsToRender(latest.language, result.error) : result.error,
        );
      }
    }
    await saved;
    return version === this.renderVersion ? result : replaced;
  }

  private finishRender(requestId: number, outcome: RenderOutcome): void {
    if (this.pendingRender?.message.requestId !== requestId) {
      return;
    }
    this.renderedRequestId = outcome.ok ? requestId : undefined;
    const { resolve } = this.pendingRender;
    this.pendingRender = undefined;
    this.unavailable = !outcome.ok && outcome.kind === "unavailable" ? outcome.error : undefined;
    resolve(outcome);
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
    for (const mark of annotation.marks) {
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
    return { ok: true, annotation: this.annotation, unknown, ids };
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
    this.state = {
      ...state,
      source,
      editedByUser: true,
      chartPresentation: state.chart
        ? captureChartPresentation(source, state.chartPresentation)
        : undefined,
    };
    this.selection = [];
    this.annotation = undefined;
    this.cancelPick("The user edited the diagram source instead of picking.");
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
    if (!state?.document) {
      return;
    }
    if (this.pendingRender) {
      void vscode.window.showWarningMessage(
        "Wait for the diagram to finish rendering before writing it.",
      );
      return;
    }
    if (this.unavailable) {
      void vscode.window.showWarningMessage(
        `The diagram was not written: ${this.unavailable} Reopen the panel and try again.`,
      );
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

  /**
   * Confirms writes that an agent replacement or chart code may have caused, and follows the
   * document block after a successful write.
   */
  private async writeToDocument(binding: DocumentBinding, source: string): Promise<void> {
    const version = this.renderVersion;
    const isCurrent = (current: DocumentBinding) => () =>
      this.renderVersion === version &&
      this.state?.document === current &&
      this.state.source === source;
    if (
      (binding.replaced || this.pageRanCode) &&
      !(await confirmWrite(binding, binding.replaced ? "replaced" : "code"))
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
      if (previous) await previous;
      const current = this.movedBinding(binding);
      const outcome = await writeFence(current, source, isCurrent(current));
      if (!outcome.written) {
        // Not awaited: the message stays until dismissed, and the diagram can be edited meanwhile.
        void reportWriteFailure(current, outcome.reason);
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

  /** Inspection never refreshes a file or reruns a command. */
  get loadedChartData(): DataTable | undefined {
    const chart = this.state?.chart;
    if (!this.chartTable && chart?.data !== undefined) {
      this.chartTable = parseTable(chart.data, chart.format);
    }
    return this.chartTable;
  }

  /** Change generated settings atomically using the retained table and manual styling. */
  async updateChart(
    input: ChartUpdateInput,
    token: vscode.CancellationToken,
    toolInvocationToken?: unknown,
  ): Promise<RenderOutcome> {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    const state = this.state;
    if (!state?.chart)
      throw new Error(
        `The current diagram is not a generated chart. Create one with ${CHART_TOOL} first.`,
      );
    const chart = updatedChartSpec(state.chart, input);
    if (input.revision !== undefined && input.revision !== this.renderVersion) {
      throw new Error(
        `The chart changed. Read ${GET_STATE_TOOL} and retry with its current revision.`,
      );
    }
    if (this.pendingRender)
      throw new Error("Wait for the current diagram to finish rendering before updating it.");
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
    const rebuilt = rebuildChart(chart, table, state.chartPresentation);
    this.webview.reveal(true);
    const outcome = await this.showChart(
      {
        ...state,
        chart,
        title: chart.title ?? state.title,
        source: JSON.stringify(rebuilt.option, null, 2),
        chartPresentation: rebuilt.presentation,
        editedByUser: rebuilt.presentation.edits.length > 0,
        origin: "tool",
      },
      table,
      "The chart changed before the user picked.",
      token,
    );
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    if (outcome.ok) this.toolRequestId = requestId(toolInvocationToken);
    return outcome;
  }

  /** Native editor action: opening options never reads a file or executes a command. */
  toggleChartOptions(): void {
    if (!this.state?.chart) {
      void vscode.window.showInformationMessage(
        "Chart Options is available for charts created from data.",
      );
      return;
    }
    this.chartOptionsVisible = !this.chartOptionsVisible;
    this.show();
    this.sendChartOptions();
  }

  private updateChartOptionsContext(): void {
    void vscode.commands.executeCommand(
      "setContext",
      "diagram.chartOptionsAvailable",
      this.state?.chart !== undefined,
    );
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
    let edited = false;
    try {
      assertChartPresentation(state.chartPresentation);
    } catch {
      edited = true;
    }
    this.post({
      type: "chartOptions",
      visible: this.chartOptionsVisible,
      state: {
        revision: this.renderVersion,
        controls: chartControls(chart),
        columns: table?.columns ?? [],
        rowCount: table?.rows.length ?? 0,
        edited,
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
      if (!state?.chart || message.revision !== this.renderVersion) {
        throw new Error("The chart changed. Reopen Chart Options and try again.");
      }
      if (!message.replaceSource) assertChartPresentation(state.chartPresentation);
      const reset = message.type === "resetChartStyling";
      let table = this.chartTable;
      if (!table && reset) {
        if (!(await this.confirmReload(state.chart))) return;
        const loaded = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Window,
            title: "Resetting chart styling and reloading data",
          },
          (_progress, token) => loadTable(state.chart as ChartSpec, token),
        );
        if (message.revision !== this.renderVersion || this.webview.tab !== tab || !tab) return;
        table = loaded.table;
        if (loaded.warning) void vscode.window.showWarningMessage(loaded.warning);
      }
      if (!table) throw new Error("Press Refresh to load the chart data first.");
      const chart = reset ? state.chart : withChartControls(state.chart, message.controls);
      const { option, presentation } = rebuildChart(
        chart,
        table,
        reset || message.replaceSource ? undefined : state.chartPresentation,
      );
      const outcome = await this.showChart(
        {
          ...state,
          chart,
          chartPresentation: presentation,
          source: JSON.stringify(option, null, 2),
          editedByUser: presentation.edits.length > 0,
        },
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
    const version = this.renderVersion;
    const tab = this.webview.tab;
    if (!chart || this.refreshing) {
      return;
    }
    this.refreshing = true;
    try {
      assertChartPresentation(presentation);
      if (!(await this.confirmReload(chart))) return;
      const { table, warning } = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Refreshing chart" },
        (_progress, token) => loadTable(chart, token),
      );
      // Any intervening render wins, even if an edit restored the same source.
      const state = this.state;
      if (this.renderVersion !== version || this.webview.tab !== tab || !tab || !state) {
        return;
      }
      if (warning) void vscode.window.showWarningMessage(warning);
      const rebuilt = rebuildChart(chart, table, presentation);
      const outcome = await this.showChart(
        {
          ...state,
          source: JSON.stringify(rebuilt.option, null, 2),
          chartPresentation: rebuilt.presentation,
          editedByUser: rebuilt.presentation.edits.length > 0,
        },
        table,
        "The chart data was refreshed before the user picked.",
      );
      if (!outcome.ok && this.state === state && this.webview.tab === tab) {
        void vscode.window.showErrorMessage(`Could not refresh the chart: ${outcome.error}`);
      }
    } catch (error) {
      if (this.renderVersion === version && this.webview.tab === tab) {
        void vscode.window.showErrorMessage(`Could not refresh the chart: ${errorMessage(error)}`);
      }
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Whether to reload the chart's data, which reruns its command: once chart code could have
   * pressed Refresh, the user is asked first.
   */
  private async confirmReload(chart: ChartSpec): Promise<boolean> {
    if (!chart.command || !this.pageRanCode) return true;
    const run = await vscode.window.showWarningMessage(
      "Run the chart's command again to reload its data?",
      {
        modal: true,
        detail: `${chart.command}\n\nThe panel ran JavaScript code from a chart, which can press Refresh as if you had.`,
      },
      "Run",
    );
    return run !== undefined;
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
  ): Promise<RenderOutcome> {
    const { state, chartTable, annotation } = this;
    const tab = this.webview.tab;
    this.state = next;
    this.chartTable = table;
    this.selection = [];
    this.annotation = undefined;
    this.cancelPick(pickReason);
    const revision = this.renderVersion + 1;
    const cancellation = token?.onCancellationRequested(() => {
      if (this.renderVersion === revision && this.pendingRender) {
        this.finishRender(this.pendingRender.message.requestId, {
          ok: false,
          kind: "unavailable",
          error: "The chart update was cancelled.",
        });
      }
    });
    let outcome: RenderOutcome;
    try {
      outcome = await this.renderCurrent();
    } finally {
      cancellation?.dispose();
    }
    const cancelled = token?.isCancellationRequested ?? false;
    if ((outcome.ok && !cancelled) || this.renderVersion !== revision || !state) return outcome;
    this.state = state;
    this.chartTable = chartTable;
    this.annotation = annotation;
    await this.store.save(state);
    if (
      this.renderVersion === revision &&
      tab &&
      this.webview.tab === tab &&
      (cancelled || (!outcome.ok && outcome.kind === "invalid"))
    ) {
      // Draw the kept chart again, but a cancelled request does not wait for the webview.
      const restoring = this.renderCurrent();
      if (!cancelled) await (token ? unlessCancelled(() => restoring, token) : restoring);
    }
    return outcome.ok
      ? outcome
      : { ...outcome, error: `${outcome.error} The previous chart is kept.` };
  }

  // Export.

  /** Exports a snapshot through VS Code's format picker and save dialog. */
  async exportDiagram(): Promise<void> {
    if (this.exporting) return;
    const state = this.state;
    let warning: string | undefined;
    if (!state) {
      warning = "Open or draw a diagram before exporting it.";
    } else if (this.pendingRender) {
      warning = "Wait for the diagram to finish rendering before exporting it.";
    } else if (state.source === undefined) {
      warning = "Press Refresh to draw the chart again, then export it.";
    } else if (state.error) {
      warning = `There is nothing to export, as the diagram fails to render: ${state.error}`;
    } else if (this.unavailable || !this.webview.isReady || this.renderedRequestId === undefined) {
      warning = `${this.unavailable ?? "The diagram panel is not showing the diagram."} Use Diagram: Show Panel and try again.`;
    }
    if (warning || state?.source === undefined) {
      void vscode.window.showWarningMessage(warning ?? "There is no diagram to export.");
      return;
    }
    const version = this.renderVersion;
    this.exporting = true;
    try {
      await exportDrawing(
        { language: state.language, title: state.title, source: state.source },
        (format) => {
          const rendered = this.renderedRequestId;
          if (version !== this.renderVersion || !this.webview.isReady || rendered === undefined) {
            throw new Error("The diagram changed or closed while choosing a format. Try again.");
          }
          return this.requestExport(format, rendered);
        },
        this.context.extensionUri,
      );
    } finally {
      this.exporting = false;
    }
  }

  private requestExport(format: ExportFormat, renderRequestId: number): Promise<ExportResult> {
    const requestId = this.nextRequestId++;
    return new Promise((resolve) => {
      const timeout = setTimeout(
        () =>
          this.finishExport({
            type: "exportError",
            requestId,
            message: `The diagram panel did not finish exporting within ${RENDER_TIMEOUT_MS / 1000} seconds. Try again or choose SVG.`,
          }),
        RENDER_TIMEOUT_MS,
      );
      const message = { type: "export", requestId, renderRequestId, format } as const;
      this.pendingExport = {
        message,
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
      };
      void this.post(message);
    });
  }

  private finishExport(result: ExportResult): void {
    if (this.pendingExport?.message.requestId !== result.requestId) return;
    const { resolve } = this.pendingExport;
    this.pendingExport = undefined;
    resolve(result);
  }

  private cancelExport(message: string): void {
    if (this.pendingExport) {
      this.finishExport({
        type: "exportError",
        requestId: this.pendingExport.message.requestId,
        message,
      });
    }
  }

  // Clicks on nodes, and requests to chat.

  /** Where a node of the diagram shown links to in the code, if anywhere. */
  private linkOf(node: DiagramNode): NodeLink | undefined {
    const links = this.state?.links;
    // A diagram that fails to render has no nodes: the click was on the one it replaced. Node ids
    // are a model's words, so only the map's own entries count, not "constructor" and the like.
    if (
      !links ||
      this.state?.error ||
      this.pendingRender ||
      this.unavailable ||
      !Object.hasOwn(links, node.id)
    ) {
      return undefined;
    }
    return links[node.id];
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
   * code could have sent it, it only fills in the chat input, for the user to send.
   */
  private async askInChat(text: string): Promise<void> {
    const query = this.state?.origin === "tool" ? text : `@diagram ${text}`;
    const selection = this.selection;
    try {
      await vscode.commands.executeCommand("workbench.action.chat.open", {
        query,
        isPartialQuery: this.pageRanCode,
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

/**
 * The id of the chat request that a tool invocation token is for. The token is opaque, and a tool
 * is given a copy of the one passed to vscode.lm.invokeTool, so tokens are compared by this id.
 */
function requestId(toolInvocationToken: unknown): unknown {
  return isPlainObject(toolInvocationToken) ? toolInvocationToken.requestId : undefined;
}
