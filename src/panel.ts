import * as vscode from "vscode";
import { guessTitle } from "./blocks";
import { describeDiagram, nodeList } from "./describe";
import {
  confirmWrite,
  type DocumentBinding,
  documentName,
  NOTEBOOK_CELL,
  openCell,
  reportWriteFailure,
  writeFence,
} from "./documentDiagram";
import { exportDrawing, pngBytes } from "./export";
import { ItemNames, type Resolved } from "./itemNames";
import { linkTexts, type NodeLink, type NodeLinks, openLink, openUrl } from "./links";
import { StateStore } from "./panelState";
import {
  type Annotation,
  type DiagramLanguage,
  type DiagramNode,
  diagramNoun,
  type ExportResult,
  errorMessage,
  type FromWebview,
  GET_STATE_TOOL,
  type ImageView,
  RENDER_TOOL,
  type RepeatedName,
  type SourceRepair,
  type ToWebview,
} from "./protocol";
import { runsCode } from "./webview/optionSource";
import { WebviewChannel } from "./webviewChannel";

type DiagramOrigin = "tool" | "document";

// "unavailable": the panel closed or stopped responding.
export type RenderOutcome =
  | { ok: true; diagramType: string; repair?: SourceRepair }
  | { ok: false; kind: "invalid" | "unavailable"; error: string };

export type Drawn = RenderOutcome & { revision: number };

type AnnotateOutcome =
  | {
      ok: true;
      annotation: Annotation;
      unknown: Resolved[];
      repeated: RepeatedName[];
      several: Resolved[];
      given: ReadonlyMap<string, string>;
      names: ItemNames | undefined;
    }
  | { ok: false; reason: string };

type RenderMessage = Extract<ToWebview, { type: "render" }>;

interface Pending<Type extends ToWebview["type"], Outcome> {
  message: Extract<ToWebview, { type: Type }>;
  resolve: (outcome: Outcome) => void;
}

export interface Diagram {
  language: DiagramLanguage;
  source: string;
  title: string;
  // A plain click on a node sends this to chat.
  clickPrompt?: string | undefined;
  // Take precedence over clickPrompt.
  links?: NodeLinks | undefined;
  document?: DocumentBinding | undefined;
  // A read-only document, to export beside.
  openedFrom?: string | undefined;
}

export interface DiagramState extends Diagram {
  origin: DiagramOrigin;
  editedByUser: boolean;
  // Since the last agent change, to show the model a diff.
  userEdit?: { from: string; to: string } | undefined;
  error?: string | undefined;
}

const RENDER_TIMEOUT_MS = 15_000;

// Source that may hang is not retried after a reload: webviews share a process.
const UNFINISHED =
  "The panel did not finish drawing it, so it is not drawn again on its own, as it may hang the panel. Edit and apply it, or render it again, to draw it anyway.";

export class DiagramPanel implements vscode.Disposable {
  private readonly store: StateStore;
  private state: DiagramState | undefined;
  private selection: DiagramNode[] = [];
  // Never persisted.
  private annotation: Annotation | undefined;

  private readonly webview: WebviewChannel;
  private nextRequestId = 1;
  private renderVersion = 0;
  // Unchanged by redraws or reloads.
  private shownRevision: number;
  private userChanges = 0;
  private pendingRender: Pending<"render", RenderOutcome> | undefined;
  private readonly pendingExports = new Map<number, (result: ExportResult) => void>();
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  // The page draws this, then lastSent, skipping any between.
  private drawing: RenderMessage | undefined;
  private lastSent: RenderMessage | undefined;
  // Not a source error. A late render may still succeed.
  private unavailable: string | undefined;
  // Chart code can forge user messages. Reset only when the tab closes: messages from before a
  // reload may still arrive.
  private pageRanCode = false;
  private confirming = false;
  private pageRefused = false;
  private noticing = false;
  // Its request id lets messages from a replaced drawing be ignored.
  private drawn: Extract<FromWebview, { type: "rendered" }> | undefined;
  private drawnNames: { drawn: object; names: ItemNames } | undefined;
  private sourceRequestId: number | undefined;
  // For viewport resets: edits keep it; new diagrams and changes of language or title advance it.
  private diagrams = 0;

  private exporting = false;
  private writing: Promise<void> | undefined;
  // Across block writes and renames, including pending writes.
  private readonly movedBindings = new WeakMap<DocumentBinding, DocumentBinding>();
  private readonly renames = vscode.workspace.onDidRenameFiles(({ files }) =>
    this.followRenames(files),
  );
  private cellFollower: vscode.Disposable | undefined;

  constructor(context: vscode.ExtensionContext) {
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

  get current(): Readonly<DiagramState> | undefined {
    return this.state;
  }

  // Optimistic concurrency token for tools.
  get revision(): number {
    return this.shownRevision;
  }

  get selectedItems(): readonly DiagramNode[] {
    return this.selection;
  }

  // Tools capture this to not overwrite later user or document changes.
  get userChangeCount(): number {
    return this.userChanges;
  }

  // Charts identify their items through their data instead.
  get drawnIds(): readonly string[] | undefined {
    return this.drawn?.nodeIds;
  }

  get itemNames(): ItemNames | undefined {
    const drawn = this.drawn;
    if (!drawn?.nodeIds) return undefined;
    if (this.drawnNames?.drawn !== drawn) {
      const { nodeIds, relationships = [] } = drawn;
      this.drawnNames = { drawn, names: new ItemNames({ nodeIds, relationships }) };
    }
    return this.drawnNames.names;
  }

  get rendering(): boolean {
    return this.pendingRender !== undefined;
  }

  get warnings(): readonly string[] {
    return this.drawn?.warnings ?? [];
  }

  describeForModel(): string | undefined {
    if (!this.state) return undefined;
    return describeDiagram(this.state, {
      selection: this.selection,
      annotation: this.annotation,
      items: this.itemNames,
      repeatedNames: this.drawn?.repeatedNames ?? [],
      // A page busy with a large drawing may still show it.
      warnings: this.unavailable
        ? [...this.warnings, `The panel is not showing it yet: ${this.unavailable}`]
        : this.warnings,
    });
  }

  async render(
    diagram: Diagram,
    origin: DiagramOrigin,
    {
      newDiagram = false,
      repairMermaid = false,
    }: { newDiagram?: boolean; repairMermaid?: boolean } = {},
  ): Promise<Drawn> {
    // Keep document bindings and export locations across revisions.
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
    };
    this.updateContext();
    this.selection = [];
    this.annotation = undefined;
    if (origin === "document") this.userChanges++;
    this.webview.reveal(origin !== "document");
    return this.renderCurrent({ repairMermaid });
  }

  show(preserveFocus = false): void {
    const opened = this.webview.reveal(preserveFocus);
    if ((opened || this.unavailable) && this.state) {
      void this.renderCurrent({ redraw: true, newPage: opened });
    }
  }

  restore(panel: vscode.WebviewPanel): void {
    if (!this.webview.adopt(panel)) {
      return;
    }
    if (this.state) {
      void this.renderCurrent({ redraw: true, newPage: true });
    } else {
      // The tab keeps the unsaved title of the diagram before.
      panel.title = "Diagram";
    }
  }

  dispose(): void {
    this.webview.dispose();
    this.renames.dispose();
    this.cellFollower?.dispose();
  }

  private closed(): void {
    this.pageRanCode = false;
    this.pageRefused = false;
    this.cancelExport("The diagram panel was closed before export finished.");
    this.selection = [];
    this.drawn = undefined;
    this.cancelRender("The diagram panel was closed before it finished rendering.");
    // A timed-out render may have started drawing after its caller stopped waiting.
    clearTimeout(this.renderTimer);
  }

  private post(message: ToWebview): void {
    if (message.type === "render") {
      // Untrusted pages cannot run code, and trust is not revoked. Once set, a large option need
      // not be scanned for code again.
      const { language, source } = message;
      this.pageRanCode ||= language === "echarts" && vscode.workspace.isTrusted && runsCode(source);
      // A page not ready yet gets it again once it is, with the full time.
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
      }
    });
  }

  // Rejects messages about replaced source or drawings.
  private onMessage(message: FromWebview): Promise<void> | undefined {
    const requestId = "requestId" in message ? message.requestId : undefined;
    const ofShown = requestId === this.sourceRequestId;
    const ofDrawn = requestId === this.drawn?.requestId;
    switch (message.type) {
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
      case "exportImage":
      case "exportError":
        this.finishExport(message);
        return;
    }
    return undefined;
  }

  // Same ids, so the original callers get the answers.
  private pageReady(): void {
    this.cancelExport("The diagram panel reloaded before export finished. Try again.");
    this.selection = [];
    this.drawing = undefined;
    this.lastSent = undefined;
    if (this.pendingRender) {
      const { message } = this.pendingRender;
      this.post(message);
      // The document may have been renamed since the render named it.
      const writeTo = this.state?.document && documentName(this.state.document);
      if (writeTo && writeTo !== message.writeTo) this.post({ type: "writeTo", writeTo });
      if (this.annotation) this.post({ type: "annotate", ...this.annotation });
    } else if (this.state) {
      void this.renderCurrent({ redraw: true, newPage: true });
    }
  }

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

  // Against host-validated links, never a path from the webview.
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

  // Redraws keep the revision.
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
    }
    if (!state || !tab) {
      return {
        ...notShown("There is no diagram panel to render in."),
        revision: this.shownRevision,
      };
    }
    this.cancelExport("The diagram changed before export finished. Try again.");
    this.drawn = undefined;
    this.sourceRequestId = undefined;
    const version = ++this.renderVersion;
    const revision = this.shownRevision;
    const replaced = "The diagram was replaced before it finished rendering.";
    this.cancelRender(replaced);
    this.unavailable = undefined;
    // Name the document, as Apply writes to it.
    tab.title = state.document ? `${state.title} — ${documentName(state.document)}` : state.title;
    const { source, title } = state;
    const message = {
      type: "render",
      requestId: this.nextRequestId++,
      language: state.language,
      source,
      title,
      repairMermaid,
      clickPrompt: state.clickPrompt,
      links: state.links && linkTexts(state.links),
      writeTo: state.document && documentName(state.document),
      diagram: this.diagrams,
      notDrawn: newPage && state.error === UNFINISHED ? UNFINISHED : undefined,
      selection:
        keepSelection && this.selection.length > 0
          ? this.selection.map((node) => node.id)
          : undefined,
    } as const;
    this.sourceRequestId = message.requestId;
    let saved = this.store.save(state, revision);
    const result = await new Promise<RenderOutcome>((resolve) => {
      this.pendingRender = { message, resolve };
      this.post(message);
      // Reloads and failed chart updates keep marks.
      if (this.annotation) this.post({ type: "annotate", ...this.annotation });
    });

    // The diagram may have been replaced while rendering.
    if (version === this.renderVersion) {
      saved = this.keepOutcome(result) ?? saved;
    }
    await saved;
    return { ...(version === this.renderVersion ? result : notShown(replaced)), revision };
  }

  // Also late answers for the current source after a timeout.
  private isCurrentRender(requestId: number): boolean {
    return this.pendingRender
      ? this.pendingRender.message.requestId === requestId
      : this.unavailable !== undefined && requestId === this.sourceRequestId;
  }

  // Only if the page is drawing it, not loading or drawing an earlier one.
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

  // The page skips queued renders but the latest, which gets a fresh timeout.
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

  private keepOutcome(result: RenderOutcome): Promise<void> | undefined {
    const state = this.state;
    if (!state) return undefined;
    if (!result.ok && result.kind === "unavailable") return undefined;
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

  annotate(annotation: Annotation): AnnotateOutcome {
    const nothing = this.nothingToMark();
    if (nothing) {
      return { ok: false, reason: nothing };
    }
    if (!this.drawn) {
      return {
        ok: false,
        reason:
          this.unavailable ??
          (this.webview.tab
            ? `The panel is still drawing the ${diagramNoun(this.state?.language ?? "mermaid")}. Wait for the current render and retry.`
            : "The diagram panel closed before the marks were shown. Retry to reopen it."),
      };
    }
    const drawn = this.drawn;
    const names = this.itemNames;
    const unknown: Resolved[] = [];
    const repeated: RepeatedName[] = [];
    const several: Resolved[] = [];
    const given = new Map<string, string>();
    const claimed = new Set(annotation.marks.map((mark) => mark.id));
    const marks: Annotation["marks"] = [];
    for (const mark of annotation.marks) {
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
      // Ambiguous when several relationships go between the ends.
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

  private nothingToMark(): string | undefined {
    const state = this.state;
    if (!state) return `There is no diagram to mark. Render one with ${RENDER_TOOL} first.`;
    if (state.error) {
      const noun = diagramNoun(state.language);
      return `The ${noun} fails to render, so there is nothing to mark. The error is: ${state.error}`;
    }
    return undefined;
  }

  private async applyEdit(source: string): Promise<void> {
    const state = this.state;
    if (!state) {
      return;
    }
    // Update inferred titles, not explicit ones.
    const title =
      state.title === guessTitle({ language: state.language, source: state.source })
        ? guessTitle({ language: state.language, source })
        : state.title;
    const { userEdit } = state;
    const from = userEdit && userEdit.to === state.source ? userEdit.from : state.source;
    const drawnByAgent = state.origin !== "document";
    this.state = {
      ...state,
      source,
      error: undefined,
      title,
      editedByUser: true,
      userEdit: drawnByAgent && from !== source ? { from, to: source } : undefined,
    };
    this.selection = [];
    this.annotation = undefined;
    this.userChanges++;
    const outcome = await this.renderCurrent();
    const binding = state.document && this.movedBinding(state.document);
    // An intervening render must not redirect this Apply, even if the source matches.
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

  private async writeShownToDocument(): Promise<void> {
    const state = this.state;
    if (!state?.document) {
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
    // Each write uses the block's position after the previous one.
    const previous = this.writing;
    const writing = (async () => {
      await previous;
      const current = this.movedBinding(binding);
      const outcome = await writeFence(current, source, isCurrent(current));
      if (!outcome.written) {
        // Not awaited: the diagram can be edited meanwhile.
        void reportWriteFailure(current, outcome.reason, source);
        return;
      }
      // Unless another diagram got its own binding meanwhile.
      const moved = { uri: current.uri, fence: outcome.fence };
      this.movedBindings.set(current, moved);
      const state = this.state;
      const bound = state?.document;
      // Agent edits may copy the binding during the write: move the copies too.
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

  private movedBinding(binding: DocumentBinding): DocumentBinding {
    const moved = this.movedBindings.get(binding);
    return moved ? this.movedBinding(moved) : binding;
  }

  private followRenames(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): void {
    const renamed = (uri: string | undefined) => {
      if (uri === undefined) return undefined;
      const cell = uri.startsWith(`${NOTEBOOK_CELL}:`) ? vscode.Uri.parse(uri) : undefined;
      for (const { oldUri, newUri } of files) {
        if (cell) {
          const old = oldUri.path.replace(/\/$/, "");
          if (cell.authority === oldUri.authority && `${cell.path}/`.startsWith(`${old}/`)) {
            const path = newUri.path.replace(/\/$/, "") + cell.path.slice(old.length);
            return cell.with({ authority: newUri.authority, path }).toString();
          }
          continue;
        }
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
    // Also for pending writes and Applies.
    if (state.document && document) {
      this.movedBindings.set(state.document, document);
      const cell = openCell(state.document.uri);
      if (cell) {
        const notebook = vscode.Uri.parse(document.uri).with({
          scheme: cell.notebook.uri.scheme,
          fragment: "",
        });
        this.followCell(document, notebook.toString(), cell.index);
      }
    }
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

  // By index once the renamed notebook is open, as that numbers cell URIs anew.
  private followCell(binding: DocumentBinding, notebook: string, index: number): void {
    this.cellFollower?.dispose();
    this.cellFollower = undefined;
    const follow = (opened: vscode.NotebookDocument) => {
      if (opened.uri.toString() !== notebook) return;
      this.cellFollower?.dispose();
      this.cellFollower = undefined;
      const state = this.state;
      const bound = state?.document;
      const uri =
        index < opened.cellCount ? opened.cellAt(index).document.uri.toString() : undefined;
      if (!state || !bound || bound.uri !== binding.uri || uri === undefined || uri === bound.uri) {
        return;
      }
      const moved = { ...bound, uri };
      this.movedBindings.set(bound, moved);
      if (binding !== bound) this.movedBindings.set(binding, { ...binding, uri });
      this.state = { ...state, document: moved };
      void this.store.save(this.state, this.shownRevision);
    };
    const open = vscode.workspace.notebookDocuments.find(({ uri }) => uri.toString() === notebook);
    if (open) follow(open);
    else this.cellFollower = vscode.workspace.onDidOpenNotebookDocument(follow);
  }

  async itemIds(): Promise<readonly string[] | undefined> {
    const state = this.state;
    if (state && !this.drawn && !this.pendingRender && !state.error) {
      const opened = this.webview.reveal(true);
      await this.renderCurrent({ redraw: true, newPage: opened });
    }
    return this.drawnIds;
  }

  // Keeps invalid source for the agent to repair.
  async editByAgent(
    edit: Pick<DiagramState, "source"> & Partial<Pick<DiagramState, "title" | "links">>,
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
      userEdit: edit.source === state.source ? state.userEdit : undefined,
      document: state.document && { ...state.document, replaced: true },
      origin: "tool",
    };
    this.webview.reveal(true);
    const outcome = await this.renderCurrent({ keepSelection: true });
    // The page reports selection only when some items remain.
    const { annotation, itemNames: known } = this;
    if (outcome.ok && known) {
      this.selection = this.selection.filter(({ id }) => known.has(id));
      if (annotation) {
        this.annotation = {
          ...annotation,
          marks: annotation.marks.filter(({ id }) => known.has(id)),
        };
        this.post({ type: "annotate", ...this.annotation });
      }
    }
    return outcome;
  }

  clearSelection(): void {
    this.selection = [];
    this.annotation = undefined;
    this.post({ type: "clearSelection" });
    this.post({ type: "annotate", marks: [], dim: false });
  }

  private updateContext(): void {
    const setContext = (key: string, value: boolean) =>
      void vscode.commands.executeCommand("setContext", key, value);
    setContext("diagram.hasDiagram", this.state !== undefined);
  }

  // One at a time. After a refusal on a page that ran chart code, refuse further requests, so
  // that code cannot flood the user with modal dialogs.
  private async confirmForPage(ask: () => Thenable<boolean>): Promise<boolean> {
    if (this.pageRefused) {
      if (!this.noticing) {
        this.noticing = true;
        const done = () => {
          this.noticing = false;
        };
        vscode.window
          .showWarningMessage(
            "You declined a request from the diagram panel after it ran JavaScript code from a chart, so it asks no more until you close it.",
          )
          .then(done, done);
      }
      return false;
    }
    if (this.confirming) return false;
    this.confirming = true;
    try {
      const confirmed = await ask();
      if (!confirmed && this.pageRanCode) this.pageRefused = true;
      return confirmed;
    } catch {
      // As while the window closes.
      return false;
    } finally {
      this.confirming = false;
    }
  }

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
    } else if (state.error) {
      warning = `There is nothing to export, as the ${noun} fails to render: ${state.error}`;
    } else if (!this.webview.isReady || !this.drawn) {
      warning = `${this.unavailable ?? `The diagram panel is not showing the ${noun}.`} Use Diagram: Show Panel and try again.`;
    }
    if (warning || !state) {
      void vscode.window.showWarningMessage(warning ?? "There is no diagram to export.");
      return;
    }
    const revision = this.shownRevision;
    const openedFrom = state.document?.uri ?? state.openedFrom;
    await exportDrawing(
      {
        language: state.language,
        title: state.title,
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
    );
  }

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
    if (state.error) {
      return `The ${noun} fails to render. Render a working ${noun} first. The error is: ${state.error}`;
    }
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

  private linkOf(node: DiagramNode): NodeLink | undefined {
    const links = this.state?.links;
    // Not inherited entries, such as "constructor".
    return links && !node.relationship && Object.hasOwn(links, node.id)
      ? links[node.id]
      : undefined;
  }

  private regarding(nodes: DiagramNode[]): string {
    const noun = diagramNoun(this.state?.language ?? "mermaid");
    return nodes.length > 0
      ? `Regarding ${nodes.map((node) => (node.relationship ? nodeList([node]) : `"${node.label}"`)).join(", ")} in the ${noun}: `
      : `Regarding the ${noun}: `;
  }

  // Requests from chart code or an old drawing only fill in the input for the user to review.
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

function warn(message: string): undefined {
  void vscode.window.showWarningMessage(message);
}

function notShown(error: string): RenderOutcome {
  return { ok: false, kind: "unavailable", error };
}

// Replaces `{label}`, or else appends the label.
export function clickToAskQuery(clickPrompt: string, label: string): string {
  return clickPrompt.includes("{label}")
    ? clickPrompt.replaceAll("{label}", () => label)
    : `${clickPrompt} "${label}"`;
}
