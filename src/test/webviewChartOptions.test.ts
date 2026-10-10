import * as assert from "node:assert";
import type { ChartSpec } from "../chartSpec";
import { buildChart } from "../charts";
import { type DataTable, parseTable } from "../data";
import type { Diagram } from "../panel";
import { suitePage, UNTIL } from "./webviewHarness";

suite("Chart Options in the webview", function () {
  // The first render loads the webview and the libraries, which can take a while.
  this.timeout(20_000);

  const page = suitePage();
  const { evaluate, nextRender, draw } = page;
  /** Renders the chart of the spec, with the data read as the table if given, and opens its options. */
  const showChartOptions = async (
    chart: ChartSpec,
    table?: DataTable,
    diagram: Partial<Diagram> = {},
  ) => {
    const source = JSON.stringify(buildChart(chart, table ?? parseTable(chart.data ?? "")).option);
    const outcome = await page.panel.render(
      { language: "echarts", source, title: "Test", chart, ...diagram },
      "tool",
      table,
    );
    assert.ok(outcome.ok);
    page.panel.toggleChartOptions();
    // The form loads when first shown.
    assert.ok(
      await evaluate(`(async () => {${UNTIL}
        return until(() => !document.getElementById("chart-options").hidden, "Chart Options");
      })()`),
    );
  };
  /** Runs the page code, such as changing the form's fields, applies the form and awaits the render. */
  const applyOptions = (code = "") =>
    nextRender(() =>
      evaluate(`(() => {${code}
        document.querySelector("#chart-options .actions button").click();
      })()`),
    );
  const closeChartOptions = () =>
    evaluate(`document.querySelector("#chart-options .chart-options-heading button").click()`);

  test("chart options apply several controls using cached command data and preserve the source", async () => {
    const table = parseTable("name,amount,other\na,1,3\nb,4,7");
    const chart: ChartSpec = {
      type: "bar",
      command: "this-command-must-never-run",
      labelColumn: "name",
      valueColumns: ["amount"],
    };
    await showChartOptions(chart, table, { clickPrompt: "Explain {label}" });
    assert.strictEqual(
      await evaluate(`document.querySelectorAll("#chart-option-label option").length`),
      3,
    );
    await nextRender(() =>
      evaluate(`(() => {
      document.getElementById("chart-option-chart").value = "pie";
      document.getElementById("chart-option-aggregation").value = "sum";
      document.getElementById("chart-option-sort").value = "descending";
      document.getElementById("chart-option-row").value = "1";
      // What Enter in a field does: click the form's default button.
      document.querySelector("#chart-options form button:default").click();
    })()`),
    );
    const { command, type, aggregate, sort, limit } = page.panel.current?.chart ?? {};
    assert.deepStrictEqual(
      { command, type, aggregate, sort, limit, clickPrompt: page.panel.current?.clickPrompt },
      {
        command: chart.command,
        type: "pie",
        aggregate: "sum",
        sort: "descending",
        limit: 1,
        clickPrompt: "Explain {label}",
      },
    );
    await closeChartOptions();
    assert.strictEqual(await evaluate(`document.getElementById("chart-options").hidden`), true);
  });

  test("chart options keep keyboard focus and column names predictable as rows change", async () => {
    const chart: ChartSpec = {
      type: "bar",
      data: "name,value,other\na,1,2\nb,2,3",
      valueColumns: ["value", "other"],
    };
    await showChartOptions(chart);
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

  test("chart options keep the focus where it was as the options apply", async () => {
    const chart: ChartSpec = {
      type: "bar",
      data: "name,value,other\na,1,2\nb,2,3",
      valueColumns: ["value", "other"],
      filters: [{ column: "name", op: "neq", value: "c" }],
    };
    await showChartOptions(chart);
    const focus = `({
      id: document.activeElement.id || document.activeElement.getAttribute("aria-label")
        || document.activeElement.textContent,
      applying: document.querySelector("#chart-options form button:default").ariaDisabled,
    })`;
    // Apply, pressed, shows itself disabled while the options apply, keeping the focus.
    await nextRender(() =>
      evaluate(`(() => {
        const apply = document.querySelector("#chart-options form button:default");
        apply.focus();
        apply.click();
        return ${focus};
      })()`).then((pending) => assert.deepStrictEqual(pending, { id: "Apply", applying: "true" })),
    );
    assert.deepStrictEqual(await evaluate(focus), { id: "Apply", applying: null });
    // Enter in a row of filters or columns.
    for (const label of ["Filter value", "Value column 2"]) {
      await nextRender(() =>
        evaluate(`(() => {
          document.querySelector('#chart-options [aria-label="${label}"]').focus();
          document.querySelector("#chart-options form").requestSubmit();
        })()`),
      );
      assert.deepStrictEqual(await evaluate(focus), { id: label, applying: null });
    }
    // Not when the user went elsewhere in VS Code meanwhile, which the focus would leave, as when
    // the row goes.
    assert.strictEqual(
      await evaluate(`(async () => {
        ${UNTIL}
        const value = document.querySelector('#chart-options [aria-label="Filter value"]');
        value.focus();
        document.hasFocus = () => false;
        try {
          receive({type: "chartOptions", visible: true, state: {revision: 0, rowCount: 2,
            controls: {type: "bar"}, columns: [{name: "name", numeric: false}], edited: false}});
          await until(() => !value.isConnected, "the row gone");
          return document.activeElement.tagName;
        } finally {
          delete document.hasFocus;
        }
      })()`),
      "BODY",
    );
    // Fields disabled, as without the data, which takes the focus from them only later.
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        ${UNTIL}
        document.getElementById("chart-option-chart").focus();
        receive({type: "chartOptions", visible: true, state: {revision: 0, controls: {type: "bar"},
          columns: [], rowCount: 0, edited: false, unavailable: "Press Refresh."}});
        await until(() => document.querySelector("#chart-options fieldset").disabled, "the fields disabled");
        return ${focus};
      })()`),
      { id: "Close", applying: null },
    );
    await closeChartOptions();
  });

  test("chat and chart option fields fit a narrow panel", async () => {
    const chart: ChartSpec = { type: "bar", data: "name,value\na,1\nb,2" };
    await showChartOptions(chart);
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
          // A filter goes on two lines, its remove button at the end of the first.
          options.querySelector("#chart-option-filters > button").click();
          options.style.width = "300px";
          const row = options.querySelector(".chart-filter-row");
          const [column, remove, value] = ["select", "button", "input"]
            .map(selector => row.querySelector(selector).getBoundingClientRect());
          return {chatFits: form.scrollWidth <= form.clientWidth,
            sendWraps: send.top >= input.bottom,
            fieldsFit: fields.scrollWidth <= fields.clientWidth,
            filterLines: [remove.top === column.top && remove.width < 50, value.top > column.bottom]};
        } finally {
          form.style.width = "";
          options.style.width = "";
          options.querySelector('[aria-label="Remove filter"]')?.click();
          options.querySelector(".chart-options-heading button").click();
        }
      })()`),
      { chatFits: true, sendWraps: true, fieldsFit: true, filterLines: [true, true] },
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
    await showChartOptions(chart, table);
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
    await applyOptions();
    assert.deepStrictEqual(page.panel.current?.chart?.filters, chart.filters);
    assert.strictEqual(page.panel.current?.chart?.facetColumns, 2);
    assert.strictEqual(page.panel.current?.chart?.facetScales, "independent");
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
        applying: apply.disabled || apply.ariaDisabled === "true",
      };
    })()`),
      { valueType: "number", valid: false, applying: false },
    );
    await applyOptions(`
      const row = [...document.querySelectorAll('.chart-filter-row')].at(-1);
      const operator = row.querySelector('[aria-label="Filter operator"]');
      operator.value = 'gte';
      operator.dispatchEvent(new Event('change'));
      row.querySelector('[aria-label="Filter value"]').value = '1';
    `);
    assert.deepStrictEqual(page.panel.current?.chart?.filters?.at(-1), {
      column: "amount",
      op: "gte",
      value: 1,
    });
    await applyOptions(`
      [...document.querySelectorAll('[aria-label="Remove filter"]')].at(-1).click();
    `);
    await applyOptions(`
      const type = document.getElementById('chart-option-chart');
      type.value = 'histogram';
      type.dispatchEvent(new Event('change'));
      document.getElementById('chart-option-bins').value = '3';
      document.getElementById('chart-option-axis').value = '';
    `);
    assert.strictEqual(page.panel.current?.chart?.type, "histogram");
    assert.strictEqual(page.panel.current?.chart?.bins, 3);
    assert.strictEqual(page.panel.current?.chart?.facetColumn, "service");
    assert.strictEqual(page.panel.current?.chart?.facetScales, undefined);
    assert.deepStrictEqual(page.panel.current?.chart?.filters, chart.filters);
    for (const key of ["labelColumn", "aggregate", "sort", "limit"] as const) {
      assert.strictEqual(page.panel.current?.chart?.[key], undefined);
    }
    await applyOptions(`
      const type = document.getElementById('chart-option-chart');
      type.value = 'pie';
      type.dispatchEvent(new Event('change'));
      document.querySelectorAll('[aria-label="Remove filter"]').forEach(button => button.click());
    `);
    for (const key of ["bins", "facetColumn", "facetColumns", "facetScales", "filters"] as const) {
      assert.strictEqual(page.panel.current?.chart?.[key], undefined);
    }
    await closeChartOptions();
  });

  test("chart options keep their rows as the options apply, and the column lists of unchanged columns", async () => {
    await draw({ language: "echarts", source: '{"series": [{"type": "pie", "data": [1]}]}' });
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        ${UNTIL}
        const show = (names, controls) => receive({type: "chartOptions", visible: true,
          state: {revision: 0, controls: {type: "bar", ...controls}, rowCount: 2, edited: false,
            columns: names.map((name) => ({name, numeric: name === "b"}))}});
        const selects = () => [...document.querySelectorAll("#chart-options select")];
        const shown = () => {
          const [label, value] = ["label", "value"].map((id) =>
            document.querySelector("#chart-option-" + id + " select"));
          const filters = [...document.querySelectorAll(".chart-filter-row")].map((row) =>
            [...row.querySelectorAll("select, input")].map((control) =>
              control.type === "number" ? "number:" + control.value : control.value));
          return {label: label.value, values: label.options.length + "/" + (value?.options.length ?? 0),
            facet: document.getElementById("chart-option-facet").value, filters};
        };
        show(["a", "b", "c"], {labelColumn: "a", valueColumns: ["gone", "b"], facetColumn: "c",
          filters: [{column: "b", op: "gt", value: 2}, {column: "a", op: "eq", value: "x"}]});
        await until(() => !document.getElementById("chart-options").hidden, "Chart Options");
        const before = selects();
        const first = shown();
        show(["a", "b", "c"], {labelColumn: "c", valueColumns: ["b"],
          filters: [{column: "a", op: "contains", value: "text"}]});
        await until(() => document.querySelectorAll(".chart-filter-row").length === 1, "one filter");
        const kept = selects().every((select) => before.includes(select));
        const second = shown();
        show(["a", "b", "d"], {labelColumn: "d"});
        await until(() => document.querySelectorAll(".chart-filter-row").length === 0, "no filter");
        const third = {...shown(), kept: selects().every((select) => before.includes(select))};
        receive({type: "chartOptions", visible: false});
        return {first, kept, second, third};
      })()`),
      {
        first: {
          label: "a",
          values: "3/4",
          facet: "c",
          filters: [
            ["b", "gt", "number", "number:2"],
            ["a", "eq", "string", "x"],
          ],
        },
        kept: true,
        second: {
          label: "c",
          values: "3/3",
          facet: "",
          filters: [["a", "contains", "string", "text"]],
        },
        third: { label: "d", values: "3/0", facet: "", filters: [], kept: true },
      },
    );
  });

  test("chart options count the rows and columns of the data, and say what refreshes it", async () => {
    const status = () =>
      evaluate(`document.querySelector("#chart-options .chart-options-heading + p").textContent`);
    for (const [data, counted] of [
      ["name,amount\na,1", "1 row · 2 columns."],
      ["name,amount,other\na,1,3\nb,4,7", "2 rows · 3 columns."],
    ] as const) {
      await showChartOptions({ type: "bar", data });
      // Inline data, which has no Refresh to load it again.
      assert.strictEqual(await status(), `${counted} Columns are inferred unless selected.`);
      await closeChartOptions();
    }
    await showChartOptions(
      { type: "bar", command: "this-command-must-never-run" },
      parseTable("name,amount\na,1"),
    );
    assert.strictEqual(
      await status(),
      "1 row · 2 columns. Columns are inferred unless selected. Refresh reloads the data.",
    );
    await closeChartOptions();
  });

  test("chart options scroll an error that the options give into view", async () => {
    await showChartOptions({
      type: "bar",
      data: "name,amount\na,1",
      filters: Array.from({ length: 10 }, () => ({ column: "name", op: "neq", value: "b" })),
    });
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        ${UNTIL}
        const container = document.getElementById("chart-options");
        const error = container.querySelector(".chart-options-error");
        const scrolls = container.scrollHeight > container.clientHeight;
        container.scrollTop = 0;
        receive({type: "chartOptionsError", message: "Could not apply the chart options."});
        await until(() => !error.hidden, "the error");
        const box = container.getBoundingClientRect();
        const shown = error.getBoundingClientRect();
        return {scrolls, inView: shown.top >= box.top && shown.bottom <= box.bottom};
      })()`),
      { scrolls: true, inView: true },
    );
    await closeChartOptions();
  });

  test("chart options show Apply and Reset busy until a reset is done, which a second click does not repeat", async () => {
    await showChartOptions({ type: "bar", data: "name,amount\na,1" });
    const revision = page.panel.revision;
    const busy = `[...document.querySelectorAll("#chart-options .actions button")]
      .map((button) => button.getAttribute("aria-disabled"))`;
    let during: unknown;
    await nextRender(async () => {
      during = await evaluate(`(() => {
        const reset = document.querySelectorAll("#chart-options .actions button")[1];
        reset.click();
        reset.click();
        return ${busy};
      })()`);
    });
    assert.deepStrictEqual(during, ["true", "true"]);
    assert.strictEqual(page.panel.revision, revision + 1);
    assert.ok(
      await evaluate(`(async () => {${UNTIL}
        return until(() => ${busy}.every((state) => state === null), "Apply and Reset");
      })()`),
    );
    await closeChartOptions();
  });

  test("chart options show disabled fields of every kind alike", async () => {
    await showChartOptions({ type: "bar", data: "name,amount\na,1" });
    assert.deepStrictEqual(
      await evaluate(`(() => {
        // As without the data, which disables the fields.
        const fields = document.querySelector("#chart-options fieldset");
        const look = () => ["chart-option-chart", "chart-option-row"]
          .map(id => document.getElementById(id))
          .concat(fields.querySelector("button"))
          .map(control => getComputedStyle(control).opacity);
        const enabled = look();
        fields.disabled = true;
        try {
          return {enabled, disabled: look()};
        } finally {
          fields.disabled = false;
        }
      })()`),
      { enabled: ["1", "1", "1"], disabled: ["0.4", "0.4", "0.4"] },
    );
    await closeChartOptions();
  });

  test("chart options name the chart types and aggregations in words, as the other choices", async () => {
    await showChartOptions({ type: "horizontalBar", data: "name,amount\na,1" });
    const texts = (id: string) =>
      evaluate(
        `[...document.getElementById("${id}").selectedOptions, ...document.getElementById("${id}").options].map(option => option.text)`,
      );
    const types = (await texts("chart-option-chart")) as string[];
    assert.deepStrictEqual(types.slice(0, 6), [
      "Horizontal bar",
      "Pie",
      "Doughnut",
      "Bar",
      "Horizontal bar",
      "Stacked bar",
    ]);
    assert.deepStrictEqual(await texts("chart-option-aggregation"), [
      "None",
      "None",
      "Sum",
      "Mean",
      "Count",
      "Min",
      "Max",
      "Median",
    ]);
    await closeChartOptions();
  });

  test("chart options leave out the fields that a box plot refuses", async () => {
    const data = "name,amount\na,1\na,2\nb,3\nb,4";
    const chart: ChartSpec = { type: "bar", data, aggregate: "sum", limit: 5 };
    await showChartOptions(chart, parseTable(data));
    const shown = `[...document.querySelectorAll('.chart-options-fields > div')]
      .filter(field => !field.hidden).map(field => field.querySelector('label').textContent)`;
    assert.deepStrictEqual(
      await evaluate(`(() => {
        const type = document.getElementById('chart-option-chart');
        type.value = 'boxplot';
        type.dispatchEvent(new Event('change'));
        return ${shown};
      })()`),
      [
        "Chart type",
        "Label columns (in order)",
        "Value columns (in order)",
        "Sort by first value",
        "Facet column",
        "Panels per row",
        "Axis scales",
        "Filters (all must match)",
      ],
    );
    await applyOptions();
    const { type, aggregate, limit } = page.panel.current?.chart ?? {};
    assert.deepStrictEqual(
      { type, aggregate, limit },
      { type: "boxplot", aggregate: undefined, limit: undefined },
    );
    // Back on a bar chart, they are there to set again.
    assert.ok(
      await evaluate(`(() => {
        const type = document.getElementById('chart-option-chart');
        type.value = 'bar';
        type.dispatchEvent(new Event('change'));
        return ${shown}.includes("Aggregation");
      })()`),
    );
    await closeChartOptions();
  });

  test("chart options show explicitly shared facet scales as the default", async () => {
    const data = "name,service,amount\na,api-a,1\nb,api-b,3";
    const table = parseTable(data);
    const chart: ChartSpec = { type: "bar", data, facetColumn: "service", facetScales: "shared" };
    await showChartOptions(chart, table);
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

  test("chart options apply with Enter in a list box, as in a text field", async () => {
    const data = "name,amount\na,1\nb,2";
    await showChartOptions({ type: "bar", data }, parseTable(data));
    await nextRender(() =>
      evaluate(`(() => {
        const sort = document.getElementById("chart-option-sort");
        sort.value = "descending";
        sort.focus();
        sort.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true, cancelable: true}));
      })()`),
    );
    assert.strictEqual(page.panel.current?.chart?.sort, "descending");
    await closeChartOptions();
  });

  test("chart options preserve column spelling when applying unrelated changes", async () => {
    const table = parseTable("name,amount\na,1\nb,2");
    const chart: ChartSpec = {
      type: "bar",
      data: "name,amount\na,1\nb,2",
      labelColumn: " NAME ",
      valueColumns: ["AMOUNT"],
    };
    await showChartOptions(chart, table);
    await applyOptions(`
      document.getElementById("chart-option-sort").value = "descending";
    `);
    assert.deepStrictEqual(page.panel.current?.chart?.labelColumn, [" NAME "]);
    assert.deepStrictEqual(page.panel.current?.chart?.valueColumns, ["AMOUNT"]);
    await closeChartOptions();
  });

  test("chart options recover inline data and close on arbitrary ECharts replacement", async () => {
    const chart: ChartSpec = { type: "bar", data: "name,value\na,1\nb,2" };
    await showChartOptions(chart);
    await draw({
      language: "echarts",
      source: '{"series":[{"type":"pie","data":[{"value":1,"name":"a"}]}]}',
    });
    assert.strictEqual(await evaluate(`document.getElementById("chart-options").hidden`), true);
    assert.strictEqual(page.panel.current?.chart, undefined);
  });
});
