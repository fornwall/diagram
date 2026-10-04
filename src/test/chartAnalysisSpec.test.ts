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
    assert.throws(
      () =>
        validateChartSpec({
          ...source,
          filters: [
            { column: "latency", op: "eq" },
            { column: "latency", op: "gt", value: "5" },
            { column: "", op: "like", value: 1, code: "x" },
          ],
        }),
      (error: Error) => {
        assert.strictEqual(
          error.message,
          "Invalid chart spec:\n" +
            "- filters[0].value is missing; it must be a string, a finite number, or null for a missing cell.\n" +
            '- filters[1].value is "5"; it must be a finite number to compare with "gt".\n' +
            '- filters[2] has unknown property "code"; a filter has "column", "op", "value".\n' +
            '- filters[2].column is ""; it must be a column name.\n' +
            '- filters[2].op is "like"; it must be one of "eq", "neq", "lt", "lte", "gt", "gte", "contains".',
        );
        return true;
      },
    );
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
