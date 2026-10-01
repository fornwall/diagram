import * as assert from "node:assert";
import type { ChartSpec, ChartType } from "../chartSpec";
import { buildChartOption, deepMerge, validateChartSpec } from "../charts";
import type { DataTable } from "../data";

const LANGUAGES: DataTable = {
  columns: ["language", "files", "lines"],
  rows: [
    ["ts", 10, 1200],
    ["css", 3, 300],
    ["md", 5, 150],
    ["json", 2, 80],
  ],
};

function chart(type: ChartType, extra: Partial<ChartSpec> = {}): ChartSpec {
  return { type, data: "unused", ...extra };
}

// biome-ignore lint/suspicious/noExplicitAny: test access to the untyped option
type Option = Record<string, any>;

function build(spec: ChartSpec, table: DataTable = LANGUAGES): Option {
  const option = buildChartOption(spec, table);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(option)), option, "the option is plain JSON");
  return option;
}

suite("charts", () => {
  test("pie uses the label column and the first value column", () => {
    const option = build(chart("pie"));
    assert.strictEqual(option.tooltip.trigger, "item");
    assert.ok(option.legend);
    assert.strictEqual(option.series.length, 1);
    const [series] = option.series;
    assert.strictEqual(series.type, "pie");
    assert.strictEqual(series.name, "files");
    assert.strictEqual(series.radius, undefined);
    assert.deepStrictEqual(series.data, [
      { name: "ts", value: 10 },
      { name: "css", value: 3 },
      { name: "md", value: 5 },
      { name: "json", value: 2 },
    ]);
  });

  test("doughnut has an inner radius", () => {
    const [series] = build(chart("doughnut")).series;
    assert.strictEqual(series.type, "pie");
    assert.ok(Array.isArray(series.radius));
  });

  test("pie sorts, limits and sums the rest up as Other", () => {
    const [series] = build(chart("pie", { sort: "descending", limit: 2 })).series;
    assert.deepStrictEqual(series.data, [
      { name: "ts", value: 10 },
      { name: "md", value: 5 },
      { name: "Other", value: 5 },
    ]);
  });

  test("bar has a category x axis and one series per value column", () => {
    const option = build(chart("bar"));
    assert.strictEqual(option.tooltip.trigger, "axis");
    assert.ok(option.legend);
    assert.deepStrictEqual(option.xAxis.type, "category");
    assert.deepStrictEqual(option.xAxis.data, ["ts", "css", "md", "json"]);
    assert.strictEqual(option.yAxis.type, "value");
    assert.deepStrictEqual(
      option.series.map((s: Option) => [s.type, s.name, s.emphasis?.focus]),
      [
        ["bar", "files", "series"],
        ["bar", "lines", "series"],
      ],
    );
    assert.deepStrictEqual(option.series[1].data[0], { name: "ts", value: 1200 });
  });

  test("a single-series bar chart has no legend and names its value axis", () => {
    const option = build(chart("bar", { valueColumns: ["lines"], sort: "ascending", limit: 2 }));
    assert.strictEqual(option.legend, undefined);
    assert.strictEqual(option.yAxis.name, "lines");
    assert.deepStrictEqual(option.xAxis.data, ["json", "md"]);
    assert.deepStrictEqual(option.series[0].data, [
      { name: "json", value: 80 },
      { name: "md", value: 150 },
    ]);
  });

  test("axes are not named after generated column names", () => {
    const table: DataTable = {
      columns: ["Column 1", "Column 2"],
      rows: [
        ["src", 120],
        ["test", 30],
      ],
    };
    const option = buildChartOption({ type: "bar" }, table) as { yAxis: { name?: string } };
    assert.strictEqual(option.yAxis.name, undefined);
  });

  test("horizontalBar has an inverted category y axis", () => {
    const option = build(chart("horizontalBar"));
    assert.strictEqual(option.xAxis.type, "value");
    assert.strictEqual(option.yAxis.type, "category");
    assert.strictEqual(option.yAxis.inverse, true);
  });

  test("stackedBar stacks its series", () => {
    const option = build(chart("stackedBar"));
    assert.ok(option.series.every((s: Option) => s.type === "bar" && s.stack === "total"));
  });

  test("line and area are unsmoothed lines, area with an area style", () => {
    const line = build(chart("line")).series[0];
    assert.strictEqual(line.type, "line");
    assert.strictEqual(line.smooth, false);
    assert.strictEqual(line.showSymbol, true);
    assert.strictEqual(line.areaStyle, undefined);
    const area = build(chart("area")).series[0];
    assert.strictEqual(area.type, "line");
    assert.ok(area.areaStyle);
  });

  test("line hides symbols when there are many points", () => {
    const rows = Array.from({ length: 100 }, (_, i) => [`d${i}`, i]);
    const [series] = build(chart("line"), { columns: ["day", "n"], rows }).series;
    assert.strictEqual(series.showSymbol, false);
  });

  test("scatter plots the first value column against the second", () => {
    const option = build(chart("scatter"));
    assert.strictEqual(option.tooltip.trigger, "item");
    assert.strictEqual(option.xAxis.name, "files");
    assert.strictEqual(option.yAxis.name, "lines");
    assert.deepStrictEqual(option.series[0].type, "scatter");
    assert.deepStrictEqual(option.series[0].data[0], { name: "ts", value: [10, 1200] });
  });

  test("scatter of numbers alone names points by their coordinates", () => {
    const table: DataTable = {
      columns: ["x", "y"],
      rows: [
        [1, 2],
        [3, null],
      ],
    };
    assert.deepStrictEqual(build(chart("scatter"), table).series[0].data, [
      { name: "(1, 2)", value: [1, 2] },
    ]);
  });

  test("scatter needs two numeric columns", () => {
    assert.throws(() => build(chart("scatter", { valueColumns: ["files"] })), /two numeric/);
  });

  test("the label column defaults to the first column when all are numeric", () => {
    const table: DataTable = {
      columns: ["year", "sales"],
      rows: [
        [2023, 5],
        [2024, 7],
      ],
    };
    const option = build(chart("bar"), table);
    assert.deepStrictEqual(option.xAxis.data, ["2023", "2024"]);
    assert.deepStrictEqual(
      option.series.map((s: Option) => s.name),
      ["sales"],
    );
  });

  test("charts leave out a totals row", () => {
    const table: DataTable = {
      columns: ["Column 1", "Column 2"],
      rows: [
        [12, "a.ts"],
        [345, "b.ts"],
        [3, "c.ts"],
        [360, "total"],
      ],
    };
    for (const type of ["pie", "bar", "line", "horizontalBar"] as const) {
      const option = build(chart(type, { sort: "descending" }), table);
      const names = option.series[0].data.map((item: Option) => item.name);
      assert.deepStrictEqual(names, ["b.ts", "a.ts", "c.ts"], type);
    }
    const cloc: DataTable = {
      columns: ["language", "files", "code"],
      rows: [
        ["TypeScript", 10, 1200],
        ["CSS", 2, 300],
        ["SUM:", 12, 1500],
      ],
    };
    assert.deepStrictEqual(build(chart("stackedBar"), cloc).xAxis.data, ["TypeScript", "CSS"]);
    assert.strictEqual(build(chart("scatter"), cloc).series[0].data.length, 2);
    // Not a total of the others: kept.
    const kept = build(chart("bar", { valueColumns: ["files"] }), {
      columns: ["k", "files"],
      rows: [
        ["a", 1],
        ["b", 2],
        ["total", 4],
      ],
    });
    assert.deepStrictEqual(kept.xAxis.data, ["a", "b", "total"]);
  });

  test("default value columns skip identifier columns", () => {
    const table: DataTable = {
      columns: ["id", "name", "score"],
      rows: [
        [7, "a", 10],
        [3, "b", 20],
      ],
    };
    assert.deepStrictEqual(
      build(chart("bar"), table).series.map((s: Option) => s.name),
      ["score"],
    );
    assert.strictEqual(build(chart("pie"), table).series[0].name, "score");
    for (const name of ["ID", "#", "user_id", "Rank", "PID", "userId"]) {
      const option = build(chart("bar"), { ...table, columns: [name, "name", "score"] });
      assert.deepStrictEqual(
        option.series.map((s: Option) => s.name),
        ["score"],
        name,
      );
    }
    // A column numbering the rows 1, 2, 3, … is skipped when there are other numeric columns.
    const numbered: DataTable = {
      columns: ["n", "name", "score"],
      rows: [
        [1, "a", 10],
        [2, "b", 20],
        [3, "c", 30],
      ],
    };
    assert.deepStrictEqual(
      build(chart("bar"), numbered).series.map((s: Option) => s.name),
      ["score"],
    );
    // Kept when it is the only numeric column, or asked for.
    const onlyId: DataTable = {
      columns: ["name", "id"],
      rows: [
        ["a", 1],
        ["b", 2],
        ["c", 3],
      ],
    };
    assert.strictEqual(build(chart("pie"), onlyId).series[0].name, "id");
    assert.deepStrictEqual(
      build(chart("bar", { valueColumns: ["id", "score"] }), table).series.map(
        (s: Option) => s.name,
      ),
      ["id", "score"],
    );
    // "paid" is not an identifier name.
    const paid: DataTable = {
      columns: ["name", "paid", "score"],
      rows: table.rows.map((r) => [r[1] ?? null, r[0] ?? null, r[2] ?? null]),
    };
    assert.deepStrictEqual(
      build(chart("bar"), paid).series.map((s: Option) => s.name),
      ["paid", "score"],
    );
  });

  test("columns are matched loosely, and unknown columns are listed", () => {
    const option = build(chart("bar", { labelColumn: "LANGUAGE", valueColumns: [" Lines "] }));
    assert.deepStrictEqual(option.series[0].name, "lines");
    assert.throws(
      () => build(chart("bar", { valueColumns: ["size"] })),
      /Unknown value column "size". Available columns: "language", "files", "lines"/,
    );
    assert.throws(() => build(chart("pie", { labelColumn: "lang" })), /Unknown label column/);
  });

  test("throws when there is nothing numeric to chart", () => {
    const table: DataTable = { columns: ["a", "b"], rows: [["x", "y"]] };
    assert.throws(() => build(chart("bar"), table), /No numeric value columns/);
    assert.throws(() => build(chart("bar", { valueColumns: ["b"] }), table), /holds no numbers/);
    assert.throws(() => build(chart("bar"), { columns: ["a"], rows: [] }), /no rows/);
  });

  test("options are deep-merged into the generated option", () => {
    const option = build(
      chart("bar", {
        options: { series: [{ label: { show: true } }], yAxis: { type: "log" }, toolbox: {} },
      }),
    );
    assert.deepStrictEqual(option.series[0].label, { show: true });
    assert.strictEqual(option.series[0].type, "bar");
    assert.strictEqual(option.series[1].label, undefined);
    assert.strictEqual(option.yAxis.type, "log");
    assert.deepStrictEqual(option.toolbox, {});
  });

  test("deepMerge merges objects, replaces arrays and values, and does not mutate", () => {
    const target = { a: { b: 1, c: [1, 2] }, d: "x", list: [{ k: 1 }, { k: 2 }] };
    const source = { a: { c: [3] }, d: 5, list: [{ j: 1 }], e: null };
    const merged = deepMerge(target, source);
    assert.deepStrictEqual(merged, {
      a: { b: 1, c: [3] },
      d: 5,
      list: [{ k: 1, j: 1 }, { k: 2 }],
      e: null,
    });
    assert.deepStrictEqual(target, {
      a: { b: 1, c: [1, 2] },
      d: "x",
      list: [{ k: 1 }, { k: 2 }],
    });
    (merged.a as { c: number[] }).c.push(4);
    assert.deepStrictEqual(source.a.c, [3]);
  });

  test("deepMerge applies an object to every element of an array of objects", () => {
    assert.deepStrictEqual(deepMerge({ series: [{ a: 1 }, { a: 2 }] }, { series: { b: 3 } }), {
      series: [
        { a: 1, b: 3 },
        { a: 2, b: 3 },
      ],
    });
    assert.deepStrictEqual(deepMerge({ s: [{ a: 1 }] }, { s: [{ b: 1 }, { c: 2 }] }), {
      s: [{ a: 1, b: 1 }, { c: 2 }],
    });
  });

  test("deepMerge ignores prototype keys", () => {
    const merged = deepMerge({}, JSON.parse('{"__proto__": {"polluted": true}}'));
    assert.strictEqual((merged as { polluted?: boolean }).polluted, undefined);
    assert.strictEqual(({} as { polluted?: boolean }).polluted, undefined);
  });

  test("validateChartSpec accepts a valid spec, as an object or JSON", () => {
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
    assert.deepStrictEqual(validateChartSpec(JSON.stringify(spec)), spec);
    assert.deepStrictEqual(validateChartSpec({ type: "bar", file: "a.csv", title: undefined }), {
      type: "bar",
      file: "a.csv",
    });
  });

  test("validateChartSpec lists every problem", () => {
    assert.throws(
      () =>
        validateChartSpec({
          type: "histogram",
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
          'Unknown property "colour"',
          '"type" is "histogram"; it must be one of "pie"',
          'Give only one of "data", "file"',
          '"limit" must be a positive integer',
          '"sort" must be',
          '"valueColumns" must be',
          '"options" must be an object',
        ]) {
          assert.ok(error.message.includes(expected), `${expected} in ${error.message}`);
        }
        return true;
      },
    );
    assert.throws(() => validateChartSpec({ type: "pie" }), /exactly one of "data"/);
    assert.throws(() => validateChartSpec({ type: "pie", data: " " }), /non-empty string/);
    assert.throws(() => validateChartSpec({ data: "a" }), /"type" is missing/);
    assert.throws(() => validateChartSpec("[1"), /not valid JSON/);
    assert.throws(() => validateChartSpec(null), /must be an object/);
  });
});
