import * as assert from "node:assert";
import { chartControls, updatedChartSpec, withChartControls } from "../chartOptions";
import { type ChartSpec, validateChartSpec } from "../chartSpec";
import { buildChart } from "../charts";
import { parseTable } from "../data";

const data = "name,amount\na,1\nb,2";

suite("chartOptions", () => {
  const spec: ChartSpec = {
    type: "bar",
    command: "print-data",
    format: "tsv",
    title: "Sales",
    sort: "descending",
    limit: 4,
    max: 100,
    options: { legend: { show: false } },
  };
  test("replaces controls together while preserving data and presentation", () => {
    const result = withChartControls(spec, {
      type: "sankey",
      labelColumn: ["target", "source"],
      valueColumns: ["amount"],
      aggregate: "sum",
    });
    assert.deepStrictEqual(result, {
      type: "sankey",
      command: "print-data",
      format: "tsv",
      title: "Sales",
      max: 100,
      options: spec.options,
      labelColumn: ["target", "source"],
      valueColumns: ["amount"],
      aggregate: "sum",
    });
    assert.strictEqual(spec.limit, 4);
  });
  test("rejects replacement data sources, arbitrary options and invalid controls", () => {
    // chartSpec's tests check which controls are valid.
    for (const extra of [{ command: "run-something" }, { options: {} }, { limit: 0 }]) {
      assert.throws(
        () => withChartControls(spec, { type: "pie", ...extra }),
        /^Error: (Unknown property|Invalid chart spec)/,
        JSON.stringify(extra),
      );
    }
  });
  test("round-trips facet and filter controls without changing predicate types", () => {
    const faceted: ChartSpec = {
      ...spec,
      facetColumn: "service",
      facetColumns: 2,
      facetScales: "independent",
      filters: [
        { column: "amount", op: "gte", value: 1 },
        { column: "name", op: "eq", value: "1" },
        { column: "missing", op: "eq", value: null },
      ],
    };
    assert.deepStrictEqual(withChartControls(faceted, chartControls(faceted)), faceted);
    const histogram = withChartControls(faceted, {
      type: "histogram",
      valueColumns: ["amount"],
      bins: 12,
      facetColumn: "service",
    });
    assert.deepStrictEqual(histogram, {
      type: "histogram",
      command: "print-data",
      format: "tsv",
      title: "Sales",
      max: 100,
      options: spec.options,
      valueColumns: ["amount"],
      bins: 12,
      facetColumn: "service",
    });
  });

  test("updates only the settings given, keeping the source and styling, and clears those set to null", () => {
    const spec: ChartSpec = {
      type: "bar",
      data,
      options: { backgroundColor: "red" },
      limit: 1,
      sort: "ascending",
    };
    const updated = updatedChartSpec(spec, { type: "horizontalBar", sort: null, limit: null });
    assert.strictEqual(updated.type, "horizontalBar");
    assert.strictEqual(updated.data, data);
    assert.deepStrictEqual(updated.options, spec.options);
    assert.ok(!Object.hasOwn(updated, "limit"));
    assert.ok(!Object.hasOwn(updated, "sort"));
    for (const [input, error] of [
      [{}, /^Error: Give at least one chart setting to change: /],
      [{ revision: 1 }, /^Error: Give at least one chart setting to change: /],
      [{ data: "x" }, /^Error: "data" cannot be updated; /],
      [{ options: {} }, /^Error: "options" cannot be updated; /],
      [{ type: null }, /^Error: "type" and "title" cannot be cleared with null\.$/],
      [{ title: null }, /^Error: "type" and "title" cannot be cleared with null\.$/],
      [{ revision: -1, limit: 2 }, /^Error: "revision" must be a nonnegative integer/],
      [{ limit: 0 }, /^Error: Invalid chart spec:\n- "limit" is 0; /],
    ] as const) {
      assert.throws(() => updatedChartSpec(spec, input), error, JSON.stringify(input));
    }
    assert.throws(
      () => updatedChartSpec(spec, { data: "x", options: {} }),
      /^Error: "data", "options" cannot be updated; only "type", .*"title", "max" and "revision" can\./,
    );
  });

  test("a new chart type drops the settings it cannot use, unless they are given", () => {
    const bar: ChartSpec = {
      type: "bar",
      data,
      labelColumn: "name",
      sort: "descending",
      limit: 3,
      facetColumn: "group",
    };
    const histogram = updatedChartSpec(bar, { type: "histogram" });
    for (const key of ["labelColumn", "sort", "limit"]) {
      assert.ok(!Object.hasOwn(histogram, key), key);
    }
    assert.strictEqual(histogram.facetColumn, "group");
    const pie = updatedChartSpec({ ...histogram, bins: 10 }, { type: "pie" });
    assert.ok(!Object.hasOwn(pie, "bins"));
    assert.ok(!Object.hasOwn(pie, "facetColumn"));
    assert.strictEqual(updatedChartSpec(bar, { type: "histogram", limit: 2 }).limit, 2);
    // A box plot summarizes every row of each group itself.
    const grouped = { ...bar, data: "name,amount\na,1\na,2\nb,3\nb,4", aggregate: "sum" } as const;
    const boxplot = updatedChartSpec(grouped, { type: "boxplot" });
    for (const key of ["aggregate", "limit", "facetColumn"]) {
      assert.ok(!Object.hasOwn(boxplot, key), key);
    }
    const { option } = buildChart(boxplot, parseTable(grouped.data));
    assert.deepStrictEqual(option.series, [
      {
        type: "boxplot",
        name: "amount",
        data: [
          [3, 3.25, 3.5, 3.75, 4],
          [1, 1.25, 1.5, 1.75, 2],
        ],
      },
    ]);
    assert.strictEqual(updatedChartSpec(boxplot, { type: "bar" }).sort, "descending");
  });

  test("keeps the histogram, facet and filter settings of an update, or clears those set to null", () => {
    const source = { type: "histogram", data: "service,latency\na,5\nb,12" };
    const initial = validateChartSpec({
      ...source,
      bins: 10,
      facetColumn: "service",
      facetColumns: 2,
      facetScales: "independent",
      filters: [{ column: "latency", op: "gt", value: 0 }],
    });
    const retained = updatedChartSpec(initial, { title: "Latency" });
    assert.deepStrictEqual(retained, { ...initial, title: "Latency" });
    const cleared = updatedChartSpec(retained, {
      bins: null,
      facetColumn: null,
      facetColumns: null,
      facetScales: null,
      filters: null,
    });
    assert.deepStrictEqual(cleared, { ...source, title: "Latency" });
    assert.deepStrictEqual(updatedChartSpec(initial, { filters: [] }).filters, []);
    assert.strictEqual(initial.bins, 10);
  });
});
