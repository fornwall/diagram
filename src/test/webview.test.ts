import * as assert from "node:assert";
import type * as vscode from "vscode";
import { validateAnnotation } from "../annotations";
import type { ChartSpec } from "../chartSpec";
import { buildChart } from "../charts";
import { parseTable } from "../data";
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

  test("chart options apply several controls using cached command data and preserve the source", async () => {
    const table = parseTable("name,amount,other\na,1,3\nb,4,7");
    const chart: ChartSpec = {
      type: "bar",
      command: "this-command-must-never-run",
      labelColumn: "name",
      valueColumns: ["amount"],
    };
    assert.ok(
      (
        await panel.render(
          {
            language: "echarts",
            source: JSON.stringify(buildChart(chart, table).option),
            title: "Cached",
            chart,
            clickPrompt: "Explain {label}",
          },
          "tool",
          undefined,
          table,
        )
      ).ok,
    );
    panel.toggleChartOptions();
    assert.deepStrictEqual(
      await evaluate(`(() => {
      const section = document.getElementById("chart-options");
      return { visible: !section.hidden, columns: section.querySelectorAll("#chart-option-label option").length };
    })()`),
      { visible: true, columns: 3 },
    );
    await nextRender(() =>
      evaluate(`(() => {
      document.getElementById("chart-option-chart").value = "pie";
      document.getElementById("chart-option-aggregation").value = "sum";
      document.getElementById("chart-option-sort").value = "descending";
      document.getElementById("chart-option-row").value = "1";
      document.querySelector("#chart-options .actions button").click();
    })()`),
    );
    assert.strictEqual(panel.current?.chart?.command, chart.command);
    assert.strictEqual(panel.current?.chart?.type, "pie");
    assert.strictEqual(panel.current?.chart?.aggregate, "sum");
    assert.strictEqual(panel.current?.chart?.sort, "descending");
    assert.strictEqual(panel.current?.chart?.limit, 1);
    assert.strictEqual(panel.current?.clickPrompt, "Explain {label}");
    await evaluate(
      `document.querySelector("#chart-options .chart-options-heading button").click()`,
    );
    assert.strictEqual(await evaluate(`document.getElementById("chart-options").hidden`), true);
  });

  test("chart options preserve typed filters and switch faceted charts to histograms", async () => {
    const data = "name,service,amount,missing\na,api-a,1,\nb,api-b,3,\nc,api-a,4,";
    const table = parseTable(data);
    const chart: ChartSpec = {
      type: "bar",
      data,
      labelColumn: "name",
      valueColumns: ["amount"],
      aggregate: "sum",
      sort: "ascending",
      limit: 10,
      facetColumn: "service",
      facetColumns: 2,
      facetScales: "independent",
      filters: [
        { column: " AMOUNT ", op: "gte", value: 1 },
        { column: "name", op: "neq", value: "1" },
        { column: "missing", op: "eq", value: null },
        { column: "service", op: "contains", value: "api" },
      ],
    };
    assert.ok(
      (
        await panel.render(
          {
            language: "echarts",
            chart,
            title: "Faceted",
            source: JSON.stringify(buildChart(chart, table).option),
          },
          "tool",
          undefined,
          table,
        )
      ).ok,
    );
    panel.toggleChartOptions();
    assert.deepStrictEqual(
      await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.chart-filter-row')];
      return rows.map(row => ({
        column: row.querySelector('[aria-label="Filter column"]').value,
        type: row.querySelector('[aria-label="Filter value type"]').value,
        value: row.querySelector('[aria-label="Filter value"]').value,
      }));
    })()`),
      [
        { column: " AMOUNT ", type: "number", value: "1" },
        { column: "name", type: "string", value: "1" },
        { column: "missing", type: "null", value: "" },
        { column: "service", type: "string", value: "api" },
      ],
    );
    await nextRender(() =>
      evaluate(`document.querySelector('#chart-options .actions button').click()`),
    );
    assert.deepStrictEqual(panel.current?.chart?.filters, chart.filters);
    assert.strictEqual(panel.current?.chart?.facetColumns, 2);
    assert.strictEqual(panel.current?.chart?.facetScales, "independent");
    assert.deepStrictEqual(
      await evaluate(`(() => {
      document.querySelector('#chart-option-filters > button').click();
      const row = [...document.querySelectorAll('.chart-filter-row')].at(-1);
      const column = row.querySelector('[aria-label="Filter column"]');
      column.value = 'amount';
      column.dispatchEvent(new Event('change'));
      return {
        valueType: row.querySelector('[aria-label="Filter value type"]').value,
        valid: document.querySelector('#chart-options form').checkValidity(),
      };
    })()`),
      { valueType: "number", valid: false },
    );
    await nextRender(() =>
      evaluate(`(() => {
      const row = [...document.querySelectorAll('.chart-filter-row')].at(-1);
      const operator = row.querySelector('[aria-label="Filter operator"]');
      operator.value = 'gte';
      operator.dispatchEvent(new Event('change'));
      row.querySelector('[aria-label="Filter value"]').value = '1';
      document.querySelector('#chart-options .actions button').click();
    })()`),
    );
    assert.deepStrictEqual(panel.current?.chart?.filters?.at(-1), {
      column: "amount",
      op: "gte",
      value: 1,
    });
    await nextRender(() =>
      evaluate(`(() => {
      [...document.querySelectorAll('[aria-label="Remove filter"]')].at(-1).click();
      document.querySelector('#chart-options .actions button').click();
    })()`),
    );
    await nextRender(() =>
      evaluate(`(() => {
      const type = document.getElementById('chart-option-chart');
      type.value = 'histogram';
      type.dispatchEvent(new Event('change'));
      document.getElementById('chart-option-bins').value = '3';
      document.getElementById('chart-option-axis').value = 'shared';
      document.querySelector('#chart-options .actions button').click();
    })()`),
    );
    assert.strictEqual(panel.current?.chart?.type, "histogram");
    assert.strictEqual(panel.current?.chart?.bins, 3);
    assert.strictEqual(panel.current?.chart?.facetColumn, "service");
    assert.strictEqual(panel.current?.chart?.facetScales, "shared");
    assert.deepStrictEqual(panel.current?.chart?.filters, chart.filters);
    for (const key of ["labelColumn", "aggregate", "sort", "limit"] as const) {
      assert.strictEqual(panel.current?.chart?.[key], undefined);
    }
    await nextRender(() =>
      evaluate(`(() => {
      const type = document.getElementById('chart-option-chart');
      type.value = 'pie';
      type.dispatchEvent(new Event('change'));
      document.querySelectorAll('[aria-label="Remove filter"]').forEach(button => button.click());
      document.querySelector('#chart-options .actions button').click();
    })()`),
    );
    for (const key of ["bins", "facetColumn", "facetColumns", "facetScales", "filters"] as const) {
      assert.strictEqual(panel.current?.chart?.[key], undefined);
    }
    await evaluate(
      `document.querySelector('#chart-options .chart-options-heading button').click()`,
    );
  });

  test("chart options recover inline data and close on arbitrary ECharts replacement", async () => {
    const chart: ChartSpec = { type: "bar", data: "name,value\na,1\nb,2" };
    assert.ok(
      (
        await render({
          language: "echarts",
          chart,
          source: JSON.stringify(buildChart(chart, parseTable(chart.data)).option),
        })
      ).ok,
    );
    panel.toggleChartOptions();
    assert.strictEqual(await evaluate(`document.getElementById("chart-options").hidden`), false);
    assert.ok(
      (
        await render({
          language: "echarts",
          source: '{"series":[{"type":"pie","data":[{"value":1,"name":"a"}]}]}',
        })
      ).ok,
    );
    assert.strictEqual(await evaluate(`document.getElementById("chart-options").hidden`), true);
    assert.strictEqual(panel.current?.chart, undefined);
  });

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

  test("reveals node picks without losing source edits and restores focus when finished", async () => {
    assert.ok((await render({ source: MERMAID["flowchart-v2"] })).ok);
    assert.deepStrictEqual(
      await evaluate(`(() => {
        try {
          const source = document.getElementById("source");
          return ["visual", "source"].flatMap(view => {
            return ["pick-done", "pick-cancel"].map(id => {
              document.getElementById("view-" + view).click();
              const draft = source.value + "\\n%% Unapplied edit";
              source.value = draft;
              source.dispatchEvent(new Event("input"));
              window.dispatchEvent(new MessageEvent("message", {data: {
                type: "startPick", pickId: 90000, prompt: "Pick a node", multiple: true
              }}));
              const canvas = document.getElementById("canvas");
              const visible = canvas.getBoundingClientRect().height > 0;
              const focused = document.activeElement === canvas;
              const preserved = source.value === draft;
              document.querySelector("#diagram .diagram-node[tabindex]")
                .dispatchEvent(new MouseEvent("click", {bubbles: true}));
              const button = document.getElementById(id);
              button.focus();
              button.click();
              return visible && focused && preserved && document.getElementById("pick").hidden &&
                document.activeElement === canvas;
            });
          });
        } finally {
          document.getElementById("revert").click();
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
          send(canvas, "pointerdown", 4);
          send(canvas, "pointermove", 4, 90);
          send(canvas, "pointerup", 4);
          const keyboardClick = new MouseEvent("click", {bubbles: true, cancelable: true, detail: 0});
          canvas.dispatchEvent(keyboardClick);
          const panClick = new MouseEvent("click", {bubbles: true, cancelable: true, detail: 1});
          canvas.dispatchEvent(panClick);
          // A release outside the canvas may have no click here. The next gesture still works,
          // including when a new diagram fits and no longer needs panning.
          send(canvas, "pointerdown", 5);
          send(canvas, "pointermove", 5, 90);
          send(document.body, "pointerup", 5);
          Object.defineProperty(canvas, "scrollWidth", {value: canvas.clientWidth, configurable: true});
          Object.defineProperty(canvas, "scrollHeight", {value: canvas.clientHeight, configurable: true});
          send(canvas, "pointerdown", 6);
          send(canvas, "pointerup", 6);
          const nextClick = new MouseEvent("click", {bubbles: true, cancelable: true, detail: 1});
          canvas.dispatchEvent(nextClick);
          return {released, restarted, unrelated, lostCapture, clickAllowed: !click.defaultPrevented,
            keyboardAllowed: !keyboardClick.defaultPrevented, panSuppressed: panClick.defaultPrevented,
            nextAllowed: !nextClick.defaultPrevented};
        } finally {
          send(canvas, "pointercancel", 1);
          send(canvas, "pointercancel", 2);
          delete canvas.setPointerCapture;
          delete canvas.hasPointerCapture;
          delete canvas.releasePointerCapture;
          delete canvas.scrollWidth;
          delete canvas.scrollHeight;
        }
      })()`),
      {
        released: true,
        restarted: true,
        unrelated: true,
        lostCapture: true,
        clickAllowed: true,
        keyboardAllowed: true,
        panSuppressed: true,
        nextAllowed: true,
      },
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

  test("acknowledges Apply when the edit matches the original unformatted chart source", async () => {
    const source = '{"series":[{"type":"pie","data":[1,2]}]}';
    assert.ok((await render({ language: "echarts", source })).ok);
    await evaluate(`(() => {
      document.getElementById("view-source").click();
      const input = document.getElementById("source");
      input.value = ${JSON.stringify(source)};
      input.dispatchEvent(new Event("input"));
    })()`);
    assert.strictEqual(await evaluate('document.getElementById("apply").disabled'), false);
    await nextRender(() => evaluate('document.getElementById("apply").click()'));
    assert.deepStrictEqual(
      await evaluate(`({
        source: document.getElementById("source").value,
        applyDisabled: document.getElementById("apply").disabled,
        draft: window.readTestState().editor ?? null
      })`),
      { source: JSON.stringify(JSON.parse(source), null, 2), applyDisabled: true, draft: null },
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

  test("keeps recovery controls visible when a render error is long", async () => {
    const outcome = await render({
      language: "echarts",
      source: '(() => { throw new Error("Invalid chart value. ".repeat(2000)); })()',
    });
    assert.ok(!outcome.ok);
    assert.deepStrictEqual(
      await evaluate(`(() => {
        document.getElementById("view-source").click();
        const error = document.getElementById("error");
        const apply = document.getElementById("apply").getBoundingClientRect();
        const footer = document.querySelector("footer").getBoundingClientRect();
        const result = {
          scrolls: error.scrollHeight > error.clientHeight,
          editorVisible: document.getElementById("source").getBoundingClientRect().height > 0,
          applyVisible: apply.top >= 0 && apply.bottom <= innerHeight,
          footerVisible: footer.bottom <= innerHeight
        };
        document.getElementById("view-visual").click();
        return result;
      })()`),
      { scrolls: true, editorVisible: true, applyVisible: true, footerVisible: true },
    );
  });

  test("disables stale drawing interactions during rendering and restores them after errors", async () => {
    for (const series of ['[{type: "pie", data: [1]}]', "[]"]) {
      const result = await render({
        language: "echarts",
        source: `(() => {
          window.testRenderingInert = document.getElementById("canvas").inert;
          return {series: ${series}};
        })()`,
      });
      assert.strictEqual(result.ok, series !== "[]");
      assert.deepStrictEqual(
        await evaluate(`({
          during: window.testRenderingInert,
          after: document.getElementById("canvas").inert
        })`),
        { during: true, after: false },
      );
    }
  });

  test("selects and marks chart names with surrounding spaces without conflating them", async () => {
    assert.ok(
      (
        await render({
          language: "echarts",
          source: JSON.stringify({
            animation: false,
            series: [
              {
                type: "pie",
                data: [
                  { name: "A", value: 1 },
                  { name: " A ", value: 1 },
                ],
                itemStyle: { color: "#0000ff" },
                emphasis: { scale: false, itemStyle: { color: "#ff0000" } },
              },
            ],
          }),
        })
      ).ok,
    );
    assert.strictEqual(
      await evaluate(`(() => {
        const slice = document.querySelectorAll('#chart svg path[fill="#0000ff"]')[1];
        const box = slice.getBoundingClientRect();
        const mouse = {
          bubbles: true, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2
        };
        // ZRender accepts a click only after matching mouse down/up on the same item.
        for (const type of ["mousedown", "mouseup", "click"]) {
          slice.dispatchEvent(new MouseEvent(type, mouse));
        }
        return document.getElementById("selection-label").textContent;
      })()`),
      "Selected: “ A ”",
    );
    panel.annotate(validateAnnotation({ marks: [{ id: " A " }] }));
    assert.strictEqual(
      await evaluate(`(async () => {
        for (let attempt = 0; attempt < 100; attempt++) {
          const svg = document.querySelector("#chart svg");
          const marked = svg.querySelectorAll('path[fill="#ff0000"]');
          if (marked.length === 1) return marked[0].getBBox().x < svg.clientWidth / 2;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        return false;
      })()`),
      true,
    );
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

  test("clears every selected chart item together", async () => {
    assert.ok(
      (
        await render({
          language: "echarts",
          source: JSON.stringify({
            animation: false,
            series: [
              {
                type: "pie",
                data: ["A", "B", "C"].map((name) => ({ name, value: 1 })),
                itemStyle: { color: "#0000ff" },
                select: { itemStyle: { color: "#ff0000" } },
                emphasis: { disabled: true },
              },
            ],
          }),
        })
      ).ok,
    );
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        for (const slice of document.querySelectorAll('#chart svg path[fill="#0000ff"]')) {
          const box = slice.getBoundingClientRect();
          const mouse = {bubbles: true, ctrlKey: true,
            clientX: box.x + box.width / 2, clientY: box.y + box.height / 2};
          for (const type of ["mousedown", "mouseup", "click"]) {
            slice.dispatchEvent(new MouseEvent(type, mouse));
          }
        }
        const count = () => document.querySelectorAll('#chart svg path[fill="#ff0000"]').length;
        const waitFor = async expected => {
          for (let attempt = 0; attempt < 100 && count() !== expected; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          return count();
        };
        const selected = await waitFor(3);
        document.getElementById("clear-selection").click();
        const cleared = await waitFor(0);
        return {selected, cleared, clearHidden: document.getElementById("clear-selection").hidden};
      })()`),
      { selected: 3, cleared: 0, clearHidden: true },
    );
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

  test("does not redraw a chart when a resize observation leaves its dimensions unchanged", async () => {
    assert.ok(
      (
        await render({
          language: "echarts",
          source: `(() => {
            window.chartDraws = 0;
            return {animation: false, series: [{type: "custom", coordinateSystem: null,
              data: [1], renderItem: () => {
                window.chartDraws++;
                return {type: "circle", shape: {cx: 20, cy: 20, r: 10}};
              }}]};
          })()`,
        })
      ).ok,
    );
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        const settle = () => new Promise(resolve => setTimeout(resolve, 300));
        await settle();
        const chart = document.getElementById("chart");
        const before = window.chartDraws;
        const width = chart.clientWidth;
        const height = chart.clientHeight;
        try {
          // Content-box changes trigger ResizeObserver, but the chart uses client dimensions.
          chart.style.padding = "1px";
          await settle();
          return {sameSize: chart.clientWidth === width && chart.clientHeight === height,
            redraws: window.chartDraws - before};
        } finally {
          chart.style.padding = "";
        }
      })()`),
      { sameSize: true, redraws: 0 },
    );
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
