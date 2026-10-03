import * as assert from "node:assert";
import { validateChartSpec } from "../chartSpec";
import { updatedChartSpec } from "../chartTools";

suite("chart analysis settings", () => {
  const source = { type: "histogram", data: "service,latency\na,5\nb,12" };

  test("validates facets, histogram bins and typed filters", () => {
    const input = {
      ...source,
      bins: 12,
      facetColumn: "service",
      facetColumns: 2,
      facetScales: "shared",
      filters: [
        { column: "latency", op: "gte", value: 5 },
        { column: "service", op: "contains", value: "a" },
        { column: "service", op: "neq", value: null },
      ],
    };
    assert.deepStrictEqual(validateChartSpec(input), input);
    for (const invalid of [
      { bins: 0 },
      { bins: 201 },
      { bins: 1.5 },
      { bins: "10" },
      { facetColumn: " " },
      { facetColumns: 0 },
      { facetColumns: 5 },
      { facetScales: "automatic" },
      { filters: {} },
      { filters: Array(51).fill({ column: "latency", op: "gte", value: 5 }) },
      { filters: [null] },
      { filters: [{ column: "latency", op: "eq" }] },
      { filters: [{ column: "latency", op: "gt", value: "5" }] },
      { filters: [{ column: "service", op: "contains", value: 5 }] },
      { filters: [{ column: "latency", op: "gte", value: Infinity }] },
      { filters: [{ column: "latency", op: "gte", value: 5, code: "unsafe" }] },
    ]) {
      assert.throws(() => validateChartSpec({ ...source, ...invalid }), /Invalid chart spec/);
    }
  });

  test("updates retain or explicitly clear analysis settings without replacing the source", () => {
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
