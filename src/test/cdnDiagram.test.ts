import * as assert from "node:assert";
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
      const root = diagramExtension().extensionUri;
      const panel = vscode.window.createWebviewPanel(
        "diagram.export-test",
        "HTML export test",
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          localResourceRoots: [root],
        },
      );
      afterTest(() => panel.dispose());
      const { webview } = panel;
      const html = await build(language, source);
      // The exact published distribution, served locally so this test does not need a CDN connection.
      const relative = CDN_MODULES[language]
        .split(`/npm/${language}@`)[1]
        ?.split("/")
        .slice(1)
        .join("/");
      assert.ok(relative);
      const module = webview.asWebviewUri(
        vscode.Uri.joinPath(root, "node_modules", language, relative),
      );
      const nonce = /nonce="([^"]+)"/.exec(html)?.[1];
      assert.ok(nonce);
      const answer = new Promise<{ text: string; width: number; height: number }>(
        (resolve, reject) => {
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
        },
      );
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
      webview.html = html
        .replaceAll(CDN_MODULES[language], module.toString())
        .replace("https://cdn.jsdelivr.net", webview.cspSource)
        .replace("</body>", `${probe}</body>`);
      const rendered = await answer;
      assert.ok(rendered.text.includes(expected));
      assert.ok(rendered.width > 0 && rendered.height > 0, JSON.stringify(rendered));
    });
  }
});
