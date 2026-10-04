// The diagram panel's webview tab: opening or taking it over, loading its page, and passing
// messages between the page and the extension.

import * as vscode from "vscode";
import { errorMessage, type FromWebview, isFromWebview, type ToWebview } from "./protocol";
import { loadWebview } from "./webviewHtml";

export class WebviewChannel implements vscode.Disposable {
  static readonly viewType = "diagram.panel";

  private panel: vscode.WebviewPanel | undefined;
  /** Messages wait for the page's "ready"; each load of the page is a new generation. */
  private ready = false;
  private generation = 0;

  /**
   * onMessage handles the validated messages of the page, and returns any work it starts;
   * onClose runs when the tab closes.
   */
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
    // After a window reload, VS Code restores a panel in a background tab only once the tab is
    // shown. Replace such a tab rather than open a second one.
    const leftovers = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter(
        (tab) =>
          tab.input instanceof vscode.TabInputWebview &&
          tab.input.viewType.endsWith(WebviewChannel.viewType),
      );
    const panel = vscode.window.createWebviewPanel(
      WebviewChannel.viewType,
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
    this.ready = false;
    loadWebview(panel.webview, this.extensionUri);

    // The webview renders content written by a model, so do not trust what it sends.
    const messageListener = panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!isFromWebview(message)) return undefined;
      if (message.type === "ready") {
        this.ready = true;
        this.generation++;
      }
      return this.onMessage(message);
    });
    // The page of an untrusted workspace cannot run JavaScript in chart options; reload it, to
    // draw the current chart again, now with its code.
    const trustListener = vscode.workspace.onDidGrantWorkspaceTrust(() => {
      this.ready = false;
      loadWebview(panel.webview, this.extensionUri);
    });
    panel.onDidDispose(() => {
      messageListener.dispose();
      trustListener.dispose();
      this.panel = undefined;
      this.ready = false;
      this.onClose();
    });
  }

  /**
   * Sends the message to the page if it is ready, and resolves to why it did not arrive, unless
   * the page was replaced or reloaded meanwhile: a reload replays requests with the same ids,
   * which an older delivery must not cancel.
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
      error = "The diagram panel is unavailable. Reopen it and try again.";
    } catch (cause) {
      error = `Could not contact the diagram panel: ${errorMessage(cause)}`;
    }
    return panel === this.panel && generation === this.generation ? error : undefined;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
