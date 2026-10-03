import * as assert from "node:assert";
import { init as initECharts } from "echarts";
import type { ChartSpec } from "../chartSpec";
import { buildChart } from "../charts";
import { filterTable } from "../chartTransforms";
import { type DataTable, parseTable } from "../data";

// biome-ignore lint/suspicious/noExplicitAny: inspecting generated ECharts JSON
type Option = Record<string, any>;

function build(data: string | DataTable, extra: Partial<ChartSpec> = {}): Option {
  const result = buildChart(
    { data: "unused", type: "histogram", ...extra } as ChartSpec,
    typeof data === "string" ? parseTable(data) : data,
  );
  assert.deepStrictEqual(JSON.parse(JSON.stringify(result.option)), result.option);
  return result.option;
}

suite("chart transforms", () => {
  test("filters AND parsed cells with strict equality and string containment without mutation", () => {
    const table: DataTable = {
      header: true,
      columns: [
        { name: "key", numeric: false },
        { name: "value", numeric: true },
      ],
      rows: [
        ["foo", 2],
        ["food", "2"],
        ["bar", null],
        ["foo", 3],
      ],
    };
    const original = structuredClone(table);
    const filtered = filterTable(table, [
      { column: "KEY", op: "contains", value: "foo" },
      { column: "value", op: "eq", value: 2 },
    ]);
    assert.deepStrictEqual(filtered.rows, [["foo", 2]]);
    assert.deepStrictEqual(
      filterTable(table, [{ column: "value", op: "neq", value: 2 }]).rows,
      table.rows.slice(1),
    );
    assert.deepStrictEqual(filterTable(table, [{ column: "value", op: "eq", value: null }]).rows, [
      ["bar", null],
    ]);
    for (const op of ["lt", "lte", "gt", "gte"] as const) {
      const expected = op === "lt" || op === "lte" ? [["foo", 2]] : [["foo", 3]];
      assert.deepStrictEqual(
        filterTable(table, [{ column: "value", op, value: 2.5 }]).rows,
        expected,
      );
    }
    assert.deepStrictEqual(table, original);
  });

  test("empty filters and unknown filter columns produce actionable errors", () => {
    const table = parseTable("name,value\na,1\nb,2");
    assert.throws(
      () => filterTable(table, [{ column: "missing", op: "eq", value: 1 }]),
      /Unknown filter column.*Available columns/,
    );
    assert.throws(
      () => filterTable(table, [{ column: "value", op: "gt", value: 9 }]),
      /No rows match.*Change or remove/,
    );
  });

  test("filters precede aggregation, sorting and limiting", () => {
    const option = build("group,value\na,2\na,90\nb,10\nb,20", {
      type: "bar",
      aggregate: "sum",
      sort: "descending",
      limit: 1,
      filters: [{ column: "value", op: "lt", value: 50 }],
    });
    assert.deepStrictEqual(option.xAxis.data, ["b"]);
    assert.deepStrictEqual(option.series[0].data, [30]);
  });

  test("histogram bins raw observations including total rows, negatives and the upper boundary", () => {
    const option = build("label,value\na,-2\nb,-1\nc,0\nd,1\ntotal,2", { bins: 2 });
    assert.deepStrictEqual(option.series[0].data, [
      { name: "[-2, 0)", value: 2, lower: -2, upper: 0 },
      { name: "[0, 2]", value: 3, lower: 0, upper: 2 },
    ]);
    assert.strictEqual(option.series[0].barCategoryGap, "0%");
    const chart = initECharts(null, undefined, {
      renderer: "svg",
      ssr: true,
      width: 600,
      height: 400,
    });
    try {
      chart.setOption(option);
      assert.match(chart.renderToSVGString(), /<svg/);
    } finally {
      chart.dispose();
    }
  });

  test("filters precede histogram edge selection and missing values are excluded", () => {
    const option = build("name,value\na,0\nb,1\nc,2\nd,100\ne,", {
      bins: 2,
      filters: [{ column: "name", op: "neq", value: "d" }],
    });
    assert.deepStrictEqual(
      option.series[0].data.map((bin: Option) => bin.value),
      [1, 2],
    );
    assert.strictEqual(option.series[0].data[1].upper, 2);
  });

  test("constant, single, tiny and extreme values produce finite edges and retain all counts", () => {
    for (const values of [
      [5, 5, 5],
      [0],
      [Number.MIN_VALUE, Number.MIN_VALUE * 2],
      [-Number.MAX_VALUE, 0, Number.MAX_VALUE],
      [Number.MAX_VALUE / 2, Number.MAX_VALUE / 2 + 2 ** 970],
    ]) {
      const table: DataTable = {
        header: true,
        columns: [{ name: "value", numeric: true }],
        rows: values.map((value) => [value]),
      };
      const option = build(table, { bins: 200 });
      const data = option.series[0].data as Option[];
      assert.strictEqual(
        data.reduce((total, bin) => total + bin.value, 0),
        values.length,
      );
      assert.ok(data.every((bin) => Number.isFinite(bin.lower) && Number.isFinite(bin.upper)));
      if (values.every((value) => value === values[0])) assert.strictEqual(data.length, 1);
    }
  });

  test("histograms reject transforms that distort distributions", () => {
    for (const extra of [
      { aggregate: "sum" },
      { sort: "descending" },
      { limit: 1 },
      { labelColumn: "name" },
      { valueColumns: ["value", "other"] },
    ]) {
      assert.throws(
        () => build("name,value,other\na,1,2\nb,3,4", extra as Partial<ChartSpec>),
        /histogram/i,
      );
    }
    assert.throws(
      () => build("name,value\na,1", { type: "bar", bins: 2 }),
      /only supported for histograms/,
    );
    assert.throws(
      () =>
        build(
          { header: true, columns: [{ name: "value", numeric: true }], rows: [[null]] },
          { valueColumns: ["value"] },
        ),
      /no finite numbers/,
    );
  });

  test("faceted date axes overridden as categories align labels without timestamp bounds", () => {
    for (const type of ["line", "horizontalBar", "scatter"] as const) {
      const axis = type === "horizontalBar" ? "yAxis" : "xAxis";
      const option = build("group,date,value\na,2024-01-01,2\na,2024-01-02,3\nb,2024-01-03,4", {
        type,
        facetColumn: "group",
        options: { [axis]: { type: "category" } },
      });
      for (const category of option[axis]) {
        assert.strictEqual(category.type, "category");
        assert.deepStrictEqual(category.data, ["2024-01-01", "2024-01-02", "2024-01-03"]);
        assert.strictEqual(category.min, undefined);
        assert.strictEqual(category.max, undefined);
      }
      assert.strictEqual(option.series[0].data[2], null);
      assert.strictEqual(option.series[1].data[0], null);
      const chart = initECharts(null, undefined, {
        renderer: "svg",
        ssr: true,
        width: 600,
        height: 400,
      });
      try {
        chart.setOption(option);
        assert.match(chart.renderToSVGString(), /<svg/);
      } finally {
        chart.dispose();
      }
    }
  });
});
