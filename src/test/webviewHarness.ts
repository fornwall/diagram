import * as assert from "node:assert";
import type * as vscode from "vscode";
import type { Diagram, DiagramPanel, RenderOutcome } from "../panel";
import { newPanel, openWebviewPanel } from "./newPanel";

/** Access to the DOM of a panel's webview, for tests that drive the actual page. */
export interface WebviewHarness {
  webview: vscode.Webview;
  /** Evaluates a JavaScript expression in the webview, awaiting a promise it returns. */
  evaluate(expression: string): Promise<unknown>;
  /** Runs the action and waits for the webview to report the outcome of the next render. */
  nextRender(action: () => unknown): Promise<void>;
  /** Whether the webview is still open, which a panel that another panel opens is not. */
  readonly open: boolean;
}

/**
 * Shows the panel and instruments its page, without adding test commands to the shipped webview:
 * `readTestState()`, `writeTestState(state)`, `testStateWrites` and `testRenderResults` (render request ids) become globals.
 */
export function instrumentWebview(panel: DiagramPanel): WebviewHarness {
  const opened = openWebviewPanel(panel);
  const { webview } = opened;
  let open = true;
  opened.onDidDispose(() => {
    open = false;
  });
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

  return {
    webview,
    evaluate,
    nextRender,
    get open() {
      return open;
    },
  };
}

/** The page that the tests of a suite draw in, as an agent does, which they share. */
export interface Page extends WebviewHarness {
  readonly panel: DiagramPanel;
  /** Renders the diagram, a Mermaid one unless it says otherwise, as a tool does. */
  render(diagram: Partial<Diagram>): Promise<RenderOutcome>;
  /** Renders the diagram, which must render. */
  draw(diagram: Partial<Diagram>): Promise<void>;
}

/**
 * The page that the webview suites share, as loading a page takes a while, and as a new page
 * opened after the Mermaid suite's ran its timers only once a second, for a reason not found.
 */
let shared: { panel: DiagramPanel; harness: WebviewHarness } | undefined;
// At the top level, this runs after the tests of every suite.
suiteTeardown(() => shared?.panel.dispose());

/**
 * The page for the tests of the suite: the one that the webview suites share, opened again if a
 * suite in between opened a panel of its own, which closes it.
 */
export function suitePage(): Page {
  suiteSetup(() => {
    if (shared?.harness.open) return;
    const panel = newPanel();
    shared = { panel, harness: instrumentWebview(panel) };
  });
  const page = () => {
    assert.ok(shared, "The page opens before the tests of the suite.");
    return shared;
  };
  const render = (diagram: Partial<Diagram>) =>
    page().panel.render({ language: "mermaid", source: "", title: "Test", ...diagram }, "tool");
  return {
    get panel() {
      return page().panel;
    },
    get webview() {
      return page().harness.webview;
    },
    get open() {
      return page().harness.open;
    },
    evaluate: (expression) => page().harness.evaluate(expression),
    nextRender: (action) => page().harness.nextRender(action),
    render,
    draw: async (diagram) => {
      const outcome = await render(diagram);
      assert.ok(outcome.ok, outcome.ok ? undefined : outcome.error);
    },
  };
}

/** Mermaid diagrams of the common types, by the type that Mermaid detects. */
export const MERMAID = {
  "flowchart-v2": "flowchart LR\n  A[Parser] --> B[Checker]",
  sequence: "sequenceDiagram\n  Alice->>Bob: Hello",
  classDiagram: "classDiagram\n  class Parser {\n    +parse() Ast\n  }",
  er: "erDiagram\n  CUSTOMER ||--o{ ORDER : places",
  gantt: "gantt\n  dateFormat YYYY-MM-DD\n  Design :a1, 2026-01-01, 7d",
  mindmap: "mindmap\n  root((Plan))\n    Research",
  timeline: "timeline\n  2025 : Started\n  2026 : Shipped",
  journey: "journey\n  section Work\n    Make tea: 5: Me",
  pie: 'pie\n  "Dogs" : 386\n  "Rats" : 2',
  gitGraph: 'gitGraph\n  commit id: "init"\n  branch develop\n  commit tag: "v1"',
  xychart: "xychart\n  x-axis [jan, feb]\n  bar [10, 50]\n  line [15, 45]",
};

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
