import * as assert from "node:assert";
import * as vscode from "vscode";
import {
  CHART_TYPES,
  type ChartSpec,
  type ChartType,
  DATA_FORMATS,
  dataOrigin,
  validateChartSpec,
} from "../chartSpec";
import { buildChart, deepMerge, describeTable } from "../charts";
import { type DataTable, parseTable } from "../data";

const LANGUAGES = parseTable(
  ["language,files,lines", "ts,10,1200", "css,3,300", "md,5,150", "json,2,80"].join("\n"),
);

function chart(type: ChartType, extra: Partial<ChartSpec> = {}): ChartSpec {
  return { type, data: "unused", ...extra };
}

// biome-ignore lint/suspicious/noExplicitAny: test access to the untyped option
type Option = Record<string, any>;

function build(spec: ChartSpec, table: DataTable | string = LANGUAGES): Option {
  const { option } = buildChart(spec, typeof table === "string" ? parseTable(table) : table);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(option)), option, "the option is plain JSON");
  return option;
}

function summary(spec: ChartSpec, table: DataTable | string = LANGUAGES): string {
  return buildChart(spec, typeof table === "string" ? parseTable(table) : table).summary;
}

function seriesNames(option: Option): string[] {
  return option.series.map((s: Option) => s.name);
}

suite("charts", () => {
  test("pie uses the label column and the first value column", () => {
    const option = build(chart("pie"));
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
    assert.strictEqual(summary(chart("pie")), 'Charted "files" by "language".');
  });

  test("doughnut has an inner radius", () => {
    const [series] = build(chart("doughnut")).series;
    assert.strictEqual(series.type, "pie");
    assert.ok(Array.isArray(series.radius));
  });

  test("pie sorts, limits and sums the rest up as Other", () => {
    const spec = chart("pie", { sort: "descending", limit: 2 });
    assert.deepStrictEqual(build(spec).series[0].data, [
      { name: "ts", value: 10 },
      { name: "md", value: 5 },
      { name: "Other", value: 5 },
    ]);
    assert.strictEqual(
      summary(spec),
      'Charted "files" by "language"; summed up the 2 rows after the first 2 as "Other".',
    );
  });

  test("bar has a category x axis and one series per value column", () => {
    const option = build(chart("bar"));
    // The webview adds the tooltip and legend.
    assert.strictEqual(option.tooltip, undefined);
    assert.strictEqual(option.legend, undefined);
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
    assert.deepStrictEqual(option.series[1].data, [1200, 300, 150, 80]);
    assert.strictEqual(summary(chart("bar")), 'Charted "files", "lines" by "language".');
  });

  test("a single-series bar chart names its value axis", () => {
    const spec = chart("bar", { valueColumns: ["lines"], sort: "ascending", limit: 2 });
    const option = build(spec);
    assert.strictEqual(option.yAxis.name, "lines");
    assert.deepStrictEqual(option.xAxis.data, ["json", "md"]);
    assert.deepStrictEqual(option.series[0].data, [80, 150]);
    assert.match(summary(spec), /; kept the first 2 of 4 rows\.$/);
  });

  test("axes are not named after generated column names", () => {
    assert.strictEqual(build(chart("bar"), "src,120\ntest,30").yAxis.name, undefined);
    assert.strictEqual(build(chart("scatter"), "1,2\n3,4").xAxis.name, undefined);
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

  test("line and area are lines, area with an area style", () => {
    const line = build(chart("line")).series[0];
    assert.strictEqual(line.type, "line");
    assert.strictEqual(line.showSymbol, undefined);
    assert.strictEqual(line.areaStyle, undefined);
    const area = build(chart("area")).series[0];
    assert.strictEqual(area.type, "line");
    assert.ok(area.areaStyle);
  });

  test("line hides symbols when there are many points", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `d${i},${i}`);
    const [series] = build(chart("line"), ["day,n", ...lines].join("\n")).series;
    assert.strictEqual(series.showSymbol, false);
  });

  test("scatter plots the first value column against the second", () => {
    const option = build(chart("scatter"));
    assert.strictEqual(option.xAxis.name, "files");
    assert.strictEqual(option.yAxis.name, "lines");
    assert.deepStrictEqual(option.series[0].type, "scatter");
    assert.deepStrictEqual(option.series[0].data[0], { name: "ts", value: [10, 1200] });
    assert.strictEqual(summary(chart("scatter")), 'Charted "lines" against "files" by "language".');
  });

  test("scatter of numbers alone plots unnamed points", () => {
    const table = "x,y\n1,2\n3,";
    assert.deepStrictEqual(build(chart("scatter"), table).series[0].data, [[1, 2]]);
    assert.strictEqual(
      summary(chart("scatter"), table),
      'Charted "y" against "x"; left out 1 row without a value.',
    );
  });

  test("scatter needs two numeric columns", () => {
    assert.throws(() => build(chart("scatter", { valueColumns: ["files"] })), /two numeric/);
  });

  test("without text columns, rows are labeled by identifiers, years or their numbers", () => {
    const years = build(chart("bar"), "year,sales\n2023,5\n2024,7");
    assert.deepStrictEqual(years.xAxis.data, ["2023", "2024"]);
    assert.deepStrictEqual(seriesNames(years), ["sales"]);
    assert.deepStrictEqual(build(chart("pie"), "pid,rss\n812,5\n4242,7").series[0].data, [
      { name: "812", value: 5 },
      { name: "4242", value: 7 },
    ]);
    for (const data of ["[5, 3, 9]", "5\n3\n9", '{"values": [5, 3, 9]}']) {
      const option = build(chart("bar"), data);
      assert.deepStrictEqual(option.xAxis.data, ["1", "2", "3"], data);
      assert.deepStrictEqual(option.series[0].data, [5, 3, 9], data);
    }
    assert.deepStrictEqual(seriesNames(build(chart("line"), '{"a": [1, 2], "b": [3, 4]}')), [
      "a",
      "b",
    ]);
    assert.strictEqual(summary(chart("pie"), "[5, 3, 9]"), 'Charted "value" by row number.');
  });

  test("the label column defaults to a text column that names each row", () => {
    const ls = [
      "total 24",
      "-rw-r--r-- 1 fred staff 1234 Jan  1 12:00 a.txt",
      "-rw-r--r-- 1 fred staff   56 Jan  1 09:30 my notes.md",
      "drwxr-xr-x 3 fred staff 4096 Jan  3 10:15 src",
    ].join("\n");
    assert.deepStrictEqual(build(chart("bar"), ls).xAxis.data, ["a.txt", "my notes.md", "src"]);
    // Dates label the rows when nothing else does.
    const sales = "date,region,sales\n2024-01-01,north,3\n2024-01-02,north,5";
    assert.deepStrictEqual(build(chart("line"), sales).xAxis.data, ["2024-01-01", "2024-01-02"]);
  });

  test("default value columns have the unit of the first", () => {
    const ps = [
      "USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND",
      "root         1  0.0  0.1 167744 11764 ?        Ss   09:12   0:02 /sbin/init splash",
      "root       812  0.0  0.0  23456  5432 ?        Ss   09:12   0:00 /usr/sbin/cron -f",
      "fred      4242  3.5  1.2 912345 98765 pts/0    Sl+  10:01   1:23 code --wait",
    ].join("\n");
    const option = build(chart("bar"), ps);
    assert.deepStrictEqual(seriesNames(option), ["%CPU", "%MEM"]);
    assert.deepStrictEqual(option.xAxis.data, [
      "/sbin/init splash",
      "/usr/sbin/cron -f",
      "code --wait",
    ]);
  });

  test("sizes in bytes are shown in a unit that suits them", () => {
    const df = [
      "Filesystem      Size  Used Avail Use% Mounted on",
      "/dev/nvme0n1p2  468G  300G  145G  68% /",
      "tmpfs           7.8G   12M  7.8G   1% /dev/shm",
      "tmpfs           1.6G     0  1.6G   0% /run",
    ].join("\n");
    const option = build(chart("bar"), df);
    assert.deepStrictEqual(seriesNames(option), ["Size (GiB)", "Used (GiB)", "Avail (GiB)"]);
    assert.deepStrictEqual(option.xAxis.data, ["/", "/dev/shm", "/run"]);
    assert.deepStrictEqual(option.series[1].data, [300, 0.01, 0]);
    assert.strictEqual(
      summary(chart("bar"), df),
      'Charted "Size (GiB)", "Used (GiB)", "Avail (GiB)" by "Mounted on"; showed sizes in GiB.',
    );
    const du = build(chart("bar", { valueColumns: ["Column 1"] }), "1.5K\ta\n512\tb");
    assert.strictEqual(du.series[0].data[0], 1.5);
  });

  test("charts leave out a totals row", () => {
    const wc = "  12 a.ts\n 345 b.ts\n   3 c.ts\n 360 total";
    for (const type of ["pie", "bar", "line", "horizontalBar"] as const) {
      const option = build(chart(type, { sort: "descending" }), wc);
      const names =
        type === "pie"
          ? option.series[0].data.map((item: Option) => item.name)
          : (option.yAxis.data ?? option.xAxis.data);
      assert.deepStrictEqual(names, ["b.ts", "a.ts", "c.ts"], type);
    }
    assert.strictEqual(
      summary(chart("bar"), wc),
      'Charted "Column 1" by "Column 2"; left out the last row, "total", a total of the others.',
    );
    const cloc = "language,files,code\nTypeScript,10,1200\nCSS,2,300\nSUM:,12,1500";
    assert.deepStrictEqual(build(chart("stackedBar"), cloc).xAxis.data, ["TypeScript", "CSS"]);
    assert.strictEqual(build(chart("scatter"), cloc).series[0].data.length, 2);
    // Within 1%.
    assert.deepStrictEqual(build(chart("bar"), "a,b\nx,50\ny,50.5\n Total ,100").xAxis.data, [
      "x",
      "y",
    ]);
    // Not a total of the others, or too few others: kept.
    for (const table of ["k,n\na,1\nb,2\ntotal,4", "k,n\na,1\ntotal,1"]) {
      assert.ok(build(chart("bar"), table).xAxis.data.includes("total"), table);
    }
  });

  test("default value columns skip identifier columns", () => {
    const table = "id,name,score\n7,a,10\n3,b,20";
    assert.deepStrictEqual(seriesNames(build(chart("bar"), table)), ["score"]);
    assert.strictEqual(build(chart("pie"), table).series[0].name, "score");
    for (const name of ["ID", "#", "user_id", "Rank", "PID", "userId"]) {
      const option = build(chart("bar"), table.replace("id", name));
      assert.deepStrictEqual(seriesNames(option), ["score"], name);
    }
    // A column numbering the rows 1, 2, 3, … is skipped when there are other numeric columns.
    assert.deepStrictEqual(
      seriesNames(build(chart("bar"), "n,name,score\n1,a,10\n2,b,20\n3,c,30")),
      ["score"],
    );
    // Kept when it is the only numeric column, or asked for.
    assert.strictEqual(build(chart("pie"), "name,id\na,1\nb,2\nc,3").series[0].name, "id");
    assert.deepStrictEqual(
      seriesNames(build(chart("bar", { valueColumns: ["id", "score"] }), table)),
      ["id", "score"],
    );
    // "paid" is not an identifier name.
    assert.deepStrictEqual(seriesNames(build(chart("bar"), "name,paid,score\na,7,10\nb,3,20")), [
      "paid",
      "score",
    ]);
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
    assert.throws(() => build(chart("bar"), "a,b\nx,y"), /No column holds numbers/);
    assert.throws(
      () => build(chart("bar", { valueColumns: ["Column 2"] }), "a,b\nx,y"),
      /holds no numbers/,
    );
  });

  test("describeTable summarizes columns and the first rows", () => {
    const table = parseTable(
      [
        "dir,size,share,note",
        "a,1K,1%,",
        "b,2,2%,",
        "c,3,3%,",
        "d,4,4%,",
        "e,5,5%,",
        "f,6,6%,",
      ].join("\n"),
    );
    assert.strictEqual(
      describeTable(table),
      [
        '6 rows; columns: "dir" (text), "size" (bytes), "share" (percentages), "note" (empty)',
        "First 5 rows:",
        '["a",1024,1,null]',
        '["b",2,2,null]',
        '["c",3,3,null]',
        '["d",4,4,null]',
        '["e",5,5,null]',
      ].join("\n"),
    );
    assert.strictEqual(
      describeTable(parseTable("x\n1")),
      '1 row; columns: "x" (numbers)\nRows:\n[1]',
    );
  });

  test("describeTable points out text cells in numeric columns", () => {
    assert.match(
      describeTable(parseTable("size,file\n1,a\n1;5X,b\n3,c")),
      /"size" \(numbers, 1 text cell: "1;5X"\), "file" \(text\)/,
    );
    assert.match(
      describeTable(parseTable("n\n1\n2\n3\n4\n5\na\nb\nc\nd")),
      /"n" \(numbers, 4 text cells: "a", "b", "c", …\)/,
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

  test("dataOrigin says where the data comes from", () => {
    assert.strictEqual(dataOrigin(chart("pie", { data: "a 1" })), "inline data");
    assert.strictEqual(dataOrigin({ type: "pie", file: "sales.csv" }), "file sales.csv");
    assert.strictEqual(dataOrigin({ type: "pie", command: "du -s *" }), "command `du -s *`");
  });

  test("validateChartSpec accepts a valid spec", () => {
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
    assert.throws(() => validateChartSpec("[1"), /must be an object/);
    assert.throws(() => validateChartSpec(null), /must be an object/);
  });
});
