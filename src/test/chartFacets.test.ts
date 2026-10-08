import * as assert from "node:assert";
import type { ChartSpec } from "../chartSpec";
import { buildChart } from "../charts";
import { parseTable } from "../data";
import { ChartItems } from "../webview/echartsItems";
import { builtOption, itemsOf, layout, type Option, withChart } from "./echartsModel";

const build = (data: string, spec: Partial<ChartSpec> = {}) =>
  builtOption({ type: "bar", data, facetColumn: "service", ...spec } as ChartSpec, data);

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
    assert.deepStrictEqual(
      option.series.map((series: Option) => series.data),
      [
        [2, 5, null],
        [null, 30, 8],
      ],
    );
    assert.deepStrictEqual(
      option.yAxis.map((axis: Option) => [axis.min, axis.max]),
      [
        [0, 30],
        [0, 30],
      ],
    );
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
    assert.deepStrictEqual(
      option.series.map((series: Option) => series.data),
      [
        [1, null, 3],
        [null, 2, null],
      ],
    );
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
    assert.deepStrictEqual(
      option.series.map((series: Option) => series.data),
      [
        [2, 5],
        [30, null],
      ],
    );
  });

  test("shares positive and negative stacked totals separately", () => {
    // Netted, the totals would be 0 and 3.
    const option = build("service,operation,a,b,c\napi,read,10,20,-30\nworker,read,1,1,1", {
      type: "stackedBar",
      valueColumns: ["a", "b", "c"],
    });
    assert.deepStrictEqual(
      option.yAxis.map((axis: Option) => [axis.min, axis.max]),
      [
        [-30, 30],
        [-30, 30],
      ],
    );
    assert.notStrictEqual(option.series[0].stack, option.series[3].stack);
  });

  test("horizontal facets share their category and value axes", () => {
    const option = build("service,operation,ms\napi,read,2\nworker,write,-4", {
      type: "horizontalBar",
    });
    assert.deepStrictEqual(option.yAxis[0].data, ["read", "write"]);
    assert.deepStrictEqual(
      option.xAxis.map((axis: Option) => [axis.min, axis.max]),
      [
        [-4, 2],
        [-4, 2],
      ],
    );
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
    assert.deepStrictEqual(
      option.series.map((series: Option) => series.data),
      [
        [null, 10, null],
        [null, 5, null],
        [null, null, -3],
        [null, null, -5],
      ],
    );
    assert.deepStrictEqual(
      option.yAxis.map((axis: Option) => [axis.min, axis.max]),
      [
        [-10, 15],
        [-10, 15],
      ],
    );
  });

  test("shared stacked bounds keep repeated timestamps as separate observations", () => {
    for (const type of ["stackedBar", "stackedArea"] as const) {
      const option = build(
        "service,date,a,b\napi,2026-01-01,10,20\napi,2026-01-01,40,50\nworker,2026-01-02,3,4",
        { type, valueColumns: ["a", "b"] },
      );
      assert.deepStrictEqual(
        option.yAxis.map((axis: Option) => [axis.min, axis.max]),
        [
          [0, 100],
          [0, 100],
        ],
        type,
      );
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
    assert.deepStrictEqual(
      scatter.xAxis.map((axis: Option) => [axis.min, axis.max]),
      [
        [10, 30],
        [10, 30],
      ],
    );
    assert.deepStrictEqual(
      scatter.yAxis.map((axis: Option) => [axis.min, axis.max]),
      [
        [100, 200],
        [100, 200],
      ],
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
      option.xAxis.map((axis: Option) => [axis.min, axis.max]),
      Array(2).fill([Date.parse(earlier), Date.parse(later)]),
    );
  });

  test("infers columns globally and keeps byte units consistent", () => {
    const option = build("service,operation,size\napi,read,1 KiB\nworker,read,4 MiB");
    assert.deepStrictEqual(
      option.series.map((series: Option) => series.id),
      ["api · size (MiB)", "worker · size (MiB)"],
    );
    assert.deepStrictEqual(
      option.series.map((series: Option) => series.data),
      [[1 / 1024], [4]],
    );
  });

  test("keeps shared inference notes separate from each facet's row notes", () => {
    const data = "service,date,size\napi,2026-01-01,1 KiB\napi,,2 KiB\nworker,2026-01-02,4 MiB";
    const chart = buildChart({ type: "line", data, facetColumn: "service" }, parseTable(data));
    const [api, worker] = chart.summary.split('"worker":');
    assert.match(api ?? "", /left out 1 row without a date/);
    assert.doesNotMatch(worker ?? "", /without a date/);
    for (const panel of [api, worker]) {
      assert.match(panel ?? "", /read "date" as ISO dates/);
      assert.match(panel ?? "", /showed sizes in MiB/);
    }
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
    assert.deepStrictEqual(
      option.series.map((series: Option) => series.data),
      [
        [1, null],
        [null, 2],
      ],
    );
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
    assert.deepStrictEqual(
      option.series.map((series: Option) => series.data),
      [
        [7, null],
        [null, 8],
      ],
    );
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
      assert.deepStrictEqual(
        option.series.map((series: Option) => series.data.map((item: Option) => item.value)),
        [
          [2, 0],
          [0, 2],
          [0, 0],
        ],
      );
    }
  });

  test("rotates a panel's labels to fit its width, keeping the grids where the facets placed them", () => {
    const option = build(
      "service,operation,ms\napi,Read configuration,2\napi,Write configuration,3\nworker,Read configuration,30\nworker,Write configuration,40",
    );
    const laidOut = layout(option, { width: 600, title: "My chart" });
    assert.deepStrictEqual(laidOut.grid, option.grid);
    assert.ok(laidOut.xAxis.every((axis: Option) => axis.axisLabel.rotate > 0));
  });

  test("panel titles are cut short at the width of their panel", () => {
    const data = "service,operation,ms\napi,read,2\nworker,read,30";
    const widths = (facetColumns: number) =>
      layout(build(data, { facetColumns }), { width: 1000 }).title.map((title: Option) =>
        Math.round(title.textStyle.width),
      );
    assert.deepStrictEqual(widths(1), [904, 904]);
    assert.deepStrictEqual(widths(2), [424, 424]);
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
    assert.strictEqual(tooltip({ type: "histogram" }).formatter, "{b}<br/>{a}: {c}");
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
      const svg = withChart(option, (chart) => chart.renderToSVGString(), {
        width: 600,
        height: 400,
      });
      assert.match(svg, />2024-01-03</, type);
    }
  });
});
