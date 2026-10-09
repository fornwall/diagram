import * as assert from "node:assert";
import type { ChartSpec } from "../chartSpec";
import { modelOf } from "../webview/echartsItems";
import { toolWarnings } from "../webview/echartsLayout";
import type { JsonObject } from "../webview/echartsOption";
import { builtOption, layout, type Option, withChart } from "./echartsModel";
import { testColors as colors } from "./themeColors";

const bars = (extra: Option = {}): Option => ({
  xAxis: { type: "category", data: ["A", "B"] },
  yAxis: { type: "value" },
  series: [{ type: "bar", data: [1, 2] }],
  ...extra,
});

suite("echartsLayout", () => {
  test("leaves out the toolbox features that a new layout would undo", () => {
    const feature = {
      saveAsImage: {},
      dataView: { lang: ["Data"] },
      magicType: { type: ["line", "bar"] },
      dataZoom: {},
      brush: {},
      restore: {},
    };
    const source = bars({ toolbox: { feature } });
    assert.deepStrictEqual(layout(source).toolbox.feature, {
      saveAsImage: {},
      dataView: { lang: ["Data"], readOnly: true },
      restore: {},
    });
    assert.ok(source.toolbox.feature.magicType);
    // A model that asked for them hears why they are not there, and what to use instead.
    assert.deepStrictEqual(toolWarnings(source), [
      'The panel leaves the toolbox features "magicType", "dataZoom", "brush" out of the chart, ' +
        "as it lays the chart out again whenever its size changes, which would undo what they " +
        "change: instead, render each chart type as a chart of its own, and zoom with a " +
        '"dataZoom" component of type "inside" or "slider".',
    ]);
    assert.deepStrictEqual(toolWarnings(bars({ toolbox: { feature: { dataView: {} } } })), []);
    assert.match(
      toolWarnings(bars({ toolbox: { feature: { dataView: { readOnly: false } } } })).join(),
      /^The panel shows the toolbox's data view read-only/,
    );
    assert.match(
      toolWarnings({ baseOption: bars({ toolbox: [{ feature: { brush: {} } }] }) }).join(),
      /toolbox feature "brush" out of the chart, .* undo what it changes\.$/,
    );
    assert.match(toolWarnings(bars({ brush: {} })).join(), /toolbox feature "brush" out/);
  });

  test("leaves out the passing toolbox features of timeline steps and media queries", () => {
    const toolbox = { feature: { magicType: { type: ["line"] }, restore: {} } };
    const source = {
      baseOption: bars({ timeline: { data: ["2025"] } }),
      options: [{ toolbox }],
      media: [{ option: { toolbox: [toolbox] } }],
    };
    const laidOut = layout(source);
    assert.deepStrictEqual(laidOut.options[0].toolbox.feature, { restore: {} });
    assert.deepStrictEqual(laidOut.media[0].option.toolbox[0].feature, { restore: {} });
    assert.match(toolWarnings(source).join(), /toolbox feature "magicType" out/);
    assert.match(
      toolWarnings({ ...bars(), options: [{ brush: {} }] }).join(),
      /toolbox feature "brush" out/,
    );
  });

  test("leaves the source option untouched", () => {
    const source = bars();
    const copy = structuredClone(source);
    layout(source);
    assert.deepStrictEqual(source, copy);
  });

  test("lays out an option that holds functions, leaving the source option untouched", () => {
    const renderItem = () => ({ type: "rect" });
    const formatter = () => "";
    const data = [1, 2];
    const source: Option = {
      xAxis: { type: "category", data: ["A", "B"] },
      yAxis: { type: "value" },
      tooltip: { formatter },
      series: [{ type: "custom", renderItem, data }],
    };
    const option = layout(source);
    assert.strictEqual(option.series[0].renderItem, renderItem);
    assert.strictEqual(option.tooltip.formatter, formatter);
    assert.strictEqual(option.grid.left, 8);
    // Data arrays are shared: the layout only ever writes to option and component objects.
    assert.strictEqual(option.series[0].data, data);
    assert.strictEqual(source.series[0].selectedMode, undefined);
    assert.strictEqual(source.tooltip.confine, undefined);
    assert.strictEqual(source.grid, undefined);
  });

  test("lays out a series with a prototype of its own, leaving the source option untouched", () => {
    // A series can be written as {__proto__: {type: "pie"}, …}, which is valid JavaScript.
    const series: Option = { data: [{ name: "a", value: 1 }] };
    Object.setPrototypeOf(series, { type: "pie" });
    const source = { series: [series], legend: {} };
    const box = ({ left, right, top, radius }: Option) => [left, right, top, radius];
    const wide = layout(source, { width: 1400, height: 900 });
    assert.deepStrictEqual(box(wide.series[0]), [8, 94, 8, "68%"]);
    assert.deepStrictEqual(Object.keys(series), ["data"]);
    // The first layout is not written to the source, so a second one is not stale.
    const narrow = layout(source, { width: 300, height: 220 });
    assert.deepStrictEqual(box(narrow.series[0]), [8, 8, 8, "90%"]);
  });

  test("lays out a series written as a class instance, leaving the source option untouched", () => {
    const node = { name: "a" };
    class Sankey {
      type = "sankey";
      data = [node];
    }
    const series = new Sankey();
    const option = layout({ series: [series] });
    assert.strictEqual(option.series[0].top, 12);
    assert.strictEqual(option.series[0].data[0].itemStyle.color, "#000000");
    assert.deepStrictEqual(Object.keys(series), ["type", "data"]);
    assert.deepStrictEqual(Object.keys(node), ["name"]);
  });

  test("copies an own __proto__ key as data, not as the prototype of the copy", () => {
    // JSON.parse does produce an own "__proto__" key, unlike an object literal.
    const legend: JsonObject = JSON.parse('{"__proto__": {"show": false}, "x": 1}');
    const option = layout(bars({ legend }));
    assert.strictEqual(Object.getPrototypeOf(option.legend), Object.prototype);
    assert.deepStrictEqual(Object.getOwnPropertyDescriptor(option.legend, "__proto__")?.value, {
      show: false,
    });
    // The legend is laid out, rather than inheriting the "show": false of the copied key.
    const { show, x, type, top } = option.legend;
    assert.deepStrictEqual([show, x, type, top], [undefined, 1, "scroll", 6]);
  });

  test("keeps a date and a typed array in chart data as they are", () => {
    const point = new Date(86_400_000);
    const time = { xAxis: { type: "time" }, series: [{ type: "line", data: [[point, 1]] }] };
    const copied = layout(time).series[0].data[0][0];
    assert.ok(copied instanceof Date && copied.getTime() === point.getTime(), String(copied));
    assert.deepStrictEqual(Object.keys(copied), []);
    // Sankey nodes are written to, but the source's date is not.
    const node = new Date(0);
    layout({ series: [{ type: "sankey", data: [node] }] });
    assert.deepStrictEqual(Object.keys(node), []);
    const data = new Float64Array([1, 2, 3]);
    assert.strictEqual(layout(bars({ series: [{ type: "bar", data }] })).series[0].data, data);
  });

  test("shares read-only points, hierarchy nodes and dataset rows across layouts", () => {
    const points = Object.freeze([Object.freeze({ value: [1, 2], name: "A" })]);
    const nodes = Object.freeze([
      Object.freeze({ name: "parent", children: Object.freeze([{ name: "child", value: 2 }]) }),
    ]);
    const rows = Object.freeze([Object.freeze({ category: "A", value: 2 })]);
    const links = Object.freeze([Object.freeze({ source: "A", target: "B" })]);
    const source = {
      dataset: { source: rows },
      baseOption: {
        series: [
          { type: "line", data: points },
          { type: "treemap", data: nodes },
          { type: "graph", nodes, links },
        ],
      },
      options: [{ series: [{ data: points }] }],
      media: [{ option: { series: [{ data: points }] } }],
    };
    for (const width of [300, 800]) {
      const option = layout(source, { width, reducedMotion: true });
      assert.strictEqual(option.dataset.source, rows);
      assert.strictEqual(option.baseOption.series[0].data, points);
      assert.strictEqual(option.baseOption.series[1].data, nodes);
      assert.strictEqual(option.baseOption.series[2].nodes, nodes);
      assert.strictEqual(option.baseOption.series[2].links, links);
      assert.strictEqual(option.options[0].series[0].data, points);
      assert.strictEqual(option.media[0].option.series[0].data, points);
      assert.strictEqual(option.options[0].series[0].animation, false);
    }
    assert.deepStrictEqual(source.options, [{ series: [{ data: points }] }]);
  });

  test("copies sankey nodes before styling, preserving source styles across themes", () => {
    const nodes = Object.freeze([
      Object.freeze({ name: "A", itemStyle: Object.freeze({ borderWidth: 2 }) }),
      Object.freeze({ name: "B", itemStyle: Object.freeze({ color: "red" }) }),
    ]);
    for (const key of ["data", "nodes"]) {
      const source = { series: [{ type: "sankey", [key]: nodes }] };
      const first = layout(source).series[0][key];
      const second = layout(source, { colors: { ...colors, palette: [colors.focus] } }).series[0][
        key
      ];
      assert.deepStrictEqual(first[0].itemStyle, { borderWidth: 2, color: "#000000" });
      assert.deepStrictEqual(second[0].itemStyle, { borderWidth: 2, color: "#0078d4" });
      assert.deepStrictEqual(first[1].itemStyle, { color: "red" });
      assert.deepStrictEqual(nodes[0]?.itemStyle, { borderWidth: 2 });
    }
  });

  test("respects reduced motion in timeline, media, and series overrides", () => {
    const animated = bars({ animation: true, series: [{ type: "bar", animation: true }] });
    const source = {
      baseOption: animated,
      options: [animated],
      media: [{ query: { maxWidth: 400 }, option: animated }],
    };
    const option = layout(source, { reducedMotion: true });
    for (const variant of [option.baseOption, option.options[0], option.media[0].option]) {
      assert.strictEqual(variant.animation, false);
      assert.strictEqual(variant.series[0].animation, false);
    }
    assert.strictEqual(animated.animation, true);
    assert.strictEqual(animated.series[0].animation, true);
    const unchanged = layout(animated);
    assert.strictEqual(unchanged.animation, true);
    assert.strictEqual(unchanged.series[0].animation, true);
  });

  test("hides a chart title that repeats the panel title", () => {
    assert.strictEqual(
      layout(bars({ title: { text: "Sales" } }), { title: "sales" }).title.show,
      false,
    );
    const subtitled = layout(bars({ title: { text: "Sales", subtext: "2026" } }), {
      title: "Sales",
    });
    assert.deepStrictEqual([subtitled.title.text, subtitled.title.subtext], ["", "2026"]);
  });

  test("reserves room for a title on the side it is placed, and truncates a long one", () => {
    const grid = (title: Option) => {
      const { top, bottom } = layout(bars({ title })).grid;
      return [top, bottom];
    };
    assert.deepStrictEqual(grid({ text: "T" }), [46, 8]);
    assert.deepStrictEqual(grid({ text: "T", top: "bottom" }), [14, 40]);
    assert.deepStrictEqual(grid({ text: "T", bottom: 0 }), [14, 40]);
    assert.deepStrictEqual(grid({ text: "T", top: "middle" }), [14, 8]);
    const { textStyle, subtextStyle } = layout(
      bars({ title: { text: "T", textStyle: { width: 50 } } }),
      {
        width: 300,
      },
    ).title;
    assert.deepStrictEqual(textStyle, { width: 50, overflow: "truncate" });
    assert.deepStrictEqual(subtextStyle, { width: 284, overflow: "truncate" });
  });

  test("adds a legend for several named series, beside non-grid charts when there is room", () => {
    const named = bars({
      series: [
        { type: "bar", name: "One", data: [1, 2] },
        { type: "bar", name: "Two", data: [3, 4] },
      ],
    });
    assert.strictEqual(layout(named).legend.top, 6);
    assert.strictEqual(layout(named, { width: 400 }).legend.bottom, 6);
    const pie = {
      series: [
        { type: "pie", name: "A" },
        { type: "pie", name: "B" },
      ],
    };
    assert.strictEqual(layout(pie).legend.orient, "vertical");
    // A legend told only which way to go goes that way beside the chart.
    assert.strictEqual(layout({ ...pie, legend: { orient: "horizontal" } }).legend.bottom, 6);
    const vertical = layout(bars({ legend: { orient: "vertical" } }));
    assert.deepStrictEqual([vertical.legend.right, vertical.legend.top], [8, "middle"]);
    assert.ok(vertical.grid.right > 60, String(vertical.grid.right));
    // One placed only up and down goes on the right too, where ECharts would center it.
    const top = layout(bars({ legend: { orient: "vertical", top: 0 } }));
    assert.deepStrictEqual([top.legend.right, top.legend.top], [8, 0]);
    assert.strictEqual(top.grid.right, vertical.grid.right);
    const left = layout(bars({ legend: { orient: "vertical", left: 0 } }));
    assert.deepStrictEqual([left.legend.right, left.grid.left > 60], [undefined, true]);
  });

  test("makes room for a pie's legend by the names of its slices", () => {
    const pie = (name: string, value: number) => ({
      legend: {},
      series: [{ type: "pie", data: [{ name, value }] }],
    });
    const long = layout(pie("A rather long name for a slice", 1)).series[0].right;
    assert.ok(long > layout(pie("A", 123_456_789)).series[0].right, String(long));
  });

  test("keeps explicit choices", () => {
    const option = layout(
      bars({ legend: { left: 0 }, grid: { left: 1 }, tooltip: { trigger: "item" }, aria: {} }),
    );
    assert.deepStrictEqual(option.legend, { left: 0, type: "scroll" });
    assert.deepStrictEqual(option.grid, { left: 1 });
    assert.deepStrictEqual(option.tooltip, { trigger: "item", confine: true });
    assert.deepStrictEqual(option.aria, {});
  });

  test("reserves room for a placed legend on the side ECharts shows it", () => {
    const bottom = layout(bars({ legend: { left: 0 } })).grid;
    assert.deepStrictEqual([bottom.top, bottom.bottom], [14, 40]);
    const top = layout(bars({ legend: { top: 0 } })).grid;
    assert.deepStrictEqual([top.top, top.bottom], [44, 8]);
  });

  test("lays out the grid of an option with an empty list of grids", () => {
    const option = layout(bars({ title: { text: "T" }, grid: [] }));
    assert.deepStrictEqual(option.grid, layout(bars({ title: { text: "T" } })).grid);
    assert.strictEqual(option.grid.top, 46);
  });

  test("places sliders along the axis they control", () => {
    const option = layout(bars({ dataZoom: [{ type: "slider" }, { yAxisIndex: 0 }] }));
    assert.deepStrictEqual(option.dataZoom, [
      { type: "slider", bottom: 8, height: 22 },
      { yAxisIndex: 0, right: 8, width: 22 },
    ]);
    assert.strictEqual(option.grid.bottom, 46);
    assert.strictEqual(option.grid.right, 58);
  });

  test("does not reserve plot space for hidden zoom sliders", () => {
    const dataZoom = [
      { type: "slider", show: false },
      { yAxisIndex: 0, show: false },
    ];
    const option = layout(bars({ dataZoom }));
    assert.deepStrictEqual(option.grid, layout(bars()).grid);
    assert.deepStrictEqual(option.dataZoom, dataZoom);
  });

  test("lengthens a continuous visual map below the chart, but not the pieces of another", () => {
    const itemHeight = (visualMap: Option) => layout(bars({ visualMap })).visualMap.itemHeight;
    assert.strictEqual(itemHeight({ min: 0, max: 10 }), 200);
    assert.strictEqual(itemHeight({ min: 0, max: 10, splitNumber: 4, calculable: true }), 200);
    assert.strictEqual(itemHeight({ type: "piecewise" }), undefined);
    assert.strictEqual(itemHeight({ min: 0, max: 10, splitNumber: 4 }), undefined);
    assert.strictEqual(itemHeight({ pieces: [{ max: 5 }, { min: 5 }] }), undefined);
    assert.strictEqual(itemHeight({ categories: ["A", "B"] }), undefined);
  });

  test("rotates category labels that would overlap", () => {
    const labels = Array.from({ length: 20 }, (_, index) => `Category ${index}`);
    const option = layout(bars({ xAxis: { type: "category", data: labels } }));
    assert.strictEqual(option.xAxis.axisLabel.rotate, 30);
    assert.strictEqual(layout(bars()).xAxis.axisLabel, undefined);
  });

  test("measures labels of charts with very many categories", () => {
    const labels = Array.from({ length: 200_000 }, (_, index) => `Category ${index}`);
    const axis = { type: "category", data: labels };
    const option = layout(bars({ xAxis: axis, yAxis: axis, legend: { data: labels } }));
    assert.strictEqual(option.xAxis.axisLabel.rotate, 45);
  });

  test("stops measuring dense axes after rotation and truncation are decided", () => {
    let reads = 0;
    const label = {
      get value() {
        reads++;
        return "A very long category label ".repeat(10);
      },
    };
    const axis = { type: "category", data: Array(200_000).fill(label) };
    const option = layout(bars({ xAxis: axis, yAxis: axis }));
    assert.strictEqual(option.xAxis.axisLabel.rotate, 45);
    assert.strictEqual(option.xAxis.axisLabel.overflow, "truncate");
    assert.strictEqual(option.yAxis.axisLabel.overflow, "truncate");
    assert.strictEqual(reads, 2);
  });

  test("caps a pie legend without flattening or measuring every slice", () => {
    let reads = 0;
    const slice = {
      get name() {
        reads++;
        return "A very long slice name ".repeat(10);
      },
      value: 1,
    };
    const option = layout({
      legend: {},
      series: [{ type: "pie", data: Array(200_000).fill(slice) }],
    });
    assert.strictEqual(option.series[0].right, 280);
    assert.strictEqual(reads, 1);
  });

  test("keeps series laid out in a box clear of the title, with room for their labels", () => {
    const box = (type: string, extra: Option = {}) => {
      const { top, left, right, bottom } = layout({
        title: { text: "T" },
        series: [{ type, ...extra }],
      }).series[0];
      return [top, left, right, bottom];
    };
    assert.deepStrictEqual(box("treemap"), [44, 12, 12, 36]);
    assert.deepStrictEqual(box("treemap", { breadcrumb: { show: false } }), [44, 12, 12, 12]);
    assert.deepStrictEqual(box("tree"), [44, 96, 96, 12]);
    assert.deepStrictEqual(box("funnel"), [44, 80, 80, 12]);
    assert.deepStrictEqual(box("sankey"), [44, 12, 144, 12]);
    assert.deepStrictEqual(box("chord"), [44, 12, 12, 12]);
  });

  test("labels large values on value axes compactly, unless the axis formats them", () => {
    const option = layout(
      bars({
        series: [{ type: "bar", data: [2e12, 3.5e12] }],
        singleAxis: [{ type: "time" }, { axisLabel: { formatter: "{value} ms" } }],
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
    const svg = withChart(option, (chart) =>
      (chart as unknown as { renderToSVGString(): string }).renderToSVGString(),
    );
    assert.match(svg, />3T</);
    assert.doesNotMatch(svg, /000,000/);
  });

  test("labels years on the value axis of a scatter chart as years", () => {
    const data = "year,sales\n2015,10\n2016,12\n2017,9\n2018,15";
    const option = layout(builtOption({ data, type: "scatter" } as ChartSpec, data));
    const svg = withChart(option, (chart) =>
      (chart as unknown as { renderToSVGString(): string }).renderToSVGString(),
    );
    assert.match(svg, />2015</);
    assert.match(svg, />2016\.5</);
    assert.doesNotMatch(svg, /K</);
  });

  test("fits a graph of placed nodes into the space left, as ECharts fits it to the chart", () => {
    const option = layout({
      title: { text: "T" },
      legend: {},
      series: [
        {
          type: "graph",
          data: [
            { name: "A", x: 0, y: 0 },
            { name: "Bee", x: 300, y: 200 },
          ],
        },
      ],
    });
    // Drawn by ECharts, the nodes keep their aspect, below the title and left of the legend.
    const points = withChart(
      option,
      (chart) => {
        const view = (modelOf(chart).getSeriesByIndex(0) as unknown as Option).coordinateSystem;
        return [...view.dataToPoint([0, 0]), ...view.dataToPoint([300, 200])];
      },
      { width: 800, height: 500 },
    );
    const [ax = 0, ay = 0, bx = 0, by = 0] = points;
    const { top, right } = option.series[0];
    assert.ok(Math.abs((bx - ax) / (by - ay) - 1.5) < 0.01, String(points));
    assert.ok(top > 32 && right > 100, `${top} ${right}`);
    assert.ok(ay >= top && by <= 500 && ax >= 0 && bx <= 800 - right, String(points));
    // Nodes in another coordinate system, or a box of the option's own, stay as they are.
    for (const series of [{ coordinateSystem: "cartesian2d" }, { left: 0 }]) {
      const placed = layout({ title: { text: "T" }, series: [{ type: "graph", ...series }] });
      assert.strictEqual(placed.series[0].top, undefined);
    }
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

  test("defaults tooltips, selection and screen reader support", () => {
    const option = layout(bars());
    assert.deepStrictEqual(option.tooltip, {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      confine: true,
    });
    assert.strictEqual(option.series[0].selectedMode, "multiple");
    assert.strictEqual(option.series[0].select.itemStyle.borderColor, "#0078d4");
    assert.deepStrictEqual(option.aria, { enabled: true });
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

  test("lays out the base option of a timeline", () => {
    const option = layout({ baseOption: bars(), options: [{ series: [{ data: [3, 4] }] }] });
    assert.strictEqual(option.baseOption.tooltip.trigger, "axis");
    assert.strictEqual(option.tooltip, undefined);
  });

  test("lays out the series that the timeline's current step or the media option starts with", () => {
    const { series: _, ...axes } = bars();
    const step = (data: number[]) => ({ series: [{ type: "bar", data }] });
    const option = layout({
      baseOption: { ...axes, timeline: { data: ["2025", "2026"], currentIndex: 1 } },
      options: [step([1, 2]), step([3, 4]), { series: [{}, { type: "line" }] }],
    });
    const [series, ...later] = option.baseOption.series;
    assert.deepStrictEqual(series.data, [3, 4]);
    assert.deepStrictEqual(series.itemStyle.borderRadius, [4, 4, 0, 0]);
    assert.strictEqual(series.selectedMode, "multiple");
    assert.deepStrictEqual(option.baseOption.tooltip.axisPointer, { type: "shadow" });
    // Series that later steps add stay there, as do those with an id.
    assert.deepStrictEqual(later, []);
    const withId = {
      baseOption: { ...axes, timeline: {} },
      options: [{ series: [{ id: "a", type: "bar" }] }],
    };
    assert.strictEqual(layout(withId).baseOption.series, undefined);
    const media = layout({
      media: [
        { query: { maxWidth: 300 }, option: {} },
        { option: { series: { type: "pie", data: [1] } } },
      ],
    });
    assert.strictEqual(media.series[0].selectedMode, "multiple");
    assert.strictEqual(media.tooltip.trigger, "item");
  });

  test("keeps the chart and legend clear of a timeline", () => {
    const named = [
      { type: "bar", name: "One", data: [1, 2] },
      { type: "bar", name: "Two", data: [3, 4] },
    ];
    const option = layout(
      { baseOption: bars({ timeline: { data: ["2025", "2026"] }, series: named }), options: [] },
      { width: 400 },
    );
    assert.strictEqual(option.baseOption.legend.bottom, 50);
    assert.strictEqual(option.baseOption.grid.bottom, 84);
    const placed = layout(bars({ timeline: { top: 0 } }));
    assert.strictEqual(placed.grid.bottom, 8);
  });
});
