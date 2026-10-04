import * as assert from "node:assert";
import * as vscode from "vscode";
import { validateAnnotation } from "../annotations";
import type { ChartSpec } from "../chartSpec";
import { buildChart } from "../charts";
import { parseTable } from "../data";
import type { Diagram, DiagramPanel, RenderOutcome } from "../panel";
import { DIAGRAM_TYPES } from "../webview/mermaidErrors";
import { newPanel, openWebviewPanel } from "./newPanel";
import { instrumentWebview, type WebviewHarness } from "./webviewHarness";

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

/**
 * A chart that counts its draws in `window.chartDraws`: how often each task that drew it did so,
 * which tells what one layout drew apart from what drew it again later.
 */
const COUNTED_CHART = `(() => {
  window.chartDraws = [];
  let drawing = false;
  return {animation: false, series: [{type: "custom", coordinateSystem: null, data: [1],
    renderItem: (params, api) => {
      if (!drawing) {
        drawing = true;
        window.chartDraws.push(0);
        queueMicrotask(() => { drawing = false; });
      }
      window.chartDraws[window.chartDraws.length - 1]++;
      return {type: "circle", shape: {cx: 20, cy: 20, r: 10}, style: api.style()};
    }}]};
})()`;

/** Webview code defining `chartFitted()`: whether the chart takes the size of its container soon. */
const CHART_FITTED = `
  const chartFitted = async () => {
    const chart = document.getElementById("chart");
    const fitted = () => {
      const svg = chart.querySelector("svg");
      return svg?.getAttribute("width") === String(chart.clientWidth) &&
        svg.getAttribute("height") === String(chart.clientHeight);
    };
    for (let frame = 0; frame < 10 && !fitted(); frame++) {
      await new Promise(requestAnimationFrame);
    }
    return fitted();
  };`;

suite("webview", function () {
  // The first render loads the webview and the libraries, which can take a while.
  this.timeout(20_000);

  let panel: DiagramPanel;
  let webview: vscode.Webview;
  let evaluate: WebviewHarness["evaluate"];
  let nextRender: WebviewHarness["nextRender"];
  suiteSetup(() => {
    panel = newPanel();
    ({ webview, evaluate, nextRender } = instrumentWebview(panel));
  });
  suiteTeardown(() => panel.dispose());

  const render = (diagram: Partial<Diagram>): Promise<RenderOutcome> =>
    panel.render({ language: "mermaid", source: "", title: "Test", ...diagram }, "tool");
  /** Renders each Mermaid source in turn, for the errors they fail with. */
  const errors = async (...sources: string[]): Promise<(string | undefined)[]> => {
    const found = [];
    for (const source of sources) found.push(await renderError(source));
    return found;
  };
  /** Renders the Mermaid source, for the error it fails with. */
  const renderError = async (source: string): Promise<string | undefined> => {
    const outcome = await render({ source });
    return outcome.ok ? undefined : outcome.error;
  };

  test("skips superseded queued renders and their annotations", async () => {
    assert.ok((await render({ source: "flowchart LR\n A --> B" })).ok);
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        window.testRenderResults = [];
        const send = data => window.dispatchEvent(new MessageEvent("message", {data}));
        send({type: "render", requestId: 900001, language: "mermaid",
          source: "invalid obsolete diagram", title: "Obsolete"});
        send({type: "annotate", marks: [], dim: false, caption: "Obsolete annotation"});
        send({type: "render", requestId: 900002, language: "mermaid",
          source: "flowchart LR\\n C --> D", title: "Intermediate"});
        send({type: "render", requestId: 900003, language: "mermaid",
          source: "flowchart LR\\n E --> F", title: "Latest"});
        send({type: "annotate", marks: [], dim: false, caption: "Latest annotation"});
        for (let i = 0; i < 200; i++) {
          await new Promise(resolve => setTimeout(resolve, 10));
          if (document.getElementById("annotation-caption").textContent === "Latest annotation") {
            return {results: window.testRenderResults,
              title: document.getElementById("title").textContent,
              errorHidden: document.getElementById("error").hidden};
          }
        }
        throw new Error("The latest diagram did not finish rendering.");
      })()`),
      { results: [900003], title: "Latest", errorHidden: true },
    );
  });

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

  test("chart options keep keyboard focus and column names predictable as rows change", async () => {
    const chart: ChartSpec = {
      type: "bar",
      data: "name,value,other\na,1,2\nb,2,3",
      valueColumns: ["value", "other"],
    };
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
    assert.deepStrictEqual(
      await evaluate(`(() => {
        const columns = document.getElementById("chart-option-value");
        const addColumn = columns.querySelector(":scope > button");
        const selects = () => [...columns.querySelectorAll("select")];
        const names = () => selects().map(select => select.getAttribute("aria-label"));
        columns.querySelector(".chart-column-row button").click();
        const afterRemove = {
          names: names(), focused: document.activeElement === selects()[0],
          removeName: columns.querySelector(".chart-column-row button").getAttribute("aria-label")
        };
        addColumn.click();
        const afterAdd = {names: names(), focused: document.activeElement === selects()[1]};
        for (const row of [...columns.querySelectorAll(".chart-column-row")]) {
          row.querySelector("button").click();
        }
        const emptyFocus = document.activeElement === addColumn;
        const filters = document.getElementById("chart-option-filters");
        const addFilter = filters.querySelector(":scope > button");
        addFilter.click();
        const first = filters.querySelector("select");
        const addedFilterFocus = document.activeElement === first;
        addFilter.click();
        filters.querySelector(".chart-filter-row:last-of-type button").click();
        const removedFilterFocus = document.activeElement === first;
        filters.querySelector(".chart-filter-row button").click();
        const emptyFilterFocus = document.activeElement === addFilter;
        document.querySelector("#chart-options .chart-options-heading button").click();
        return {afterRemove, afterAdd, emptyFocus, addedFilterFocus, removedFilterFocus, emptyFilterFocus};
      })()`),
      {
        afterRemove: {
          names: ["Value column 1"],
          focused: true,
          removeName: "Remove value column 1",
        },
        afterAdd: { names: ["Value column 1", "Value column 2"], focused: true },
        emptyFocus: true,
        addedFilterFocus: true,
        removedFilterFocus: true,
        emptyFilterFocus: true,
      },
    );
  });

  test("chat and chart option fields fit a narrow panel", async () => {
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
    assert.deepStrictEqual(
      await evaluate(`(() => {
        const form = document.getElementById("ask-form");
        const options = document.getElementById("chart-options");
        try {
          form.style.width = "180px";
          options.style.width = "150px";
          const input = document.getElementById("ask-input").getBoundingClientRect();
          const send = document.getElementById("ask-submit").getBoundingClientRect();
          const fields = options.querySelector("fieldset");
          return {chatFits: form.scrollWidth <= form.clientWidth,
            sendWraps: send.top >= input.bottom,
            fieldsFit: fields.scrollWidth <= fields.clientWidth};
        } finally {
          form.style.width = "";
          options.style.width = "";
          options.querySelector(".chart-options-heading button").click();
        }
      })()`),
      { chatFits: true, sendWraps: true, fieldsFit: true },
    );
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
      const apply = document.querySelector('#chart-options .actions button');
      apply.click();
      return {
        valueType: row.querySelector('[aria-label="Filter value type"]').value,
        valid: document.querySelector('#chart-options form').checkValidity(),
        applying: apply.disabled,
      };
    })()`),
      { valueType: "number", valid: false, applying: false },
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
      document.getElementById('chart-option-axis').value = '';
      document.querySelector('#chart-options .actions button').click();
    })()`),
    );
    assert.strictEqual(panel.current?.chart?.type, "histogram");
    assert.strictEqual(panel.current?.chart?.bins, 3);
    assert.strictEqual(panel.current?.chart?.facetColumn, "service");
    assert.strictEqual(panel.current?.chart?.facetScales, undefined);
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

  test("chart options show explicitly shared facet scales as the default", async () => {
    const data = "name,service,amount\na,api-a,1\nb,api-b,3";
    const table = parseTable(data);
    const chart: ChartSpec = { type: "bar", data, facetColumn: "service", facetScales: "shared" };
    assert.ok(
      (
        await panel.render(
          {
            language: "echarts",
            chart,
            title: "Shared scales",
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
        const scales = document.getElementById('chart-option-axis');
        const shown = {choices: [...scales.options].map(option => option.text),
          selected: scales.selectedOptions[0]?.text};
        document.querySelector('#chart-options .chart-options-heading button').click();
        return shown;
      })()`),
      { choices: ["Shared", "Independent"], selected: "Shared" },
    );
  });

  test("chart options preserve column spelling when applying unrelated changes", async () => {
    const table = parseTable("name,amount\na,1\nb,2");
    const chart: ChartSpec = {
      type: "bar",
      data: "name,amount\na,1\nb,2",
      labelColumn: " NAME ",
      valueColumns: ["AMOUNT"],
    };
    assert.ok(
      (
        await panel.render(
          {
            language: "echarts",
            title: "Columns",
            chart,
            source: JSON.stringify(buildChart(chart, table).option),
          },
          "tool",
          undefined,
          table,
        )
      ).ok,
    );
    panel.toggleChartOptions();
    await nextRender(() =>
      evaluate(`(() => {
      document.getElementById("chart-option-sort").value = "descending";
      document.querySelector("#chart-options .actions button").click();
    })()`),
    );
    assert.deepStrictEqual(panel.current?.chart?.labelColumn, [" NAME "]);
    assert.deepStrictEqual(panel.current?.chart?.valueColumns, ["AMOUNT"]);
    await evaluate(
      'document.querySelector("#chart-options .chart-options-heading button").click()',
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

  test("lays out Mermaid drawings outside the flow of the panel", async () => {
    // Mermaid draws in an element of its own, by default at the end of the body, where it would
    // take room from the panel while rendering. (Text it measures synchronously is not drawn.)
    await evaluate(`(() => {
      window.testBodyDrawings = 0;
      window.testBodyObserver = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node.id?.startsWith("ddiagram-")) window.testBodyDrawings++;
          }
        }
      });
      window.testBodyObserver.observe(document.body, {childList: true});
    })()`);
    for (const source of Object.values(MERMAID)) {
      assert.ok((await render({ source })).ok);
    }
    assert.ok(!(await render({ source: "flowchart TD\n  A@{ shape: nosuch }" })).ok);
    assert.deepStrictEqual(
      await evaluate(`(() => {
        window.testBodyObserver.disconnect();
        return {drawings: window.testBodyDrawings, left: document.querySelectorAll('[id^="ddiagram-"]').length};
      })()`),
      { drawings: 0, left: 0 },
    );
  });

  test("draws Gantt charts at the width of the canvas they are shown in", async () => {
    for (const view of ["split", "visual"]) {
      await evaluate(`document.getElementById("view-${view}").click()`);
      assert.ok((await render({ source: MERMAID.gantt })).ok);
      const { drawn, room, zoom } = (await evaluate(`(() => {
        const canvas = document.getElementById("canvas");
        const style = getComputedStyle(canvas);
        return {
          drawn: document.querySelector("#diagram svg").viewBox.baseVal.width,
          room: canvas.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
          zoom: document.getElementById("zoom-reset").textContent,
        };
      })()`)) as { drawn: number; room: number; zoom: string };
      assert.ok(Math.abs(drawn - room) < 1, `${view}: drawn ${drawn} wide in ${room}`);
      assert.strictEqual(zoom, "100%", view);
    }
  });

  test("scrolls past every side of a Mermaid drawing larger than the canvas", async () => {
    assert.ok((await render({ source: "flowchart LR\n  A[Left] --> B[Middle] --> C[Right]" })).ok);
    const padded = await evaluate(`(async () => {
      for (let i = 0; i < 12; i++) document.getElementById("zoom-in").click();
      const canvas = document.getElementById("canvas");
      const visible = canvas.getBoundingClientRect();
      const right = visible.left + canvas.clientLeft + canvas.clientWidth;
      const bottom = visible.top + canvas.clientTop + canvas.clientHeight;
      const svg = document.querySelector("#diagram svg");
      canvas.scrollTo(0, 0);
      const start = svg.getBoundingClientRect();
      canvas.scrollTo(canvas.scrollWidth, canvas.scrollHeight);
      const end = svg.getBoundingClientRect();
      document.getElementById("zoom-reset").click();
      // Some of the canvas padding shows beyond each side.
      return {left: start.left - visible.left >= 1, top: start.top - visible.top >= 1,
        right: right - end.right >= 1, bottom: bottom - end.bottom >= 1};
    })()`);
    assert.deepStrictEqual(padded, { left: true, top: true, right: true, bottom: true });
  });

  test("shows Mermaid labels whole, in the boxes Mermaid measured for them", async () => {
    // Mermaid measures labels outside the canvas (see layoutContainer), so styles that apply only
    // where the drawing is shown would make labels overflow the boxes laid out for them.
    const diagrams = [
      'flowchart TD\n  A[A label long enough to wrap onto several lines] -->|edge label| B{"`**Bold** and _emphasis_`"}\n  B --> C[Line one<br>line two]\n  subgraph S [A subgraph title]\n    C --> D[漢字のラベル 😀]\n  end',
      "sequenceDiagram\n  actor U as A user\n  U->>S: A long message to the server\n  Note over U,S: A note over both",
      "classDiagram\n  class Animal {\n    <<abstract>>\n    +String name\n    +makeSound(volume int) void\n  }\n  Animal <|-- Duck : inherits",
      "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy : start a long job\n  state Busy {\n    [*] --> Working\n  }",
      'erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  CUSTOMER {\n    string name PK "full name"\n  }',
      "mindmap\n  root((A central idea))\n    A branch with a longer label\n    Another",
      "journey\n  section Work\n    Make tea with a long name: 5: Me",
      "kanban\n  todo[To do]\n    t1[Write the documentation for a feature]",
    ];
    for (const source of diagrams) {
      assert.ok((await render({ source })).ok, source);
      const overflows = await evaluate(`(() => {
        const svg = document.querySelector("#diagram svg");
        const drawing = svg.getBoundingClientRect();
        const problems = [];
        for (const box of svg.querySelectorAll("foreignObject")) {
          if (!box.textContent.trim()) continue;
          const outer = box.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(box);
          for (const line of range.getClientRects()) {
            for (const bounds of [outer, drawing]) {
              if (line.left < bounds.left - 1 || line.right > bounds.right + 1 ||
                line.top < bounds.top - 1 || line.bottom > bounds.bottom + 1) {
                problems.push(box.textContent.trim());
              }
            }
          }
        }
        return [...new Set(problems)];
      })()`);
      assert.deepStrictEqual(overflows, [], source.split("\\n")[0]);
    }
  });

  test("widens the drawing for text that Mermaid draws beyond it, also in images", async () => {
    // Mermaid places long radar axis labels and quadrant point labels partly outside its view box.
    for (const source of [
      'radar-beta\n  axis m["Math"], e["English literature and composition"]\n  curve a["Alice"]{85, 80}',
      "quadrantChart\n  A point with a long label near the edge: [0.98, 0.5]",
    ]) {
      assert.ok((await render({ source })).ok, source);
      const result = (await evaluate(`(async () => {
        const svg = document.querySelector("#diagram svg");
        const drawing = svg.getBoundingClientRect();
        const clipped = Array.from(svg.querySelectorAll("text"), text => text.getBoundingClientRect())
          .filter(text => text.width && (text.left < drawing.left - 1 || text.right > drawing.right + 1
            || text.top < drawing.top - 1 || text.bottom > drawing.bottom + 1)).length;
        const handle = document.getElementById("drag-out");
        handle.dispatchEvent(new PointerEvent("pointerenter"));
        for (let attempt = 0; attempt < 100; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 20));
          const dataTransfer = new DataTransfer();
          handle.dispatchEvent(new DragEvent("dragstart", {dataTransfer, cancelable: true}));
          const image = dataTransfer.getData("image/svg+xml");
          if (image) {
            const exported = new DOMParser().parseFromString(image, "image/svg+xml").documentElement;
            return {clipped, viewBox: svg.getAttribute("viewBox") === exported.getAttribute("viewBox")};
          }
        }
        throw new Error("The diagram image was not prepared.");
      })()`)) as { clipped: number; viewBox: boolean };
      assert.deepStrictEqual(result, { clipped: 0, viewBox: true }, source);
    }
  });

  test("shows Mermaid tooltips in the colors of the theme's hovers", async () => {
    assert.ok(
      (await render({ source: 'flowchart LR\n  A --> B\n  click A callback "A tooltip"' })).ok,
    );
    const colors = await evaluate(`(async () => {
      document.querySelector("#diagram g.node[title]").dispatchEvent(new MouseEvent("mouseover"));
      const tooltip = document.querySelector(".mermaidTooltip");
      const hover = document.createElement("div");
      hover.style.cssText = "color: var(--vscode-editorHoverWidget-foreground); background: var(--vscode-editorHoverWidget-background)";
      document.body.append(hover);
      const [shown, expected] = [tooltip, hover].map(element => {
        const style = getComputedStyle(element);
        return [style.color, style.backgroundColor];
      });
      hover.remove();
      return {text: tooltip.textContent, same: JSON.stringify(shown) === JSON.stringify(expected)};
    })()`);
    assert.deepStrictEqual(colors, { text: "A tooltip", same: true });
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

  test("shows why an action is disabled on hover", async () => {
    assert.ok((await render({ source: MERMAID["flowchart-v2"] })).ok);
    assert.deepStrictEqual(
      await evaluate(`(() => {
        const button = document.getElementById("highlight-path");
        return {disabled: button.disabled, title: button.title, hoverable: getComputedStyle(button).pointerEvents !== "none"};
      })()`),
      {
        disabled: true,
        title: "Select two flowchart nodes, first the start and then the destination",
        hoverable: true,
      },
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

  test("selection updates only the changed Mermaid nodes", async () => {
    const source = `flowchart LR\n${Array.from({ length: 24 }, (_, i) => `A${i}[Node ${i}]`).join("\n")}`;
    assert.ok((await render({ source })).ok);
    assert.deepStrictEqual(
      await evaluate(`(() => {
        const diagram = document.getElementById("diagram");
        const observer = new MutationObserver(() => {});
        observer.observe(diagram, {subtree: true, attributes: true, attributeFilter: ["aria-pressed"]});
        const changes = () => [...new Set(observer.takeRecords().map(record => record.target.getAttribute("data-diagram-id")))].sort();
        const click = (id, shiftKey = false) => diagram.querySelector('[data-diagram-id="' + id + '"]').dispatchEvent(new MouseEvent("click", {bubbles: true, shiftKey}));
        try {
          click("A0");
          const first = changes();
          click("A1", true);
          const second = changes();
          click("A1");
          const third = changes();
          document.getElementById("clear-selection").click();
          return [first, second, third, changes()];
        } finally {
          observer.disconnect();
        }
      })()`),
      [["A0"], ["A1"], ["A0"], ["A1"]],
    );
  });

  test("annotation updates touch only changed Mermaid marks", async () => {
    const source = `flowchart LR\n${Array.from({ length: 24 }, (_, i) => `A${i}[Node ${i}]`).join("\n")}`;
    assert.ok((await render({ source })).ok);
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        const diagram = document.getElementById("diagram");
        const changed = new Set();
        const toggle = DOMTokenList.prototype.toggle;
        const markVisits = [];
        let visits = 0;
        DOMTokenList.prototype.toggle = function (token, ...args) {
          if (token.startsWith("diagram-mark")) visits++;
          return toggle.call(this, token, ...args);
        };
        const observer = new MutationObserver(records => {
          for (const record of records) {
            const id = record.target.getAttribute("data-diagram-id");
            if (id) changed.add(id);
          }
        });
        observer.observe(diagram, {subtree: true, attributes: true, attributeFilter: ["class"]});
        const mark = async (marks, dim = false) => {
          changed.clear();
          visits = 0;
          window.dispatchEvent(new MessageEvent("message", {data: {type: "annotate", marks, dim}}));
          await new Promise(resolve => setTimeout(resolve, 0));
          markVisits.push(visits);
          return [...changed].sort();
        };
        try {
          const first = await mark([{id: "A0", kind: "problem"}]);
          const notesOnly = await mark([{id: "A0", kind: "problem", note: "More detail"}], true);
          const replacement = await mark([{id: "A0", kind: "good"}, {id: "A1", kind: "info"}]);
          const node = diagram.querySelector('[data-diagram-id="A0"]');
          const replaced = node.classList.contains("diagram-mark-good") && !node.classList.contains("diagram-mark-problem");
          const cleared = await mark([]);
          return {first, notesOnly, replacement, replaced, cleared, markVisits, remaining: diagram.querySelectorAll(".diagram-marked").length};
        } finally {
          DOMTokenList.prototype.toggle = toggle;
          observer.disconnect();
        }
      })()`),
      {
        first: ["A0"],
        notesOnly: [],
        replacement: ["A0", "A1"],
        replaced: true,
        cleared: ["A0", "A1"],
        markVisits: [1, 0, 2, 2],
        remaining: 0,
      },
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

  test("zooms at the pointer in proportion to Ctrl+scrolling", async () => {
    const chain = Array.from({ length: 30 }, (_, i) => `n${i} --> n${i + 1}`).join("\n  ");
    assert.ok((await render({ source: `flowchart LR\n  ${chain}` })).ok);
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        const frame = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve)));
        const canvas = document.getElementById("canvas");
        const zoom = () => document.getElementById("zoom-reset").textContent;
        const wheel = (deltaY, deltaMode = 0) => {
          const box = document.querySelector('[data-diagram-id="n15"][tabindex]').getBoundingClientRect();
          const x = box.left + box.width / 2;
          const y = box.top + box.height / 2;
          canvas.dispatchEvent(new WheelEvent("wheel", {deltaY, deltaMode, clientX: x, clientY: y,
            ctrlKey: true, bubbles: true, cancelable: true}));
          return {x, y};
        };
        document.getElementById("zoom-reset").click();
        if (zoom() !== "100%") document.getElementById("zoom-reset").click();
        canvas.scrollLeft = (canvas.scrollWidth - canvas.clientWidth) / 2;
        await frame();
        // A pinch: many small deltas in one frame, which add up to one notch.
        const anchor = wheel(-25);
        for (let i = 0; i < 3; i++) wheel(-25);
        await frame();
        const pinched = zoom();
        const box = document.querySelector('[data-diagram-id="n15"][tabindex]').getBoundingClientRect();
        // The diagram is taller than the canvas only once zoomed in, so only scrolling left keeps up.
        const moved = Math.abs(box.left + box.width / 2 - anchor.x);
        wheel(6.25, WheelEvent.DOM_DELTA_LINE);
        await frame();
        return {pinched, steady: moved < 2, notch: zoom()};
      })()`),
      { pinched: "120%", steady: true, notch: "100%" },
    );
  });

  test("keeps a zoom made while fitting the diagram to a resized panel is pending", async () => {
    const chain = Array.from({ length: 30 }, (_, i) => `n${i} --> n${i + 1}`).join("\n  ");
    assert.ok((await render({ source: `flowchart LR\n  ${chain}` })).ok);
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        const frame = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve)));
        const canvas = document.getElementById("canvas");
        const zoom = () => document.getElementById("zoom-reset").textContent;
        await frame();
        try {
          // The resize observer runs after this frame, and fits the diagram in the next one.
          canvas.style.paddingRight = "60px";
          await frame();
          document.getElementById("zoom-in").click();
          const zoomed = zoom();
          await frame();
          await frame();
          return zoom() === zoomed;
        } finally {
          canvas.style.paddingRight = "";
        }
      })()`),
      true,
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

  test("reuses formatted source and only persists changed editor state", async () => {
    await evaluate('document.getElementById("view-visual").click()');
    const source = '{"series":[{"type":"pie","data":[3,7]}]}';
    assert.ok((await render({ language: "echarts", source })).ok);
    assert.deepStrictEqual(
      await evaluate(`(() => {
        const parse = JSON.parse;
        let parses = 0;
        JSON.parse = function (text, ...args) {
          if (text === ${JSON.stringify(source)}) parses++;
          return parse.call(this, text, ...args);
        };
        window.testStateWrites = 0;
        try {
          for (const view of ["source", "source", "visual", "split", "split"]) {
            document.getElementById("view-" + view).click();
          }
          const viewWrites = window.testStateWrites;
          const input = document.getElementById("source");
          input.value += " ";
          input.dispatchEvent(new Event("input"));
          input.dispatchEvent(new Event("input"));
          return {parses, viewWrites, editWrites: window.testStateWrites - viewWrites,
            saved: window.readTestState().editor.source === input.value};
        } finally {
          JSON.parse = parse;
        }
      })()`),
      { parses: 1, viewWrites: 3, editWrites: 1, saved: true },
    );
    const incoming = '{"series":[{"type":"pie","data":[9,1]}]}';
    assert.ok((await render({ language: "echarts", source: incoming })).ok);
    assert.deepStrictEqual(
      await evaluate(`(() => {
        const stale = !document.getElementById("stale-note").hidden;
        document.getElementById("revert").click();
        return {stale, source: document.getElementById("source").value,
          draft: window.readTestState().editor ?? null};
      })()`),
      { stale: true, source: JSON.stringify(JSON.parse(incoming), null, 2), draft: null },
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

  test("exports complete chart items while their entrance animations are pending", async () => {
    const option = {
      animation: true,
      animationDelay: 60_000,
      xAxis: { type: "category", data: ["A", "B"] },
      yAxis: {},
      series: [{ type: "bar", data: [10, 20], itemStyle: { color: "#123456" } }],
    };
    const paths: unknown[] = [];
    for (const animation of [true, false]) {
      assert.ok(
        (await render({ language: "echarts", source: JSON.stringify({ ...option, animation }) }))
          .ok,
      );
      paths.push(
        await evaluate(`(async () => {
        const handle = document.getElementById("drag-out");
        handle.dispatchEvent(new PointerEvent("pointerenter"));
        handle.dispatchEvent(new PointerEvent("pointerdown", {shiftKey: true}));
        for (let attempt = 0; attempt < 100; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 20));
          const dataTransfer = new DataTransfer();
          handle.dispatchEvent(new DragEvent("dragstart", {dataTransfer, cancelable: true}));
          const svg = dataTransfer.getData("image/svg+xml");
          if (svg) {
            const image = new DOMParser().parseFromString(svg, "image/svg+xml");
            return [...image.querySelectorAll('path[fill="#123456"]')].map(path => path.getAttribute("d"));
          }
        }
        throw new Error("The chart image was not prepared.");
      })()`),
      );
    }
    assert.ok(Array.isArray(paths[1]) && paths[1].length === 2);
    assert.deepStrictEqual(paths[0], paths[1]);
  });

  test("exports the current chart size before the resize observer runs", async () => {
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
        const chart = document.getElementById("chart");
        try {
          chart.style.width = "321px";
          chart.style.height = "234px";
          const expected = [chart.clientWidth, chart.clientHeight];
          const handle = document.getElementById("drag-out");
          handle.dispatchEvent(new PointerEvent("pointerenter"));
          handle.dispatchEvent(new PointerEvent("pointerdown", {shiftKey: true}));
          for (let attempt = 0; attempt < 100; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 20));
            const dataTransfer = new DataTransfer();
            handle.dispatchEvent(new DragEvent("dragstart", {dataTransfer, cancelable: true}));
            const svg = dataTransfer.getData("image/svg+xml");
            if (svg) {
              const image = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
              return {expected, actual: [Number(image.getAttribute("width")), Number(image.getAttribute("height"))]};
            }
          }
          throw new Error("The chart image was not prepared.");
        } finally {
          chart.style.width = "";
          chart.style.height = "";
        }
      })()`),
      { expected: [321, 234], actual: [321, 234] },
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
    const exported = async (source: string) => {
      assert.ok((await render({ source })).ok);
      return evaluate(`(async () => {
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
    };
    assert.deepStrictEqual(
      await exported(
        "---\nconfig:\n  htmlLabels: true\n---\nflowchart LR\n A[Exported label] --> B[Other label]",
      ),
      { htmlLabels: 0, text: "ExportedlabelOtherlabel" },
    );
    // User journeys draw task names as HTML with a text fallback.
    const journey = (await exported("journey\n  section Work\n    Brew tea: 5: Me")) as {
      htmlLabels: number;
      text: string;
    };
    assert.strictEqual(journey.htmlLabels, 0);
    assert.match(journey.text, /Brewtea/);
  });

  test("centers exported Mermaid labels that Mermaid leaves to CSS", async () => {
    // Mermaid starts these labels at the middle of the node, for CSS that only flowcharts have.
    for (const source of [
      "mindmap\n  root((Central idea with long text))\n    sq[Square node text]\n    hx{{Hexagon node text}}\n    Default node text",
      'usecase-beta\n  actor Customer\n  Customer --> "Place an order with a long name"',
      "flowchart LR\n  A((Circle label)) --> B[Rectangle label]",
    ]) {
      assert.ok((await render({ source })).ok, source);
      const offCenter = await evaluate(`(async () => {
        const handle = document.getElementById("drag-out");
        handle.dispatchEvent(new PointerEvent("pointerenter"));
        for (let attempt = 0; attempt < 100; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 20));
          const dataTransfer = new DataTransfer();
          handle.dispatchEvent(new DragEvent("dragstart", {dataTransfer, cancelable: true}));
          const image = dataTransfer.getData("image/svg+xml");
          if (!image) continue;
          const host = document.createElement("div");
          host.innerHTML = image;
          document.body.append(host);
          const center = (box) => (box.left + box.right) / 2;
          const problems = Array.from(host.querySelectorAll("g.node"), node => {
            const text = node.querySelector("text").getBoundingClientRect();
            const shape = node.querySelector(":scope > :is(circle, ellipse, path, polygon, rect)").getBoundingClientRect();
            // Mermaid itself places some labels, like those under use case actors, a few pixels off.
            return Math.abs(center(text) - center(shape)) > 8 ? node.textContent : undefined;
          }).filter(Boolean);
          host.remove();
          return problems;
        }
        throw new Error("The diagram image was not prepared.");
      })()`);
      assert.deepStrictEqual(offCenter, [], source);
    }
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

  test("moves the focus between Mermaid nodes with arrow keys from one tab stop", async () => {
    assert.ok((await render({ source: "flowchart LR\n  A --> B\n  A --> C\n  C --> D" })).ok);
    const moves = (await evaluate(`(() => {
      const stops = () => Array.from(document.querySelectorAll('#diagram [tabindex="0"]'), e => e.dataset.diagramId);
      const press = (key) => {
        document.activeElement.dispatchEvent(new KeyboardEvent("keydown", {key, bubbles: true, cancelable: true}));
        return document.activeElement.dataset.diagramId;
      };
      const initial = stops();
      document.querySelector('#diagram [data-diagram-id="A"][tabindex]').focus();
      return {initial, right: [press("ArrowRight"), press("ArrowRight")], stops: stops(),
        back: [press("ArrowLeft"), press("ArrowLeft")], end: press("End"), home: press("Home"),
        edge: press("ArrowLeft")};
    })()`)) as Record<string, string | string[]>;
    const [edge, target] = moves.right as string[];
    assert.match(edge ?? "", /^edge:L_A_(B|C)_0$/);
    assert.strictEqual(target, edge?.slice("edge:L_A_".length, -2));
    const { initial, stops, back, end, home, edge: leftOfA } = moves;
    assert.strictEqual(initial?.length, 1);
    // Nothing is left of A.
    assert.deepStrictEqual(
      { stops, back, end, home, leftOfA },
      { stops: [target], back: [edge, "A"], end: "D", home: "A", leftOfA: "A" },
    );
  });

  test("keeps keyboard focus on a Mermaid node when a new version of the diagram arrives", async () => {
    assert.ok((await render({ source: "flowchart LR\n  A --> B" })).ok);
    await evaluate(`document.querySelector('#diagram [data-diagram-id="B"][tabindex]').focus()`);
    assert.ok((await render({ source: "flowchart LR\n  A --> B --> C" })).ok);
    assert.strictEqual(
      await evaluate(`document.activeElement.getAttribute("data-diagram-id")`),
      "B",
    );
    await evaluate(`document.querySelector('#diagram [data-diagram-id="C"][tabindex]').focus()`);
    assert.ok((await render({ source: "flowchart LR\n  A --> B" })).ok);
    assert.strictEqual(await evaluate(`document.activeElement.id`), "canvas");
  });

  test("keeps keyboard focus and selection on a Mermaid node when the theme redraws it", async () => {
    assert.ok(
      (
        await render({
          source: MERMAID["flowchart-v2"],
          links: { A: { file: "src/parser.ts", line: 42 } },
        })
      ).ok,
    );
    panel.annotate({ marks: [{ id: "A", kind: "info" }], dim: true });
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        const node = document.querySelector('#diagram [data-diagram-id="A"][tabindex]');
        node.dispatchEvent(new MouseEvent("click", {bubbles: true, shiftKey: true}));
        node.focus();
        const original = document.body.dataset.vscodeThemeId;
        document.body.dataset.vscodeThemeId = "test-theme-redraw";
        try {
          for (let attempt = 0; attempt < 100; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 20));
            if (!node.isConnected) return {
              id: document.activeElement?.getAttribute("data-diagram-id"),
              selected: document.activeElement?.classList.contains("diagram-selected"),
              pressed: document.activeElement?.getAttribute("aria-pressed"),
              marked: document.activeElement?.classList.contains("diagram-mark-info"),
              link: document.activeElement?.querySelector("title.diagram-link")?.textContent,
              tooltips: document.activeElement?.querySelectorAll("title.diagram-link").length
            };
          }
          throw new Error("The theme change did not redraw the diagram.");
        } finally {
          if (original === undefined) delete document.body.dataset.vscodeThemeId;
          else document.body.dataset.vscodeThemeId = original;
        }
      })()`),
      {
        id: "A",
        selected: true,
        pressed: "true",
        marked: true,
        link: "Open src/parser.ts#L42",
        tooltips: 1,
      },
    );
  });

  test("names an unknown Mermaid diagram type, and what it could be", async () => {
    assert.deepStrictEqual(
      await errors("flowchar TD\n  A --> B", "sequence\n  A->>B: x", "erdiagram", "C4"),
      [
        'Unknown diagram type "flowchar": did you mean "flowchart"?',
        'Unknown diagram type "sequence": did you mean "sequenceDiagram"?',
        'Unknown diagram type "erdiagram": did you mean "erDiagram"?',
        'Unknown diagram type "C4": did you mean "C4Context", "C4Container" or "C4Component"?',
      ],
    );
    const [unknown, fenced, labeled] = await errors(
      "nonsense\n  A --> B",
      "```mermaid\nflowchart TD\n  A --> B\n```",
      "mermaid\nflowchart TD",
    );
    assert.match(
      unknown ?? "",
      /^Unknown diagram type "nonsense": start the diagram with its type, such as flowchart, /,
    );
    assert.match(fenced ?? "", /^Remove the code fence/);
    assert.match(labeled ?? "", /^Remove the "mermaid" line/);
  });

  test("knows the diagram types that Mermaid detects", async function () {
    this.timeout(60_000);
    for (const type of DIAGRAM_TYPES) {
      assert.doesNotMatch((await renderError(`${type}\n  !`)) ?? "", /Unknown diagram type/, type);
    }
  });

  test("reports Mermaid syntax errors at their line and column in the source", async () => {
    // Mermaid parses the text without front matter, directives, comment lines and leading blank
    // lines, normalizes line breaks and encodes entities, and some diagrams change it further.
    const preamble = ["---", "title: T", "---", '%%{init: {"theme": "dark"}}%%', "%% comment", ""];
    const cases: [string[], string][] = [
      // The flowchart parser drops blank lines after "}".
      [
        ["flowchart TD", "  A{x} --> B{y}", "", "", "  B -> C"],
        'Parse error on line 12, column 5: unexpected "-"',
      ],
      [
        ["flowchart LR", '  A["#quot;Hi#quot;"] -- x'],
        "Parse error on line 9, column 27: unexpected end of the diagram",
      ],
      [
        ["sequenceDiagram", "  Alice->>Bob: Hi", "  Alice->>: x"],
        'Parse error on line 10, column 11: unexpected ": x"',
      ],
      [
        ["classDiagram", "  class A {", "    +x int", "  }", "", "  A <|-- -- B"],
        'Parse error on line 13, column 10: unexpected "--"',
      ],
      [
        ["stateDiagram-v2", "  [*] --> S", "  S --> --> T"],
        'Parse error on line 10, column 9: unexpected "-->"; expected ID or EDGE_STATE.',
      ],
      [
        ["erDiagram", "  A ||--o{ B : has", "  A ||-- B"],
        'Parse error on line 10, column 10: unexpected "B"',
      ],
      [
        ["gantt", "  dateFormat YYYY-MM-DD", "  Task :a1, 2026-01-01, 7d", "  : : :"],
        'Parse error on line 11, column 3: unexpected ": : :"',
      ],
      // Blank lines after the type, which Mermaid fails on in mind maps and kanban boards, are left out.
      [
        ["mindmap", "", "  root((Plan))", "    A", "    B))("],
        'Parse error on line 12, column 8: unexpected "("',
      ],
      [
        ["kanban", " ", "  Todo", "    Task))("],
        'Parse error on line 11, column 11: unexpected "("',
      ],
      // A lexer error, which Jison reports without a column.
      [
        ["quadrantChart", "  x-axis Low --> High", "  Point A: [0.3, 0.6] !"],
        'Parse error on line 10, column 23: unexpected "!".',
      ],
      // The sankey parser drops blank lines.
      [
        ["sankey", "A,B,10", "", 'B,C,"x'],
        "Parse error on line 11, column 7: unexpected end of the diagram",
      ],
      [
        ["C4Context", '  Person(a, "A")', "  Rel(a,"],
        "Parse error on line 10, column 9: unexpected end of the diagram",
      ],
      // Langium parsers report each error.
      [
        ["pie", '  "Dogs" : 386', "  Rats : 1", "  Cats : 2"],
        'Parse error on line 10, column 3: unexpected "Rats".\nParse error on line 11, column 3: unexpected "Cats".',
      ],
      [
        ["gitGraph", "  commit", "  comit"],
        'Parse error on line 10, column 3: unexpected "comit"; expected end of the diagram.',
      ],
      [
        ["treemap-beta", '  "A"', '    "B": 1', '    "C" x'],
        'Parse error on line 11, column 9: unexpected "x"; expected STRING2 or CLASS_DEF.',
      ],
      // Agent flows keep comment lines.
      [
        ["agentflow-beta", "  %% kept", "  A --> B", "  B -> --> C"],
        'Parse error on line 11, column 5: unexpected "-"',
      ],
      [
        ["usecase-beta", "  actor A", "  A --> --> B"],
        'Parse error on line 10, column 9: unexpected "-->"',
      ],
    ];
    for (const [[header, ...body], expected] of cases) {
      const source = [...preamble, header, "  %% comment", ...body].join("\r\n");
      const error = await renderError(source);
      assert.ok(error?.startsWith(expected), `${header}: ${error}`);
    }
  });

  test("draws mind maps, kanban boards and Ishikawa diagrams with blank lines after their type", async () => {
    // Mermaid fails on the indentation after them, also after a comment line it removes.
    for (const [header, node] of [
      ["mindmap", "root((Plan))"],
      ["kanban", "Todo"],
      ["ishikawa-beta", "Problem"],
    ] as const) {
      const source = `---\ntitle: T\n---\n${header}\n\n  %% comment\n  \n  ${node}\n    Child`;
      assert.ok((await render({ source })).ok, header);
      const text = (await evaluate(`document.querySelector("#diagram svg").textContent`)) as string;
      assert.match(text, /Child/, header);
    }
  });

  test("reports invalid YAML at its line and column in the source", async () => {
    assert.deepStrictEqual(
      await errors(
        "---\ntitle: T\nconfig:\n  theme: : x\n---\nflowchart TD",
        "flowchart TD\n  A@{ shape: [ } --> B",
        "flowchart TD\n  A@{\n    label: [\n  } --> B",
      ),
      [
        "Invalid YAML in the front matter on line 4, column 10: bad indentation of a mapping entry.",
        "Invalid YAML in the node's metadata on line 2, column 16: missed comma between flow collection entries.",
        "Invalid YAML in the node's metadata on line 4, column 3: unexpected end of the stream within a flow collection.",
      ],
    );
    // Agent flows check the shapes of nodes themselves, and number the lines of the source.
    assert.strictEqual(
      await renderError("---\ntitle: T\n---\nagentflow-beta\n  %% c\n  A@{ shape: nope } --> B"),
      "Error on line 6, column 4: No such shape: nope.",
    );
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

  test("selects sequence footer participants by identity when their labels match", async () => {
    assert.ok(
      (
        await render({
          source: "sequenceDiagram\n participant A as Service\n actor B as Service\n A->>B: Hello",
        })
      ).ok,
    );
    assert.deepStrictEqual(
      await evaluate(`(() => {
        return [...document.querySelectorAll('#diagram .actor-bottom')].map(footer => {
          footer.dispatchEvent(new MouseEvent('click', {bubbles: true}));
          return {
            name: footer.getAttribute('name'),
            selected: [...document.querySelectorAll('#diagram [data-et="participant"].diagram-selected')]
              .map(node => node.getAttribute('data-id'))
          };
        }).sort((a, b) => a.name.localeCompare(b.name));
      })()`),
      [
        { name: "A", selected: ["A"] },
        { name: "B", selected: ["B"] },
      ],
    );
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
          window.testRenderingBusy = document.getElementById("canvas").getAttribute("aria-busy");
          window.testRenderingStatus = document.getElementById("render-status").textContent;
          window.testRenderingHeight = document.getElementById("canvas").clientHeight;
          return {series: ${series}};
        })()`,
      });
      assert.strictEqual(result.ok, series !== "[]");
      assert.deepStrictEqual(
        await evaluate(`({
          during: window.testRenderingInert,
          duringBusy: window.testRenderingBusy,
          duringStatus: window.testRenderingStatus,
          // A status shown only while rendering would size the chart for a smaller canvas.
          sameHeight: window.testRenderingHeight === document.getElementById("canvas").clientHeight,
          after: document.getElementById("canvas").inert,
          afterBusy: document.getElementById("canvas").getAttribute("aria-busy"),
          afterStatus: document.getElementById("render-status").textContent,
          idleStatusHeight: document.getElementById("render-status").getBoundingClientRect().height
        })`),
        {
          during: true,
          duringBusy: "true",
          // Only a slow render shows its status.
          duringStatus: "",
          // Unlike the error that follows a failed render.
          sameHeight: series !== "[]",
          after: false,
          afterBusy: "false",
          afterStatus: "",
          idleStatusHeight: 0,
        },
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

  test("tells apart chart items of the same name when selecting and marking them", async () => {
    assert.ok(
      (
        await render({
          language: "echarts",
          source: JSON.stringify({
            animation: false,
            xAxis: { type: "category", data: ["A", "B", "A"] },
            yAxis: {},
            series: [
              {
                type: "bar",
                data: [1, 1, 1],
                itemStyle: { color: "#0000ff" },
                emphasis: { itemStyle: { color: "#ff0000" } },
              },
            ],
          }),
        })
      ).ok,
    );
    assert.strictEqual(
      await evaluate(`(() => {
        const bar = document.querySelectorAll('#chart svg path[fill="#0000ff"]')[2];
        const box = bar.getBoundingClientRect();
        const mouse = {
          bubbles: true, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2
        };
        for (const type of ["mousedown", "mouseup", "click"]) {
          bar.dispatchEvent(new MouseEvent(type, mouse));
        }
        return document.getElementById("selection-label").textContent;
      })()`),
      "Selected: “A”",
    );
    assert.match(
      panel.describeForModel() ?? "",
      /selected these chart items in the panel: "A" \(id: A \(item 3\)\)/,
    );
    const ambiguous = panel.annotate({ marks: [{ id: "A", kind: "info" }], dim: false });
    assert.ok(ambiguous.ok);
    assert.deepStrictEqual(ambiguous.repeated, [
      { name: "A", ids: ["A (item 1)", "A (item 3)"], count: 2 },
    ]);
    panel.annotate({ marks: [{ id: "A (item 3)", kind: "info" }], dim: false });
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
    assert.ok((await render({ language: "echarts", source: COUNTED_CHART })).ok);
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        ${CHART_FITTED}
        // Let an earlier layout change, should one still be on its way, resize the chart first.
        if (!(await chartFitted())) return "The chart does not take the size of its container.";
        const chart = document.getElementById("chart");
        const width = chart.clientWidth;
        const height = chart.clientHeight;
        // The panel handles resize observations in an animation frame: count what those draw.
        const requestFrame = window.requestAnimationFrame;
        let redraws = 0;
        window.requestAnimationFrame = (callback) => requestFrame((time) => {
          const before = window.chartDraws.length;
          callback(time);
          redraws += window.chartDraws.length - before;
        });
        try {
          await new Promise((resolve) => {
            // Observed after the panel's observer, so this observer hears of the same resize
            // after it, and its frame follows the panel's.
            const observer = new ResizeObserver(() => {
              observer.disconnect();
              requestFrame(resolve);
            });
            // Content-box changes trigger ResizeObserver, but the chart uses client dimensions.
            chart.style.padding = "1px";
            observer.observe(chart);
          });
          return {sameSize: chart.clientWidth === width && chart.clientHeight === height, redraws};
        } finally {
          window.requestAnimationFrame = requestFrame;
          chart.style.padding = "";
        }
      })()`),
      { sameSize: true, redraws: 0 },
    );
  });

  test("fits a chart drawn while its container briefly had another size or was hidden", async () => {
    assert.ok((await render({ language: "echarts", source: COUNTED_CHART })).ok);
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        ${CHART_FITTED}
        const chart = document.getElementById("chart");
        const results = window.testRenderResults;
        const send = (requestId, source) => window.dispatchEvent(new MessageEvent("message",
          {data: {type: "render", requestId, language: "echarts", source, title: "Test"}}));
        let request = 900010;
        // Draws a new chart in place of one that failed, which hid the chart, between the same
        // two frames, while its container has another size: ResizeObserver, which compares sizes
        // in frames, sees none of it.
        const redraw = async (whileDrawing, afterDrawing) => {
          const failing = ++request;
          const drawn = ++request;
          const push = results.push;
          results.push = (id) => {
            if (id === failing) {
              whileDrawing();
              send(drawn, '{"series": [{"type": "pie", "data": [1]}]}');
            } else if (id === drawn) {
              afterDrawing();
            }
            return push.call(results, id);
          };
          try {
            send(failing, '{"xAxis": null, "yAxis": {}, "series": [{"type": "bar", "data": [1]}]}');
            while (!results.includes(drawn)) await new Promise(resolve => setTimeout(resolve, 10));
          } finally {
            results.push = push;
          }
          return chartFitted();
        };
        const view = (name) => () => document.getElementById("view-" + name).click();
        return {
          fitted: await chartFitted(),
          resized: await redraw(() => { chart.style.bottom = "41px"; },
            () => { chart.style.bottom = ""; }),
          hidden: await redraw(view("source"), view("visual")),
        };
      })()`),
      { fitted: true, resized: true, hidden: true },
    );
  });

  test("draws a chart once in the colors of a new theme", async () => {
    assert.ok((await render({ language: "echarts", source: COUNTED_CHART })).ok);
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        const fill = () => document.querySelector("#chart svg path")?.getAttribute("fill");
        const root = document.documentElement.style;
        const before = window.chartDraws.length;
        root.setProperty("--vscode-charts-blue", "#123456");
        try {
          while (fill() !== "#123456") await new Promise(requestAnimationFrame);
          // A layout that is not the theme's, still on its way from rendering, draws once too.
          return [...new Set(window.chartDraws.slice(before))];
        } finally {
          root.removeProperty("--vscode-charts-blue");
          while (fill() === "#123456") await new Promise(requestAnimationFrame);
        }
      })()`),
      [1],
    );
  });

  test("keeps a selected chart item selected through a theme change", async () => {
    assert.ok(
      (
        await render({
          language: "echarts",
          source: JSON.stringify({
            animation: false,
            series: [
              {
                type: "pie",
                data: ["A", "B"].map((name) => ({ name, value: 1 })),
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
        const fills = () => [...document.querySelectorAll("#chart svg path")]
          .map(path => path.getAttribute("fill")).filter(fill => fill !== "none").sort();
        const waitFor = async (done) => {
          for (let attempt = 0; attempt < 100 && !done(); attempt++) {
            await new Promise(resolve => setTimeout(resolve, 20));
          }
        };
        const slice = document.querySelectorAll("#chart svg path")[1];
        const box = slice.getBoundingClientRect();
        const mouse = {bubbles: true, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2};
        for (const type of ["mousedown", "mouseup", "click"]) {
          slice.dispatchEvent(new MouseEvent(type, mouse));
        }
        await waitFor(() => fills().includes("#ff0000"));
        const root = document.documentElement.style;
        root.setProperty("--vscode-charts-blue", "#123456");
        try {
          await waitFor(() => fills().includes("#123456"));
          return fills();
        } finally {
          root.removeProperty("--vscode-charts-blue");
        }
      })()`),
      ["#123456", "#ff0000"],
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

suite("JavaScript in chart options", function () {
  this.timeout(20_000);

  let panel: DiagramPanel;
  let webview: vscode.Webview;
  const messages: string[] = [];
  suiteSetup(() => {
    panel = newPanel();
    ({ webview } = openWebviewPanel(panel));
    webview.onDidReceiveMessage((message: { type: string }) => messages.push(message.type));
  });
  suiteTeardown(() => panel.dispose());

  const render = (source: string): Promise<RenderOutcome> =>
    panel.render({ language: "echarts", source, title: "Test" }, "tool");
  // Code in the option clicks Refresh, which sends the extension a message as if the user had.
  const forging =
    '{series: [{type: "pie", data: [1]}], title: {text: (document.getElementById("refresh").click(), "Forged")}}';

  test("runs in a trusted workspace, with all the power of the page", async () => {
    assert.match(webview.html, /script-src 'nonce-[\w-]+' 'unsafe-eval'/);
    assert.deepStrictEqual(await render(forging), { ok: true, diagramType: "pie" });
    assert.ok(messages.includes("refresh"));
  });

  test("does not run in an untrusted workspace, whose page may not evaluate code", async () => {
    const ready = new Promise<void>((resolve) => {
      const listener = webview.onDidReceiveMessage((message: { type: string }) => {
        if (message.type !== "ready") return;
        listener.dispose();
        resolve();
      });
    });
    // The page that loadWebview makes for an untrusted workspace.
    webview.html = webview.html.replace(" 'unsafe-eval'", "");
    await ready;
    messages.length = 0;
    const outcome = await render(forging);
    assert.ok(!outcome.ok);
    assert.match(
      outcome.error,
      /^The ECharts option has JavaScript code \(line 1, column 52\), which the panel runs only in a trusted workspace\./,
    );
    assert.ok(!messages.includes("refresh"), "the code in the option ran");
    // Object literals need no evaluation.
    assert.deepStrictEqual(await render("{series: [{type: 'pie', data: [1,],}],}"), {
      ok: true,
      diagramType: "pie",
    });
  });
});

suite("Mermaid sources from a model or an untrusted repository", function () {
  this.timeout(20_000);

  let panel: DiagramPanel;
  let evaluate: WebviewHarness["evaluate"];
  suiteSetup(() => {
    panel = newPanel();
    ({ evaluate } = instrumentWebview(panel));
  });
  suiteTeardown(() => panel.dispose());

  const script = "<img src=x onerror='window.pwned=1'>";
  const payloads: Record<string, string> = {
    "HTML labels": `flowchart LR\n  A["${script}"] --> B["<a href='javascript:window.pwned=2'>x</a>"]\n  C["<iframe srcdoc='<script>parent.pwned=3</script>'></iframe>"]`,
    "click directives": `flowchart LR\n  A --> B --> C --> D\n  click A call alert(1)\n  click B href "javascript:window.pwned=4"\n  click C href "https://example.com/?secret" _blank\n  click D href "vscode://file/etc/passwd"`,
    "links in labels and actor menus": `sequenceDiagram\n  participant A as <a href='https://example.com'>A</a>\n  links A: {"Repo": "https://example.com"}\n  A->>B: <a href='mailto:x@example.com'>mail</a>`,
    "an init directive": `%%{init: {"securityLevel": "loose", "dompurifyConfig": {"ADD_ATTR": ["onerror"]}}}%%\nflowchart LR\n  A["${script}"] --> B\n  click B call alert(1)`,
    "front matter": `---\nconfig:\n  securityLevel: loose\n  dompurifyConfig:\n    ADD_ATTR: [onerror]\n---\nflowchart LR\n  A["${script}"] --> B`,
  };

  for (const [name, source] of Object.entries(payloads)) {
    test(`runs no script and opens no link from ${name}`, async () => {
      assert.ok((await panel.render({ language: "mermaid", source, title: name }, "tool")).ok);
      const found = await evaluate(`(() => {
        const elements = [...document.getElementById("diagram").querySelectorAll("*")];
        return {
          handlers: elements.flatMap(e => [...e.attributes].filter(a => /^on/i.test(a.name)).map(a => a.name)),
          frames: elements.filter(e => /^(script|iframe|object|embed)$/i.test(e.tagName)).length,
          links: elements.filter(e => e.tagName === "a" && (e.hasAttribute("href") || e.hasAttributeNS("http://www.w3.org/1999/xlink", "href"))).length,
          pwned: window.pwned ?? null,
        };
      })()`);
      assert.deepStrictEqual(found, { handlers: [], frames: 0, links: 0, pwned: null });
    });
  }

  /** Records the URLs that the panel opens, instead of opening them. */
  async function opening(action: () => Promise<unknown>, count: number): Promise<string[]> {
    const openExternal = vscode.env.openExternal;
    const opened: string[] = [];
    vscode.env.openExternal = async (uri) => {
      opened.push(uri.toString(true));
      return true;
    };
    try {
      await action();
      for (let attempt = 0; attempt < 100 && opened.length < count; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // Give a click that should not open anything as long to arrive.
      await new Promise((resolve) => setTimeout(resolve, 100));
      return opened;
    } finally {
      vscode.env.openExternal = openExternal;
    }
  }

  test("opens a node's link on a plain click or Enter, and selects or picks on other clicks", async () => {
    const source = `flowchart LR\n  A[Docs] --> B["Mail <a href='mailto:docs@example.com'>us</a>"] --> C\n  click A href "https://example.com/docs?page=2" "Read the docs" _blank`;
    assert.ok((await panel.render({ language: "mermaid", source, title: "Links" }, "tool")).ok);
    let shown: unknown;
    const opened = await opening(async () => {
      shown = await evaluate(`(() => {
        const node = id => document.querySelector('#diagram [data-diagram-id="' + id + '"][tabindex]');
        const click = (element, init) =>
          element.dispatchEvent(new MouseEvent("click", {bubbles: true, ...init}));
        const shown = {
          tooltips: ["A", "B", "C"].map(id => node(id).querySelector("title.diagram-link")?.textContent ?? null),
          hint: document.getElementById("selection-label").textContent,
        };
        click(node("A"), {shiftKey: true});
        click(node("B").querySelector("a"), {ctrlKey: true});
        shown.selected = [...document.querySelectorAll("#diagram .diagram-selected[tabindex]")]
          .map(element => element.getAttribute("data-diagram-id"));
        window.dispatchEvent(new MessageEvent("message", {data: {
          type: "startPick", pickId: 90001, prompt: "Pick a node", multiple: false
        }}));
        click(node("A"));
        shown.picked = document.getElementById("pick").hidden;
        click(node("A"));
        node("A").dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true}));
        click(node("B").querySelector("a"));
        click(node("B"));
        click(node("C"));
        return shown;
      })()`);
    }, 4);
    assert.deepStrictEqual(shown, {
      tooltips: ["Open https://example.com/docs?page=2", "Open mailto:docs@example.com", null],
      hint: "Click a linked node to open its link (Ctrl/Cmd/Shift+click to select nodes).",
      selected: ["A", "B"],
      picked: true,
    });
    assert.deepStrictEqual(opened, [
      "https://example.com/docs?page=2",
      "https://example.com/docs?page=2",
      "mailto:docs@example.com",
      "mailto:docs@example.com",
    ]);
  });

  test("opens a Gantt task's link through the extension, keeping the panel", async () => {
    const source =
      'gantt\n  dateFormat YYYY-MM-DD\n  Design :a1, 2026-01-01, 7d\n  click a1 href "https://example.com/plan"';
    assert.ok((await panel.render({ language: "mermaid", source, title: "Plan" }, "tool")).ok);
    const opened = await opening(
      () =>
        evaluate(`document.querySelector('#diagram [data-diagram-id="a1"][tabindex]')
          .dispatchEvent(new MouseEvent("click", {bubbles: true}))`),
      1,
    );
    assert.deepStrictEqual(opened, ["https://example.com/plan"]);
    // Mermaid would have taken the panel to the URL itself.
    assert.strictEqual(await evaluate(`document.getElementById("diagram").hidden`), false);
  });

  const actorLinks = `sequenceDiagram
  participant Alice
  participant Bob
  link Alice: Dashboard @ https://example.com/dash
  links Bob: {"Wiki": "https://example.com/wiki", "Repo": "https://example.com/repo"}
  Alice->>Bob: hi`;

  test("opens an actor's link, or offers a menu of its links", async () => {
    assert.ok(
      (await panel.render({ language: "mermaid", source: actorLinks, title: "Seq" }, "tool")).ok,
    );
    let shown: unknown;
    const opened = await opening(async () => {
      shown = await evaluate(`(() => {
        const node = id => document.querySelector('#diagram [data-diagram-id="' + id + '"][tabindex]');
        const click = (element, init) =>
          element.dispatchEvent(new MouseEvent("click", {bubbles: true, ...init}));
        const key = (element, key) =>
          element.dispatchEvent(new KeyboardEvent("keydown", {key, bubbles: true}));
        const menu = () => document.querySelector("#canvas .link-menu");
        const focused = () =>
          document.activeElement.getAttribute("data-diagram-id") ?? document.activeElement.textContent;
        const shown = {
          tooltips: ["Alice", "Bob"].map(id => node(id).querySelector("title.diagram-link")?.textContent),
          hint: document.getElementById("selection-label").textContent,
        };
        click(node("Alice"));
        click(node("Bob"), {ctrlKey: true});
        shown.selected = [...document.querySelectorAll("#diagram .diagram-selected[tabindex]")]
          .map(element => element.getAttribute("data-diagram-id"));
        shown.menuAfterSelecting = menu() !== null;
        node("Bob").focus();
        key(node("Bob"), "Enter");
        shown.menu = {
          role: menu().getAttribute("role"),
          label: menu().getAttribute("aria-label"),
          items: [...menu().children].map(item => [item.getAttribute("role"), item.textContent, item.title]),
          focused: focused(),
        };
        key(document.activeElement, "ArrowDown");
        shown.afterArrowDown = focused();
        key(document.activeElement, "ArrowDown");
        shown.afterWrapping = focused();
        key(document.activeElement, "End");
        document.activeElement.click();
        shown.afterChoosing = {menu: menu() !== null, focused: focused()};
        key(node("Bob"), "Enter");
        key(document.activeElement, "Escape");
        shown.afterEscape = {menu: menu() !== null, focused: focused()};
        // The footer copy of the actor, which takes no focus.
        click(document.querySelector('#diagram [data-diagram-id="Bob"]:not([tabindex])'));
        shown.footerMenu = menu() !== null;
        document.getElementById("canvas").focus();
        shown.afterFocusElsewhere = menu() !== null;
        return shown;
      })()`);
    }, 2);
    assert.deepStrictEqual(shown, {
      tooltips: ["Open Dashboard (https://example.com/dash)", "Open Wiki or Repo"],
      hint: "Click a linked node to open its link (Ctrl/Cmd/Shift+click to select nodes).",
      selected: ["Bob"],
      menuAfterSelecting: false,
      menu: {
        role: "menu",
        label: "Links of Bob",
        items: [
          ["menuitem", "Wiki", "https://example.com/wiki"],
          ["menuitem", "Repo", "https://example.com/repo"],
        ],
        focused: "Wiki",
      },
      afterArrowDown: "Repo",
      afterWrapping: "Wiki",
      afterChoosing: { menu: false, focused: "Bob" },
      afterEscape: { menu: false, focused: "Bob" },
      footerMenu: true,
      afterFocusElsewhere: false,
    });
    assert.deepStrictEqual(opened, ["https://example.com/dash", "https://example.com/repo"]);
  });

  test("opens the entries of actor menus that sequence.forceMenus shows", async () => {
    const source = `%%{init: {"sequence": {"forceMenus": true}}}%%\n${actorLinks}`;
    assert.ok((await panel.render({ language: "mermaid", source, title: "Seq" }, "tool")).ok);
    const opened = await opening(
      () =>
        evaluate(`(() => {
          const entry = document.querySelector('#diagram .actorPopupMenu a[data-href="https://example.com/wiki"] tspan');
          entry.dispatchEvent(new MouseEvent("click", {bubbles: true}));
        })()`),
      1,
    );
    assert.deepStrictEqual(opened, ["https://example.com/wiki"]);
  });

  const linkedImages = {
    "a flowchart":
      'flowchart LR\n  A[Docs] --> B\n  click A href "https://example.com/docs" "Docs"',
    "actor menus": `%%{init: {"sequence": {"forceMenus": true}}}%%\n${actorLinks}`,
  };
  for (const [name, source] of Object.entries(linkedImages)) {
    test(`leaves links out of images of ${name}`, async () => {
      assert.ok((await panel.render({ language: "mermaid", source, title: "Links" }, "tool")).ok);
      const svg = await evaluate(`(async () => {
      const handle = document.getElementById("drag-out");
      handle.dispatchEvent(new PointerEvent("pointerenter"));
      for (let attempt = 0; attempt < 100; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 20));
        const dataTransfer = new DataTransfer();
        handle.dispatchEvent(new DragEvent("dragstart", {dataTransfer, cancelable: true}));
        const svg = dataTransfer.getData("image/svg+xml");
        if (svg) return svg;
      }
      throw new Error("The image was not prepared.");
    })()`);
      assert.ok(typeof svg === "string" && /Docs|Wiki/.test(svg));
      assert.doesNotMatch(svg, /example\.com|href/);
    });
  }
});
