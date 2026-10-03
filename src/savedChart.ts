// Offline HTML export with the chart, theme and renderer inlined.

import * as vscode from "vscode";
import { SAVED_CHART, type SavedChart } from "./protocol";
import { type ThemeColors, toCss } from "./webview/colors";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (char) => HTML_ESCAPES[char] ?? char);

/**
 * JSON to embed in a script element: an escaped "<" can neither end the element early nor start a
 * comment, whatever the chart's titles and labels contain.
 */
const embedJson = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");

/** Preserve international font names without allowing CSS or HTML injection. */
function fontStack(colors: ThemeColors): string {
  return (
    colors.fontFamily.replace(/[^\p{L}\p{M}\p{N}_\s,.'"()-]/gu, "").trim() ||
    "system-ui, sans-serif"
  );
}

/**
 * Offline chart page with the renderer and theme inlined. CSP blocks resource loads and form
 * submissions, but JavaScript options still execute and can navigate the page.
 */
export async function savedChartHtml(chart: SavedChart, extensionUri: vscode.Uri): Promise<string> {
  const script = await vscode.workspace.fs.readFile(
    vscode.Uri.joinPath(extensionUri, "dist", "standalone.js"),
  );
  const { colors } = chart;
  const title = chart.title.trim();
  const nonce = crypto.randomUUID();
  // ECharts styles its tooltips inline, hence 'unsafe-inline' for styles, and an option written as
  // JavaScript is compiled with new Function, hence 'unsafe-eval', as in the panel. Nothing is
  // loaded: everything the page needs is in it.
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' 'unsafe-eval'`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    // Spelled out because form-action does not fall back to default-src.
    "form-action 'none'",
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title || "Chart")}</title>
<style>
html, body { height: 100%; margin: 0; }
body {
  display: flex;
  flex-direction: column;
  background: ${toCss(colors.background)};
  color: ${toCss(colors.foreground)};
  font-family: ${fontStack(colors)};
  font-size: ${colors.fontSize}px;
}
h1 { margin: 0; padding: 12px 14px 0; font-size: 1.2em; font-weight: 600; }
#error { margin: 0; padding: 12px 14px; color: ${toCss(colors.red)}; }
/* The chart fills the page below the title, as it fills the panel below its header. */
#canvas { position: relative; flex: 1; min-height: 0; }
#chart { position: absolute; inset: 8px 12px 12px; }
</style>
</head>
<body>
${title ? `<h1>${escapeHtml(title)}</h1>\n` : ""}<p id="error" role="alert" hidden></p>
<div id="canvas"></div>
<script nonce="${nonce}">window.${SAVED_CHART} = ${embedJson(chart)};</script>
<script nonce="${nonce}">${new TextDecoder().decode(script)}</script>
</body>
</html>
`;
}
