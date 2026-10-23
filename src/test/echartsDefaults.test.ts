import * as assert from "node:assert";
import type { ChartSpec } from "../chartSpec";
import { modelOf } from "../webview/echartsItems";
import { bars, builtOption, layout, type Option, svgOf, withChart } from "./echartsModel";

suite("echartsDefaults", () => {
  test("names the whole of an unnamed treemap in its breadcrumb", () => {
    const treemap = { type: "treemap", data: [{ name: "src", value: 1 }] };
    const name = (option: Option) => layout(option).series.map((each: Option) => each.name);
    const source = { series: [treemap] };
    assert.deepStrictEqual(name(source), ["All"]);
    assert.strictEqual(Object.hasOwn(treemap, "name"), false);
    assert.deepStrictEqual(name({ series: [{ ...treemap, name: "" }] }), ["All"]);
    // Not one named, nor one without a breadcrumb, nor one beside another series, whose items go
    // by its name, nor a sunburst, whose tooltips show it.
    assert.deepStrictEqual(name({ series: [{ ...treemap, name: "Files" }] }), ["Files"]);
    assert.deepStrictEqual(name({ series: [{ ...treemap, breadcrumb: { show: false } }] }), [
      undefined,
    ]);
    assert.deepStrictEqual(name({ series: [treemap, treemap] }), [undefined, undefined]);
    assert.deepStrictEqual(name({ series: [{ ...treemap, type: "sunburst" }] }), [undefined]);
  });

  test("labels large values on value axes compactly, unless the axis formats them", () => {
    const option = layout(
      bars({
        series: [{ type: "bar", data: [2e12, 3.5e12] }],
        singleAxis: [{ type: "category" }, { axisLabel: { formatter: "{value} ms" } }],
        parallel: { parallelAxisDefault: { type: "category" } },
        parallelAxis: [{ dim: 0 }, { dim: 1, type: "log" }],
      }),
    );
    const format = option.yAxis.axisLabel.formatter;
    assert.deepStrictEqual(
      [0, 0.25, 999, 2015.5, -9999, 12_500, -25_000, 1_025_000, 1e9, 3.5e12].map(format),
      ["0", "0.25", "999", "2015.5", "-9999", "12.5K", "-25K", "1.025M", "1B", "3.5T"],
    );
    assert.strictEqual(option.xAxis.axisLabel, undefined);
    assert.deepStrictEqual(
      [...option.singleAxis, ...option.parallelAxis].map((axis: Option) => axis.axisLabel),
      [undefined, { formatter: "{value} ms" }, undefined, { formatter: format }],
    );
    const svg = svgOf(option);
    assert.match(svg, />3T</);
    assert.doesNotMatch(svg, /000,000/);
  });

  test("groups and rounds the values that labels and item tooltips fill into templates", () => {
    const source = {
      tooltip: { formatter: "{a}<br/>{b}: {c} ({d}%)" },
      series: [
        {
          type: "pie",
          name: "Size <MiB>",
          label: { formatter: "{b}: {c}" },
          data: [
            { name: "A & B", value: 0.1 + 0.2 },
            { name: "C", value: 1234567.5 },
          ],
        },
        // Placeholders that only ECharts fills in, and a template without a value.
        { type: "funnel", label: { formatter: "{@score}: {c}" }, tooltip: { formatter: "{b}" } },
      ],
    };
    const option = layout(source);
    const svg = svgOf(option);
    assert.match(svg, />A &amp; B: 0\.3</);
    assert.match(svg, />C: 1,234,567\.5</);
    const tooltip = option.tooltip.formatter;
    const params = { seriesName: "Size <MiB>", name: "A & B", value: 0.1 + 0.2, percent: 12.5 };
    assert.strictEqual(tooltip(params), "Size &lt;MiB&gt;<br/>A &amp; B: 0.3 (12.5%)");
    assert.deepStrictEqual(
      [option.series[1].label.formatter, option.series[1].tooltip.formatter],
      ["{@score}: {c}", "{b}"],
    );
    // The same formatters in each layout, which only needs the chart resized.
    assert.strictEqual(layout(source, { width: 900 }).tooltip.formatter, tooltip);
    // Not that of a tooltip of axes, which lists every series.
    const axis = layout(bars({ tooltip: { trigger: "axis", formatter: "{b}: {c}" } }));
    assert.strictEqual(axis.tooltip.formatter, "{b}: {c}");
  });

  test("heads the tooltip of a time axis by the time as the axis labels it", () => {
    const source = {
      xAxis: { type: "time" },
      yAxis: {},
      series: [{ type: "line", data: [["2026-01-02", 1]] }],
    };
    const option = layout(source);
    const formatter = option.xAxis.axisPointer.label.formatter;
    assert.strictEqual(formatter({ value: new Date(2026, 0, 2).getTime() }), "2026-01-02");
    assert.strictEqual(
      formatter({ value: new Date(2026, 0, 2, 10, 30).getTime() }),
      "2026-01-02 10:30:00",
    );
    assert.strictEqual(option.yAxis.axisPointer, undefined);
    // The same formatter in each layout, which only needs the chart resized.
    assert.strictEqual(layout(source, { width: 900 }).xAxis.axisPointer.label.formatter, formatter);
    // In UTC where the option labels its axes in it.
    const utc = layout({ ...source, useUTC: true }).xAxis.axisPointer.label.formatter;
    assert.strictEqual(utc({ value: Date.UTC(2026, 0, 2, 10, 30) }), "2026-01-02 10:30:00");
    assert.strictEqual(utc({ value: Date.UTC(2026, 0, 2) }), "2026-01-02");
    assert.strictEqual(
      layout({ ...source, useUTC: true }, { width: 900 }).xAxis.axisPointer.label.formatter,
      utc,
    );
    // Not where the option formats the pointer's label itself, for the axis or for all.
    const own = [
      { ...source, xAxis: { type: "time", axisPointer: { label: { formatter: "{value}" } } } },
      { ...source, tooltip: { axisPointer: { label: { formatter: "{value}" } } } },
      { ...source, axisPointer: { label: { formatter: "{value}" } } },
    ];
    for (const each of own) {
      assert.notStrictEqual(layout(each).xAxis.axisPointer?.label?.formatter, formatter);
    }
  });

  test("labels years on the value axis of a scatter chart as years", () => {
    const data = "year,sales\n2015,10\n2016,12\n2017,9\n2018,15";
    const option = layout(builtOption({ data, type: "scatter" } as ChartSpec, data));
    const svg = svgOf(option);
    assert.match(svg, />2015</);
    assert.match(svg, />2016\.5</);
    assert.doesNotMatch(svg, /K</);
  });

  test("gives sankey nodes their own palette colors, also beyond eight", () => {
    const nodes = Array.from({ length: 10 }, (_, index) => ({ name: `N${index}` }));
    const option = layout({ series: [{ type: "sankey", data: nodes }] });
    assert.strictEqual(option.series[0].data[9].itemStyle.color, "#090000");
    // The nodes of the same name in two stages share a color.
    const stages = layout({
      series: [
        {
          type: "sankey",
          data: [
            { id: "Yes (q1)", name: "Yes" },
            { id: "No (q1)", name: "No" },
            { id: "Yes (q2)", name: "Yes" },
            { name: "Maybe" },
          ],
        },
      ],
    });
    assert.deepStrictEqual(
      stages.series[0].data.map((node: Option) => node.itemStyle.color),
      ["#000000", "#010000", "#000000", "#020000"],
    );
  });

  test("says the row of a heatmap's cell in its tooltip, which ECharts names by its column", () => {
    const source = {
      xAxis: { type: "category", data: [9, 10] },
      yAxis: { type: "category", data: ["Mon", { value: "Tue" }] },
      visualMap: { min: 0, max: 2000 },
      series: [
        {
          type: "heatmap",
          name: "n <b>",
          data: [
            [1, 1, 1234.5],
            ["9", "Mon", 0.1 + 0.2],
          ],
        },
      ],
    };
    const option = layout(source);
    const formatter = option.series[0].tooltip.formatter;
    const marker = "<span>●</span>";
    assert.strictEqual(
      formatter({ seriesName: "n <b>", name: "10", value: [1, 1, 1234.5], marker }),
      "n &lt;b&gt;<br/><span>●</span>10, Tue&nbsp;&nbsp;<b>1,234.5</b>",
    );
    assert.strictEqual(
      formatter({ seriesName: "series\u00000", name: "9", value: ["9", "Mon", 0.1 + 0.2], marker }),
      "<span>●</span>9, Mon&nbsp;&nbsp;<b>0.3</b>",
    );
    // The same formatter in each layout, which only needs the chart resized.
    assert.strictEqual(layout(source, { width: 900 }).series[0].tooltip.formatter, formatter);
    // The row and the value where the series encodes them, as a dataset's rows hold them by name
    // and a cell's columns can come in any order, as ECharts tells the formatter.
    const params = (option: Option) =>
      withChart(layout(option), (chart) => {
        const series = modelOf(chart).getSeriesByIndex(0) as unknown as {
          getDataParams(index: number): Option;
        };
        return series.getDataParams(0);
      });
    const encoded = [
      {
        ...source,
        xAxis: { type: "category", data: ["9", "10"] },
        dataset: { source: [{ day: "Mon", hour: "9", n: 3 }] },
        series: [{ type: "heatmap", encode: { x: "hour", y: "day", value: "n" } }],
      },
      {
        ...source,
        series: [{ type: "heatmap", data: [[3, "Mon", 9]], encode: { value: 0, y: 1, x: 2 } }],
      },
    ];
    for (const each of encoded) {
      assert.strictEqual(
        layout(each).series[0].tooltip.formatter({ ...params(each), marker }),
        "<span>●</span>9, Mon&nbsp;&nbsp;<b>3</b>",
        JSON.stringify(each.series),
      );
    }
    // Not where the option formats the tooltip or its values itself, nor off a grid.
    const own = layout({ ...source, tooltip: { formatter: "{b}" } });
    assert.strictEqual(own.series[0].tooltip, undefined);
    const valued = layout({ ...source, tooltip: { valueFormatter: (value: unknown) => value } });
    assert.strictEqual(valued.series[0].tooltip, undefined);
    const calendar = layout({
      calendar: { range: "2026-01" },
      visualMap: { min: 0, max: 1 },
      series: [{ type: "heatmap", coordinateSystem: "calendar", data: [["2026-01-02", 1]] }],
    });
    assert.strictEqual(calendar.series[0].tooltip, undefined);
  });

  test("defaults tooltips, selection and screen reader support", () => {
    const option = layout(bars());
    assert.deepStrictEqual(option.tooltip, {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      confine: true,
    });
    assert.strictEqual(option.series[0].selectedMode, "multiple");
    // Outlined in the foreground color, which stands out on items of any color, as one of the
    // focus color would not on an item of a color like it, and in a glow of the focus color.
    const { borderColor, shadowColor } = option.series[0].select.itemStyle;
    assert.deepStrictEqual([borderColor, shadowColor], ["#cccccc", "rgba(0, 120, 212, 0.7)"]);
    assert.deepStrictEqual(option.aria, { enabled: true });
  });

  test("lets bars be as wide as their series sets, or a histogram's fill its bins", () => {
    const maxWidth = (series: Option) =>
      layout(bars({ series: [{ type: "bar", data: [1, 2], ...series }] })).series[0].barMaxWidth;
    assert.strictEqual(maxWidth({ barCategoryGap: "0%" }), "100%");
    // Separated as the segments of a stack are, rather than rounded.
    const itemStyle = (series: Option) => layout(bars({ series: [series] })).series[0].itemStyle;
    assert.deepStrictEqual(
      itemStyle({ type: "bar", barCategoryGap: "0%" }),
      itemStyle({ type: "bar", stack: "s" }),
    );
    assert.strictEqual(maxWidth({ barWidth: 60 }), "100%");
    for (const gap of [0, "0", "0px", "0%"]) {
      assert.strictEqual(maxWidth({ barCategoryGap: gap }), "100%", String(gap));
    }
    // Not for bars only further apart than usual.
    assert.strictEqual(maxWidth({ barCategoryGap: "40%" }), undefined);
    assert.strictEqual(maxWidth({ barWidth: 60, barMaxWidth: 40 }), 40);
    // The theme's, for bars of the usual gaps.
    assert.strictEqual(maxWidth({}), undefined);
  });

  test("rounds the data ends of bars, unless a bar may point the other way", () => {
    const radius = (option: Option) => layout(option).series[0].itemStyle.borderRadius;
    assert.deepStrictEqual(radius(bars()), [4, 4, 0, 0]);
    // Bars go along the axis of categories, which an axis with data is, or else of time.
    const across = (xAxis: Option, yAxis: Option) => radius(bars({ xAxis, yAxis }));
    assert.deepStrictEqual(across({}, { data: ["A", "B"] }), [0, 4, 4, 0]);
    assert.deepStrictEqual(across({ type: "value" }, { type: "time" }), [0, 4, 4, 0]);
    assert.deepStrictEqual(across({ data: ["A"] }, { type: "category" }), [4, 4, 0, 0]);
    assert.deepStrictEqual(across({ type: "time" }, { type: "time" }), [4, 4, 0, 0]);
    assert.deepStrictEqual(across({ inverse: true }, { data: ["A"] }), [4, 0, 0, 4]);
    assert.deepStrictEqual(across({ data: ["A"] }, { inverse: true }), [0, 0, 4, 4]);
    assert.strictEqual(
      radius(bars({ series: [{ type: "bar", data: [{ value: -1 }] }] })),
      undefined,
    );
    const polar = { type: "bar", coordinateSystem: "polar", data: [1, 2] };
    assert.strictEqual(radius(bars({ series: [polar] })), undefined);
    const fromDataset = (source: unknown, extra: Option = {}) =>
      radius(
        bars({
          dataset: [{ source }, { fromDatasetIndex: 0 }],
          series: [{ type: "bar", ...extra }],
        }),
      );
    assert.deepStrictEqual(fromDataset([["A", 1]]), [4, 4, 0, 0]);
    assert.strictEqual(fromDataset([["A", -1]]), undefined);
    assert.strictEqual(fromDataset([{ name: "A", value: -1 }]), undefined);
    assert.strictEqual(fromDataset([{ name: "A", value: 1, change: -1 }]), undefined);
    assert.strictEqual(fromDataset({ name: ["A"], value: [-1] }), undefined);
    assert.strictEqual(fromDataset([["A", -1]], { datasetIndex: 1 }), undefined);
  });

  test("samples long lines and draws many alike points as one shape, as generated charts do", () => {
    const many = Array.from({ length: 2000 }, (_, index) => [index, index % 7]);
    const drawn = (series: Option, extra: Option = {}) => {
      const [laidOut] = layout({ xAxis: {}, yAxis: {}, series: [series], ...extra }).series;
      return { sampling: laidOut.sampling, large: laidOut.large };
    };
    const line = { type: "line", data: many };
    const scatter = { type: "scatter", data: many };
    assert.deepStrictEqual(drawn(line), { sampling: "lttb", large: undefined });
    assert.deepStrictEqual(drawn(scatter), { sampling: undefined, large: true });
    // Points from a dataset, by rows or by columns.
    const fromDataset = (source: unknown) =>
      drawn({ type: "line" }, { dataset: { source } }).sampling;
    assert.strictEqual(fromDataset(many), "lttb");
    assert.strictEqual(fromDataset({ x: many.map(([x]) => x), y: many.map(([, y]) => y) }), "lttb");
    // Series of fewer points stay as they are, and so do explicit choices.
    const asIs = { sampling: undefined, large: undefined };
    assert.deepStrictEqual(drawn({ ...line, data: many.slice(1) }), asIs);
    assert.deepStrictEqual(drawn({ ...scatter, data: many.slice(1) }), asIs);
    assert.strictEqual(drawn({ ...line, sampling: false }).sampling, false);
    assert.strictEqual(drawn({ ...scatter, large: false }).large, false);
    // Stacked lines would misalign, and statistics of the points would change.
    assert.strictEqual(drawn({ ...line, stack: "total" }).sampling, undefined);
    const average = { data: [{ type: "average" }] };
    assert.strictEqual(drawn({ ...line, markLine: average }).sampling, undefined);
    assert.strictEqual(
      drawn({ ...line, markLine: { data: [[{ xAxis: 1 }, { xAxis: 2 }]] } }).sampling,
      "lttb",
    );
    // One shape draws every point alike.
    const styled = many.map((value, index) => (index ? value : { value, itemStyle: {} }));
    assert.strictEqual(drawn({ ...scatter, data: styled }).large, undefined);
    assert.strictEqual(drawn({ ...scatter, symbolSize: () => 4 }).large, undefined);
    assert.strictEqual(drawn(scatter, { visualMap: { dimension: 1 } }).large, undefined);
    assert.strictEqual(drawn({ ...scatter, coordinateSystem: "polar" }).large, undefined);
  });

  test("counts dataset points along the configured series orientation", () => {
    const points = Array.from({ length: 2500 }, (_, index) => index);
    const sampling = (dataset: Option, series: Option = {}) =>
      layout({
        xAxis: {},
        yAxis: {},
        dataset,
        series: [{ type: "line", ...series }],
      }).series[0].sampling;
    const rows = { source: [points, points], sourceHeader: false };
    assert.strictEqual(sampling(rows, { seriesLayoutBy: "row" }), "lttb");
    assert.strictEqual(sampling({ ...rows, seriesLayoutBy: "row" }), "lttb");
    assert.strictEqual(sampling(rows), undefined);
    assert.strictEqual(
      sampling({ ...rows, seriesLayoutBy: "row" }, { seriesLayoutBy: "column" }),
      undefined,
    );
    // Many dimensions with only two points must not be mistaken for a long series.
    assert.strictEqual(
      sampling({ source: points.map((point) => [point, point]), seriesLayoutBy: "row" }),
      undefined,
    );
    // seriesLayoutBy applies to datasets, not a series' own data.
    assert.strictEqual(sampling(rows, { data: points, seriesLayoutBy: "row" }), "lttb");
  });

  test("draws the axis lines that the theme hides on value axes outside a grid", () => {
    const option = layout({
      polar: {},
      angleAxis: { type: "value", axisTick: { show: false } },
      radiusAxis: {},
      parallel: [{}, { parallelAxisDefault: { axisLine: { show: false } } }],
      parallelAxis: [{ dim: 0 }, { dim: 1, parallelIndex: 1 }],
      series: [{ type: "bar", coordinateSystem: "polar", data: [1] }],
    });
    assert.deepStrictEqual(option.angleAxis.axisLine, { show: true });
    assert.deepStrictEqual(option.angleAxis.axisTick, { show: false });
    assert.strictEqual(option.radiusAxis.axisLine, undefined);
    assert.deepStrictEqual(
      option.parallelAxis.map((axis: Option) => axis.axisLine.show),
      [true, false],
    );
  });
});
