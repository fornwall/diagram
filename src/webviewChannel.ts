import * as vscode from "vscode";
import { errorMessage, type FromWebview, isFromWebview, type ToWebview } from "./protocol";
import { loadWebview } from "./webviewHtml";

export class WebviewChannel implements vscode.Disposable {
  static readonly viewType = "diagram.panel";

  private panel: vscode.WebviewPanel | undefined;
  // The panel replays state on "ready", so earlier messages can be dropped. VS Code may reload a
  // page itself, as when its tab moves to another window; "ready" is the only notice of that.
  private ready = false;
  private generation = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (message: FromWebview) => Promise<void> | undefined,
    private readonly onClose: () => void,
  ) {}

  get tab(): vscode.WebviewPanel | undefined {
    return this.panel;
  }

  get isReady(): boolean {
    return this.ready;
  }

  // True if it opened the tab.
  reveal(preserveFocus: boolean): boolean {
    if (this.panel) {
      if (!preserveFocus || !this.panel.visible) {
        this.panel.reveal(undefined, preserveFocus);
      }
      return false;
    }
    // VS Code restores background tabs lazily after a reload: replace unrestored ones.
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
    vscode.window.tabGroups.close(leftovers, true).then(undefined, () => {});
    return true;
  }

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

    // The webview renders model-written content: do not trust what it sends.
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

  // Errors only for the same page: reloads replay requests with the same ids.
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
