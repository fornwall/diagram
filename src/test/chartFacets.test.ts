import * as assert from "node:assert";
import type { ChartSpec } from "../chartSpec";
import { buildChart } from "../charts";
import { parseTable } from "../data";
import { minimumHeight } from "../webview/echartsFacets";
import { ChartItems } from "../webview/echartsItems";
import {
  builtOption,
  itemsOf,
  layout,
  type Option,
  seriesData,
  svgOf,
  withChart,
} from "./echartsModel";

const build = (data: string, spec: Partial<ChartSpec> = {}) =>
  builtOption({ type: "bar", data, facetColumn: "service", ...spec } as ChartSpec, data);

/** The bounds of each axis. */
const bounds = (axes: Option[]) => axes.map((axis) => [axis.min, axis.max]);

/** A box laid out in percent of a size, in whole pixels. */
const inPixels = (box: Option, width: number, height: number): Option =>
  Object.fromEntries(
    ["left", "top", "width", "height"].map((key) => [
      key,
      Math.round(
        (Number.parseFloat(box[key]) * (key === "left" || key === "width" ? width : height)) / 100,
      ),
    ]),
  );

suite("chartFacets", () => {
  test("shares category order without changing the values' categories", () => {
    const option = build(
      "service,operation,ms\napi,read,2\napi,write,5\nworker,write,30\nworker,delete,8",
    );
    assert.deepStrictEqual(
      option.xAxis.map((axis: Option) => axis.data),
      [
        ["read", "write", "delete"],
        ["read", "write", "delete"],
      ],
    );
    assert.deepStrictEqual(seriesData(option), [
      [2, 5, null],
      [null, 30, 8],
    ]);
    assert.deepStrictEqual(bounds(option.yAxis), Array(2).fill([0, 30]));
    assert.deepStrictEqual(
      option.series.map((series: Option) => [series.id, series.name]),
      [
        ["api · ms", "ms"],
        ["worker · ms", "ms"],
      ],
    );
    assert.deepStrictEqual(
      option.series.map((series: Option) => series.xAxisIndex),
      [0, 1],
    );
  });

  test("shares one array of categories, in time order for dates read as categories", () => {
    const data = "service,date,ms\napi,2026-01-01,1\napi,2026-03-01,3\nworker,2026-02-01,2";
    const option = build(data, { options: { xAxis: { type: "category" } } });
    assert.deepStrictEqual(option.xAxis[0].data, ["2026-01-01", "2026-02-01", "2026-03-01"]);
    assert.deepStrictEqual(seriesData(option), [
      [1, null, 3],
      [null, 2, null],
    ]);
    // Numbers too, as years, of which a panel may lack the first.
    const years = build("service,year,ms\napi,2021,1\napi,2022,2\nworker,2020,3", {
      labelColumn: "year",
    });
    assert.deepStrictEqual(years.xAxis[0].data, ["2020", "2021", "2022"]);
    const plain = build(data.replaceAll("2026-", "x"));
    assert.strictEqual(plain.xAxis[0].data, plain.xAxis[1].data);
    // Sorted rows keep the order of the panels' rows.
    const sorted = build(data, { options: { xAxis: { type: "category" } }, sort: "descending" });
    assert.deepStrictEqual(sorted.xAxis[0].data, ["2026-03-01", "2026-01-01", "2026-02-01"]);
  });

  test("preserves repeated category observations without implicit aggregation", () => {
    const option = build("service,operation,ms\napi,read,2\napi,read,5\nworker,read,30");
    assert.deepStrictEqual(option.xAxis[0].data, ["read", "read"]);
    assert.deepStrictEqual(seriesData(option), [
      [2, 5],
      [30, null],
    ]);
  });

  test("shares positive and negative stacked totals separately", () => {
    // Netted, the totals would be 0 and 3.
    const option = build("service,operation,a,b,c\napi,read,10,20,-30\nworker,read,1,1,1", {
      type: "stackedBar",
      valueColumns: ["a", "b", "c"],
    });
    assert.deepStrictEqual(bounds(option.yAxis), Array(2).fill([-30, 30]));
    assert.notStrictEqual(option.series[0].stack, option.series[3].stack);
  });

  test("horizontal facets share their category and value axes", () => {
    const option = build("service,operation,ms\napi,read,2\nworker,write,-4", {
      type: "horizontalBar",
    });
    assert.deepStrictEqual(option.yAxis[0].data, ["read", "write"]);
    assert.deepStrictEqual(bounds(option.xAxis), Array(2).fill([-4, 2]));
    // The category axis stays at the edge of the shared range, also in the panel without -4.
    assert.deepStrictEqual(
      option.yAxis.map((axis: Option) => axis.axisLine),
      [{ onZero: false }, { onZero: false }],
    );
  });

  test("shared stacked bounds skip missing observations in disjoint categories", () => {
    const option = build("service,operation,a,b\napi,empty,,\napi,read,10,5\nworker,write,-3,-5", {
      type: "stackedBar",
      valueColumns: ["a", "b"],
    });
    assert.deepStrictEqual(option.xAxis[0].data, ["empty", "read", "write"]);
    assert.deepStrictEqual(seriesData(option), [
      [null, 10, null],
      [null, 5, null],
      [null, null, -3],
      [null, null, -5],
    ]);
    assert.deepStrictEqual(bounds(option.yAxis), Array(2).fill([-10, 15]));
  });

  test("shared stacked bounds keep repeated timestamps as separate observations", () => {
    for (const type of ["stackedBar", "stackedArea"] as const) {
      const option = build(
        "service,date,a,b\napi,2026-01-01,10,20\napi,2026-01-01,40,50\nworker,2026-01-02,3,4",
        { type, valueColumns: ["a", "b"] },
      );
      assert.deepStrictEqual(bounds(option.yAxis), Array(2).fill([0, 100]), type);
      assert.strictEqual(option.series[0].data.length, 2);
    }
  });

  test("rounds shared value bounds out to ticks that every panel shares", () => {
    const bars = build("service,operation,ms\napi,read,2\nworker,write,1234");
    assert.deepStrictEqual(
      bars.yAxis.map((axis: Option) => [axis.min, axis.max, axis.interval]),
      Array(2).fill([0, 1400, 200]),
    );
    const scatter = build("service,x,y\napi,0.33,1\nworker,0.87,2", { type: "scatter" });
    // Exactly, rather than 3 * 0.1.
    assert.deepStrictEqual([scatter.xAxis[0].min, scatter.xAxis[0].max], [0.3, 0.9]);
    // A count goes up in whole numbers.
    const counts = build("service,ms\napi,1\napi,1\nworker,2", { type: "histogram" });
    assert.deepStrictEqual(
      [counts.yAxis[0].min, counts.yAxis[0].max, counts.yAxis[0].interval],
      [0, 2, 1],
    );
  });

  test("independent scales keep different category domains and automatic numeric ranges", () => {
    const option = build("service,operation,ms\napi,read,2\nworker,write,30", {
      facetScales: "independent",
    });
    assert.deepStrictEqual(
      option.xAxis.map((axis: Option) => axis.data),
      [["read"], ["write"]],
    );
    assert.strictEqual(option.yAxis[0].max, undefined);
  });

  test("shares time extents and scatter numeric extents", () => {
    const time = build("service,date,ms\napi,2026-01-01,2\nworker,2026-02-01,30", { type: "line" });
    assert.deepStrictEqual(
      time.xAxis.map((axis: Option) => [axis.type, axis.min, axis.max]),
      Array(2).fill(["time", "2026-01-01", "2026-02-01"]),
    );
    const scatter = build("service,x,y\napi,10,100\nworker,30,200", { type: "scatter" });
    assert.deepStrictEqual(bounds(scatter.xAxis), Array(2).fill([10, 30]));
    assert.deepStrictEqual(bounds(scatter.yAxis), Array(2).fill([100, 200]));
  });

  test("a scatter facet without a complete point is an empty panel, as a bar facet is", () => {
    const data = "service,x,y\napi,10,100\napi,20,200\nworker,30,\nworker,,40";
    const chart = buildChart({ type: "scatter", data, facetColumn: "service" }, parseTable(data));
    const series = chart.option.series as Option[];
    assert.deepStrictEqual(
      series.map((each) => each.data),
      [
        [
          [10, 100],
          [20, 200],
        ],
        [],
      ],
    );
    assert.match(chart.summary, /"worker": .*left out 2 rows without both an x and a y value/);
    assert.ok(!("empty" in chart));
    // Without a point in any facet, the chart fails as one without facets does.
    const none = "service,x,y\napi,10,\napi,,200\nworker,30,\nworker,,40";
    for (const spec of [{ facetColumn: "service" }, {}]) {
      assert.throws(
        () => buildChart({ type: "scatter", data: none, ...spec }, parseTable(none)),
        new Error(
          'A scatter chart needs rows with numbers in both "x", "y", but none has. Choose ' +
            '"valueColumns" that are filled in the same rows.',
        ),
      );
    }
  });

  test("a bar facet without a number says so, and fails the chart when every facet has none", () => {
    const data = "service,operation,ms\napi,read,2\nworker,write,\nworker,read,";
    const chart = buildChart({ type: "bar", data, facetColumn: "service" }, parseTable(data));
    assert.match(chart.summary, /Charted "ms" by "operation"\. "worker": no row has a number/);
    assert.doesNotMatch(chart.summary, /"api"/);
    // Numbers of "ms" only in rows that a filter leaves out of every facet's time axis.
    const undated = "service,date,ms\napi,2026-01-01,\napi,,3\nworker,2026-01-02,";
    assert.throws(
      () =>
        buildChart({ type: "line", data: undated, facetColumn: "service" }, parseTable(undated)),
      new Error('No row has a number in "ms" to chart.'),
    );
  });

  test("facets that alone would read their labels differently share one axis type", () => {
    // Alone, "api" reads as dates and "worker" as categories.
    const data = "service,when,ms\napi,2026-01-01,2\napi,2026-01-02,3\nworker,soon,30";
    const option = build(data, { type: "line" });
    assert.deepStrictEqual(
      option.xAxis.map((axis: Option) => axis.type),
      ["category", "category"],
    );
  });

  test("shared time bounds use the viewer's timezone for unzoned dates", () => {
    const previousTimezone = process.env.TZ;
    try {
      for (const [start, end, hour] of [
        ["2026-01", "2026-02", 0],
        ["2026-01-01", "2026-02-01", 0],
        ["2026-01-01T14:00:00", "2026-02-01T14:00:00", 14],
      ] as const) {
        process.env.TZ = "Europe/Stockholm";
        const option = build(`service,date,ms\napi,${start},2\nworker,${end},30`, {
          type: "line",
        });
        // Simulate a viewer in another timezone than the extension host.
        process.env.TZ = "America/Los_Angeles";
        withChart(
          { ...option, animation: false },
          (chart) => {
            const localEnd = new Date(2026, 1, 1, hour).getTime();
            const endPixel = chart.convertToPixel({ xAxisIndex: 1 }, localEnd);
            const boundPixel = chart.convertToPixel({ xAxisIndex: 1 }, option.xAxis[1].max);
            assert.strictEqual(endPixel, boundPixel, end);
          },
          { width: 800, height: 600 },
        );
      }
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  test("shared zoned bounds follow instants rather than timestamp text order", () => {
    const earlier = "2026-01-01T02:00:00+05:30";
    const later = "2026-01-01T00:00:00Z";
    const option = build(`service,date,ms\napi,${earlier},2\nworker,${later},30`, { type: "line" });
    assert.deepStrictEqual(
      bounds(option.xAxis),
      Array(2).fill([Date.parse(earlier), Date.parse(later)]),
    );
  });

  test("infers columns globally and keeps byte units consistent", () => {
    const option = build("service,operation,size\napi,read,1 KiB\nworker,read,4 MiB");
    assert.deepStrictEqual(
      option.series.map((series: Option) => series.id),
      ["api · size (MiB)", "worker · size (MiB)"],
    );
    assert.deepStrictEqual(seriesData(option), [[1 / 1024], [4]]);
  });

  test("says what every panel reads alike once, and each panel's own row notes by panel", () => {
    const data = "service,date,size\napi,2026-01-01,1 KiB\napi,,2 KiB\nworker,2026-01-02,4 MiB";
    const { summary } = buildChart(
      { type: "line", data, facetColumn: "service" },
      parseTable(data),
    );
    assert.strictEqual(
      summary,
      'Faceted by "service" into 2 panels with shared scales. Charted "size (MiB)" by "date"; ' +
        'read "date" as ISO dates on a time axis; {"xAxis": {"type": "category"}} in "options" ' +
        'reads them as labels instead; showed sizes in MiB. "api": left out 1 row without a date.',
    );
    // Panels whose rows gave the same notes are told of together.
    const grouped = "service,k,n\napi,a,1\napi,a,2\nworker,b,3\nworker,b,4";
    assert.strictEqual(
      buildChart(
        { type: "bar", data: grouped, facetColumn: "service", aggregate: "sum" },
        parseTable(grouped),
      ).summary,
      'Faceted by "service" into 2 panels with shared scales. Charted "n" by "k". Each panel: ' +
        'grouped 2 rows into 1 by "k", summing their values.',
    );
    const counts = "service,ms\napi,1\napi,x\nworker,2";
    assert.strictEqual(
      buildChart({ type: "histogram", data: counts, facetColumn: "service" }, parseTable(counts))
        .summary,
      'Faceted by "service" into 2 panels with shared scales. Charted "ms" in 2 histogram bins. ' +
        '"api": 1 observation; skipped 1 row without a number. "worker": 1 observation.',
    );
  });

  test("counts a single panel as one", () => {
    const data = "service,operation,ms\napi,read,2\napi,write,5";
    const { summary } = buildChart({ type: "bar", data, facetColumn: "service" }, parseTable(data));
    assert.match(summary, /^Faceted by "service" into 1 panel with shared scales\./);
  });

  test("says what the filters kept before the panels rather than within the last one", () => {
    const data = "service,operation,ms\napi,read,2\napi,write,5\nworker,read,30";
    const { summary } = buildChart(
      {
        type: "bar",
        data,
        facetColumn: "service",
        filters: [{ column: "ms", op: "gt", value: 2 }],
      },
      parseTable(data),
    );
    assert.match(summary, /^The filters kept 2 of 3 rows\. Faceted by "service" into 2 panels/);
  });

  test("recomputes shared inference and byte units for each chart request", () => {
    const data = "service,date,size\napi,2026-01-01,1 KiB\nworker,2026-01-02,4 MiB";
    const table = parseTable(data);
    const spec: ChartSpec = { type: "line", data, facetColumn: "service" };
    buildChart(spec, table);
    table.rows[1] = ["worker", "not a date", 2 * 1024];
    const option: Option = buildChart(spec, table).option;
    assert.deepStrictEqual(
      option.xAxis.map((axis: Option) => axis.type),
      ["category", "category"],
    );
    assert.deepStrictEqual(
      option.series.map((series: Option) => series.id),
      ["api · size (KiB)", "worker · size (KiB)"],
    );
    assert.deepStrictEqual(seriesData(option), [
      [1, null],
      [null, 2],
    ]);
  });

  test("excludes numeric facet fields from inferred measurements", () => {
    const option = build("service,operation,ms\n1,read,2\n2,read,30");
    assert.deepStrictEqual(
      option.series.map((series: Option) => series.id),
      ["1 · ms", "2 · ms"],
    );
  });

  test("filters first and aggregates, sorts and limits within each facet", () => {
    const option = build(
      "service,operation,ms\napi,read,2\napi,read,5\napi,write,3\nworker,write,8\nworker,read,4\nother,read,90",
      {
        filters: [{ column: "service", op: "neq", value: "other" }],
        aggregate: "sum",
        sort: "descending",
        limit: 1,
      },
    );
    assert.deepStrictEqual(option.xAxis[0].data, ["read", "write"]);
    assert.deepStrictEqual(seriesData(option), [
      [7, null],
      [null, 8],
    ]);
  });

  test("component identities follow groups across row reorder and missing labels remain distinct", () => {
    const first = build("service,operation,ms\napi,read,2\nworker,read,30");
    const second = build("service,operation,ms\nworker,read,30\napi,read,2");
    for (const key of ["grid", "title", "xAxis", "yAxis", "series"])
      assert.strictEqual(first[key][0].id, second[key][1].id);
    const option = build(
      '[{"service":null,"operation":"read","ms":2},{"service":"(missing)","operation":"read","ms":3}]',
    );
    assert.notStrictEqual(option.series[0].id, option.series[1].id);
    assert.notStrictEqual(option.title[0].id, option.title[1].id);
  });

  test("orders panels of numbers, dates and weekdays, and puts missing values last", () => {
    const titles = (data: string) =>
      build(data, { facetColumn: "when" }).title.map((title: Option) => title.text);
    assert.deepStrictEqual(titles("when,operation,ms\n10,read,1\n,read,2\n9,read,3"), [
      "when = 9",
      "when = 10",
      "when = (missing)",
    ]);
    assert.deepStrictEqual(titles("when,operation,ms\nTue,read,1\nMon,read,2\nTue,write,3"), [
      "when = Mon",
      "when = Tue",
    ]);
    assert.deepStrictEqual(titles("when,operation,ms\nworker,read,1\n,read,2\napi,read,3"), [
      "when = worker",
      "when = api",
      "when = (missing)",
    ]);
  });

  test("selection names stay unique for ambiguous missing labels and delimiter collisions", () => {
    const missing = build(
      '[{"service":null,"operation":"read","ms":2},{"service":"(missing)","operation":"read","ms":3},{"service":"(missing value)","operation":"read","ms":4}]',
    );
    assert.strictEqual(new Set(missing.series.map((series: Option) => series.id)).size, 3);
    const delimiters = build("service,operation,c,b · c\na · b,read,2,3\na,read,4,5", {
      valueColumns: ["c", "b · c"],
    });
    assert.strictEqual(new Set(delimiters.series.map((series: Option) => series.id)).size, 4);
    const items = itemsOf(delimiters);
    assert.deepStrictEqual(
      delimiters.series.map((_: Option, i: number) => items.node(`${i}::0`)?.id),
      ["a · b · c/read", "a · b · b · c/read", "a · c/read", "a · b · c (2)/read"],
    );
  });

  test("a measure has one color and one legend entry, and selection tells its panels apart", () => {
    const option = build("service,operation,a,b\napi,read,2,3\nworker,read,30,40", {
      valueColumns: ["a", "b"],
    });
    withChart(option, (chart) => {
      const colors = [0, 1, 2, 3].map((seriesIndex) => chart.getVisual({ seriesIndex }, "color"));
      assert.strictEqual(colors[0], colors[2]);
      assert.strictEqual(colors[1], colors[3]);
      assert.notStrictEqual(colors[0], colors[1]);
      const items = new ChartItems(chart);
      assert.deepStrictEqual(
        [0, 1, 2, 3].map((i) => items.node(`${i}::0`)?.id),
        ["api · a/read", "api · b/read", "worker · a/read", "worker · b/read"],
      );
    });
    // The legend lists the series' names once each, and hides a measure in every panel.
    assert.deepStrictEqual(
      option.series.map((series: Option) => series.name),
      ["a", "b", "a", "b"],
    );
    assert.strictEqual(option.legend.type, "scroll");
    // A single measure has no legend to tell it from others.
    assert.deepStrictEqual(build("service,operation,ms\napi,read,2\nworker,read,30").legend, {
      show: false,
    });
  });

  test("histogram facets share bin boundaries including an empty numeric group", () => {
    for (const facetScales of ["shared", "independent"] as const) {
      const option = build("service,value\n1,0\n1,2\n2,8\n2,10\n3,", {
        type: "histogram",
        bins: 2,
        facetScales,
      });
      assert.deepStrictEqual(
        option.xAxis.map((axis: Option) => axis.data),
        Array(3).fill(["[0, 5)", "[5, 10]"]),
      );
      assert.deepStrictEqual(seriesData(option), [
        [2, 0],
        [0, 2],
        [0, 0],
      ]);
    }
  });

  test("rotates a panel's labels to fit its width, in the grids laid out for the panel", () => {
    const option = build(
      "service,operation,ms\napi,Read configuration,2\napi,Write configuration,3\nworker,Read configuration,30\nworker,Write configuration,40",
    );
    const laidOut = layout(option, { width: 600, title: "My chart" });
    assert.deepStrictEqual(
      laidOut.grid.map((grid: Option) => {
        const { left, top, width, height } = inPixels(grid, 600, 500);
        return [left, top, width, height];
      }),
      [
        [16, 34, 272, 450],
        [312, 34, 272, 450],
      ],
    );
    assert.ok(laidOut.xAxis.every((axis: Option) => axis.axisLabel.rotate > 0));
  });

  test("panel titles are cut short at the width of their panel", () => {
    const data = "service,operation,ms\napi,read,2\nworker,read,30";
    const widths = (facetColumns: number) =>
      layout(build(data, { facetColumns }), { width: 1000 }).title.map((title: Option) =>
        Math.round(title.textStyle.width),
      );
    assert.deepStrictEqual(widths(1), [952, 952]);
    assert.deepStrictEqual(widths(2), [456, 456]);
  });

  test("panel titles leave out the facet column's name when one would not fit its panel", () => {
    const data = "a long name of a service,ms\napi,2\nworker,30\n,4";
    const texts = (
      width: number,
      option = build(data, { facetColumn: "a long name of a service" }),
    ) => layout(option, { width }).title.map((title: Option) => title.text);
    assert.deepStrictEqual(texts(1000), [
      "a long name of a service = api",
      "a long name of a service = worker",
      "a long name of a service = (missing)",
    ]);
    assert.deepStrictEqual(texts(400), ["api", "worker", "(missing)"]);
    // Values quoted to tell them apart, and titles of the user's own, which it leaves as they are.
    const mixed = parseTable("service,ms\n1,2\n2,3");
    mixed.rows[1] = ["1", 3];
    const ambiguous = buildChart(
      { type: "bar", data: "", facetColumn: "service" } as ChartSpec,
      mixed,
    ).option as Option;
    assert.deepStrictEqual(texts(150, ambiguous), ["1", '"1"']);
    const own = build(data, {
      facetColumn: "a long name of a service",
      options: { title: [{ text: "My own title for the first panel" }] },
    });
    assert.deepStrictEqual(texts(400, own), [
      "My own title for the first panel",
      "a long name of a service = worker",
      "a long name of a service = (missing)",
    ]);
  });

  test("asks for a view tall enough for a row of facets for every few of them", () => {
    assert.strictEqual(minimumHeight(build(regions(5)), 1100), 112);
    assert.strictEqual(minimumHeight(build(regions(5)), 360), 212);
    assert.strictEqual(minimumHeight(build(regions(12)), 360), 412);
    assert.strictEqual(
      minimumHeight(builtOption({ type: "bar" } as ChartSpec, regions(5)), 360),
      0,
    );
  });

  const regions = (count: number) =>
    `service,month,ms\n${Array.from({ length: count }, (_, panel) =>
      ["Jan", "Feb", "Mar", "Apr", "May", "Jun"]
        .map((month, i) => `s${panel},${month},${50 + ((panel * 13 + i * 17) % 40)}`)
        .join("\n"),
    ).join("\n")}`;

  test("lays the panels out in pixels, each title above its grid and clear of the row above", () => {
    const option = build(regions(5));
    const laidOut = layout(option, { width: 1100, height: 540 });
    // In percent of the size laid out for, which a chart resized without a new layout scales.
    assert.match(laidOut.grid[1].left, /^[\d.]+%$/);
    const boxes = laidOut.grid.map((grid: Option) => inPixels(grid, 1100, 540));
    const titles = laidOut.title.map((title: Option) => inPixels(title, 1100, 540));
    assert.deepStrictEqual(new Set(boxes.map(({ left }: Option) => left)).size, 2);
    assert.deepStrictEqual(new Set(boxes.map(({ top }: Option) => top)).size, 3);
    titles.forEach((title: Option, i: number) => {
      assert.deepStrictEqual([title.left, title.top + 26], [boxes[i].left, boxes[i].top]);
    });
    assert.ok(boxes[0].top + boxes[0].height < titles[2].top, JSON.stringify(boxes));
    // Plots of over 80 pixels, rather than the 40 that percentages of the chart left them.
    withChart(
      laidOut,
      (chart) => {
        const y = (value: number) => Number(chart.convertToPixel({ yAxisIndex: 4 }, value));
        assert.ok(y(0) - y(100) > 80, String(y(0) - y(100)));
        assert.ok(y(100) > titles[4].top + 40, "below the title and the axis name");
      },
      { width: 1100, height: 540 },
    );
    // The panels of a user's own boxes stay where the user places them.
    const placed = build(regions(5), { options: { grid: [{ top: "10%" }] } });
    assert.deepStrictEqual(layout(placed, { width: 1100, height: 540 }).grid, placed.grid);
  });

  test("takes more columns when rows of panels would be too short, while they are wide enough", () => {
    const columns = (width: number, height: number, count = 5) =>
      new Set(layout(build(regions(count)), { width, height }).grid.map(({ left }: Option) => left))
        .size;
    assert.strictEqual(columns(1100, 540), 2);
    assert.strictEqual(columns(800, 340), 3);
    assert.strictEqual(columns(600, 150), 5);
    // Too narrow for more.
    assert.strictEqual(columns(200, 150), 2);
    assert.strictEqual(columns(800, 340, 9), 5);
  });

  test("gives short panels fewer value labels, alike in every panel, and drops the axis name", () => {
    const option = build(regions(5));
    assert.deepStrictEqual(
      [option.yAxis[0].min, option.yAxis[0].max, option.yAxis[0].interval],
      [0, 100, 20],
    );
    const axes = (width: number, height: number) =>
      layout(option, { width, height }).yAxis.map(({ min, max, interval, name }: Option) => ({
        min,
        max,
        interval,
        name,
      }));
    const tall = axes(1100, 900);
    assert.deepStrictEqual(tall[0], { min: 0, max: 100, interval: 20, name: "ms" });
    const usual = axes(1100, 540);
    assert.deepStrictEqual(usual[0], { min: 0, max: 100, interval: 25, name: "ms" });
    const short = axes(500, 200);
    assert.deepStrictEqual(short[0], { min: 0, max: 100, interval: 50, name: "" });
    for (const each of [tall, usual, short]) {
      assert.ok(each.every((axis: Option) => JSON.stringify(axis) === JSON.stringify(each[0])));
    }
    // A count stays whole, and independent scales take fewer ticks of ECharts' own.
    const values = Array.from({ length: 5 }, (_, panel) =>
      Array.from({ length: 12 }, (_, i) => `s${panel},${i < 10 ? 1 : 9}`).join("\n"),
    );
    const counts = build(`service,value\n${values.join("\n")}`, { type: "histogram", bins: 2 });
    assert.deepStrictEqual([counts.yAxis[0].interval, counts.yAxis[0].minInterval], [2, 1]);
    const fractions = {
      ...counts,
      yAxis: counts.yAxis.map(({ minInterval: _, ...axis }: Option) => axis),
    };
    const interval = (option: Option) =>
      layout(option, { width: 1100, height: 540 }).yAxis[0].interval;
    assert.deepStrictEqual([interval(counts), interval(fractions)], [5, 2.5]);
    const independent = build(regions(5), { facetScales: "independent" });
    assert.strictEqual(layout(independent, { width: 500, height: 200 }).yAxis[0].splitNumber, 2);
    assert.strictEqual(
      layout(independent, { width: 1100, height: 900 }).yAxis[0].splitNumber,
      undefined,
    );
  });

  test("takes more panels per row than 4 rows of panels would need, and says so", () => {
    const panels = (count: number) =>
      `service,ms\n${Array.from({ length: count }, (_, i) => `s${i},${i}`).join("\n")}`;
    const lefts = (chart: Option) => new Set(chart.grid.map((grid: Option) => grid.left)).size;
    assert.strictEqual(lefts(build(panels(4), { facetColumns: 1 })), 1);
    assert.strictEqual(lefts(build(panels(12))), 3);
    const data = panels(12);
    const { option, summary } = buildChart(
      { type: "bar", data, facetColumn: "service", facetColumns: 1 },
      parseTable(data),
    );
    assert.strictEqual(lefts(option), 3);
    assert.match(
      summary,
      /12 panels in 3 columns, as "facetColumns": 1 would leave them too short/,
    );
    assert.doesNotMatch(
      buildChart({ type: "bar", data, facetColumn: "service" }, parseTable(data)).summary,
      /too short/,
    );
  });

  test("panels keep the tooltip of their type", () => {
    const data = "service,operation,ms\napi,read,2\nworker,read,30";
    const tooltip = (spec: Partial<ChartSpec>) => layout(build(data, spec), { width: 600 }).tooltip;
    assert.deepStrictEqual(tooltip({}).axisPointer, { type: "shadow" });
    assert.strictEqual(tooltip({ type: "line" }).trigger, "axis");
    assert.strictEqual(tooltip({ type: "histogram" }).trigger, "item");
  });

  test("validates facet types, names and group count instead of dropping groups", () => {
    assert.throws(
      () => build("service,ms\na,2", { type: "pie" }),
      /Faceting is not supported for pie charts.*leave out "facetColumn"/,
    );
    assert.throws(
      () => build("service,ms\na,2", { facetColumn: "unknown" }),
      /Unknown facet column.*Available columns/,
    );
    assert.throws(
      () => build(`service,ms\n${Array.from({ length: 13 }, (_, i) => `s${i},${i}`).join("\n")}`),
      /facet column "service" has 13 values, more than the 12 panels.*"filters"/,
    );
  });

  test("manual options merge over generated bounds and remain unchanged during panel layout", () => {
    const option = build("service,operation,ms\napi,read,2\nworker,write,30", {
      options: {
        grid: [{ left: "8%" }],
        yAxis: [{ max: 100 }],
        title: [{ textStyle: { fontSize: 17 } }],
      },
    });
    assert.strictEqual(option.grid[0].left, "8%");
    assert.strictEqual(option.yAxis[0].max, 100);
    const laidOut = layout(option, { width: 400, title: "My chart" });
    assert.deepStrictEqual(laidOut.grid, option.grid);
    assert.strictEqual(laidOut.title[0].text, "service = api");
    assert.strictEqual(laidOut.title[0].textStyle.fontSize, 17);
    assert.strictEqual(laidOut.series[1].xAxisIndex, 1);
    assert.notStrictEqual(laidOut.grid[0].left, laidOut.grid[1].left);
  });

  test("renders all facet grids and titles as actual ECharts SVG", () => {
    const option = build("service,operation,ms\napi,read,2\nworker,write,30");
    withChart(
      { ...option, animation: false },
      (chart) => {
        const svg = chart.renderToSVGString();
        assert.match(svg, /service = api/);
        assert.match(svg, /service = worker/);
        assert.match(svg, />read<\/text>/);
        assert.match(svg, />write<\/text>/);
        const x1 = chart.convertToPixel({ xAxisIndex: 0 }, "read");
        const x2 = chart.convertToPixel({ xAxisIndex: 1 }, "read");
        assert.ok(typeof x1 === "number" && typeof x2 === "number" && x2 > x1 + 100);
      },
      { width: 800, height: 600 },
    );
  });

  test("aligns the dates of panels whose date axes the options make category axes", () => {
    for (const type of ["line", "horizontalBar", "scatter"] as const) {
      const axis = type === "horizontalBar" ? "yAxis" : "xAxis";
      const option = build("service,date,value\na,2024-01-01,2\na,2024-01-02,3\nb,2024-01-03,4", {
        type,
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
      const svg = svgOf(option, { width: 600, height: 400 });
      assert.match(svg, />2024-01-03</, type);
    }
  });
});
