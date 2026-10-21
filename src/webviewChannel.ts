// Owns the webview tab and validates messages sent to the extension host.

import * as vscode from "vscode";
import { errorMessage, type FromWebview, isFromWebview, type ToWebview } from "./protocol";
import { loadWebview } from "./webviewHtml";

export class WebviewChannel implements vscode.Disposable {
  static readonly viewType = "diagram.panel";

  private panel: vscode.WebviewPanel | undefined;
  /**
   * The panel replays state on "ready", so earlier messages can be dropped. Track generations
   * to ignore delivery failures from old pages. VS Code can also reload a page itself, such as
   * when its tab moves to another window; "ready" is the only notification in that case.
   */
  private ready = false;
  private generation = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (message: FromWebview) => Promise<void> | undefined,
    private readonly onClose: () => void,
  ) {}

  /** The open tab, if any. A tab that is closed and opened again is a new one. */
  get tab(): vscode.WebviewPanel | undefined {
    return this.panel;
  }

  /** Whether the page has loaded and takes messages. */
  get isReady(): boolean {
    return this.ready;
  }

  /** Reveals the tab, or opens it, in which case this returns true. */
  reveal(preserveFocus: boolean): boolean {
    if (this.panel) {
      if (!preserveFocus || !this.panel.visible) {
        this.panel.reveal(undefined, preserveFocus);
      }
      return false;
    }
    // VS Code restores background tabs lazily after a window reload. Replace an unrestored tab
    // to avoid duplicates. Accept both the API's view type and VS Code's internal prefix.
    const viewTypes = [WebviewChannel.viewType, `mainThreadWebview-${WebviewChannel.viewType}`];
    const leftovers = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter(
        (tab) =>
          tab.input instanceof vscode.TabInputWebview && viewTypes.includes(tab.input.viewType),
      );
    const panel = vscode.window.createWebviewPanel(
      WebviewChannel.viewType,
      "Diagram",
      {
        viewColumn: leftovers[0]?.group.viewColumn ?? vscode.ViewColumn.Beside,
        preserveFocus,
      },
      // Hidden tabs must still answer render and pick requests, and retain zoom and source edits.
      { retainContextWhenHidden: true, enableFindWidget: true },
    );
    this.attach(panel);
    // Failure to close an old tab does not prevent using the new one.
    vscode.window.tabGroups.close(leftovers, true).then(undefined, () => {});
    return true;
  }

  /** Takes over a tab restored by VS Code after a reload, unless one is open already. */
  adopt(panel: vscode.WebviewPanel): boolean {
    if (this.panel) {
      panel.dispose();
      return false;
    }
    this.attach(panel);
    return true;
  }

  private attach(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    panel.iconPath = new vscode.ThemeIcon("type-hierarchy");
    this.load(panel);

    // The webview renders content written by a model, so do not trust what it sends.
    const messageListener = panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!isFromWebview(message)) return undefined;
      if (message.type === "ready") {
        this.ready = true;
        this.generation++;
        // Set visibility before onMessage replays the diagram.
        if (!panel.visible) this.postVisibility(panel);
      }
      return this.onMessage(message);
    });
    // A hidden webview keeps running but has no usable viewport size.
    const viewStateListener = panel.onDidChangeViewState(() => this.postVisibility(panel));
    // Reload with the updated CSP so chart callbacks can run after the user grants trust.
    const trustListener = vscode.workspace.onDidGrantWorkspaceTrust(() => this.load(panel));
    panel.onDidDispose(() => {
      messageListener.dispose();
      viewStateListener.dispose();
      trustListener.dispose();
      this.panel = undefined;
      this.ready = false;
      this.onClose();
    });
  }

  private postVisibility(panel: vscode.WebviewPanel): void {
    void this.post({ type: "tabVisibility", hidden: !panel.visible });
  }

  private load(panel: vscode.WebviewPanel): void {
    this.ready = false;
    this.generation++;
    loadWebview(panel.webview, this.extensionUri);
  }

  /**
   * Return a delivery error only if the same page is still active. Reloads replay requests with
   * the same ids, so a stale failure must not cancel the new attempt.
   */
  async post(message: ToWebview): Promise<string | undefined> {
    const panel = this.panel;
    if (!this.ready || !panel) {
      return undefined;
    }
    const generation = this.generation;
    let error: string;
    try {
      if (await panel.webview.postMessage(message)) {
        return undefined;
      }
      error = "The diagram panel is unavailable.";
    } catch (cause) {
      error = `Could not contact the diagram panel: ${errorMessage(cause)}`;
    }
    return panel === this.panel && generation === this.generation ? error : undefined;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
