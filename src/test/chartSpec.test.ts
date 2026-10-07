import * as assert from "node:assert";
import * as vscode from "vscode";
import { CHART_TYPES, DATA_FORMATS, dataOrigin, validateChartSpec } from "../chartSpec";

suite("chartSpec", () => {
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
            '- filters[2]: Unknown property "code"; the properties are "column", "op", "value".\n' +
            '- filters[2].column is ""; it must be a column name.\n' +
            '- filters[2].op is "like"; it must be one of "eq", "neq", "lt", "lte", "gt", "gte", "contains".',
        );
        return true;
      },
    );
  });

  test("the tool schema lists the chart types and data formats", () => {
    const schema = vscode.extensions
      .getExtension("fornwall.diagram")
      ?.packageJSON.contributes.languageModelTools.find(
        (tool: { name: string }) => tool.name === "diagram_chart",
      ).inputSchema.properties;
    assert.deepStrictEqual(schema.type.enum, CHART_TYPES);
    assert.deepStrictEqual(schema.format.enum, DATA_FORMATS);
  });

  test("says where a chart's data comes from", () => {
    assert.strictEqual(dataOrigin({ type: "pie", data: "a 1" }), "inline data");
    assert.strictEqual(dataOrigin({ type: "pie", file: "sales.csv" }), "file sales.csv");
    assert.strictEqual(dataOrigin({ type: "pie", command: "du -s *" }), "command `du -s *`");
  });

  test("accepts a valid spec, leaving out empty properties and the click prompt", () => {
    const spec = {
      type: "pie",
      title: "Sizes",
      command: "du -s *",
      format: "whitespace",
      labelColumn: "dir",
      valueColumns: ["size"],
      sort: "descending",
      limit: 8,
      options: { legend: { show: false } },
    };
    assert.deepStrictEqual(validateChartSpec(spec), spec);
    const sparse = { type: "bar", file: "a.csv", title: undefined, data: null, limit: null };
    assert.deepStrictEqual(validateChartSpec(sparse), {
      type: "bar",
      file: "a.csv",
    });
    const clickable = { type: "pie", data: "a 1", clickPrompt: "Explain {label}" };
    assert.deepStrictEqual(validateChartSpec(clickable), { type: "pie", data: "a 1" });
    const json = validateChartSpec({ type: "pie", data: [{ name: "a", value: 1 }] });
    assert.deepStrictEqual(json, { type: "pie", data: '[{"name":"a","value":1}]' });
  });

  test("accepts several label columns, a maximum and an aggregation", () => {
    const flows = { type: "sankey", data: "a,b,n", labelColumn: ["from", "to"] };
    assert.deepStrictEqual(validateChartSpec(flows), flows);
    const gauge = { type: "gauge", data: "n\n5", max: 100 };
    assert.deepStrictEqual(validateChartSpec(gauge), gauge);
    assert.throws(
      () => validateChartSpec({ type: "sankey", data: "a,1", labelColumn: [] }),
      /"labelColumn" is \[\]; it must be a column name, or an array of them/,
    );
    assert.throws(
      () => validateChartSpec({ type: "sankey", data: "a,1", labelColumn: [1] }),
      /"labelColumn" is \[1\]; it must be/,
    );
    assert.throws(
      () => validateChartSpec({ type: "gauge", data: "a,1", max: "100" }),
      /"max" is "100"; it must be a number/,
    );
    const grouped = { type: "bar", data: "a,1", aggregate: "count" };
    assert.deepStrictEqual(validateChartSpec(grouped), grouped);
    assert.throws(
      () => validateChartSpec({ type: "bar", data: "a,1", aggregate: "total" }),
      /"aggregate" is "total"; it must be one of "sum", "mean", "count", "min", "max", "median"/,
    );
  });

  test("lists every problem of an invalid spec", () => {
    assert.throws(
      () =>
        validateChartSpec({
          type: "not-a-chart",
          data: "a,1",
          file: "x.csv",
          limit: 2.5,
          sort: "up",
          valueColumns: "size",
          options: [],
          colour: "red",
        }),
      (error: Error) => {
        for (const expected of [
          'Unknown property "colour"; the properties are "type", "title",',
          '"options", "clickPrompt".',
          '"type" is "not-a-chart"; it must be one of "pie"',
          'Give only one of "data", "file"',
          '"limit" is 2.5; it must be a positive integer',
          '"sort" is "up"; it must be one of "ascending", "descending"',
          '"valueColumns" is "size"; it must be a non-empty array',
          '"options" is []; it must be an object',
        ]) {
          assert.ok(error.message.includes(expected), `${expected} in ${error.message}`);
        }
        return true;
      },
    );
    assert.throws(() => validateChartSpec({ type: "pie" }), /exactly one of "data"/);
    assert.throws(() => validateChartSpec({ type: "pie", data: " " }), /non-empty string/);
    assert.throws(() => validateChartSpec({ data: "a" }), /"type" is missing/);
    assert.throws(
      () => validateChartSpec({ type: "pie", data: "a,1", clickPrompt: 5 }),
      /"clickPrompt" is 5; it must be a string\./,
    );
    assert.throws(() => validateChartSpec("[1"), /must be an object/);
    assert.throws(() => validateChartSpec(null), /must be an object/);
  });
});
