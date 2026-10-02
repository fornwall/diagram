// The diagram webview's page: its options, content security policy and markup, which
// src/webview/main.ts brings to life.

import * as vscode from "vscode";

/**
 * The icons of the view buttons, drawn inline as the webview may not load fonts or images:
 * connected nodes for the rendering, a divided pane for the split view, and `</>` for the source.
 */
const icon = (paths: string) =>
  `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
const DIAGRAM_ICON = icon(
  '<rect x="1.5" y="2" width="6" height="4" rx="1"/><rect x="8.5" y="10" width="6" height="4" rx="1"/><path d="M4.5 6v6h4"/>',
);
const SPLIT_ICON = icon(
  '<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M8 2.5v11"/>',
);
const SOURCE_ICON = icon('<path d="M6 3.5 2.5 8 6 12.5"/><path d="M10 3.5 13.5 8 10 12.5"/>');
/** A picture, for the handle that drags the drawing out of the panel as an image. */
const IMAGE_ICON = icon(
  '<rect x="1.5" y="3" width="13" height="10" rx="1"/><circle cx="5.5" cy="6.5" r="1.1"/><path d="M2 11.5 6 8l3 2.5 2-1.5 3 2.5"/>',
);

/** Loads the page into the webview, which may run scripts and load only the built files in dist. */
export function loadWebview(webview: vscode.Webview, extensionUri: vscode.Uri): void {
  const dist = vscode.Uri.joinPath(extensionUri, "dist");
  // Forms stay off: the only form here is handled in script and never submitted, while a
  // submission is one of the few ways code in the webview could still send data anywhere.
  webview.options = { enableScripts: true, enableForms: false, localResourceRoots: [dist] };
  const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(dist, name));
  const nonce = crypto.randomUUID();
  // Mermaid injects <style> elements into the SVGs it generates, and ECharts styles its tooltips
  // inline, hence 'unsafe-inline' for styles. Scripts need the nonce; the chunks that the script
  // imports inherit it. An ECharts option may be written as JavaScript, as a custom series needs a
  // renderItem function, which the webview compiles with new Function, hence 'unsafe-eval'.
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}' 'unsafe-eval'`,
    // Spelled out because form-action does not fall back to default-src.
    "form-action 'none'",
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
      <button id="save" title="Save the chart as a self-contained HTML file" hidden>Save…</button>
      <button id="write-to" hidden></button>
      <span id="drag-out" class="drag-out" draggable="true" role="img" aria-label="Drag the drawing into another application as an image" title="Drag into another app as an image (hold Shift to drag SVG)" hidden>${IMAGE_ICON}</span>
      <div id="views" class="views" role="group" aria-label="View">
        <button id="view-visual" aria-pressed="true" title="Show the diagram" aria-label="Show the diagram">${DIAGRAM_ICON}</button>
        <button id="view-split" aria-pressed="false" title="Show the diagram and its source" aria-label="Show the diagram and its source">${SPLIT_ICON}</button>
        <button id="view-source" aria-pressed="false" title="Edit the source" aria-label="Edit the source">${SOURCE_ICON}</button>
      </div>
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
  <div id="annotation" role="status" hidden>
    <span id="annotation-caption" hidden></span>
    <ul id="annotation-notes"></ul>
  </div>
  <div id="panes" class="view-visual">
    <section id="editor">
      <textarea id="source" spellcheck="false" aria-label="Diagram source"></textarea>
      <p id="stale-note" class="note" hidden>The diagram changed since you started editing. Apply replaces it with your version.</p>
      <div class="actions">
        <button id="apply" title="Render your version (Ctrl/Cmd+Enter)">Apply</button>
        <button id="revert" class="secondary" title="Discard your changes">Revert</button>
      </div>
    </section>
    <div id="splitter" role="separator" tabindex="0" aria-label="Resize the source editor" aria-valuemin="15" aria-valuemax="85"></div>
    <main id="canvas">
      <div id="empty">No diagram yet. Ask <code>@diagram</code> in chat to draw a diagram or chart.</div>
      <div id="diagram"></div>
    </main>
  </div>
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
