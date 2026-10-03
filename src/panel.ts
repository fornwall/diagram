import * as os from "node:os";
import * as vscode from "vscode";
import { unlessCancelled } from "./cancellation";
import { chartControls, withChartControls } from "./chartOptions";
import {
  assertChartPresentation,
  type ChartPresentation,
  captureChartPresentation,
  rebuildChart,
} from "./chartPresentation";
import { type ChartSpec, dataOrigin } from "./chartSpec";
import { type ChartUpdateInput, updatedChartSpec } from "./chartTools";
import { type DataTable, parseTable } from "./data";
import { loadTable, resolveFile } from "./dataSource";
import { describeDiagram, nodeList } from "./describe";
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
  type ExportFormat,
  type ExportResult,
  errorMessage,
  type FromWebview,
  isFromWebview,
  isPlainObject,
  RENDER_TOOL,
  safeFileName,
  type ToWebview,
} from "./protocol";
import { savedChartHtml } from "./savedChart";
import { loadWebview } from "./webviewHtml";

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

const STATE_KEY = "diagram.state";
/** Large generated chart options can be reloaded; manual edits must be kept. */
const MAX_SAVED_CHART_SOURCE = 1_000_000;
const RENDER_TIMEOUT_MS = 15_000;

/** The panel shared by the chat participant and language model tools. */
export class DiagramPanel implements vscode.Disposable {
  static readonly viewType = "diagram.panel";

  /** The id of the chat request that a tool rendered the current diagram for; see {@link adopt}. */
  private toolRequestId: unknown;

  private panel: vscode.WebviewPanel | undefined;
  /** Messages wait for "ready"; pending renders and picks are replayed after reloads. */
  private webviewReady = false;
  private webviewGeneration = 0;
  private state: DiagramState | undefined;
  private selection: DiagramNode[] = [];
  /** Rendered node ids, or undefined when unavailable. */
  private nodeIds: string[] | undefined;
  private relationships: DiagramNode[] = [];
  /** Transient marks: cleared on replacement, never persisted. */
  private annotation: Annotation | undefined;
  private nextRequestId = 1;
  private pendingRender: Pending<"render", RenderOutcome> | undefined;
  private unavailable: string | undefined;
  private renderVersion = 0;
  /** Whether the next render shows a different diagram, which the webview fits to the panel. */
  private newDiagram = false;
  private pendingPick: Pending<"startPick", PickOutcome> | undefined;
  private refreshing = false;
  private saving = false;
  private renderedRequestId: number | undefined;
  /** Identifies the editable source even when its render fails. */
  private sourceRequestId: number | undefined;
  private pendingExport: Pending<"export", ExportResult> | undefined;
  private chartTable: DataTable | undefined;
  private chartOptionsVisible = false;
  private saveFailed = false;
  /** State is replaced on every edit; weak identity avoids retaining an old large chart. */
  private lastSave: { state: WeakRef<DiagramState>; promise: Promise<void> } | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.state = context.workspaceState.get<DiagramState>(STATE_KEY);
    if (this.state) {
      this.lastSave = { state: new WeakRef(this.state), promise: Promise.resolve() };
    }
    // Older saved states have no baseline against which manual changes can be distinguished.
    if (this.state?.chart && !this.state.chartPresentation && this.state.source !== undefined) {
      const chartPresentation: ChartPresentation = this.state.editedByUser
        ? {
            baseline: {},
            // No source edit can establish which data was originally generated.
            dataHash: "",
            edits: [],
            blocked:
              "This saved chart has manual edits without a generated baseline. " +
              "Your source is kept. Use Reset Styling in Chart Options to return to the generated chart.",
          }
        : captureChartPresentation(this.state.source);
      this.state = { ...this.state, chartPresentation };
    }
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
        "The current diagram is not a generated chart. Create one with diagram_chart first.",
      );
    const chart = updatedChartSpec(state.chart, input);
    if (input.revision !== undefined && input.revision !== this.renderVersion) {
      throw new Error(
        "The chart changed. Read diagram_getState and retry with its current revision.",
      );
    }
    if (this.pendingRender)
      throw new Error("Wait for the current diagram to finish rendering before updating it.");
    assertChartPresentation(state.chartPresentation);
    const table = this.loadedChartData;
    if (!table)
      throw new Error(
        "The chart data is not loaded. Refresh it first; updating never rereads files or reruns commands.",
      );
    const rebuilt = rebuildChart(chart, table, state.chartPresentation);
    const previousRequest = this.toolRequestId;
    const selection = this.selection;
    const annotation = this.annotation;
    this.reveal(true);
    const panel = this.panel;
    this.state = {
      ...state,
      chart,
      title: chart.title ?? state.title,
      source: JSON.stringify(rebuilt.option, null, 2),
      chartPresentation: rebuilt.presentation,
      editedByUser: rebuilt.presentation.edits.length > 0,
      origin: "tool",
    };
    this.toolRequestId = requestId(toolInvocationToken);
    this.selection = [];
    this.annotation = undefined;
    this.cancelPick("The chart changed before the user picked.");
    const revision = this.renderVersion + 1;
    let cancelled = false;
    const cancellation = token.onCancellationRequested(() => {
      cancelled = true;
      if (this.renderVersion === revision && this.pendingRender) {
        this.finishRender(this.pendingRender.message.requestId, {
          ok: false,
          kind: "unavailable",
          error: "Chart update was cancelled.",
        });
      }
    });
    let outcome: RenderOutcome;
    try {
      outcome = await this.renderCurrent();
    } finally {
      cancellation.dispose();
    }
    if ((!outcome.ok || cancelled) && this.renderVersion === revision) {
      this.state = state;
      this.toolRequestId = previousRequest;
      this.selection = selection;
      this.annotation = annotation;
      await this.save();
      if (
        this.renderVersion === revision &&
        this.panel === panel &&
        panel &&
        (cancelled || (!outcome.ok && outcome.kind === "invalid"))
      ) {
        // Restore the view even after cancellation, but do not make a cancelled tool wait for
        // an unresponsive webview. The persisted source has already been restored above.
        const restoring = this.renderCurrent();
        if (!cancelled && !token.isCancellationRequested) {
          await unlessCancelled(() => restoring, token);
        }
      }
      if (!outcome.ok)
        outcome = { ...outcome, error: `${outcome.error} The previous chart is kept.` };
    }
    if (cancelled || token.isCancellationRequested) throw new vscode.CancellationError();
    return outcome;
  }

  /**
   * The ids of the nodes the panel has drawn, when it knows them, so that a model can be told that
   * a node it named is not there. A chart reports none: its items are its data, not a list of ids.
   */
  get drawnIds(): readonly string[] | undefined {
    return this.nodeIds;
  }

  /** Opens and renders a diagram, tracking the originating tool request for adoption. */
  async render(
    diagram: Diagram,
    origin: DiagramOrigin,
    toolInvocationToken?: unknown,
    chartTable?: DataTable,
  ): Promise<RenderOutcome> {
    this.toolRequestId = requestId(toolInvocationToken);
    this.newDiagram ||= !this.state || isDifferentDiagram(this.state, diagram);
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
    this.reveal(origin !== "document");
    return this.renderCurrent();
  }

  /** Adopts a tool render only if it belongs to this participant request. */
  adopt(toolInvocationToken: unknown): Readonly<DiagramState> | undefined {
    const id = requestId(toolInvocationToken);
    if (!this.state || id === undefined || id !== this.toolRequestId) {
      return undefined;
    }
    this.state = { ...this.state, origin: "participant" };
    void this.save();
    return this.state;
  }

  /** Shows and focuses the panel unless a background update asks to preserve focus. */
  show(preserveFocus = false): void {
    if ((this.reveal(preserveFocus) || this.unavailable) && this.state) {
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

  /** Replaces marks without redrawing, reporting any unknown node ids. */
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
    return (
      this.state &&
      `Revision: ${this.renderVersion}.\n\n${describeDiagram(this.state, this.selection, this.annotation, this.relationships)}`
    );
  }

  dispose(): void {
    this.panel?.dispose();
  }

  /** Reveals the panel, or creates it, in which case this returns true. */
  private reveal(preserveFocus: boolean): boolean {
    if (this.panel) {
      if (!preserveFocus || !this.panel.visible) {
        this.panel.reveal(undefined, preserveFocus);
      }
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
        preserveFocus,
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
      this.cancelExport("The diagram panel was closed before export finished.");
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
        this.cancelExport("The diagram panel reloaded before export finished. Try again.");
        // The webview loaded, or lost its content and loaded again (e.g. when moved to another
        // window). Keep the pending request id so its caller is answered.
        this.webviewReady = true;
        this.webviewGeneration++;
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
          void this.applyEdit(message.source);
        } else {
          void vscode.window.showWarningMessage(
            "The diagram changed before your edit arrived. Your draft is kept in Edit source; review it and apply again.",
          );
        }
        break;
      case "closeChartOptions":
        this.chartOptionsVisible = false;
        break;
      case "resetChartStyling":
      case "applyChartOptions":
        void this.applyChartOptions(message);
        break;
      case "refresh":
        void this.refreshChart();
        break;
      case "exportImage":
      case "exportTheme":
      case "exportError":
        this.finishExport(message);
        break;
      case "writeToDocument":
        if (message.requestId === this.sourceRequestId) {
          void this.writeShownToDocument();
        } else {
          void vscode.window.showWarningMessage(
            "The diagram changed before it could be written. Review it and write it again.",
          );
        }
        break;
      case "ask":
        void this.askInChat(`${this.regarding(message.nodes)}${message.text}`);
        break;
      case "clickToAsk":
        // A diagram that fails to render has no nodes: the click was on the one it replaced.
        if (
          this.state?.clickPrompt &&
          !this.state.error &&
          !this.pendingRender &&
          !this.unavailable
        ) {
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
    this.panel.title = state.document
      ? `${state.title} — ${documentName(state.document)}`
      : state.title;
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
      newDiagram: this.newDiagram || undefined,
    } as const;
    this.newDiagram = false;
    this.sourceRequestId = message.requestId;
    // Preserve new source even if VS Code reloads before the webview answers.
    let saved = this.save();
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
          saved = this.save();
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
    const binding = state.document;
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

  /** Confirms agent replacements and follows the document block after a successful write. */
  private async writeToDocument(binding: DocumentBinding, source: string): Promise<void> {
    const version = this.renderVersion;
    const isCurrent = () =>
      this.renderVersion === version &&
      this.state?.document === binding &&
      this.state.source === source;
    if (binding.replaced && !(await confirmReplacedWrite(binding))) {
      return;
    }
    if (!isCurrent()) {
      void vscode.window.showWarningMessage(
        "The diagram changed while you were confirming the write. Review it and write it again.",
      );
      return;
    }
    const outcome = await writeFence(binding, source, isCurrent);
    if (!outcome.written) {
      // Not awaited: the message stays until dismissed, and the diagram can be edited meanwhile.
      void reportWriteFailure(binding, outcome.reason);
      return;
    }
    // Follow the written block, unless another diagram acquired its own binding while writing.
    const state = this.state;
    if (state?.document === binding) {
      this.state = { ...state, document: { uri: binding.uri, fence: outcome.fence } };
      await this.save();
    }
  }

  private updateChartOptionsContext(): void {
    void vscode.commands.executeCommand(
      "setContext",
      "diagram.chartOptionsAvailable",
      this.state?.chart !== undefined,
    );
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
    const panel = this.panel;
    const previousTable = this.chartTable;
    try {
      if (!state?.chart || message.revision !== this.renderVersion) {
        throw new Error("The chart changed. Reopen Chart Options and try again.");
      }
      if (!message.replaceSource) assertChartPresentation(state.chartPresentation);
      const reset = message.type === "resetChartStyling";
      let table = this.chartTable;
      if (!table && reset) {
        const loaded = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Window,
            title: "Resetting chart styling and reloading data",
          },
          (_progress, token) => loadTable(state.chart as ChartSpec, token),
        );
        if (message.revision !== this.renderVersion || this.panel !== panel || !panel) return;
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
      const annotation = this.annotation;
      this.chartTable = table;
      this.state = {
        ...state,
        chart,
        chartPresentation: presentation,
        source: JSON.stringify(option, null, 2),
        editedByUser: presentation.edits.length > 0,
      };
      this.selection = [];
      this.annotation = undefined;
      this.cancelPick("Chart options changed before the user picked.");
      const revision = this.renderVersion + 1;
      const outcome = await this.renderCurrent();
      if (!outcome.ok && this.renderVersion === revision) {
        this.state = state;
        this.chartTable = previousTable;
        this.annotation = annotation;
        await this.save();
        if (this.renderVersion !== revision || this.panel !== panel) return;
        if (outcome.kind === "invalid") await this.renderCurrent();
        throw new Error(
          `The chart options could not be rendered. Your previous chart is kept. ${outcome.error}`,
        );
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
    const panel = this.panel;
    if (!chart || this.refreshing) {
      return;
    }
    this.refreshing = true;
    try {
      assertChartPresentation(presentation);
      const { table, warning } = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Refreshing chart" },
        (_progress, token) => loadTable(chart, token),
      );
      // Any intervening render wins, even if an edit restored the same source.
      if (this.renderVersion !== version || this.panel !== panel || !panel || !this.state) {
        return;
      }
      const previousState = this.state;
      const annotation = this.annotation;
      const rebuilt = rebuildChart(chart, table, presentation);
      const source = JSON.stringify(rebuilt.option, null, 2);
      const previousTable = this.chartTable;
      this.chartTable = table;
      this.cancelPick("The chart data was refreshed before the user picked.");
      this.state = {
        ...this.state,
        source,
        chartPresentation: rebuilt.presentation,
        editedByUser: rebuilt.presentation.edits.length > 0,
      };
      this.selection = [];
      this.annotation = undefined;
      if (warning) {
        void vscode.window.showWarningMessage(warning);
      }
      const outcome = await this.renderCurrent();
      if (!outcome.ok && this.renderVersion === version + 1) {
        this.state = previousState;
        this.chartTable = previousTable;
        this.annotation = annotation;
        await this.save();
        if (this.renderVersion !== version + 1 || this.panel !== panel) {
          return;
        }
        if (outcome.kind === "invalid") {
          await this.renderCurrent();
        }
        void vscode.window.showErrorMessage(
          `Could not refresh the chart: ${outcome.error} The previous source and styling are kept.`,
        );
      }
    } catch (error) {
      if (this.renderVersion === version && this.panel === panel) {
        void vscode.window.showErrorMessage(`Could not refresh the chart: ${errorMessage(error)}`);
      }
    } finally {
      this.refreshing = false;
    }
  }

  /** Exports a snapshot through VS Code's format picker and save dialog. */
  async exportDiagram(): Promise<void> {
    if (this.saving) return;
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
    } else if (
      this.unavailable ||
      !this.webviewReady ||
      !this.panel ||
      this.renderedRequestId === undefined
    ) {
      warning = `The diagram is unavailable. ${this.unavailable ?? ""} Use Diagram: Show Panel and try again.`;
    }
    if (warning || !state || state.source === undefined) {
      void vscode.window.showWarningMessage(warning ?? "There is no diagram to export.");
      return;
    }
    const version = this.renderVersion;
    this.saving = true;
    try {
      const formats: (vscode.QuickPickItem & { format: ExportFormat })[] = [
        { label: "PNG image", description: ".png", format: "png" },
        { label: "SVG image", description: ".svg", format: "svg" },
      ];
      if (state.language === "echarts") {
        formats.push({
          label: "Interactive HTML",
          description: ".html · Works offline",
          format: "html",
        });
      }
      const choice = await vscode.window.showQuickPick(formats, {
        title: "Export Diagram",
        placeHolder: "Choose an export format",
      });
      if (!choice) return;
      if (
        version !== this.renderVersion ||
        !this.panel ||
        !this.webviewReady ||
        this.renderedRequestId === undefined
      ) {
        throw new Error("The diagram changed or closed while choosing a format. Try again.");
      }
      const { format } = choice;
      const result = await this.requestExport(format, this.renderedRequestId);
      if (result.type === "exportError") throw new Error(result.message);
      let bytes: Uint8Array;
      if (format === "html" && result.type === "exportTheme") {
        const html = await savedChartHtml(
          { title: state.title, source: state.source, colors: result.colors },
          this.context.extensionUri,
        );
        bytes = new TextEncoder().encode(html);
      } else if (result.type === "exportImage" && result.format === format) {
        if (format === "png") {
          if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(result.data)) {
            throw new Error("The panel returned an invalid PNG image. Try exporting as SVG.");
          }
          bytes = Buffer.from(result.data.slice("data:image/png;base64,".length), "base64");
        } else {
          bytes = new TextEncoder().encode(result.data);
        }
      } else {
        throw new Error("The panel returned the wrong export format. Try again.");
      }
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
      const target = await vscode.window.showSaveDialog({
        title: `Export ${choice.label}`,
        saveLabel: "Export",
        defaultUri: vscode.Uri.joinPath(
          folder,
          `${safeFileName(state.title, "diagram")}.${format}`,
        ),
        filters: { [choice.label]: [format] },
      });
      if (!target) return;
      await vscode.workspace.fs.writeFile(target, bytes);
      if (format === "html") void offerToOpen(target);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not export the diagram: ${errorMessage(error)}`);
    } finally {
      this.saving = false;
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
            message:
              "The diagram panel did not finish exporting within 15 seconds. Try again or choose SVG.",
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

  private save(): Promise<void> {
    const state = this.state;
    if (!state) return Promise.resolve();
    // Reloads and reopening the panel render the same state. Share an in-flight save too,
    // so callers still wait for durability without serializing large chart sources again.
    if (this.lastSave?.state.deref() === state) return this.lastSave.promise;
    const saved =
      state?.chart &&
      (state.chart.file !== undefined || state.chart.command !== undefined) &&
      !state.editedByUser &&
      state.source !== undefined &&
      state.source.length > MAX_SAVED_CHART_SOURCE
        ? { ...state, source: undefined, editedByUser: false, error: undefined }
        : state;
    const saving = { state: new WeakRef(state), promise: Promise.resolve() };
    this.lastSave = saving;
    saving.promise = (async () => {
      try {
        await this.context.workspaceState.update(STATE_KEY, saved);
        this.saveFailed = false;
      } catch (error) {
        // Failed writes must remain retryable, including when the source has not changed.
        if (this.lastSave === saving) this.lastSave = undefined;
        if (!this.saveFailed) {
          void vscode.window.showWarningMessage(
            `Could not save the diagram: ${errorMessage(error)}. Changes may be lost when VS Code closes.`,
          );
        }
        this.saveFailed = true;
      }
    })();
    return saving.promise;
  }

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
      ? `Regarding ${nodes.map((node) => (node.relationship ? nodeList([node]) : `"${node.label}"`)).join(", ")} in the ${noun}: `
      : `Regarding the ${noun}: `;
  }

  /** Sends a request about the diagram to chat, routed to whoever produced the diagram. */
  private async askInChat(text: string): Promise<void> {
    const query = this.state?.origin === "tool" ? text : `@diagram ${text}`;
    const selection = this.selection;
    try {
      await vscode.commands.executeCommand("workbench.action.chat.open", { query });
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

  private async post(message: ToWebview): Promise<void> {
    if (!this.webviewReady || !this.panel) {
      return;
    }
    const panel = this.panel;
    const generation = this.webviewGeneration;
    let error: string;
    try {
      if (await panel.webview.postMessage(message)) {
        return;
      }
      error = "The diagram panel is unavailable. Reopen it and try again.";
    } catch (cause) {
      error = `Could not contact the diagram panel: ${errorMessage(cause)}`;
    }
    // Reloads replay pending requests with the same ids. An older delivery must not cancel them.
    if (panel !== this.panel || generation !== this.webviewGeneration) {
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
}

/**
 * Whether a diagram replaces a different one rather than revising it: another language, another
 * Markdown block, or for an agent's diagram, another title.
 */
function isDifferentDiagram(previous: DiagramState, next: Diagram): boolean {
  if (previous.language !== next.language) {
    return true;
  }
  if (next.document) {
    return (
      previous.document?.uri !== next.document.uri ||
      previous.document.fence.openingLine !== next.document.fence.openingLine
    );
  }
  return previous.title !== next.title;
}

/** Says where a chart was saved, and opens it in the user's browser if they ask. */
async function offerToOpen(target: vscode.Uri): Promise<void> {
  try {
    const name = target.path.split("/").pop() || target.path;
    const open = await vscode.window.showInformationMessage(`Saved the chart to ${name}.`, "Open");
    if (open && !(await vscode.env.openExternal(target))) {
      throw new Error("No application accepted the file");
    }
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Could not open the saved chart: ${errorMessage(error)}. Open ${target.fsPath} in your browser.`,
    );
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
