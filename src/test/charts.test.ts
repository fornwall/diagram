import * as assert from "node:assert";
import { time as echartsTime, init as initECharts } from "echarts";
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
import { newPanel } from "./newPanel";

const LANGUAGES = parseTable(
  ["language,files,lines", "ts,10,1200", "css,3,300", "md,5,150", "json,2,80"].join("\n"),
);

function chart(
  type: ChartType,
  extra: Partial<Omit<ChartSpec, "data" | "file" | "command">> = {},
): ChartSpec {
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
    assert.strictEqual(
      summary(chart("pie", { valueColumns: ["lines", "files"] })),
      'Charted "lines" by "language"; left out "files", as a pie chart shows one value column.',
    );
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
      'Charted "files" by "language"; kept the first 2 rows and summed up the other 2 as "Other".',
    );
  });

  test("pie sums up a row named Other with the rest", () => {
    const spec = chart("pie", { limit: 2 });
    assert.deepStrictEqual(build(spec, "k,n\nOther,4\na,3\nb,2\nc,1").series[0].data, [
      { name: "a", value: 3 },
      { name: "b", value: 2 },
      { name: "Other", value: 5 },
    ]);
  });

  test("pie leaves out rows without a positive value before limiting", () => {
    const table = "k,n\na,3\nb,-2\nc,0\nd,\ne,2\nf,1\ng,1";
    const spec = chart("pie", { limit: 2 });
    assert.deepStrictEqual(build(spec, table).series[0].data, [
      { name: "a", value: 3 },
      { name: "e", value: 2 },
      { name: "Other", value: 2 },
    ]);
    assert.strictEqual(
      summary(spec, table),
      'Charted "n" by "k"; left out 3 rows without a positive value; ' +
        'kept the first 2 rows and summed up the other 2 as "Other".',
    );
    assert.throws(() => build(chart("pie"), "k,n\na,-1\nb,0"), /needs positive numbers/);
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

  test("with negative values, the category axis is at the edge rather than at zero", () => {
    assert.strictEqual(build(chart("bar")).xAxis.axisLine, undefined);
    const balance = "month,balance\njan,5\nfeb,-3";
    assert.deepStrictEqual(build(chart("bar"), balance).xAxis.axisLine, { onZero: false });
    assert.deepStrictEqual(build(chart("horizontalBar"), balance).yAxis.axisLine, {
      onZero: false,
    });
  });

  test("stackedBar stacks its series", () => {
    const option = build(chart("stackedBar"));
    assert.ok(option.series.every((s: Option) => s.type === "bar" && s.stack === "total"));
  });

  test("line and area are lines, area with an area style", () => {
    // Only a line's value axis need not start at zero.
    assert.strictEqual(build(chart("line")).yAxis.scale, true);
    assert.strictEqual(build(chart("area")).yAxis.scale, undefined);
    assert.strictEqual(build(chart("bar")).yAxis.scale, undefined);
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
      'Charted "y" against "x"; left out 1 row without both an x and a y value.',
    );
    assert.throws(() => build(chart("scatter"), "x,y\n1,\n,2"), /No row has numbers in both/);
  });

  test("scatter plots columns that bar charts leave out by default against each other", () => {
    // A column numbering the rows is a likely x, and x and y often have different units.
    assert.strictEqual(
      summary(chart("scatter"), "size,ms\n1,0.5\n2,0.9\n3,1.4"),
      'Charted "ms" against "size".',
    );
    assert.strictEqual(
      summary(chart("scatter"), "file,size,lines\na,10K,100\nb,20K,300"),
      'Charted "lines" against "size (KiB)" by "file"; showed sizes in KiB.',
    );
  });

  test("scatter needs two numeric columns", () => {
    assert.throws(() => build(chart("scatter", { valueColumns: ["files"] })), /two numeric/);
  });

  test("stackedArea stacks its areas", () => {
    const option = build(chart("stackedArea"));
    assert.strictEqual(option.xAxis.boundaryGap, false);
    // Areas show amounts by their length, which needs a value axis from zero.
    assert.strictEqual(option.yAxis.scale, undefined);
    assert.ok(
      option.series.every((s: Option) => s.type === "line" && s.stack === "total" && s.areaStyle),
    );
  });

  const DU = [
    "4.0K\tsrc/webview/colors.ts",
    "12K\tsrc/webview/main.ts",
    "20K\tsrc/webview",
    "8.0K\tsrc/charts.ts",
    "28K\tsrc",
  ].join("\n");

  test("treemap splits path-like labels into levels and sums them up", () => {
    const [series] = build(chart("treemap"), DU).series;
    assert.strictEqual(series.type, "treemap");
    assert.strictEqual(series.name, "Column 1 (KiB)");
    // The directory rows total their files, and the one root holds every row.
    assert.deepStrictEqual(series.data, [
      {
        name: "webview",
        value: 16,
        children: [
          { name: "colors.ts", value: 4 },
          { name: "main.ts", value: 12 },
        ],
      },
      { name: "charts.ts", value: 8 },
    ]);
    assert.strictEqual(
      summary(chart("treemap"), DU),
      'Charted "Column 1 (KiB)" by the levels of "Column 2"; split "Column 2" on "/" into ' +
        "levels; left out 2 rows that other rows nest under, as the values of their children " +
        "total them; showed sizes in KiB; nested the rows 2 levels deep; showed what is inside " +
        '"src", which holds every row.',
    );
    // The sort and the limit then apply to the rows that have a value of their own, which keep
    // the levels they are nested in.
    const biggest = build(chart("treemap", { sort: "descending", limit: 2 }), DU);
    assert.deepStrictEqual(biggest.series[0].data, [
      { name: "webview", value: 12, children: [{ name: "main.ts", value: 12 }] },
      { name: "charts.ts", value: 8 },
    ]);
  });

  test("treemap and sunburst read several label columns as levels", () => {
    const sales = "region,country,sales\nEurope,Sweden,5\nEurope,Norway,3\nAsia,Japan,9";
    const option = build(chart("sunburst"), sales);
    assert.strictEqual(option.series[0].type, "sunburst");
    assert.deepStrictEqual(option.series[0].data, [
      {
        name: "Europe",
        value: 8,
        children: [
          { name: "Sweden", value: 5 },
          { name: "Norway", value: 3 },
        ],
      },
      { name: "Asia", value: 9, children: [{ name: "Japan", value: 9 }] },
    ]);
    assert.strictEqual(
      summary(chart("treemap"), sales),
      'Charted "sales" by the levels of "region", "country"; nested the rows 2 levels deep.',
    );
    // One label column asked for is one level, as labels without a path are.
    const flat = build(chart("treemap", { labelColumn: "country" }), sales);
    assert.deepStrictEqual(flat.series[0].data, [
      { name: "Sweden", value: 5 },
      { name: "Norway", value: 3 },
      { name: "Japan", value: 9 },
    ]);
    assert.strictEqual(summary(chart("treemap"), LANGUAGES), 'Charted "files" by "language".');
  });

  test("a hierarchy leaves out rows without a positive value", () => {
    assert.strictEqual(
      summary(chart("sunburst"), "k,n\na,3\nb,-1"),
      'Charted "n" by "k"; left out 1 row without a positive value.',
    );
    assert.throws(() => build(chart("treemap"), "k,n\na,0\nb,-1"), /treemap chart needs positive/);
  });

  test("sankey flows from a source column to a target column", () => {
    const flows = "from,to,n\na,b,3\nb,c,1\na,c,2";
    const [series] = build(chart("sankey"), flows).series;
    assert.strictEqual(series.type, "sankey");
    assert.strictEqual(series.name, "n");
    assert.deepStrictEqual(series.data, [{ name: "a" }, { name: "b" }, { name: "c" }]);
    assert.deepStrictEqual(series.links, [
      { source: "a", target: "b", value: 3 },
      { source: "a", target: "c", value: 2 },
      { source: "b", target: "c", value: 1 },
    ]);
    assert.strictEqual(
      summary(chart("sankey"), flows),
      'Charted "n" as flows from "from" to "to".',
    );
  });

  test("sankey flows through several stages and the levels of a path", () => {
    const stages = "a,b,c,n\nx,y,z,3\nx,y,w,2";
    assert.deepStrictEqual(build(chart("sankey"), stages).series[0].links, [
      // The flows of rows that share a source and a target are summed up.
      { source: "x", target: "y", value: 5 },
      { source: "y", target: "z", value: 3 },
      { source: "y", target: "w", value: 2 },
    ]);
    assert.strictEqual(
      summary(chart("sankey"), stages),
      'Charted "n" as flows from "a" to "b" to "c".',
    );
    assert.deepStrictEqual(build(chart("sankey"), "a,b,c,n\nx,y,z,3\nw,y,z,2").series[0].links, [
      { source: "x", target: "y", value: 3 },
      { source: "y", target: "z", value: 5 },
      { source: "w", target: "y", value: 2 },
    ]);
    assert.deepStrictEqual(build(chart("sankey"), DU).series[0].links, [
      { source: "src", target: "webview", value: 16 },
      { source: "webview", target: "colors.ts", value: 4 },
      { source: "webview", target: "main.ts", value: 12 },
      { source: "src", target: "charts.ts", value: 8 },
    ]);
    assert.match(summary(chart("sankey"), DU), /as flows between the levels of "Column 2"/);
  });

  test("sankey flows from one label column to a node per value column", () => {
    const budget = "department,salaries,equipment\nops,50,10\ndev,80,20";
    const [series] = build(chart("sankey"), budget).series;
    assert.deepStrictEqual(series.links, [
      { source: "ops", target: "salaries", value: 50 },
      { source: "ops", target: "equipment", value: 10 },
      { source: "dev", target: "salaries", value: 80 },
      { source: "dev", target: "equipment", value: 20 },
    ]);
    // The value columns are the nodes the flows run into, so none of them names the series.
    assert.strictEqual(series.name, undefined);
    assert.strictEqual(
      summary(chart("sankey"), budget),
      'Charted "salaries", "equipment" as flows from "department" to a node per value column.',
    );
    assert.match(
      summary(chart("sankey"), "k,x,y\na,-1,3\nb,2,-4"),
      /left out 2 flows without a positive value/,
    );
  });

  test("sankey says what it cannot draw", () => {
    assert.throws(
      () => build(chart("sankey"), "from,to,n\na,b,3\nb,a,1"),
      /come back around: "a" -> "b" -> "a"/,
    );
    assert.match(
      summary(chart("sankey"), "from,to,n\na,a,3\na,b,1\nb,c,2"),
      /left out 1 flow from a node to itself/,
    );
    assert.throws(
      () => build(chart("sankey"), "dir,size\nsrc/,10\ndist/,20"),
      /needs flows between two nodes, but every row holds one level only/,
    );
    assert.throws(
      () => build(chart("sankey"), "[5, 3, 9]"),
      /nodes its flows run between to be named[\s\S]*Available columns: "value"/,
    );
  });

  test("heatmap pivots two label columns, with a visual map of the range", () => {
    const sales = "region,month,sales\nEU,jan,1\nEU,feb,3\nUS,jan,4";
    const option = build(chart("heatmap"), sales);
    assert.deepStrictEqual(option.xAxis.data, ["jan", "feb"]);
    assert.strictEqual(option.xAxis.name, "month");
    assert.deepStrictEqual(option.yAxis.data, ["EU", "US"]);
    assert.strictEqual(option.yAxis.name, "region");
    // The first row at the top, as in a table.
    assert.strictEqual(option.yAxis.inverse, true);
    assert.deepStrictEqual(option.visualMap, { min: 1, max: 4, calculable: true });
    const [series] = option.series;
    assert.strictEqual(series.type, "heatmap");
    assert.strictEqual(series.name, "sales");
    assert.deepStrictEqual(series.data, [
      [0, 0, 1],
      [1, 0, 3],
      [0, 1, 4],
    ]);
    assert.strictEqual(
      summary(chart("heatmap"), sales),
      'Charted "sales" by "region" (rows) and "month" (columns).',
    );
    // Rows that share a row and a column are summed up into one cell.
    const twice = `${sales}\nEU,jan,2`;
    assert.strictEqual(build(chart("heatmap"), twice).series[0].data[0][2], 3);
    assert.match(summary(chart("heatmap"), twice), /summed up 1 row into cells that had a value/);
  });

  test("heatmap of a numeric matrix uses the value columns as its columns", () => {
    const option = build(chart("heatmap"));
    assert.deepStrictEqual(option.xAxis.data, ["files", "lines"]);
    // The columns are named by the value columns, not by a label column.
    assert.strictEqual(option.xAxis.name, undefined);
    assert.deepStrictEqual(option.yAxis.data, ["ts", "css", "md", "json"]);
    assert.strictEqual(option.yAxis.name, "language");
    assert.deepStrictEqual(option.series[0].data.slice(0, 2), [
      [0, 0, 10],
      [1, 0, 1200],
    ]);
    assert.strictEqual(
      summary(chart("heatmap")),
      'Charted "files", "lines" (columns) by "language" (rows).',
    );
    assert.match(
      summary(chart("heatmap"), "k,x,y\na,1,\nb,,2"),
      /left out 2 cells without a value/,
    );
  });

  test("radar draws an axis per value column and a shape per row", () => {
    const option = build(chart("radar"));
    assert.deepStrictEqual(option.radar.indicator, [
      { name: "files", max: 10 },
      { name: "lines", max: 1200 },
    ]);
    // A radar's legend names its shapes, which are data items rather than series.
    assert.deepStrictEqual(option.legend.data, ["ts", "css", "md", "json"]);
    assert.strictEqual(option.series[0].type, "radar");
    assert.deepStrictEqual(option.series[0].data[0], { name: "ts", value: [10, 1200] });
    assert.strictEqual(
      summary(chart("radar")),
      'Charted "files", "lines" on an axis each by "language".',
    );
    assert.deepStrictEqual(build(chart("radar", { max: 100 })).radar.indicator, [
      { name: "files", max: 100 },
      { name: "lines", max: 100 },
    ]);
    // One shape needs no legend, and a negative value an axis that reaches below zero.
    const negative = build(chart("radar"), "k,x,y\na,-1,3");
    assert.strictEqual(negative.legend, undefined);
    assert.deepStrictEqual(negative.radar.indicator, [
      { name: "x", max: 0, min: -1 },
      { name: "y", max: 3 },
    ]);
    assert.throws(() => build(chart("radar"), "k,n\na,1\nb,2"), /needs two numeric columns, one/);
  });

  test("boxplot computes the five numbers of each group", () => {
    const times = "test,ms\na,10\na,12\na,14\na,40\nb,5\nb,6\nb,7";
    const option = build(chart("boxplot"), times);
    assert.deepStrictEqual(option.xAxis.data, ["a", "b"]);
    assert.strictEqual(option.yAxis.name, "ms");
    // A spread reads against itself rather than against zero.
    assert.strictEqual(option.yAxis.scale, true);
    assert.strictEqual(option.series[0].type, "boxplot");
    assert.strictEqual(option.series[0].name, "ms");
    // Min, lower quartile, median, upper quartile and max, interpolated between the values.
    assert.deepStrictEqual(option.series[0].data, [
      [10, 11.5, 13, 20.5, 40],
      [5, 5.5, 6, 6.5, 7],
    ]);
    assert.strictEqual(
      summary(chart("boxplot"), times),
      'Charted the spread of "ms" by "test"; computed the min, lower quartile, median, upper ' +
        "quartile and max of 2 boxes from 7 values.",
    );
  });

  test("boxplot without a label column draws a box per value column", () => {
    const measurements = "before,after\n5,10\n3,20\n9,30";
    const option = build(chart("boxplot"), measurements);
    assert.deepStrictEqual(option.xAxis.data, ["before", "after"]);
    assert.strictEqual(option.yAxis.name, undefined);
    assert.deepStrictEqual(option.series[0].data, [
      [3, 4, 5, 7, 9],
      [10, 15, 20, 25, 30],
    ]);
    assert.strictEqual(
      summary(chart("boxplot"), measurements),
      'Charted the spread of "before", "after"; computed the min, lower quartile, median, upper ' +
        "quartile and max of 2 boxes from 6 values.",
    );
  });

  test("gauge shows one value and infers the top of its scale", () => {
    const [series] = build(chart("gauge")).series;
    assert.strictEqual(series.type, "gauge");
    assert.strictEqual(series.name, "files");
    assert.strictEqual(series.max, 20);
    assert.deepStrictEqual(series.data, [{ name: "ts", value: 10 }]);
    assert.strictEqual(
      summary(chart("gauge")),
      'Charted "files" by "language"; showed the first of 4 rows, "ts"; scaled it to 20, the ' +
        'total of "files".',
    );
    // Percentages fill a scale to 100, a lone value a round number above it, and "max" wins.
    const coverage = build(chart("gauge"), "metric,share\ncoverage,87%");
    assert.strictEqual(coverage.series[0].max, 100);
    assert.deepStrictEqual(coverage.series[0].detail, { formatter: "{value}%" });
    assert.strictEqual(build(chart("gauge"), "metric,n\nlatency,12").series[0].max, 20);
    assert.strictEqual(
      build(chart("gauge", { max: 50 }), "metric,n\nlatency,12").series[0].max,
      50,
    );
    const balance = "month,balance\njan,-3";
    assert.strictEqual(build(chart("gauge"), balance).series[0].min, -3);
    assert.match(summary(chart("gauge"), balance), /scaled it from -3 to 1, rounded up/);
  });

  test("funnel orders its stages by value", () => {
    const stages = "stage,n\nvisit,100\ncart,40\nbuy,10";
    const [series] = build(chart("funnel"), stages).series;
    assert.strictEqual(series.type, "funnel");
    assert.strictEqual(series.sort, "descending");
    assert.deepStrictEqual(series.data, [
      { name: "visit", value: 100 },
      { name: "cart", value: 40 },
      { name: "buy", value: 10 },
    ]);
    assert.strictEqual(
      summary(chart("funnel"), stages),
      'Charted "n" by "stage"; ordered the stages by value, the largest first.',
    );
    // An order that was asked for is the one ECharts draws.
    const ascending = build(chart("funnel", { sort: "ascending" }), stages);
    assert.strictEqual(ascending.series[0].sort, "ascending");
    assert.throws(() => build(chart("funnel"), "k,n\na,0"), /funnel chart needs positive numbers/);
  });

  test("label columns are matched loosely, and the extra ones are left out", () => {
    const sales = "region,country,sales\nEU,SE,5\nAS,JP,9";
    const option = build(chart("sankey", { labelColumn: [" REGION ", "country"] }), sales);
    assert.deepStrictEqual(option.series[0].links, [
      { source: "EU", target: "SE", value: 5 },
      { source: "AS", target: "JP", value: 9 },
    ]);
    assert.throws(
      () => build(chart("sankey", { labelColumn: ["region", "nation"] }), sales),
      /Unknown label column "nation"\. Available columns: "region", "country", "sales"/,
    );
    assert.match(
      summary(chart("heatmap", { labelColumn: ["region", "country", "sales"] }), sales),
      /left out "sales", as a heatmap chart reads two label columns/,
    );
    assert.match(
      summary(chart("pie", { labelColumn: ["language", "files"] })),
      /left out "files", as a pie chart reads one label column/,
    );
  });

  const AMOUNTS = "region,amount\nEU,5\nUS,3\nEU,7\nAS,1\nUS,9";

  test("aggregate collapses the rows that share a label", () => {
    const combined = (how: ChartSpec["aggregate"]) =>
      build(chart("bar", { aggregate: how }), AMOUNTS).series[0].data;
    assert.deepStrictEqual(build(chart("bar", { aggregate: "sum" }), AMOUNTS).xAxis.data, [
      "EU",
      "US",
      "AS",
    ]);
    assert.deepStrictEqual(combined("sum"), [12, 12, 1]);
    assert.deepStrictEqual(combined("mean"), [6, 6, 1]);
    assert.deepStrictEqual(combined("min"), [5, 3, 1]);
    assert.deepStrictEqual(combined("max"), [7, 9, 1]);
    assert.deepStrictEqual(combined("count"), [2, 2, 1]);
    // The median interpolates between the sorted values, as a box plot's quartiles do.
    assert.deepStrictEqual(
      build(chart("bar", { aggregate: "median" }), "k,n\na,1\na,2\na,6\nb,5").series[0].data,
      [2, 5],
    );
    assert.strictEqual(
      summary(chart("bar", { aggregate: "mean" }), AMOUNTS),
      'Charted "amount" by "region"; grouped 5 rows into 3 by "region", averaging their values.',
    );
    // Empty cells are not averaged in, and a group without numbers has no value.
    assert.deepStrictEqual(
      build(chart("bar", { aggregate: "mean" }), "k,n\na,2\na,\nb,").series[0].data,
      [2, null],
    );
  });

  test("min and max aggregate large groups without overflowing the call stack", () => {
    const table: DataTable = {
      header: true,
      columns: [
        { name: "group", numeric: false },
        { name: "value", numeric: true },
      ],
      rows: Array.from({ length: 150_000 }, (_, i) => ["a", i - 75_000]),
    };
    assert.deepStrictEqual(
      build(chart("bar", { aggregate: "min" }), table).series[0].data,
      [-75_000],
    );
    assert.deepStrictEqual(
      build(chart("bar", { aggregate: "max" }), table).series[0].data,
      [74_999],
    );
  });

  test("grouped columns skip missing observations but count every row", () => {
    const data = "group,x,y\na,-3,\na,,8\na,9,4\nb,,\nc,0,-2";
    const expected = {
      sum: [
        [6, null, 0],
        [12, null, -2],
      ],
      mean: [
        [3, null, 0],
        [6, null, -2],
      ],
      min: [
        [-3, null, 0],
        [4, null, -2],
      ],
      max: [
        [9, null, 0],
        [8, null, -2],
      ],
      median: [
        [3, null, 0],
        [6, null, -2],
      ],
      count: [[3, 1, 1]],
    };
    for (const aggregate of ["sum", "mean", "min", "max", "median", "count"] as const) {
      const option = build(chart("bar", { aggregate, valueColumns: ["x", "y"] }), data);
      assert.deepStrictEqual(option.xAxis.data, ["a", "b", "c"]);
      assert.deepStrictEqual(
        option.series.map((series: Option) => series.data),
        expected[aggregate],
      );
    }
  });

  test("group and flow keys preserve control characters in labels", () => {
    const data = JSON.stringify([
      { from: "a\u0000b", to: "c", n: 2 },
      { from: "a", to: "b\u0000c", n: 4 },
    ]);
    const heatmap = build(chart("heatmap", { aggregate: "sum" }), data);
    assert.deepStrictEqual(heatmap.series[0].data, [
      [0, 0, 2],
      [1, 1, 4],
    ]);
    assert.deepStrictEqual(build(chart("sankey"), data).series[0].links, [
      { source: "a\u0000b", target: "c", value: 2 },
      { source: "a", target: "b\u0000c", value: 4 },
    ]);
  });

  test("count needs no value column, and counts rows before sorting and limiting", () => {
    const authors = "alice\nbob\nalice\ncarol\nalice\nbob";
    const spec = chart("bar", { aggregate: "count", sort: "descending", limit: 2 });
    const option = build(spec, authors);
    assert.deepStrictEqual(option.xAxis.data, ["alice", "bob"]);
    assert.strictEqual(option.series[0].name, "rows");
    assert.deepStrictEqual(option.series[0].data, [3, 2]);
    assert.strictEqual(
      summary(spec, authors),
      'Charted "rows" by "Column 1"; grouped 6 rows into 3 by "Column 1", counting the rows of ' +
        "each group; kept the first 2 of 3 rows.",
    );
    // A pie sums up the groups it has no room for, not the rows.
    const pie = chart("pie", { aggregate: "count", sort: "descending", limit: 2 });
    assert.deepStrictEqual(build(pie, authors).series[0].data, [
      { name: "alice", value: 3 },
      { name: "bob", value: 2 },
      { name: "Other", value: 1 },
    ]);
    // Value columns are left out, as counting does not read them.
    assert.match(
      summary(chart("bar", { aggregate: "count", valueColumns: ["amount"] }), AMOUNTS),
      /left out "amount", as "count" counts the rows of a group/,
    );
  });

  test("aggregate groups the levels, flows and cells of the other families", () => {
    // A heatmap, a sankey and a hierarchy sum up what shares a cell, a pair or a path anyway, so
    // grouping them is how to combine those rows another way.
    const cells = "region,month,n\nEU,jan,1\nEU,jan,3\nUS,jan,4";
    const mean = build(chart("heatmap", { aggregate: "mean" }), cells);
    assert.deepStrictEqual(mean.series[0].data, [
      [0, 0, 2],
      [0, 1, 4],
    ]);
    assert.strictEqual(
      summary(chart("heatmap", { aggregate: "mean" }), cells),
      'Charted "n" by "region" (rows) and "month" (columns); grouped 3 rows into 2 by "region", ' +
        '"month", averaging their values.',
    );
    const flows = "from,to,n\na,b,2\na,b,4\nb,c,9";
    assert.deepStrictEqual(build(chart("sankey", { aggregate: "mean" }), flows).series[0].links, [
      { source: "a", target: "b", value: 3 },
      { source: "b", target: "c", value: 9 },
    ]);
    // Counting the rows of a path gives a treemap of how many files each level holds.
    const files = "path\nsrc/a.ts\nsrc/b.ts\ndist/c.js";
    assert.deepStrictEqual(
      build(chart("treemap", { aggregate: "count" }), files).series[0].data.slice(-2),
      [
        {
          name: "src",
          value: 2,
          children: [
            { name: "a.ts", value: 1 },
            { name: "b.ts", value: 1 },
          ],
        },
        { name: "dist", value: 1, children: [{ name: "c.js", value: 1 }] },
      ],
    );
  });

  test("aggregate says where it cannot be used", () => {
    assert.throws(
      () => build(chart("boxplot", { aggregate: "mean" }), AMOUNTS),
      /A box plot summarizes the raw rows of each group itself/,
    );
    for (const type of ["scatter", "radar"] as const) {
      assert.throws(
        () => build(chart(type, { aggregate: "count" }), AMOUNTS),
        /needs two value columns, but "aggregate": "count" gives one count per group/,
        type,
      );
    }
  });

  test("a label column of dates becomes a time axis", () => {
    const daily = "date,sales\n2026-01-02,3\n2026-01-05,5";
    const option = build(chart("line"), daily);
    assert.strictEqual(option.xAxis.type, "time");
    // A time axis needs each point as a pair, and has no categories of its own.
    assert.strictEqual(option.xAxis.data, undefined);
    assert.strictEqual(option.xAxis.boundaryGap, undefined);
    assert.deepStrictEqual(option.series[0].data, [
      ["2026-01-02", 3],
      ["2026-01-05", 5],
    ]);
    assert.strictEqual(
      summary(chart("line"), daily),
      'Charted "sales" by "date"; read "date" as ISO dates on a time axis; {"xAxis": {"type": ' +
        '"category"}} in "options" reads them as labels instead.',
    );
    // The time axis of a horizontal bar chart is its y axis, still with the first row at the top.
    const horizontal = build(chart("horizontalBar"), daily);
    assert.strictEqual(horizontal.xAxis.type, "value");
    assert.deepStrictEqual(horizontal.yAxis, { type: "time", inverse: true });
    assert.deepStrictEqual(horizontal.series[0].data, [
      [3, "2026-01-02"],
      [5, "2026-01-05"],
    ]);
    assert.match(
      summary(chart("horizontalBar"), daily),
      /\{"yAxis": \{"type": "category"\}\} in "options"/,
    );
    // The escape hatch reads them as labels again.
    const categories = build(chart("line", { options: { xAxis: { type: "category" } } }), daily);
    assert.strictEqual(categories.xAxis.type, "category");
  });

  test("only unmistakable date shapes are read as times", () => {
    const times = (data: string) => build(chart("line"), data).xAxis;
    for (const [dates, format] of [
      ["2026-01-02\n2026-01-05", "ISO dates"],
      ["2026-01-02T14:30:00Z\n2026-01-02T15:00:00+02:00", "ISO date-times"],
      ["2026-01-02 14:30\n2026-01-02 15:00:30.5", "ISO date-times"],
      ["2026-01\n2026-02", "ISO months"],
      ["2026/01/02\n2026/01/05", "dates written YYYY/MM/DD"],
      ["2024-02-29\n2000-02-29", "ISO dates"],
    ] as const) {
      const data = `date,n\n${dates.split("\n")[0]},3\n${dates.split("\n")[1]},5`;
      assert.strictEqual(times(data).type, "time", dates);
      assert.match(summary(chart("line"), data), new RegExp(`as ${format} on a time axis`), dates);
    }
    // Ambiguous or invalid dates, years and mixed shapes stay labels, with nothing said about them.
    for (const dates of [
      ["01/02/2026", "01/03/2026"],
      ["2026-13-01", "2026-13-02"],
      ["2026-01-32", "2026-01-33"],
      ["2026-02-28", "2026-02-29"],
      ["1900-02-28", "1900-02-29"],
      ["2026-04-30", "2026-04-31"],
      ["2026/02/28", "2026/02/31"],
      ["2026-02-28T12:00Z", "2026-02-31T12:00Z"],
      ["2026-01-02", "2026-01-02T10:00:00Z"],
      ["Jan 2", "Jan 5"],
    ]) {
      const data = `date,n\n${dates[0]},3\n${dates[1]},5`;
      assert.strictEqual(times(data).type, "category", String(dates));
      assert.strictEqual(summary(chart("line"), data), 'Charted "n" by "date".', String(dates));
    }
    // A column of years is a set of categories, as it is everywhere else in the tool.
    const years = build(chart("line"), "year,sales\n2023,5\n2024,7");
    assert.strictEqual(years.xAxis.type, "category");
    assert.deepStrictEqual(years.xAxis.data, ["2023", "2024"]);
  });

  test("time axes preserve offset minutes and fractional seconds", () => {
    const timestamps = [
      "2026-01-02T14:30:00+05:30",
      "2026-01-02T14:30:00-03:30",
      "2026-01-02 14:30:00+0545",
      "2026-01-02T14:30:00.5Z",
      "2026-01-02T14:30:00.05Z",
      "2026-01-02T14:30:00.123456789Z",
      "0099-01-02T14:30:00Z",
    ];
    const expected = [
      Date.UTC(2026, 0, 2, 9),
      Date.UTC(2026, 0, 2, 18),
      Date.UTC(2026, 0, 2, 8, 45),
      Date.UTC(2026, 0, 2, 14, 30, 0, 500),
      Date.UTC(2026, 0, 2, 14, 30, 0, 50),
      Date.UTC(2026, 0, 2, 14, 30, 0, 123),
      -59042856600000,
    ];
    const data = `date,n\n${timestamps.map((date) => `${date},3`).join("\n")}`;
    for (const type of ["line", "bar", "horizontalBar", "scatter"] as const) {
      const points: (string | number)[][] = build(chart(type), data).series[0].data;
      assert.deepStrictEqual(
        points.map((point) => +echartsTime.parse(point[type === "horizontalBar" ? 1 : 0])),
        expected,
        type,
      );
    }
  });

  test("unzoned times stay local and pad fractional seconds for ECharts", () => {
    const data = "date,n\n2026-01-02 14:30:00.5,3\n2026-01-02T14:30:00.05,5";
    const points: (string | number)[][] = build(chart("line"), data).series[0].data;
    assert.deepStrictEqual(points, [
      ["2026-01-02 14:30:00.500", 3],
      ["2026-01-02T14:30:00.050", 5],
    ]);
    assert.deepStrictEqual(
      points.map((point) => +echartsTime.parse(point[0])),
      [+new Date(2026, 0, 2, 14, 30, 0, 500), +new Date(2026, 0, 2, 14, 30, 0, 50)],
    );
  });

  test("category axis overrides retain original timestamp labels", () => {
    const dates = ["2026-01-02T14:30:00+05:30", "2026-01-02T14:30:00.5Z"];
    const data = `date,n\n${dates.map((date) => `${date},3`).join("\n")}`;
    for (const type of ["line", "horizontalBar", "scatter"] as const) {
      const axis = type === "horizontalBar" ? "yAxis" : "xAxis";
      for (const override of [{ type: "category" }, [{ type: "category" }]]) {
        const option = build(chart(type, { options: { [axis]: override } }), data);
        assert.deepStrictEqual(
          option.series[0].data,
          dates.map((date) => (type === "horizontalBar" ? [3, date] : [date, 3])),
        );
        const rendered = initECharts(null, undefined, {
          renderer: "svg",
          ssr: true,
          width: 1200,
          height: 800,
        });
        try {
          rendered.setOption(option);
          const svg = rendered.renderToSVGString();
          for (const date of dates) {
            assert.ok(svg.includes(date), `${type} must display the original label ${date}`);
          }
        } finally {
          rendered.dispose();
        }
      }
    }
  });

  test("times are read only where the label column is an axis", () => {
    const daily = "date,ms\n2026-01-02,3\n2026-01-05,5";
    // A scatter chart plots the values against the times, so it needs one value column, not two.
    const option = build(chart("scatter"), daily);
    assert.strictEqual(option.xAxis.type, "time");
    assert.strictEqual(option.yAxis.name, "ms");
    assert.deepStrictEqual(option.series[0].data, [
      ["2026-01-02", 3],
      ["2026-01-05", 5],
    ]);
    assert.match(summary(chart("scatter"), daily), /^Charted "ms" against "date"; read "date" as /);
    // Charts without an axis for the labels keep them as the names of their items.
    const pie = build(chart("pie"), daily);
    assert.deepStrictEqual(pie.series[0].data, [
      { name: "2026-01-02", value: 3 },
      { name: "2026-01-05", value: 5 },
    ]);
    assert.strictEqual(summary(chart("pie"), daily), 'Charted "ms" by "date".');
  });

  test("a time axis counts, sorts and leaves out rows without a date", () => {
    // Counting the rows per day needs no value column at all.
    const log = "2026-01-02\n2026-01-02\n2026-01-03";
    for (const type of ["bar", "scatter"] as const) {
      const perDay = build(chart(type, { aggregate: "count" }), log);
      assert.strictEqual(perDay.xAxis.type, "time");
      assert.deepStrictEqual(perDay.series[0].data, [
        ["2026-01-02", 2],
        ["2026-01-03", 1],
      ]);
    }
    const sorted = chart("line", { sort: "descending" });
    assert.match(
      summary(sorted, "date,n\n2026-01-02,3\n2026-01-05,5"),
      /sorted the rows by value rather than in time order, which a line runs back over/,
    );
    assert.match(
      summary(chart("line"), "date,n\n2026-01-02,3\n,5"),
      /left out 1 row without a date/,
    );
  });

  test("grouped and timed charts render in ECharts", async function () {
    this.timeout(20_000);
    const panel = newPanel();
    try {
      const charts: [ChartType, ChartSpec][] = [
        ["bar", chart("bar", { aggregate: "count" })],
        ["line", chart("line", { aggregate: "sum" })],
        ["scatter", chart("scatter")],
        ["scatter", chart("scatter", { aggregate: "count" })],
        ["horizontalBar", chart("horizontalBar")],
      ];
      for (const [type, spec] of charts) {
        const source = JSON.stringify(build(spec, "date,n\n2026-01-02,3\n2026-01-02,5"));
        const outcome = await panel.render({ language: "echarts", source, title: type }, "tool");
        assert.deepStrictEqual(
          outcome,
          {
            ok: true,
            diagramType: type === "scatter" ? "scatter" : type === "line" ? "line" : "bar",
          },
          type,
        );
      }
    } finally {
      panel.dispose();
    }
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
    // Dates label the rows when nothing else does, and a cartesian chart draws them as times.
    const sales = "date,region,sales\n2024-01-01,north,3\n2024-01-02,north,5";
    const option = build(chart("line"), sales);
    assert.strictEqual(option.xAxis.type, "time");
    assert.deepStrictEqual(option.series[0].data, [
      ["2024-01-01", 3],
      ["2024-01-02", 5],
    ]);
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
    assert.deepStrictEqual(option.series[1].data, [300, 12 / 1024, 0]);
    assert.strictEqual(
      summary(chart("bar"), df),
      'Charted "Size (GiB)", "Used (GiB)", "Avail (GiB)" by "Mounted on"; showed sizes in GiB.',
    );
    const du = build(chart("bar", { valueColumns: ["Column 1"] }), "1.5K\ta\n512\tb");
    assert.strictEqual(du.series[0].data[0], 1.5);
  });

  test("byte scaling preserves small values and differences between large values", () => {
    const data = "file,size\nlarge,1GiB\nsmall,1B\nnearby,1073741825B";
    const expected = [1, 1 / 1024 ** 3, 1073741825 / 1024 ** 3];
    assert.deepStrictEqual(build(chart("bar"), data).series[0].data, expected);
    assert.deepStrictEqual(
      build(chart("pie"), data).series[0].data.map((item: Option) => item.value),
      expected,
    );
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
    assert.match(
      describeTable({ columns: [{ name: "x", numeric: true }], rows: [[null]], header: true }),
      /"x" \(empty\)/,
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

  test("every chart type renders in ECharts", async function () {
    // The first render loads the webview and ECharts.
    this.timeout(20_000);
    const panel = newPanel();
    try {
      const negative = "k,x,y\na,-1,3\nb,2,-4\nc,3,5";
      const single = "k,x,y\na,1,2";
      for (const type of CHART_TYPES) {
        for (const table of [LANGUAGES, negative, single]) {
          const option = build(chart(type), table);
          const source = JSON.stringify(option);
          const outcome = await panel.render({ language: "echarts", source, title: type }, "tool");
          assert.deepStrictEqual(outcome, { ok: true, diagramType: option.series[0].type }, type);
        }
      }
    } finally {
      panel.dispose();
    }
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
    // null removes a generated setting.
    const doughnut = build(chart("doughnut", { options: { series: { radius: null } } }));
    assert.ok(!("radius" in doughnut.series[0]));
  });

  test("deepMerge merges objects, replaces arrays and values, and does not mutate", () => {
    const target = { a: { b: 1, c: [1, 2] }, d: "x", list: [{ k: 1 }, { k: 2 }] };
    const source = { a: { b: null, c: [3] }, d: 5, list: [{ j: 1 }], e: null, f: { g: null } };
    const merged = deepMerge(target, source);
    assert.deepStrictEqual(merged, {
      a: { c: [3] },
      d: 5,
      list: [{ k: 1, j: 1 }, { k: 2 }],
      f: {},
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
    assert.strictEqual(dataOrigin({ type: "pie", data: "a 1" }), "inline data");
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

  test("validateChartSpec accepts several label columns and a maximum", () => {
    const flows = { type: "sankey", data: "a,b,n", labelColumn: ["from", "to"] };
    assert.deepStrictEqual(validateChartSpec(flows), flows);
    const gauge = { type: "gauge", data: "n\n5", max: 100 };
    assert.deepStrictEqual(validateChartSpec(gauge), gauge);
    assert.throws(
      () => validateChartSpec({ type: "sankey", data: "a,1", labelColumn: [] }),
      /"labelColumn" is an array; it must be a column name, or an array of them/,
    );
    assert.throws(
      () => validateChartSpec({ type: "sankey", data: "a,1", labelColumn: [1] }),
      /"labelColumn" is an array; it must be/,
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
          'Unknown property "colour"; the properties are "type", "title",',
          '"options", "clickPrompt".',
          '"type" is "histogram"; it must be one of "pie"',
          'Give only one of "data", "file"',
          '"limit" is 2.5; it must be a positive integer',
          '"sort" is "up"; it must be one of "ascending", "descending"',
          '"valueColumns" is "size"; it must be a non-empty array',
          '"options" is an array; it must be an object',
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
