import * as assert from "node:assert";
import type * as vscode from "vscode";
import type { Diagram, DiagramPanel, RenderOutcome } from "../panel";
import { newPanel, openWebviewPanel } from "./newPanel";

/** How long `evaluate` waits for an expression's answer. */
const EVALUATE_TIMEOUT = 10_000;
/**
 * How long before then the `until` calls of an expression give up, saying what they await: longer
 * than a step of a throttled page, which runs its timers once a second, so that they fail first.
 */
const UNTIL_MARGIN = 2000;

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
 * `readTestState()`, `writeTestState(state)`, `testStateWrites`, `testRenderResults` (render request ids)
 * and `receive(data)`, which hands the page a message as if from the extension, become globals.
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
  let isLoaded = false;
  const loaded = new Promise<void>((resolve) => {
    const listener = webview.onDidReceiveMessage((message) => {
      if (message.type !== "testLoaded") return;
      listener.dispose();
      isLoaded = true;
      resolve();
    });
  });
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
        window.receive = (data) => window.dispatchEvent(new MessageEvent("message", {data}));
        const postMessage = (message) => {
          if (/^render(ed|Error|Unavailable)$/.test(message.type)) {
            window.testRenderResults.push(message.requestId);
          }
          return api.postMessage(message);
        };
        window.addEventListener("message", async ({data}) => {
          if (data.type !== "testExpression") return;
          const {id} = data;
          try {
            api.postMessage({type: "testResult", id, value: await new Function("testDeadline", "return (" + data.expression + ")")(
              performance.now() + ${EVALUATE_TIMEOUT - UNTIL_MARGIN},
            )});
          } catch (error) {
            api.postMessage({type: "testResult", id, error: error?.message ?? String(error)});
          }
        });
        api.postMessage({type: "testLoaded"});
        return {...api, postMessage, setState: (state) => {
          window.testStateWrites++;
          return api.setState(state);
        }};
      };
    </script><script type="module"`,
  );

  // Tells answers apart, as an expression that timed out may still answer, later.
  let expressions = 0;
  function evaluate(expression: string): Promise<unknown> {
    // The time to answer starts once the page has loaded, which takes long on a busy machine.
    // Once it has, the expression goes at once, before any message that the test sends next.
    if (!isLoaded) return loaded.then(() => evaluate(expression));
    const id = ++expressions;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listener.dispose();
        reject(new Error("The webview did not answer the test expression."));
      }, EVALUATE_TIMEOUT);
      const listener = webview.onDidReceiveMessage((message) => {
        if (message.type === "testResult" && message.id === id) {
          clearTimeout(timer);
          listener.dispose();
          if (message.error) reject(new Error(message.error));
          else resolve(message.value);
        }
      });
      void webview.postMessage({ type: "testExpression", id, expression });
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
 * The page that the webview suites share, as loading a page takes a while, and as a page opened
 * within about a second of closing another often runs its timers only once a second, as do VS
 * Code's frames around it: Chromium throttles the frames as if hidden, though they draw and see
 * themselves visible, until the panel is hidden and shown. Polling the page with setTimeout then
 * takes a second a step. Neither the page's content nor its code matter: an empty page does it.
 */
let shared: { panel: DiagramPanel; harness: WebviewHarness } | undefined;
// At the top level, this runs after the tests of every suite.
suiteTeardown(() => shared?.panel.dispose());

/**
 * The page for the tests of the suite: the one that the webview suites share, opened again if a
 * suite in between opened a panel of its own, which closes it.
 */
export function suitePage(): Page {
  suiteSetup(async () => {
    if (shared?.harness.open) return;
    const panel = newPanel();
    shared = { panel, harness: instrumentWebview(panel) };
    // Loads the page before the tests, whose time it would take.
    await shared.harness.evaluate("0");
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
 * Webview code defining `until(done, awaited, step)`, which waits for `done()` and returns it,
 * checking it every 20 ms, or after each `step()` such as `nextFrame`, for up to four seconds, as
 * a throttled page runs its timers and frames once a second, and only while the expression it is
 * in may still answer. Told what it awaits, it fails saying so rather than return a false value.
 */
export const UNTIL = `
  const nextFrame = () => new Promise(requestAnimationFrame);
  const until = async (done, awaited, step = () => new Promise(resolve => setTimeout(resolve, 20))) => {
    for (const end = Math.min(performance.now() + 4000, testDeadline); ; await step()) {
      const result = done();
      if (result) return result;
      if (performance.now() > end) {
        if (awaited) throw new Error("Timed out waiting for " + awaited + ".");
        return result;
      }
    }
  };`;

/**
 * Webview code defining `dragImage(init)`: what dragging the drawing out of the panel carries, once
 * the image is ready, with the pointer pressed on the handle as `init` says, such as with Shift.
 * It keeps its `until` to itself, for expressions that define their own.
 */
export const DRAG_IMAGE = `
  const dragImage = (() => {
    ${UNTIL}
    return async (init) => {
      const handle = document.getElementById("drag-out");
      handle.dispatchEvent(new PointerEvent("pointerenter"));
      if (init) handle.dispatchEvent(new PointerEvent("pointerdown", init));
      return until(() => {
        const dataTransfer = new DataTransfer();
        handle.dispatchEvent(new DragEvent("dragstart", {dataTransfer, cancelable: true}));
        return dataTransfer.getData("image/svg+xml") && dataTransfer;
      }, "the drag image");
    };
  })();`;
