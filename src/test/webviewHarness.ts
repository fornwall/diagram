import * as assert from "node:assert";
import type * as vscode from "vscode";
import type { DiagramPanel } from "../panel";

/** Access to the DOM of a panel's webview, for tests that drive the actual page. */
export interface WebviewHarness {
  webview: vscode.Webview;
  /** Evaluates a JavaScript expression in the webview, awaiting a promise it returns. */
  evaluate(expression: string): Promise<unknown>;
  /** Runs the action and waits for the webview to report the outcome of the next render. */
  nextRender(action: () => unknown): Promise<void>;
}

/**
 * Shows the panel and instruments its page, without adding test commands to the shipped webview:
 * `readTestState()`, `testStateWrites` and `testRenderResults` (render request ids) become globals.
 */
export function instrumentWebview(panel: DiagramPanel): WebviewHarness {
  panel.show();
  const { webview } = (panel as unknown as { panel: vscode.WebviewPanel }).panel;
  const nonce = /nonce="([^"]+)"/.exec(webview.html)?.[1];
  assert.ok(nonce);
  webview.html = webview.html.replace(
    '<script type="module"',
    `<script nonce="${nonce}">
      const acquire = acquireVsCodeApi;
      acquireVsCodeApi = () => {
        const api = acquire();
        window.readTestState = () => api.getState();
        window.testStateWrites = 0;
        window.testRenderResults = [];
        const postMessage = (message) => {
          if (message.type === "rendered" || message.type === "renderError") {
            window.testRenderResults.push(message.requestId);
          }
          return api.postMessage(message);
        };
        window.addEventListener("message", async ({data}) => {
          if (data.type !== "testExpression") return;
          try {
            api.postMessage({type: "testResult", value: await new Function("return (" + data.expression + ")")()});
          } catch (error) {
            api.postMessage({type: "testResult", error: String(error)});
          }
        });
        return {...api, postMessage, setState: (state) => {
          window.testStateWrites++;
          return api.setState(state);
        }};
      };
    </script><script type="module"`,
  );

  function evaluate(expression: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listener.dispose();
        reject(new Error("The webview did not answer the test expression."));
      }, 5000);
      const listener = webview.onDidReceiveMessage((message) => {
        if (message.type === "testResult") {
          clearTimeout(timer);
          listener.dispose();
          if (message.error) reject(new Error(message.error));
          else resolve(message.value);
        }
      });
      void webview.postMessage({ type: "testExpression", expression });
    });
  }

  function nextRender(action: () => unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listener.dispose();
        reject(new Error("The webview did not render its diagram."));
      }, 10_000);
      const listener = webview.onDidReceiveMessage((message) => {
        if (message.type === "rendered" || message.type === "renderError") {
          clearTimeout(timer);
          listener.dispose();
          if (message.type === "renderError") reject(new Error(message.message));
          else resolve();
        }
      });
      Promise.resolve()
        .then(action)
        .catch((error: unknown) => {
          clearTimeout(timer);
          listener.dispose();
          reject(error);
        });
    });
  }

  return { webview, evaluate, nextRender };
}
