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
      undefined,
      table,
    );
    assert.ok(outcome.ok);
    page.panel.toggleChartOptions();
    // The form loads when first shown.
    assert.ok(
      await evaluate(`(async () => {${UNTIL}
        return until(() => !document.getElementById("chart-options").hidden);
      })()`),
    );
  };
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
    await nextRender(() =>
      evaluate(`document.querySelector('#chart-options .actions button').click()`),
    );
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
    assert.deepStrictEqual(page.panel.current?.chart?.filters?.at(-1), {
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
    assert.strictEqual(page.panel.current?.chart?.type, "histogram");
    assert.strictEqual(page.panel.current?.chart?.bins, 3);
    assert.strictEqual(page.panel.current?.chart?.facetColumn, "service");
    assert.strictEqual(page.panel.current?.chart?.facetScales, undefined);
    assert.deepStrictEqual(page.panel.current?.chart?.filters, chart.filters);
    for (const key of ["labelColumn", "aggregate", "sort", "limit"] as const) {
      assert.strictEqual(page.panel.current?.chart?.[key], undefined);
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
      assert.strictEqual(page.panel.current?.chart?.[key], undefined);
    }
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

  test("chart options preserve column spelling when applying unrelated changes", async () => {
    const table = parseTable("name,amount\na,1\nb,2");
    const chart: ChartSpec = {
      type: "bar",
      data: "name,amount\na,1\nb,2",
      labelColumn: " NAME ",
      valueColumns: ["AMOUNT"],
    };
    await showChartOptions(chart, table);
    await nextRender(() =>
      evaluate(`(() => {
      document.getElementById("chart-option-sort").value = "descending";
      document.querySelector("#chart-options .actions button").click();
    })()`),
    );
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
