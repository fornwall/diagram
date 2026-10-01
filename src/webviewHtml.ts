// The diagram webview's page: its options, content security policy and markup, which
// src/webview/main.ts brings to life.

import * as vscode from "vscode";

/** Loads the page into the webview, which may run scripts and load only the built files in dist. */
export function loadWebview(webview: vscode.Webview, extensionUri: vscode.Uri): void {
  const dist = vscode.Uri.joinPath(extensionUri, "dist");
  webview.options = { enableScripts: true, localResourceRoots: [dist] };
  const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(dist, name));
  const nonce = crypto.randomUUID();
  // Mermaid injects <style> elements into the SVGs it generates, and ECharts styles its tooltips
  // inline, hence 'unsafe-inline' for styles. Scripts need the nonce; the chunks that the script
  // imports inherit it.
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset("webview.css")}">
  <title>Diagram</title>
</head>
<body>
  <header>
    <h1 id="title">Diagram</h1>
    <div class="actions">
      <button id="zoom-out" title="Zoom out" aria-label="Zoom out">&minus;</button>
      <button id="zoom-reset" title="Reset zoom">100%</button>
      <button id="zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
      <button id="refresh" hidden>Refresh</button>
      <button id="edit" title="Edit the Mermaid source">Edit source</button>
    </div>
  </header>
  <div id="pick" role="status" hidden>
    <span id="pick-prompt"></span>
    <div class="actions">
      <button id="pick-done" hidden>Done</button>
      <button id="pick-cancel" class="secondary">Cancel</button>
    </div>
  </div>
  <div id="error" role="alert" hidden></div>
  <section id="editor" hidden>
    <textarea id="source" spellcheck="false" aria-label="Diagram source"></textarea>
    <p id="stale-note" class="note" hidden>The diagram changed since you started editing. Apply replaces it with your version.</p>
    <div class="actions">
      <button id="apply">Apply</button>
      <button id="cancel" class="secondary">Cancel</button>
    </div>
  </section>
  <main id="canvas">
    <div id="empty">No diagram yet. Ask <code>@diagram</code> in chat to draw a diagram or chart.</div>
    <div id="diagram"></div>
  </main>
  <footer>
    <div id="selection">
      <span id="selection-label">Click nodes to select them (Ctrl/Cmd/Shift+click for several).</span>
      <button id="clear-selection" class="link" hidden>Clear</button>
    </div>
    <form id="ask-form">
      <input id="ask-input" type="text" placeholder="Ask about or change the diagram…" aria-label="Message">
      <button type="submit">Send to chat</button>
    </form>
  </footer>
  <script type="module" nonce="${nonce}" src="${asset("webview.js")}"></script>
</body>
</html>`;
}
