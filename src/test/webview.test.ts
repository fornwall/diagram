import * as assert from "node:assert";
import type * as vscode from "vscode";
import type { Diagram, DiagramPanel, RenderOutcome } from "../panel";
import { newPanel } from "./newPanel";

const MERMAID: Record<string, string> = {
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

suite("webview", function () {
  // The first render loads the webview and the libraries, which can take a while.
  this.timeout(20_000);

  let panel: DiagramPanel;
  let webview: vscode.Webview;
  suiteSetup(() => {
    panel = newPanel();
    panel.show();
    webview = (panel as unknown as { panel: vscode.WebviewPanel }).panel.webview;
    const nonce = /nonce="([^"]+)"/.exec(webview.html)?.[1];
    assert.ok(nonce);
    // Drive the actual DOM without adding test commands to the shipped webview.
    webview.html = webview.html.replace(
      '<script type="module"',
      `<script nonce="${nonce}">
        const acquire = acquireVsCodeApi;
        acquireVsCodeApi = () => {
          const api = acquire();
          window.readTestState = () => api.getState();
          window.addEventListener("message", async ({data}) => {
            if (data.type !== "testExpression") return;
            try {
              api.postMessage({type: "testResult", value: await new Function("return (" + data.expression + ")")()});
            } catch (error) {
              api.postMessage({type: "testResult", error: String(error)});
            }
          });
          return api;
        };
      </script><script type="module"`,
    );
  });
  suiteTeardown(() => panel.dispose());

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

  const render = (diagram: Partial<Diagram>): Promise<RenderOutcome> =>
    panel.render({ language: "mermaid", source: "", title: "Test", ...diagram }, "tool");

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

  test("renders Mermaid diagrams of the common types", async () => {
    for (const [diagramType, source] of Object.entries(MERMAID)) {
      assert.deepStrictEqual(await render({ source }), { ok: true, diagramType });
    }
  });

  test("resizes the source pane to its limits and resets it with the keyboard", async () => {
    assert.ok((await render({ source: MERMAID["flowchart-v2"] })).ok);
    assert.deepStrictEqual(
      await evaluate(`(() => {
        document.getElementById("view-split").click();
        const splitter = document.getElementById("splitter");
        splitter.focus();
        const values = [];
        try {
          for (const key of ["Home", "End", "Enter"]) {
            const event = new KeyboardEvent("keydown", {key, bubbles: true, cancelable: true});
            splitter.dispatchEvent(event);
            values.push({
              value: splitter.getAttribute("aria-valuenow"),
              prevented: event.defaultPrevented,
              focused: document.activeElement === splitter
            });
          }
          return values;
        } finally {
          document.getElementById("view-visual").click();
        }
      })()`),
      [
        { value: "15", prevented: true, focused: true },
        { value: "85", prevented: true, focused: true },
        { value: "40", prevented: true, focused: true },
      ],
    );
  });

  test("only enables sending to chat when the message contains text", async () => {
    assert.deepStrictEqual(
      await evaluate(`(() => {
        const input = document.getElementById("ask-input");
        const submit = document.querySelector('#ask-form button[type="submit"]');
        const original = input.value;
        try {
          return ["", "   ", "Explain this node", ""].map(value => {
            input.value = value;
            input.dispatchEvent(new Event("input"));
            return submit.disabled;
          });
        } finally {
          input.value = original;
          input.dispatchEvent(new Event("input"));
        }
      })()`),
      [true, true, false, true],
    );
  });

  test("returns keyboard focus to visible content after clearing the selection", async () => {
    assert.ok((await render({ source: MERMAID["flowchart-v2"] })).ok);
    assert.deepStrictEqual(
      await evaluate(`(() => {
        const node = document.querySelector("#diagram .diagram-node[tabindex]");
        const clear = document.getElementById("clear-selection");
        try {
          return ["visual", "source"].map(view => {
            node.dispatchEvent(new MouseEvent("click", {bubbles: true}));
            document.getElementById("view-" + view).click();
            const selected = !clear.hidden;
            clear.focus();
            clear.click();
            return {
              selected,
              cleared: clear.hidden && !document.querySelector("#diagram .diagram-selected"),
              focused: document.activeElement === document.getElementById(view === "source" ? "source" : "canvas")
            };
          });
        } finally {
          document.getElementById("view-visual").click();
        }
      })()`),
      [
        { selected: true, cleared: true, focused: true },
        { selected: true, cleared: true, focused: true },
      ],
    );
  });

  test("restores focus after completing or cancelling a node pick", async () => {
    assert.ok((await render({ source: MERMAID["flowchart-v2"] })).ok);
    assert.deepStrictEqual(
      await evaluate(`(() => {
        try {
          return ["visual", "source"].flatMap(view => {
            document.getElementById("view-" + view).click();
            return ["pick-done", "pick-cancel"].map(id => {
              window.dispatchEvent(new MessageEvent("message", {data: {
                type: "startPick", pickId: 90000, prompt: "Pick a node", multiple: true
              }}));
              document.querySelector("#diagram .diagram-node[tabindex]")
                .dispatchEvent(new MouseEvent("click", {bubbles: true}));
              const button = document.getElementById(id);
              button.focus();
              button.click();
              return document.getElementById("pick").hidden &&
                document.activeElement === document.getElementById(view === "source" ? "source" : "canvas");
            });
          });
        } finally {
          document.getElementById("view-visual").click();
          document.getElementById("clear-selection").click();
        }
      })()`),
      [true, true, true, true],
    );
  });

  test("ends panning when released outside the canvas or pointer capture is lost", async () => {
    assert.ok((await render({ source: MERMAID["flowchart-v2"] })).ok);
    assert.deepStrictEqual(
      await evaluate(`(() => {
        const canvas = document.getElementById("canvas");
        const captured = [];
        let pointer;
        // Synthetic pointer events cannot acquire native pointer capture.
        canvas.setPointerCapture = id => { pointer = id; captured.push(id); };
        canvas.hasPointerCapture = id => pointer === id;
        canvas.releasePointerCapture = () => { pointer = undefined; };
        Object.defineProperty(canvas, "scrollWidth", {value: canvas.clientWidth + 100, configurable: true});
        const send = (target, type, pointerId, clientX = 100) => target.dispatchEvent(
          new PointerEvent(type, {pointerId, clientX, clientY: 100, pointerType: "mouse",
            button: 0, isPrimary: true, bubbles: true})
        );
        try {
          send(canvas, "pointerdown", 1);
          send(document.body, "pointerup", 1);
          send(canvas, "pointermove", 1, 90);
          const released = !canvas.classList.contains("panning") && captured.length === 0;
          send(canvas, "pointerdown", 2);
          send(canvas, "pointermove", 2, 90);
          const restarted = canvas.classList.contains("panning") && captured.at(-1) === 2;
          send(document.body, "pointerup", 3);
          const unrelated = canvas.classList.contains("panning");
          send(canvas, "lostpointercapture", 2);
          const lostCapture = !canvas.classList.contains("panning");
          const click = new MouseEvent("click", {bubbles: true, cancelable: true});
          canvas.dispatchEvent(click);
          return {released, restarted, unrelated, lostCapture, clickAllowed: !click.defaultPrevented};
        } finally {
          send(canvas, "pointercancel", 1);
          send(canvas, "pointercancel", 2);
          delete canvas.setPointerCapture;
          delete canvas.hasPointerCapture;
          delete canvas.releasePointerCapture;
          delete canvas.scrollWidth;
        }
      })()`),
      { released: true, restarted: true, unrelated: true, lostCapture: true, clickAllowed: true },
    );
  });

  test("keeps unapplied source edits across view changes and incoming diagrams", async () => {
    assert.ok((await render({ source: "flowchart LR\n A --> B" })).ok);
    await evaluate(`(() => {
      document.getElementById("view-split").click();
      const source = document.getElementById("source");
      source.value = "flowchart LR\\n A --> Draft";
      source.dispatchEvent(new Event("input"));
      document.getElementById("view-visual").click();
      document.getElementById("view-split").click();
    })()`);
    assert.strictEqual(
      await evaluate('document.getElementById("source").value'),
      "flowchart LR\n A --> Draft",
    );
    await evaluate('document.getElementById("view-visual").click()');
    assert.ok((await render({ source: "flowchart LR\n A --> New" })).ok);
    await evaluate('document.getElementById("view-source").click()');
    assert.deepStrictEqual(
      await evaluate(`({
        source: document.getElementById("source").value,
        stale: !document.getElementById("stale-note").hidden
      })`),
      { source: "flowchart LR\n A --> Draft", stale: true },
    );
    await evaluate('document.getElementById("revert").click()');
    assert.strictEqual(
      await evaluate('document.getElementById("source").value'),
      "flowchart LR\n A --> New",
    );
    await evaluate('document.getElementById("view-visual").click()');
  });

  test("restores unapplied source edits after a webview reload", async () => {
    const original = "flowchart LR\n A --> Original";
    const draft = "flowchart LR\n A --> Draft";
    assert.ok((await render({ source: original })).ok);
    await evaluate(`(() => {
      document.getElementById("view-split").click();
      const input = document.getElementById("source");
      input.value = ${JSON.stringify(draft)};
      input.dispatchEvent(new Event("input"));
    })()`);
    assert.deepStrictEqual(await evaluate("window.readTestState().editor"), {
      source: draft,
      base: original,
    });
    await nextRender(() => {
      webview.html += "\n<!-- Reload to verify draft restoration. -->";
    });
    assert.deepStrictEqual(
      await evaluate(`({
        source: document.getElementById("source").value,
        stale: !document.getElementById("stale-note").hidden,
        applyDisabled: document.getElementById("apply").disabled
      })`),
      { source: draft, stale: false, applyDisabled: false },
    );
    const incoming = "flowchart LR\n A --> Incoming";
    assert.ok((await render({ source: incoming })).ok);
    assert.deepStrictEqual(
      await evaluate(`({
        source: document.getElementById("source").value,
        stale: !document.getElementById("stale-note").hidden
      })`),
      { source: draft, stale: true },
    );
    await evaluate('document.getElementById("revert").click()');
    assert.strictEqual(await evaluate('document.getElementById("source").value'), incoming);
    assert.strictEqual(await evaluate("window.readTestState().editor ?? null"), null);
    await evaluate(`(() => {
      const input = document.getElementById("source");
      input.value = ${JSON.stringify(draft)};
      input.dispatchEvent(new Event("input"));
    })()`);
    await nextRender(() => evaluate('document.getElementById("apply").click()'));
    assert.strictEqual(panel.current?.source, draft);
    assert.strictEqual(await evaluate("window.readTestState().editor ?? null"), null);
    await evaluate('document.getElementById("view-visual").click()');
  });

  test("exports chart dimensions while its rendering is hidden in Source view", async () => {
    assert.ok(
      (
        await render({
          language: "echarts",
          source: '{"series": [{"type": "pie", "data": [1, 2]}]}',
        })
      ).ok,
    );
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        const chart = document.querySelector("#chart svg");
        const width = chart.width.baseVal.value;
        const height = chart.height.baseVal.value;
        document.getElementById("view-source").click();
        const handle = document.getElementById("drag-out");
        handle.dispatchEvent(new PointerEvent("pointerenter"));
        try {
          for (let attempt = 0; attempt < 100; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 20));
            const dataTransfer = new DataTransfer();
            handle.dispatchEvent(new DragEvent("dragstart", {dataTransfer, cancelable: true}));
            const svg = dataTransfer.getData("image/svg+xml");
            if (svg) {
              const image = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
              return {
                hidden: chart.getBoundingClientRect().width === 0,
                sized: width > 0 && height > 0 && Number(image.getAttribute("width")) === width &&
                  Number(image.getAttribute("height")) === height,
                viewBox: image.getAttribute("viewBox") === "0 0 " + width + " " + height
              };
            }
          }
          throw new Error("The chart image was not prepared.");
        } finally {
          document.getElementById("view-visual").click();
        }
      })()`),
      { hidden: true, sized: true, viewBox: true },
    );
  });

  test("sizes a chart first rendered in Source view and resizes it when revealed", async () => {
    assert.ok((await render({ source: "flowchart LR\n A --> B" })).ok);
    await evaluate('document.getElementById("view-source").click()');
    try {
      assert.ok(
        (
          await render({
            language: "echarts",
            source: '{"series": [{"type": "pie", "data": [1, 2]}]}',
          })
        ).ok,
      );
      assert.strictEqual(
        await evaluate(`(() => {
          const svg = document.querySelector("#chart svg");
          return svg.width.baseVal.value > 0 && svg.height.baseVal.value > 0;
        })()`),
        true,
      );
      assert.strictEqual(
        await evaluate(`(async () => {
          document.getElementById("view-visual").click();
          const chart = document.getElementById("chart");
          const svg = chart.querySelector("svg");
          for (let attempt = 0; attempt < 100; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 20));
            if (chart.clientWidth > 0 && svg.width.baseVal.value === chart.clientWidth &&
              svg.height.baseVal.value === chart.clientHeight) return true;
          }
          return false;
        })()`),
        true,
      );
    } finally {
      await evaluate('document.getElementById("view-visual").click()');
    }
  });

  test("exports SVG when the browser cannot create a PNG", async () => {
    assert.ok(
      (
        await render({
          language: "echarts",
          source: '{"series": [{"type": "pie", "data": [1, 2]}]}',
        })
      ).ok,
    );
    const download = await evaluate(`(async () => {
      const original = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = () => "data:,";
      try {
        const handle = document.getElementById("drag-out");
        handle.dispatchEvent(new PointerEvent("pointerenter"));
        for (let attempt = 0; attempt < 100; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 20));
          const dataTransfer = new DataTransfer();
          handle.dispatchEvent(new DragEvent("dragstart", {dataTransfer, cancelable: true}));
          const download = dataTransfer.getData("DownloadURL");
          if (download) return download;
        }
        throw new Error("The SVG fallback was not prepared.");
      } finally {
        HTMLCanvasElement.prototype.toDataURL = original;
      }
    })()`);
    assert.strictEqual(typeof download, "string");
    assert.match(download as string, /^image\/svg\+xml:Test\.svg:data:image\/svg\+xml/);
  });

  test("keeps SVG export and rendering available while PNG decoding stalls", async () => {
    assert.ok(
      (
        await render({
          language: "echarts",
          source:
            '{"animation": false, "series": [{"type": "pie", "data": [{"name": "Original", "value": 1}]}]}',
        })
      ).ok,
    );
    assert.deepStrictEqual(
      await evaluate(`(async () => {
      const original = HTMLImageElement.prototype.decode;
      let release;
      let decoding = false;
      const pending = new Promise(resolve => { release = resolve; });
      HTMLImageElement.prototype.decode = function () {
        decoding = true;
        return pending.then(() => original.call(this));
      };
      const handle = document.getElementById("drag-out");
      try {
        handle.dispatchEvent(new PointerEvent("pointerenter"));
        for (let attempt = 0; !decoding && attempt < 100; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        const dataTransfer = new DataTransfer();
        handle.dispatchEvent(new DragEvent("dragstart", {dataTransfer, cancelable: true}));
        const svgAvailable = dataTransfer.getData("image/svg+xml").includes("Original");
        window.dispatchEvent(new MessageEvent("message", {data: {
          type: "render", language: "echarts", requestId: -1, title: "Incoming",
          source: JSON.stringify({animation: false, series: [{type: "pie", data: [{name: "Incoming", value: 1}]}]})
        }}));
        for (let attempt = 0; attempt < 100; attempt++) {
          if (document.querySelector("#chart svg")?.textContent.includes("Incoming")) {
            return {svgAvailable, rendered: true};
          }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        return {svgAvailable, rendered: false};
      } finally {
        HTMLImageElement.prototype.decode = original;
        release();
      }
    })()`),
      { svgAvailable: true, rendered: true },
    );
  });

  test("exports Mermaid labels as SVG text despite diagram configuration", async () => {
    assert.ok(
      (
        await render({
          source:
            "---\nconfig:\n  htmlLabels: true\n---\nflowchart LR\n A[Exported label] --> B[Other label]",
        })
      ).ok,
    );
    const exported = await evaluate(`(async () => {
      const handle = document.getElementById("drag-out");
      handle.dispatchEvent(new PointerEvent("pointerenter"));
      for (let attempt = 0; attempt < 100; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 20));
        const dataTransfer = new DataTransfer();
        handle.dispatchEvent(new DragEvent("dragstart", {dataTransfer, cancelable: true}));
        const svg = dataTransfer.getData("image/svg+xml");
        if (svg) {
          const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
          return {
            htmlLabels: parsed.querySelectorAll("foreignObject").length,
            text: Array.from(parsed.querySelectorAll("text"), node => node.textContent).join("").replace(/\\s/g, "")
          };
        }
      }
      throw new Error("The diagram image was not prepared.");
    })()`);
    assert.deepStrictEqual(exported, { htmlLabels: 0, text: "ExportedlabelOtherlabel" });
  });

  test("keeps Mermaid image export separate from an incoming render", async () => {
    assert.ok((await render({ source: "flowchart LR\n A[Original label] --> B" })).ok);
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        const original = DOMParser.prototype.parseFromString;
        let exported;
        DOMParser.prototype.parseFromString = function (source, type) {
          const parsed = original.call(this, source, type);
          if (String(source).includes('id="diagram-image-') && type === "image/svg+xml") {
            exported = {
              htmlLabels: parsed.querySelectorAll("foreignObject").length,
              originalLabel: parsed.documentElement.textContent.includes("Original label")
            };
          }
          return parsed;
        };
        try {
          document.getElementById("drag-out").dispatchEvent(new PointerEvent("pointerenter"));
          window.dispatchEvent(new MessageEvent("message", {data: {
            type: "render", language: "mermaid", requestId: -1,
            source: "flowchart LR\\n C[Incoming label] --> D", title: "Incoming"
          }}));
          for (let attempt = 0; attempt < 100; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 20));
            if (exported && document.querySelector("#diagram").textContent.includes("Incoming label")) {
              return exported;
            }
          }
          throw new Error("Concurrent image export and render did not finish.");
        } finally {
          DOMParser.prototype.parseFromString = original;
        }
      })()`),
      { htmlLabels: 0, originalLabel: true },
    );
  });

  test("names an unknown Mermaid diagram type instead of repeating the source", async () => {
    const outcome = await render({ source: "flowchar TD\n  A --> B" });
    assert.ok(!outcome.ok);
    assert.match(outcome.error, /^Unknown diagram type "flowchar": the first line must declare/);
    const fenced = await render({ source: "```mermaid\nflowchart TD\n  A --> B\n```" });
    assert.ok(!fenced.ok);
    assert.match(fenced.error, /^Remove the code fence/);
  });

  test("reports Mermaid errors on the line of the source", async () => {
    // Mermaid numbers the lines without front matter, directives, comments and leading blank lines.
    const source =
      "---\ntitle: T\n---\n%%{init: {}}%%\n\nflowchart TD\n  %% note\n  A --> B\n  B -> C";
    const outcome = await render({ source });
    assert.ok(!outcome.ok);
    assert.match(outcome.error, /^Parse error on line 9:/);
    const yaml = await render({ source: "---\ntitle: [\n---\nflowchart TD" });
    assert.ok(!yaml.ok);
    assert.match(yaml.error, /^Invalid YAML in the front matter on line \d+: /);
  });

  test("explains Mermaid's limits", async () => {
    const edges = Array.from({ length: 501 }, (_, i) => `  n${i} --> n${i + 1}`);
    const outcome = await render({ source: `flowchart TD\n${edges.join("\n")}` });
    assert.ok(!outcome.ok);
    assert.match(outcome.error, /^The diagram has more than 500 edges/);
    // Mermaid would draw a message in place of the diagram.
    const long = await render({ source: `flowchart TD\n${"  A --> B\n".repeat(5000)}` });
    assert.ok(!long.ok);
    assert.match(long.error, /^The diagram is too long/);
  });

  test("lets the webview compile an option written as JavaScript", () => {
    panel.show();
    const { webview } = (panel as unknown as { panel: vscode.WebviewPanel }).panel;
    assert.match(webview.html, /script-src 'nonce-[\w-]+' 'unsafe-eval'/);
  });

  test("renders charts, and switches between charts and diagrams", async () => {
    const option = {
      xAxis: { type: "category", data: ["A", "B"] },
      yAxis: {},
      series: [{ type: "bar", data: [1, 2] }],
    };
    const chart = { language: "echarts", source: JSON.stringify(option) } as const;
    assert.deepStrictEqual(await render(chart), { ok: true, diagramType: "bar" });
    assert.ok((await render({ source: MERMAID["flowchart-v2"] })).ok);
    assert.ok((await render(chart)).ok);
  });

  test("reports the node ids it drew, and marks them on the diagram it already shows", async () => {
    assert.ok((await render({ source: MERMAID["flowchart-v2"] })).ok);
    assert.deepStrictEqual([...(panel.drawnIds ?? [])].sort(), ["A", "B"]);
    const marked = panel.annotate({
      marks: [
        { id: "A", kind: "problem", note: "fails here" },
        { id: "B", kind: "good" },
      ],
      caption: "Step 1 of 2",
      dim: true,
    });
    assert.ok(marked.ok);
    assert.deepStrictEqual(marked.unknown, []);
    // The diagram is still the one that was rendered, and it still renders and picks.
    assert.strictEqual(panel.current?.source, MERMAID["flowchart-v2"]);
    assert.strictEqual(panel.current?.error, undefined);
    assert.ok((await render({ source: MERMAID.sequence })).ok);
    assert.deepStrictEqual([...(panel.drawnIds ?? [])].sort(), ["Alice", "Bob"]);

    // A chart's items are its data, which the panel does not name, so ids cannot be checked.
    const pie = '{"series": [{"type": "pie", "data": [1]}]}';
    assert.ok((await render({ language: "echarts", source: pie })).ok);
    assert.strictEqual(panel.drawnIds, undefined);
    const chartMarks = panel.annotate({ marks: [{ id: "1", kind: "info" }], dim: true });
    assert.ok(chartMarks.ok);
    assert.deepStrictEqual(chartMarks.unknown, []);
  });

  test("explains charts that cannot render", async () => {
    const outcome = await render({
      language: "echarts",
      source: '{"series": [{"type": "map"}]}',
    });
    assert.ok(!outcome.ok && outcome.kind === "invalid");
    assert.match(outcome.error, /unsupported type "map"/);
  });

  test("highlights the right unnamed or slash-named chart series", async () => {
    for (const names of [
      [undefined, undefined],
      ["Sales", "Sales/EU"],
    ]) {
      assert.ok(
        (
          await render({
            language: "echarts",
            source: JSON.stringify({
              animation: false,
              series: names.map((name, index) => ({
                name,
                type: "pie",
                center: [index === 0 ? "25%" : "75%", "50%"],
                radius: 30,
                data: [{ name: "A", value: 1 }],
                itemStyle: { color: "#0000ff" },
                emphasis: { scale: false, itemStyle: { color: "#ff0000" } },
              })),
            }),
          })
        ).ok,
      );
      panel.annotate({ marks: [{ id: `${names[1] ?? "Series 2"}/A`, kind: "info" }], dim: false });
      assert.strictEqual(
        await evaluate(`(async () => {
          for (let attempt = 0; attempt < 100; attempt++) {
            const svg = document.querySelector("#chart svg");
            const marked = svg.querySelectorAll('path[fill="#ff0000"]');
            if (marked.length === 1) return marked[0].getBBox().x > svg.clientWidth / 2;
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          return false;
        })()`),
        true,
        `Did not highlight the second series (${names[1] ?? "unnamed"}).`,
      );
    }
  });

  test("renders custom shapes without a coordinate system", async () => {
    assert.deepStrictEqual(
      await render({
        language: "echarts",
        source:
          '{series: [{type: "custom", coordinateSystem: null, data: [1], ' +
          'renderItem: () => ({type: "circle", shape: {cx: 20, cy: 20, r: 10}})}]}',
      }),
      { ok: true, diagramType: "custom" },
    );
    assert.ok(await evaluate('document.querySelector("#chart svg path") !== null'));
  });

  test("recovers from invalid chart components and renders an explicit graph view", async () => {
    const invalid = await render({
      language: "echarts",
      source: '{"xAxis": null, "yAxis": {}, "series": [{"type": "bar", "data": [1]}]}',
    });
    assert.ok(!invalid.ok);
    assert.match(invalid.error, /needs "xAxis" and "yAxis"/);
    const graph = await render({
      language: "echarts",
      source: JSON.stringify({
        series: [
          {
            type: "graph",
            coordinateSystem: "view",
            layout: "circular",
            data: [{ name: "A" }, { name: "B" }],
            links: [{ source: 0, target: 1 }],
          },
        ],
      }),
    });
    assert.deepStrictEqual(graph, { ok: true, diagramType: "graph" });
  });
});
