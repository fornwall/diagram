import * as assert from "node:assert";
import type * as vscode from "vscode";
import type { DiagramPanel } from "../panel";
import { openWebviewPanel } from "./newPanel";

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
 * `readTestState()`, `writeTestState(state)`, `testStateWrites` and `testRenderResults` (render request ids) become globals.
 */
export function instrumentWebview(panel: DiagramPanel): WebviewHarness {
  const { webview } = openWebviewPanel(panel);
  const nonce = /nonce="([^"]+)"/.exec(webview.html)?.[1];
  assert.ok(nonce);
  webview.html = webview.html.replace(
    '<script type="module"',
    `<script nonce="${nonce}">
      const acquire = acquireVsCodeApi;
      acquireVsCodeApi = () => {
        const api = acquire();
        window.readTestState = () => api.getState();
        window.writeTestState = (state) => api.setState(state);
        window.testStateWrites = 0;
        window.testRenderResults = [];
        const postMessage = (message) => {
          if (/^render(ed|Error|Unavailable)$/.test(message.type)) {
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
        if (/^render(ed|Error|Unavailable)$/.test(message.type)) {
          clearTimeout(timer);
          listener.dispose();
          if (message.type !== "rendered") reject(new Error(message.message));
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

/**
 * Webview code defining `dragImage(init)`: what dragging the drawing out of the panel carries, once
 * the image is ready, with the pointer pressed on the handle as `init` says, such as with Shift.
 */
export const DRAG_IMAGE = `
  const dragImage = async (init) => {
    const handle = document.getElementById("drag-out");
    handle.dispatchEvent(new PointerEvent("pointerenter"));
    if (init) handle.dispatchEvent(new PointerEvent("pointerdown", init));
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      const dataTransfer = new DataTransfer();
      handle.dispatchEvent(new DragEvent("dragstart", {dataTransfer, cancelable: true}));
      if (dataTransfer.getData("image/svg+xml")) return dataTransfer;
    }
    throw new Error("The image was not prepared.");
  };`;

/** Webview code defining `until(done)`, which waits up to two seconds for `done()`, and returns it. */
export const UNTIL = `
  const until = async (done) => {
    for (let attempt = 0; attempt < 100 && !done(); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return done();
  };`;
