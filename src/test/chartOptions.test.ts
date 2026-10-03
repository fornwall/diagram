import * as assert from "node:assert";
import { chartControls, withChartControls } from "../chartOptions";
import type { ChartSpec } from "../chartSpec";
import { isFromWebview } from "../protocol";

suite("chart options", () => {
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
    for (const extra of [
      { command: "run-something" },
      { options: {} },
      { limit: 0 },
      { type: "bogus" },
      { valueColumns: [] },
      { bins: 201 },
      { facetColumns: 5 },
      { filters: [{ column: "amount", op: "gte", value: "1" }] },
    ]) {
      assert.throws(() => withChartControls(spec, { type: "pie", ...extra }));
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
    assert.strictEqual(histogram.bins, 12);
    assert.strictEqual(histogram.facetColumn, "service");
    for (const key of [
      "aggregate",
      "sort",
      "limit",
      "filters",
      "facetColumns",
      "facetScales",
    ] as const) {
      assert.strictEqual(histogram[key], undefined);
    }
    assert.strictEqual(histogram.command, spec.command);
    assert.deepStrictEqual(histogram.options, spec.options);
  });
  test("validates options revision and explicit source replacement before handling messages", () => {
    const valid = {
      type: "applyChartOptions",
      revision: 1,
      controls: { type: "bar" },
      replaceSource: false,
    };
    assert.ok(isFromWebview(valid));
    assert.ok(!isFromWebview({ ...valid, revision: "1" }));
    assert.ok(!isFromWebview({ ...valid, controls: [] }));
    assert.ok(!isFromWebview({ ...valid, replaceSource: "true" }));
  });
});
