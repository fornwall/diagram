// A single HTML document whose only required external assets are the pinned CDN renderer.

import type * as vscode from "vscode";
import { parsableSource } from "./mermaidSyntax";
import type { DiagramLanguage } from "./protocol";
import { embedJson, fontStack, savedChartHtml } from "./savedChart";
import { escapeHtml } from "./text";
import { mix, type ThemeColors, toCss } from "./webview/colors";

// Match the versions used to render the source in the panel; never use a moving CDN alias.
export const CDN_MODULES = {
  mermaid: "https://cdn.jsdelivr.net/npm/mermaid@12.2.0/dist/mermaid.esm.min.mjs",
  echarts: "https://cdn.jsdelivr.net/npm/echarts@6.1.0/dist/echarts.esm.min.mjs",
} as const;

export async function cdnDiagramHtml(
  drawing: { language: DiagramLanguage; source: string; title: string },
  colors: ThemeColors,
  extensionUri: vscode.Uri,
): Promise<string> {
  if (drawing.language === "echarts") {
    // Never serialize the panel state: it also holds raw, potentially filtered-out input rows,
    // previous user edits, local file paths, commands and document bindings.
    return savedChartHtml(
      { title: drawing.title, source: drawing.source, colors },
      extensionUri,
      CDN_MODULES.echarts,
    );
  }
  const title = drawing.title.trim() || "Diagram";
  const nonce = crypto.randomUUID();
  const config = {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    htmlLabels: false,
    theme: "base",
    fontFamily: fontStack(colors),
    themeVariables: {
      darkMode: colors.dark,
      background: toCss(colors.background),
      primaryColor: toCss(mix(colors.background, colors.blue, colors.dark ? 0.16 : 0.08)),
      primaryTextColor: toCss(colors.foreground),
      primaryBorderColor: toCss(colors.blue),
      lineColor: toCss(colors.foreground),
      textColor: toCss(colors.foreground),
      fontFamily: fontStack(colors),
      fontSize: `${colors.fontSize}px`,
    },
  };
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' https://cdn.jsdelivr.net`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
html { color-scheme: ${colors.dark ? "dark" : "light"}; }
body { margin: 0; background: ${toCss(colors.background)}; color: ${toCss(colors.foreground)}; font-family: ${fontStack(colors)}; font-size: ${colors.fontSize}px; }
h1 { margin: 0; padding: 16px; font-size: 1.2em; font-weight: 600; }
#error { padding: 0 16px; color: ${toCss(colors.red)}; white-space: pre-wrap; }
#diagram { padding: 16px; overflow: auto; }
#diagram svg { display: block; margin: auto; max-width: none !important; }
noscript { display: block; padding: 16px; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p id="error" role="alert" hidden></p>
<noscript>Enable JavaScript and internet access to render this diagram.</noscript>
<main id="diagram" aria-label="${escapeHtml(title)}"></main>
<script type="module" nonce="${nonce}">
const source = ${embedJson(parsableSource(drawing.source))};
try {
  const { default: mermaid } = await import(${embedJson(CDN_MODULES.mermaid)});
  mermaid.initialize(${embedJson(config)});
  const { svg } = await mermaid.render("exported-diagram", source);
  const container = document.getElementById("diagram");
  container.innerHTML = svg;
  // Preserve readable natural dimensions; large diagrams scroll rather than shrinking their text.
  const drawing = container.querySelector("svg");
  if (drawing?.viewBox.baseVal.width > 0) drawing.style.width = drawing.viewBox.baseVal.width + "px";
} catch (error) {
  const element = document.getElementById("error");
  element.textContent = "Could not render the diagram. This HTML needs internet access to load Mermaid from jsDelivr. " + (error?.message ?? String(error));
  element.hidden = false;
}
</script>
</body>
</html>
`;
}
