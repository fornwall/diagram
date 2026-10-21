// HTML export with embedded chart data and theme, and ECharts loaded from a CDN.

import * as vscode from "vscode";
import { SAVED_CHART, type SavedChart } from "./protocol";
import { escapeHtml } from "./text";
import { type ThemeColors, toCss } from "./webview/colors";

/**
 * JSON to embed in a script element: an escaped "<" can neither end the element early nor start a
 * comment, whatever the chart's titles and labels contain.
 */
export const embedJson = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");

/**
 * Preserve international font names without allowing CSS or HTML injection. Font names have no
 * parentheses, and an unclosed one or an unclosed quote would take the rest of the stylesheet
 * into the declaration.
 */
export function fontStack(colors: ThemeColors): string {
  return (
    colors.fontFamily
      .replace(/[^\p{L}\p{M}\p{N}_\s,.'"-]/gu, "")
      .replace(/"[^"]*"|'[^']*'|["']/g, (match) => (match.length > 1 ? match : ""))
      .trim() || "system-ui, sans-serif"
  );
}

/**
 * Embed the panel's chart renderer and load ECharts from the pinned CDN module.
 * CSP blocks other resource loads and form submissions. JavaScript options can still execute
 * and navigate the page; tooltip links open normally in the browser.
 */
export async function savedChartHtml(
  chart: SavedChart,
  extensionUri: vscode.Uri,
  cdnModule: string,
): Promise<string> {
  const [script, style] = await Promise.all(
    ["standalone.js", "standalone.css"].map(async (name) =>
      new TextDecoder().decode(
        await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extensionUri, "dist", name)),
      ),
    ),
  );
  const { colors } = chart;
  const title = chart.title.trim();
  const nonce = crypto.randomUUID();
  // ECharts styles its tooltips inline, hence 'unsafe-inline' for styles, and an option written as
  // JavaScript is compiled with new Function, hence 'unsafe-eval', as in the panel.
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' 'unsafe-eval' https://cdn.jsdelivr.net`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    // Spelled out because neither falls back to default-src. The HTML of a chart's tooltip could
    // otherwise add a <base>, which relative URLs such as the url(#id) of SVGs resolve to.
    "base-uri 'none'",
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
/* Scrollbars and controls, such as those of a toolbox's data view, in the theme's light or dark. */
html { color-scheme: ${colors.dark ? "dark" : "light"}; }
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
${style}</style>
</head>
<body>
${title ? `<h1>${escapeHtml(title)}</h1>\n` : ""}<p id="error" role="alert" hidden></p>
<div id="canvas"></div>
<script nonce="${nonce}">window.${SAVED_CHART} = ${embedJson(chart)};</script>
<script type="module" nonce="${nonce}">
try {
  const echarts = await import(${embedJson(cdnModule)});
  // The panel uses two text measures from its bundled ECharts adapter. The public CDN build
  // exposes the same font measurement through format.getTextRect.
  const width = (text, font) => echarts.format.getTextRect(text, font).width;
  globalThis.DiagramECharts = {
    init: echarts.init,
    drawnWidth: width,
    textWidth: (text, font) => {
      let measured = 0;
      // ECharts breaks text by UTF-16 code units, treating every non-ASCII unit as full-width.
      for (let i = 0; i < text.length; i++) measured += width(text.charCodeAt(i) > 127 ? "国" : text[i], font);
      return measured;
    },
  };
  ${script}
} catch (error) {
  const element = document.getElementById("error");
  element.textContent = "Could not load the chart. This HTML needs internet access to load ECharts from jsDelivr. " + (error?.message ?? String(error));
  element.hidden = false;
}
</script>
</body>
</html>
`;
}
