import * as assert from "node:assert";
import { init as initECharts } from "echarts";
import type { ChartSpec } from "../chartSpec";
import { buildChart } from "../charts";
import { parseTable } from "../data";
import { layoutOption } from "../webview/echartsLayout";
import { testColors as colors } from "./themeColors";

// biome-ignore lint/suspicious/noExplicitAny: inspect plain JSON chart options in tests.
type Option = Record<string, any>;
function build(data: string, spec: Partial<ChartSpec> = {}): Option {
  const chart = buildChart(
    { type: "bar", data, facetColumn: "service", ...spec } as ChartSpec,
    parseTable(data),
  );
  assert.deepStrictEqual(JSON.parse(JSON.stringify(chart.option)), chart.option);
  return chart.option;
}

suite("chart facets", () => {
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
      option.series.map((series: Option) => series.name),
      ["api · ms", "worker · ms"],
    );
    assert.deepStrictEqual(
      option.series.map((series: Option) => series.xAxisIndex),
      [0, 1],
    );
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
    const option = build("service,operation,a,b,c\napi,read,10,20,-5\nworker,read,-20,-15,3", {
      type: "stackedBar",
      valueColumns: ["a", "b", "c"],
    });
    assert.deepStrictEqual(
      option.yAxis.map((axis: Option) => [axis.min, axis.max]),
      [
        [-35, 30],
        [-35, 30],
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
          [0, 90],
          [0, 90],
        ],
        type,
      );
      assert.strictEqual(option.series[0].data.length, 2);
    }
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
        const chart = initECharts(null, undefined, {
          renderer: "svg",
          ssr: true,
          width: 800,
          height: 600,
        });
        try {
          chart.setOption({ ...option, animation: false });
          const localEnd = new Date(2026, 1, 1, hour).getTime();
          const endPixel = chart.convertToPixel({ xAxisIndex: 1 }, localEnd);
          const boundPixel = chart.convertToPixel({ xAxisIndex: 1 }, option.xAxis[1].max);
          assert.strictEqual(endPixel, boundPixel, end);
        } finally {
          chart.dispose();
        }
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
      option.series.map((series: Option) => series.name),
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
      option.series.map((series: Option) => series.name),
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
      option.series.map((series: Option) => series.name),
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
    assert.notStrictEqual(option.series[0].name, option.series[1].name);
    assert.notStrictEqual(option.title[0].id, option.title[1].id);
  });

  test("selection names stay unique for ambiguous missing labels and delimiter collisions", () => {
    const missing = build(
      '[{"service":null,"operation":"read","ms":2},{"service":"(missing)","operation":"read","ms":3},{"service":"(missing value)","operation":"read","ms":4}]',
    );
    assert.strictEqual(new Set(missing.series.map((series: Option) => series.name)).size, 3);
    const delimiters = build("service,operation,c,b · c\na · b,read,2,3\na,read,4,5", {
      valueColumns: ["c", "b · c"],
    });
    assert.strictEqual(new Set(delimiters.series.map((series: Option) => series.name)).size, 4);
    assert.strictEqual(new Set(delimiters.series.map((series: Option) => series.id)).size, 4);
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

  test("multi-grid label fitting uses the panel width without changing explicit grid positions", () => {
    const option = build(
      "service,operation,ms\napi,Read configuration,2\napi,Write configuration,3\nworker,Read configuration,30\nworker,Write configuration,40",
    );
    const laidOut = layoutOption(option, {
      width: 600,
      height: 500,
      title: "My chart",
      colors,
      reducedMotion: true,
    }) as Option;
    assert.deepStrictEqual(laidOut.grid, option.grid);
    assert.ok(laidOut.xAxis.every((axis: Option) => axis.axisLabel.rotate > 0));
  });

  test("validates facet types, names and group count instead of dropping groups", () => {
    assert.throws(
      () => build("service,ms\na,2", { type: "pie" }),
      /Faceting is not supported.*clear facetColumn/,
    );
    assert.throws(
      () => build("service,ms\na,2", { facetColumn: "unknown" }),
      /Unknown facet column.*Available columns/,
    );
    assert.throws(
      () => build(`service,ms\n${Array.from({ length: 13 }, (_, i) => `s${i},${i}`).join("\n")}`),
      /more than 12 groups.*at most 12.*Filter/,
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
    const laidOut = layoutOption(option, {
      width: 400,
      height: 500,
      title: "My chart",
      colors,
      reducedMotion: true,
    }) as Option;
    assert.deepStrictEqual(laidOut.grid, option.grid);
    assert.strictEqual(laidOut.title[0].text, "service = api");
    assert.strictEqual(laidOut.title[0].textStyle.fontSize, 17);
    assert.strictEqual(laidOut.series[1].xAxisIndex, 1);
    assert.notStrictEqual(laidOut.grid[0].left, laidOut.grid[1].left);
  });

  test("renders all facet grids and titles as actual ECharts SVG", () => {
    const option = build("service,operation,ms\napi,read,2\nworker,write,30");
    const chart = initECharts(null, undefined, {
      renderer: "svg",
      ssr: true,
      width: 800,
      height: 600,
    });
    try {
      chart.setOption({ ...option, animation: false });
      const svg = chart.renderToSVGString();
      assert.match(svg, /service = api/);
      assert.match(svg, /service = worker/);
      assert.match(svg, />read<\/text>/);
      assert.match(svg, />write<\/text>/);
      const x1 = chart.convertToPixel({ xAxisIndex: 0 }, "read");
      const x2 = chart.convertToPixel({ xAxisIndex: 1 }, "read");
      assert.ok(typeof x1 === "number" && typeof x2 === "number" && x2 > x1 + 100);
    } finally {
      chart.dispose();
    }
  });
});
