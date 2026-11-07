import * as assert from "node:assert";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { CDN_MODULES, cdnDiagramHtml } from "../cdnDiagram";
import type { DiagramLanguage } from "../protocol";
import { afterTest, diagramExtension } from "./afterTest";
import { testColors } from "./themeColors";

const build = (language: DiagramLanguage, source: string, title = "Exported diagram") =>
  cdnDiagramHtml({ language, source, title }, testColors, diagramExtension().extensionUri);

suite("cdnDiagram", () => {
  test("pins each CDN renderer to the package lock and embeds no relative resources", async () => {
    const root = diagramExtension().extensionUri;
    const lock = JSON.parse(
      fs.readFileSync(vscode.Uri.joinPath(root, "package-lock.json").fsPath, "utf8"),
    );
    for (const language of ["mermaid", "echarts"] as const) {
      const version = lock.packages[`node_modules/${language}`].version;
      assert.ok(CDN_MODULES[language].includes(`@${version}/`));
      const html = await build(language, language === "mermaid" ? "flowchart LR\n A-->B" : "{}");
      assert.ok(html.includes(CDN_MODULES[language]));
      // The browser checks each file it loads, chunks included, against the one in the package.
      const dist = vscode.Uri.joinPath(root, "node_modules", language, "dist").fsPath;
      const files = [
        ...(language === "mermaid" ? ["chunks/mermaid.esm.min"] : []).flatMap((dir) =>
          fs.readdirSync(`${dist}/${dir}`).map((file) => `${dir}/${file}`),
        ),
        CDN_MODULES[language].split("/dist/")[1] ?? "",
      ].filter((file) => file.endsWith(".mjs"));
      const integrity = JSON.parse(
        /<script type="importmap"[^>]*>(.*?)<\/script>/.exec(html)?.[1] ?? "{}",
      ).integrity;
      assert.strictEqual(Object.keys(integrity).length, files.length);
      for (const file of files) {
        const hash = createHash("sha384")
          .update(fs.readFileSync(`${dist}/${file}`))
          .digest("base64");
        const url = CDN_MODULES[language].replace(/\/dist\/.*/, `/dist/${file}`);
        assert.strictEqual(integrity[url], `sha384-${hash}`);
      }
      assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:src|href)=/);
      assert.match(html, /base-uri 'none'/);
      assert.match(html, /form-action 'none'/);
    }
  });

  test("embeds hostile source/title text without allowing HTML or script breakout", async () => {
    const source = "</script><script>globalThis.injected = true</script><!--";
    const title = '</title><img src=x onerror="alert(1)">';
    for (const language of ["mermaid", "echarts"] as const) {
      const html = await build(language, source, title);
      assert.ok(!html.includes(source));
      assert.ok(!html.includes(title));
      assert.ok(html.includes("\\u003c/script>"));
      assert.ok(html.includes("&lt;/title&gt;"));
    }
  });

  for (const [language, source, expected] of [
    ["mermaid", "mindmap\r\n\r\n  root[Root]\r\n    child[Child]", "Child"],
    ["mermaid", "---\nconfig:\n  layout: elk\n---\nflowchart LR\n A[Alpha] --> B[Beta]", "Alpha"],
    // As the panel draws it, rather than with the tags as text.
    ["mermaid", 'flowchart LR\n A["<b>Bold</b> label"] --> B', "Bold label"],
    [
      "echarts",
      '{"xAxis":{"type":"category","data":["Alpha","Beta"]},"yAxis":{},"series":[{"type":"bar","data":[10,20]}]}',
      "Alpha",
    ],
    [
      "echarts",
      '{series:[{type:"pie",label:{formatter: p => "Value " + p.value},data:[{name:"Alpha",value:12},{name:"Beta",value:8}]}]}',
      "Value 12",
    ],
  ] as const) {
    test(`renders exported ${language} HTML with ${expected} using the actual CDN distribution`, async function () {
      this.timeout(30_000);
      const rendered = await renderExported(language, await build(language, source), expected);
      assert.ok(rendered.text.includes(expected));
      assert.ok(rendered.width > 0 && rendered.height > 0, JSON.stringify(rendered));
    });
  }

  test("loads no renderer file other than the one the extension was built with", async function () {
    this.timeout(30_000);
    for (const language of ["mermaid", "echarts"] as const) {
      const html = await build(language, language === "mermaid" ? "flowchart LR\n A-->B" : "{}");
      const tampered = html.replace(/("integrity":\{[^}]*?"sha384-)[^"]+/, "$1AAAA");
      assert.notStrictEqual(tampered, html);
      // The page says why, rather than wait for a drawing.
      await assert.rejects(
        renderExported(language, tampered, "B"),
        /^Error: Could not (?:render the diagram|load the chart)\./,
      );
    }
  });
});

/**
 * Renders an exported page in a webview from the exact published distribution, served locally so
 * that no CDN connection is needed, until its drawing shows the expected text or its error.
 */
async function renderExported(
  language: DiagramLanguage,
  html: string,
  expected: string,
): Promise<{ text: string; width: number; height: number }> {
  const root = diagramExtension().extensionUri;
  const panel = vscode.window.createWebviewPanel(
    "diagram.export-test",
    "HTML export test",
    vscode.ViewColumn.One,
    { enableScripts: true, localResourceRoots: [root] },
  );
  afterTest(() => panel.dispose());
  const { webview } = panel;
  const cdn = /^(.*\/npm\/[^/]+\/)/.exec(CDN_MODULES[language])?.[1];
  assert.ok(cdn);
  const local = webview.asWebviewUri(vscode.Uri.joinPath(root, "node_modules", language));
  const nonce = /nonce="([^"]+)"/.exec(html)?.[1];
  assert.ok(nonce);
  const answer = new Promise<{ text: string; width: number; height: number }>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("The exported page did not render.")),
      25_000,
    );
    const listener = webview.onDidReceiveMessage((message) => {
      clearTimeout(timeout);
      listener.dispose();
      if (message.error) reject(new Error(message.error));
      else resolve(message);
    });
    afterTest(() => {
      clearTimeout(timeout);
      listener.dispose();
    });
  });
  const probe = `<script nonce="${nonce}">
    const api = acquireVsCodeApi();
    const check = () => {
      const error = document.getElementById("error");
      const svg = document.querySelector("#diagram svg, #chart svg");
      if (error && !error.hidden) { api.postMessage({error: error.textContent}); observer.disconnect(); }
      else if (svg?.textContent.includes(${JSON.stringify(expected)})) {
        const box = svg.getBoundingClientRect();
        api.postMessage({text: svg.textContent, width: box.width, height: box.height});
        observer.disconnect();
      }
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, {childList: true, subtree: true, attributes: true});
    check();
  </script>`;
  // The CSP names the CDN first, before the files that the page loads from it.
  webview.html = html
    .replace("https://cdn.jsdelivr.net", webview.cspSource)
    .replaceAll(cdn, `${local}/`)
    .replace("</body>", `${probe}</body>`);
  return answer;
}
