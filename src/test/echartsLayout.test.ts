import * as assert from "node:assert";
import type { ChartSpec } from "../chartSpec";
import { GUIDE_TOPICS } from "../guideTopics";
import { modelOf } from "../webview/echartsItems";
import { disableAnimation, toolWarnings } from "../webview/echartsLayout";
import type { JsonObject } from "../webview/echartsOption";
import { bars, builtOption, layout, type Option, svgOf, withChart } from "./echartsModel";
import { testColors as colors } from "./themeColors";

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

  test("wraps a legend that the panel places into a few rows, rather than page through it", () => {
    const named = (count: number, extra: Option = {}) =>
      layout({
        xAxis: { type: "category", data: ["a"] },
        yAxis: {},
        series: Array.from({ length: count }, (_, index) => ({
          name: `Product line ${index + 1}`,
          type: "line",
          data: [index],
        })),
        ...extra,
      });
    const top = (option: Option) => [option.legend.type, option.grid.top];
    assert.deepStrictEqual(top(named(5)), ["scroll", 44]);
    assert.deepStrictEqual(top(named(12)), ["plain", 68]);
    assert.deepStrictEqual(top(named(16)), ["plain", 92]);
    // Too many to wrap into a few rows, or a legend that says its kind or place.
    assert.deepStrictEqual(top(named(30)), ["scroll", 44]);
    assert.deepStrictEqual(top(named(12, { legend: { type: "scroll" } })), ["scroll", 44]);
    assert.strictEqual(named(12, { legend: { bottom: 0 } }).legend.type, "scroll");
    // As many rows as a fifth of the height takes, as for the slices of a pie in a tall panel.
    const slices = (height: number) =>
      layout(
        {
          series: [
            {
              type: "pie",
              data: Array.from({ length: 8 }, (_, index) => ({
                name: `Browser ${index}`,
                value: 1,
              })),
            },
          ],
        },
        { width: 260, height },
      ).legend.type;
    assert.strictEqual(slices(600), "plain");
    assert.strictEqual(slices(300), "scroll");
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

  test("cuts a title short of the toolbox beside it", () => {
    const width = (title: Option, toolbox: Option) =>
      layout(bars({ title: { text: "T", ...title }, toolbox }), { width: 300 }).title.textStyle
        .width;
    // Three icons of 15 pixels, 10 apart, and the padding right of them, and a gap to the title.
    const feature = { saveAsImage: {}, dataView: {}, restore: {}, magicType: { type: ["line"] } };
    assert.strictEqual(width({}, { feature }), 284 - 80 - 8);
    assert.strictEqual(width({ left: "center" }, { feature }), 284 - 2 * (80 + 8));
    assert.strictEqual(width({}, { feature, itemSize: 20, itemGap: 4, padding: 5 }), 284 - 73 - 8);
    // Not beside a toolbox placed elsewhere, nor one without icons, nor below it.
    for (const [title, toolbox] of [
      [{}, { feature, top: "bottom" }],
      [{}, { feature, orient: "vertical" }],
      [{}, { feature, show: false }],
      [{}, { feature: { magicType: { type: ["line"] }, restore: { show: false } } }],
      [{ top: "bottom" }, { feature }],
    ] as const) {
      assert.strictEqual(width(title, toolbox), 284, JSON.stringify([title, toolbox]));
    }
  });

  test("keeps the plot and a legend below a toolbox at the top", () => {
    const feature = { saveAsImage: {}, dataView: {} };
    const tops = (extra: Option) => {
      const { grid, legend } = layout(bars({ toolbox: { feature }, ...extra }));
      return [grid.top, legend?.top];
    };
    // The icons of 15 pixels and the padding above them.
    assert.deepStrictEqual(tops({}), [30 + 14, undefined]);
    assert.deepStrictEqual(tops({ legend: {} }), [30 + 30 + 14, 30]);
    assert.deepStrictEqual(tops({ toolbox: { feature, itemSize: 20 } }), [35 + 14, undefined]);
    // Beside a title, as high as it is.
    assert.deepStrictEqual(tops({ title: { text: "T" } }), [32 + 14, undefined]);
    // Not a toolbox placed elsewhere.
    assert.deepStrictEqual(tops({ toolbox: { feature, top: "bottom" } }), [14, undefined]);
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

  test("gives the labels of a narrow pie room on lines from the edge, or a legend instead", () => {
    // The example of the guide's echarts-pie topic.
    const pie = (label: Option | null = { formatter: "{b}: {d}%" }, own: Option = {}): Option => ({
      title: { text: "Disk usage", subtext: "GB" },
      series: [
        {
          type: "pie",
          ...(label && { label }),
          ...own,
          data: [
            { name: "Videos", value: 182 },
            { name: "Photos", value: 96 },
            { name: "Apps", value: 64 },
            { name: "Other", value: 31 },
          ],
        },
      ],
    });
    // As wide as a panel of 420 pixels draws it.
    const size = { width: 396, height: 575 };
    const narrow = layout(pie(), size);
    const [series] = narrow.series;
    assert.deepStrictEqual(
      [series.label.alignTo, series.label.overflow, series.labelLine.length2, narrow.legend],
      ["edge", "break", 0, undefined],
    );
    // A pie of a radius that leaves room for them.
    assert.ok(Number.parseFloat(series.radius) <= 50, String(series.radius));
    // Drawn whole, where ECharts cut the labels to "Photo..." and "...".
    const svg = svgOf(narrow, size);
    assert.match(svg, />Photos: 25\.74%</);
    assert.match(svg, />Videos: ?</);
    assert.doesNotMatch(svg, /\.\.\.</);
    // Beside a wide pie, the labels stay as ECharts places them.
    const wide = layout(pie()).series[0];
    assert.deepStrictEqual(wide.label, { formatter: "{b}: {d}%" });
    // A radius of the option's own stays as it is, as a doughnut's: the labels go onto lines,
    // and those whose words do not fit beside it are cut short, never broken within a word.
    const ring = layout(pie(undefined, { radius: ["45%", "70%"] }), size);
    const [doughnut] = ring.series;
    assert.deepStrictEqual(
      [doughnut.radius, doughnut.label.alignTo, doughnut.label.overflow],
      [["45%", "70%"], "edge", "break"],
    );
    const words = new Set(["Disk", "usage", "GB", "Videos:", "Photos:", "Apps:", "Other:"]);
    for (const share of ["48.79%", "25.74%", "17.16%", "8.31%"]) words.add(share);
    const drawn = [...svgOf(ring, size).matchAll(/>([^<>]+)<\/text>/g)].flatMap(([, text = ""]) =>
      text.split(/\s+/).filter(Boolean),
    );
    assert.ok(drawn.length > 0);
    for (const word of drawn) {
      assert.ok(words.has(word) || word.endsWith("…"), `${word} of ${drawn.join(" ")}`);
    }
    // Too narrow for them even so: a legend names the slices, unless the option sets how to
    // label them, as with a template that tells their shares.
    const narrower = { width: 260, height: 575 };
    const named = layout(pie(null), narrower);
    assert.deepStrictEqual([named.legend.bottom, named.series[0].label.show], [6, false]);
    for (const label of [{ formatter: "{b}: {d}%" }, { show: true }, { fontSize: 11 }]) {
      const shown = layout(pie(label), narrower);
      assert.deepStrictEqual(
        [shown.legend, shown.series[0].label.show, shown.series[0].label.alignTo],
        [undefined, label.show, "edge"],
        JSON.stringify(label),
      );
      assert.ok(Number.parseFloat(shown.series[0].radius) >= 39, String(shown.series[0].radius));
    }
    // Nor beside a legend of the option's own.
    const legend = layout({ ...pie(), legend: {} }, narrower).series[0].label;
    assert.deepStrictEqual([legend.show, legend.alignTo], [undefined, "edge"]);
    // Labels of no settings beside a radius of the option's own, too short for them.
    assert.strictEqual(
      layout(pie(null, { radius: ["45%", "70%"] }), size).series[0].label.show,
      false,
    );
    // Nor labels inside the slices, or aligned otherwise by the option.
    for (const label of [{ position: "inside" }, { alignTo: "labelLine" }]) {
      const own = layout(pie(label, { radius: ["45%", "70%"] }), size).series[0];
      assert.deepStrictEqual([own.label, own.radius], [label, ["45%", "70%"]]);
    }
  });

  test("draws the labels of the guide's pie whole in a narrow panel", () => {
    const topic = GUIDE_TOPICS.find(({ name }) => name === "echarts-pie");
    const size = { width: 396, height: 575 };
    const svg = svgOf(layout(JSON.parse(topic?.example ?? "{}"), size), size);
    assert.match(svg, />Photos:(?: 25\.74%)? ?</);
    assert.doesNotMatch(svg, /(?:…|\.\.\.)</);
  });

  test("draws the labels of diagram_chart's pies whole in a narrow panel", () => {
    const table = "component,bugs\nParser,42\nRenderer,31\nCommand line,9\nDocumentation,6";
    const size = { width: 396, height: 575 };
    for (const type of ["pie", "doughnut"] as const) {
      const option = layout(
        builtOption({ type, data: "unused", labelColumn: "component" }, table),
        size,
      );
      const svg = svgOf(option, size);
      assert.match(svg, />Documentation: 6\.82%</, type);
      assert.doesNotMatch(svg, /(?:…|\.\.\.)</, type);
    }
  });

  test("keeps the shares of diagram_chart's pie labels where a word of them does not fit", () => {
    const table =
      "component,bugs\nParser,42\nRenderer,31\nCommand line interface,9\nDocumentation,6\nInstallation scripts,5";
    const shares = ["45.16%", "33.33%", "9.68%", "6.45%", "5.38%"];
    // Of the labels and the legend.
    const words = new Set(table.split(/[\s,]+/).flatMap((word) => [word, `${word}:`]));
    // Beside a pie of the panel's radius, and of diagram_chart's doughnut, where the shares fit.
    for (const [width, type] of [
      [260, "pie"],
      [300, "pie"],
      [350, "doughnut"],
    ] as const) {
      const size = { width, height: 575 };
      const option = layout(
        builtOption({ type, data: "unused", labelColumn: "component" }, table),
        size,
      );
      const drawn = [...svgOf(option, size).matchAll(/>([^<>]+)<\/text>/g)]
        .map(([, text = ""]) => text)
        .join(" ");
      // Each share, of a word cut short rather than broken within it.
      for (const share of shares) assert.ok(drawn.includes(share), `${share} of ${drawn}`);
      for (const word of drawn.split(/\s+/).filter(Boolean)) {
        assert.ok(
          words.has(word) || shares.includes(word) || /…:?$/.test(word),
          `${word} of ${drawn}`,
        );
      }
    }
    // A formatter of the option's own, as a function, labels each slice still, cut short whole.
    const formatter = ({ name }: { name: string }) => `${name}!`;
    const own = builtOption({ type: "pie", data: "unused", labelColumn: "component" }, table);
    own.series[0].label = { formatter };
    const size = { width: 300, height: 575 };
    const labels = layout(own, size).series[0].data.map(({ label }: Option) => label);
    assert.ok(
      labels.some((label: Option) => label?.overflow === "truncate"),
      JSON.stringify(labels),
    );
    assert.ok(labels.every((label: Option) => label?.formatter === undefined));
    assert.match(svgOf(layout(own, size), size), />Parser!</);
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
    assert.strictEqual(itemHeight({ min: 0, max: 10, itemHeight: 120 }), 120);
  });

  test("shows the values at the ends of a continuous visual map, within the room left for it", () => {
    const placed = (visualMap: Option) => {
      const { calculable, text, padding } = layout(bars({ visualMap })).visualMap;
      return { calculable, text, padding };
    };
    // As text, rather than handles that would let the user filter the data.
    assert.deepStrictEqual(placed({ min: 0, max: 12_500 }), {
      calculable: undefined,
      text: ["12.5K", "0"],
      padding: 5,
    });
    // ECharts' default bounds.
    assert.deepStrictEqual(placed({ calculable: false }).text, ["200", "0"]);
    // In the format and precision of the visual map, as its handles would write them.
    assert.deepStrictEqual(placed({ max: 50, formatter: "{value} %", precision: 1 }).text, [
      "50.0 %",
      "0.0 %",
    ]);
    // ECharts' precision of 0 with a format, and a precision within what it takes.
    const text = (visualMap: Option) => placed({ min: 0, max: 12_500, ...visualMap }).text;
    assert.deepStrictEqual(text({ formatter: "{value}–{value2}" }), ["12500–12500", "0–0"]);
    assert.deepStrictEqual(text({ formatter: "{value} ({value})" }), [
      "12500 ({value})",
      "0 ({value})",
    ]);
    assert.deepStrictEqual(text({ precision: 1.5 }), ["12500.0", "0.0"]);
    assert.deepStrictEqual(text({ precision: -1 }), ["12500", "0"]);
    assert.deepStrictEqual(
      text({ precision: 150 }).map((each: string) => each.length),
      [26, 22],
    );
    // Not one with a formatter function, whose code the layout leaves to ECharts.
    assert.strictEqual(placed({ formatter: () => "x" }).text, undefined);
    // Not one with handles or a text of its own, nor the pieces of another.
    assert.deepStrictEqual(placed({ calculable: true, padding: 10 }), {
      calculable: true,
      text: undefined,
      padding: 10,
    });
    assert.deepStrictEqual(placed({ text: ["High", "Low"] }).text, ["High", "Low"]);
    assert.deepStrictEqual(placed({ type: "piecewise" }), {
      calculable: undefined,
      text: undefined,
      padding: 5,
    });
    // A visual map placed elsewhere keeps ECharts' padding.
    assert.strictEqual(placed({ right: 0 }).padding, undefined);
  });

  test("gives up a zoom slider, a subtitle and a title in turn for a plot too short to read", () => {
    const at = (height: number) => {
      const option = layout(
        bars({
          title: { text: "Latency", subtext: "p50 and p99" },
          dataZoom: [{ type: "slider" }],
          series: ["p50", "p99"].map((name) => ({ type: "bar", name, data: [1, 2] })),
        }),
        { height },
      );
      return {
        zoom: option.dataZoom[0].type,
        subtext: option.title.subtext,
        title: option.title.show !== false,
        legend: option.legend.show !== false,
      };
    };
    const full = { zoom: "slider", subtext: "p50 and p99", title: true, legend: true };
    assert.deepStrictEqual(at(500), full);
    assert.deepStrictEqual(at(240), { ...full, zoom: "inside" });
    assert.deepStrictEqual(at(210), { ...full, zoom: "inside", subtext: "" });
    assert.deepStrictEqual(at(190), { ...full, zoom: "inside", title: false });
    // Where nothing more can be given up, the legend stays.
    assert.deepStrictEqual(at(100), { ...full, zoom: "inside", title: false });
  });

  test("gives the value axis of a short or narrow plot fewer labels, which would pile up", () => {
    const short = layout(bars(), { width: 900, height: 160 });
    assert.strictEqual(short.yAxis.splitNumber, 3);
    // Nor in a plot of the usual size, nor where the option says.
    assert.strictEqual(layout(bars()).yAxis.splitNumber, undefined);
    const placed = bars({ yAxis: { type: "value", splitNumber: 6 } });
    assert.strictEqual(layout(placed, { width: 900, height: 160 }).yAxis.splitNumber, 6);
    const scatter = {
      xAxis: { type: "value" },
      yAxis: { type: "value" },
      series: [{ type: "scatter", data: [[1, 2]] }],
    };
    assert.strictEqual(layout(scatter, { width: 240 }).xAxis.splitNumber, 2);
    assert.strictEqual(layout(scatter).xAxis.splitNumber, undefined);
    // The bounds, interval and name of the option's own axis stay as they are.
    const bounded = { type: "value", name: "Count", min: 0, max: 7, interval: 1 };
    for (const height of [130, 160, 200]) {
      const axis = layout(bars({ yAxis: bounded }), { width: 900, height }).yAxis;
      assert.deepStrictEqual(
        { ...axis, axisLabel: undefined },
        { ...bounded, axisLabel: undefined },
      );
    }
  });

  test("hides a visual map below a chart too short for it and a plot to read", () => {
    const visualMap = { min: 0, max: 10 };
    const short = layout(bars({ title: { text: "T" }, visualMap }), { height: 220 });
    assert.strictEqual(short.visualMap.show, false);
    assert.deepStrictEqual(
      short.grid,
      layout(bars({ title: { text: "T" } }), { height: 220 }).grid,
    );
    assert.strictEqual(layout(bars({ visualMap }), { height: 220 }).visualMap.show, undefined);
    // Not one placed by the option, nor one the panel has room for.
    const placed = { ...visualMap, right: 0 };
    assert.strictEqual(
      layout(bars({ visualMap: placed }), { height: 150 }).visualMap.show,
      undefined,
    );
    assert.strictEqual(layout(bars({ title: { text: "T" }, visualMap })).visualMap.show, undefined);
  });

  test("rotates category labels that would overlap", () => {
    const labels = Array.from({ length: 20 }, (_, index) => `Category ${index}`);
    const option = layout(bars({ xAxis: { type: "category", data: labels } }));
    assert.strictEqual(option.xAxis.axisLabel.rotate, 30);
    assert.strictEqual(layout(bars()).xAxis.axisLabel, undefined);
  });

  test("tells long category labels apart by lines, or else by what follows the start they share", () => {
    const table = (count: number, name = (index: number) => `Northern Regional Center ${index}`) =>
      `center,shipments\n${Array.from({ length: count }, (_, index) => `${name(index)},${index + 1}`).join("\n")}`;
    const bars = (type: "bar" | "horizontalBar", data: string) =>
      layout(builtOption({ type, data: "unused", labelColumn: "center" }, data), {
        width: 400,
        height: 700,
      });
    // Too many rows for lines: the labels are what follows "Northern Regional Center ", which
    // names the axis above them, starting at the axis.
    const many = bars("horizontalBar", table(25));
    const label = many.yAxis.axisLabel;
    assert.strictEqual(many.yAxis.name, "Northern Regional Center …");
    assert.strictEqual(many.yAxis.nameTextStyle.align, "left");
    assert.deepStrictEqual(
      [label.formatter("Northern Regional Center 12"), label.formatter("Other"), label.width],
      ["12", "Other", undefined],
    );
    const svg = svgOf(many, { width: 400, height: 700 });
    assert.match(svg, />12</);
    assert.match(svg, />Northern Regional Center …</);
    assert.doesNotMatch(svg, /\.\.\.</);
    // Rows with the height for them take lines.
    const few = bars("horizontalBar", table(5)).yAxis;
    assert.deepStrictEqual(
      [few.axisLabel.overflow, few.axisLabel.formatter, few.name],
      ["break", undefined, undefined],
    );
    // Columns name their axis below their labels, which then go across.
    const columns = bars("bar", table(6)).xAxis;
    assert.deepStrictEqual(
      [columns.name, columns.nameLocation, columns.nameGap, columns.axisLabel.rotate],
      ["Northern Regional Center …", "middle", 30, undefined],
    );
    // Labels that differ at the start, or share none up to a word, are cut short as before.
    const sides = ["North", "South", "East", "West"];
    for (const name of [
      (index: number) => `${sides[index % 4]} Regional Distribution Center ${index}`,
      (index: number) => `NorthernRegionalDistributionCenter${index}`,
    ]) {
      const axis = bars("horizontalBar", table(25, name)).yAxis;
      assert.deepStrictEqual(
        [axis.axisLabel.overflow, axis.axisLabel.formatter, axis.name],
        ["truncate", undefined, undefined],
      );
    }
    // A name of the option's own goes first, and labels it formats stay as they are.
    const sites = (axis: Option) =>
      layout(
        {
          xAxis: { type: "value" },
          yAxis: {
            type: "category",
            data: Array.from({ length: 25 }, (_, index) => `Northern Regional Center ${index}`),
            ...axis,
          },
          series: [{ type: "bar", data: Array(25).fill(1) }],
        },
        { width: 400, height: 700 },
      ).yAxis;
    // The name of the option's own stays, and the labels then keep their ends, which tell them
    // apart.
    const named = sites({ name: "Site" });
    assert.deepStrictEqual(
      [named.name, named.axisLabel.formatter("Northern Regional Center 12"), named.nameTextStyle],
      ["Site", "…Center 12", undefined],
    );
    // Unless they end alike too: then they are told apart by what follows the start they share,
    // across the chart as down it.
    const warehouses = Array.from(
      { length: 25 },
      (_, index) => `Northern Regional Center ${index} (Warehouse and Logistics)`,
    );
    const across = layout(
      {
        xAxis: { type: "category", name: "Site", data: warehouses },
        yAxis: { type: "value" },
        series: [{ type: "bar", data: Array(25).fill(1) }],
      },
      { width: 800, height: 500 },
    ).xAxis;
    for (const axis of [sites({ name: "Site", data: warehouses }), across]) {
      const { formatter } = axis.axisLabel;
      assert.deepStrictEqual(
        [axis.name, formatter(warehouses[12]), new Set(warehouses.map(formatter)).size],
        ["Site", "12 (Warehouse and Logistics)", 25],
      );
    }
    // A name beside the labels in the middle of the axis is not aligned to its end.
    const middle = sites({ nameLocation: "middle" });
    assert.deepStrictEqual(
      [middle.name, middle.nameTextStyle],
      ["Northern Regional Center …", undefined],
    );
    const formatted = sites({ axisLabel: { formatter: "{value}" } });
    assert.deepStrictEqual([formatted.name, formatted.axisLabel.formatter], [undefined, "{value}"]);
    // Labels that the option hides name nothing, across or down the chart.
    const centers = Array.from({ length: 12 }, (_, index) => `Northern Regional Center ${index}`);
    const hidden = layout(
      {
        xAxis: { type: "category", data: centers, axisLabel: { show: false } },
        yAxis: { type: "value" },
        series: [{ type: "bar", data: Array(12).fill(1) }],
      },
      { width: 400, height: 700 },
    );
    assert.deepStrictEqual(
      [hidden.xAxis.name, hidden.xAxis.nameLocation, hidden.xAxis.axisLabel.formatter],
      [undefined, undefined, undefined],
    );
    const down = sites({ axisLabel: { show: false } });
    assert.deepStrictEqual([down.name, down.axisLabel.formatter], [undefined, undefined]);
  });

  test("names an inverse axis where it starts, above a heatmap's first row", () => {
    const spec = { type: "heatmap", labelColumn: ["day", "hour"], valueColumns: ["count"] };
    const heatmap = layout(
      builtOption(spec as ChartSpec, "day,hour,count\nMon,0:00,1\nMon,1:00,2\nTue,0:00,3"),
    );
    assert.deepStrictEqual([heatmap.yAxis.name, heatmap.yAxis.nameLocation], ["day", "start"]);
    assert.strictEqual(heatmap.xAxis.nameLocation, undefined);
    const svg = svgOf(heatmap, { width: 800, height: 500 });
    const top = (text: string) =>
      Number(new RegExp(String.raw`translate\([\d.]+ ([\d.]+)\)[^>]*>${text}<`).exec(svg)?.[1]);
    assert.ok(top("day") < top("Mon"), `${top("day")} < ${top("Mon")}`);
    // Unless the axis says where.
    const placed = { type: "category", data: ["A"], inverse: true, name: "N", nameLocation: "end" };
    assert.strictEqual(layout(bars({ yAxis: placed })).yAxis.nameLocation, "end");
    assert.strictEqual(layout(bars({ yAxis: { name: "N" } })).yAxis.nameLocation, undefined);
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

  test("fits a calendar into the space left, across the chart or, in a narrow one, down it", () => {
    const calendar = (width: number, height: number, own: Option = {}) =>
      layout(
        {
          title: { text: "Contributions" },
          visualMap: { min: 0, max: 10 },
          calendar: { range: "2026", ...own },
          series: [{ type: "heatmap", coordinateSystem: "calendar", data: [["2026-03-01", 4]] }],
        },
        { width, height },
      ).calendar;
    // Below the title, with square cells as large as there is room for: 53 weeks across, 7 days
    // down, between the labels around them and the visual map below.
    const wide = calendar(1200, 800);
    assert.deepStrictEqual(
      [wide.left, wide.top, wide.cellSize, wide.dayLabel],
      [64, 62, [21, 21], undefined],
    );
    // Too close for a label a day, every other one.
    assert.deepStrictEqual(calendar(600, 500).dayLabel.nameMap, ["", "M", "", "W", "", "F", ""]);
    // A week a row, where the chart is too narrow for days to be read across it.
    const narrow = calendar(420, 700);
    assert.deepStrictEqual(
      [narrow.orient, narrow.left, narrow.top, narrow.cellSize],
      ["vertical", 40, 90, [52, 10]],
    );
    // A quarter, starting on a Thursday, takes 14 weeks.
    assert.deepStrictEqual(
      calendar(420, 700, { range: ["2026-01", "2026-03-31"] }).cellSize,
      [24, 24],
    );
    // Drawn within the chart.
    const svg = svgOf(
      layout({ calendar: { range: "2026" }, series: [] }, { width: 420, height: 700 }),
      { width: 420, height: 700 },
    );
    const xs = [...svg.matchAll(/translate\((-?[\d.]+) /g)].map(([, x]) => Number(x));
    assert.ok(xs.length > 0 && xs.every((x) => x >= 0 && x <= 420), String(xs));
    // Placed or sized by the option, or of a range it cannot tell, it stays as it is.
    for (const own of [{ cellSize: 10 }, { orient: "horizontal" }, { top: 0 }, { range: "soon" }]) {
      assert.deepStrictEqual(
        Object.keys(calendar(420, 700, own)).sort(),
        Object.keys({ range: 0, ...own }).sort(),
      );
    }
  });

  test("gives the names of parallel axes room, on two rows where the axes are close", () => {
    const cars = (axis: Option = {}): Option => ({
      title: { text: "Cars" },
      parallelAxis: ["Price", "Horsepower", "Consumption", "Weight", "Origin"].map((name, dim) => ({
        dim,
        name,
        ...axis,
      })),
      series: [{ type: "parallel", data: [[30000, 150, 7.5, 1400, 1]] }],
    });
    const narrow = { width: 404, height: 575 };
    const laidOut = layout(cars(), narrow);
    // Every other name a line higher, each as wide as the room between three axes.
    assert.deepStrictEqual(
      laidOut.parallelAxis.map((axis: Option) => axis.nameGap),
      [15, 32, 15, 32, 15],
    );
    const { left, right, top } = laidOut.parallel;
    const step = (404 - left - right) / 4;
    assert.strictEqual(laidOut.parallelAxis[1].nameTruncate.maxWidth, Math.round(2 * step - 8));
    assert.strictEqual(top, 32 + 15 + 2 * 17 + 8);
    // Drawn whole, where ECharts cut them to "Horsep..." and "Consum...".
    const svg = svgOf(laidOut, narrow);
    assert.match(svg, />Horsepower</);
    assert.match(svg, />Consumption</);
    assert.doesNotMatch(svg, /\.\.\.</);
    // On one row where they fit, and as the option places them otherwise.
    const wide = layout(cars(), { width: 1200, height: 800 });
    assert.deepStrictEqual(
      [wide.parallelAxis[1].nameGap, wide.parallel.top],
      [undefined, 32 + 15 + 17 + 8],
    );
    const own = layout(cars({ nameGap: 20 }), narrow);
    assert.deepStrictEqual([own.parallelAxis[1].nameGap, own.parallel], [20, undefined]);
  });

  test("leaves room beside a radar for the names of its indicators", () => {
    const radius = (names: string[], width: number) =>
      layout(
        {
          radar: { indicator: names.map((name) => ({ name, max: 10 })) },
          series: [{ type: "radar", data: [{ value: names.map(() => 5) }] }],
        },
        { width, height: 500 },
      ).radar.radius;
    const short = ["Speed", "Cost", "Size"];
    const long = ["Speed", "Intelligence", "Size"];
    // In a narrow chart, the names take from the width of the radar.
    assert.ok(radius(long, 360) < radius(short, 360));
    assert.ok(radius(long, 360) <= (360 - 2 * 12 * colors.fontSize * 0.6) / 2 - 20);
    // In a wide one, the height decides.
    assert.strictEqual(radius(long, 1200), radius(short, 1200));
  });

  test("labels the nodes of a tree beside them, rather than over them and their lines", () => {
    const tree = (extra: Option = {}) =>
      layout({
        series: [
          {
            type: "tree",
            data: [{ name: "root", children: [{ name: "leaf" }] }],
            ...extra,
          },
        ],
      }).series[0];
    const beside = (position: string, align: string) => ({
      position,
      align,
      verticalAlign: "middle",
      // Onto lines past 40% of the width, as the leaves are far enough apart.
      width: 800 * 0.4 - 12,
      overflow: "break",
    });
    const laidOut = tree();
    // Before the nodes with children, toward the root, and after the leaves.
    assert.deepStrictEqual(
      [laidOut.label, laidOut.leaves.label],
      [beside("left", "right"), beside("right", "left")],
    );
    const svg = svgOf({ series: [laidOut] });
    assert.match(svg, /text-anchor="end"[^>]*>root</);
    assert.match(svg, /text-anchor="start"[^>]*>leaf</);
    const mirrored = tree({ orient: "RL", leaves: { label: { color: "red" } } });
    assert.deepStrictEqual(
      [mirrored.label, mirrored.leaves.label],
      [beside("right", "left"), { ...beside("left", "right"), color: "red" }],
    );
    // Cut short where the leaves are too close for lines.
    const leaves = Array.from({ length: 40 }, (_, index) => ({ name: `leaf ${index}` }));
    assert.strictEqual(
      tree({ data: [{ name: "root", children: leaves }] }).leaves.label.overflow,
      "truncate",
    );
    // Not placed by the option, nor from the top down or around the root.
    assert.deepStrictEqual(tree({ label: { position: "top" } }).label, { position: "top" });
    for (const extra of [{ orient: "TB" }, { layout: "radial" }]) {
      assert.strictEqual(tree(extra).label, undefined, JSON.stringify(extra));
    }
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
    assert.deepStrictEqual(box("treemap", { breadcrumb: { top: 40 } }), [68, 12, 12, 12]);
    assert.deepStrictEqual(box("treemap", { breadcrumb: { top: "top" } }), [68, 12, 12, 12]);
    assert.deepStrictEqual(box("treemap", { breadcrumb: { top: "90%" } }), [44, 12, 12, 36]);
    assert.deepStrictEqual(box("treemap", { breadcrumb: { top: "middle" } }), [44, 12, 12, 12]);
    assert.deepStrictEqual(box("tree"), [44, 96, 96, 12]);
    // The labels at the ends of a tree, of its root and of the deepest level it shows, which
    // the panel places beside their nodes: the leaves' after them.
    const leaf = "a leaf with a long name, and on";
    const tree = {
      data: [
        { name: "root", children: [{ name: "a", children: [{ name: leaf }] }, { name: "b" }] },
      ],
    };
    const whole = Math.round(leaf.length * colors.fontSize * 0.6 + 12);
    assert.deepStrictEqual(box("tree", tree), [44, 96, whole, 12]);
    assert.deepStrictEqual(box("tree", { ...tree, orient: "RL" }), [44, whole, 96, 12]);
    // Centered on their nodes, half of them.
    const half = Math.round((leaf.length * colors.fontSize * 0.6) / 2 + 12);
    assert.deepStrictEqual(box("tree", { ...tree, label: { position: "inside" } }), [
      44,
      96,
      Math.max(96, half),
      12,
    ]);
    const right = { leaves: { label: { position: "right" } } };
    assert.deepStrictEqual(box("tree", { ...tree, ...right }), [44, 96, whole, 12]);
    assert.deepStrictEqual(box("tree", { ...tree, ...right, orient: "RL" }), [44, 96, 96, 12]);
    const left = { leaves: { label: { position: "left" } }, orient: "RL" };
    assert.deepStrictEqual(box("tree", { ...tree, ...left }), [44, whole, 96, 12]);
    // Deeper than it shows, or laid out around its root.
    assert.deepStrictEqual(
      box("tree", { ...tree, ...right, initialTreeDepth: 1 }),
      [44, 96, 96, 12],
    );
    assert.deepStrictEqual(box("tree", { ...tree, ...right, layout: "radial" }), [44, 96, 96, 12]);
    assert.deepStrictEqual(box("funnel"), [44, 80, 80, 12]);
    // A funnel's labels beside it on the right, unless placed otherwise, as long as they are.
    const stages = { data: [{ name: "Visited the product page", value: 3 }, { name: "Paid" }] };
    const room = Math.round(24 * colors.fontSize * 0.6 + 33);
    assert.deepStrictEqual(box("funnel", stages), [44, 80, room, 12]);
    assert.deepStrictEqual(box("funnel", { ...stages, label: { position: "leftTop" } }), [
      44,
      room,
      80,
      12,
    ]);
    assert.deepStrictEqual(
      box("funnel", { ...stages, label: { position: "inside" } }),
      [44, 80, 80, 12],
    );
    assert.deepStrictEqual(
      box("funnel", { ...stages, label: { formatter: "{b}: {c}" }, labelLine: { length: 10 } }),
      [44, 80, Math.round((24 + 2 + 6) * colors.fontSize * 0.6 + 23), 12],
    );
    assert.deepStrictEqual(box("sankey"), [44, 12, 144, 12]);
    assert.deepStrictEqual(box("chord"), [44, 12, 12, 12]);
  });

  test("lays out a theme river as a grid, with the names of its layers beside it", () => {
    const river = (names: string[], extra: Option = {}): Option => ({
      title: { text: "T" },
      legend: {},
      singleAxis: { type: "time" },
      series: [
        {
          type: "themeRiver",
          data: names.flatMap((name, index) => [
            ["2026-01-01", 3 + index, name],
            ["2026-01-02", 5, name],
          ]),
        },
      ],
      ...extra,
    });
    const option = layout(river(["Docs", "Frontend"]));
    // The legend above the river, below the title, as above a grid, rather than over it.
    assert.deepStrictEqual([option.legend.top, option.legend.orient], [32, undefined]);
    const nameWidth = Math.round(8 * 11 * 0.6 + 12);
    const { left, right, top, bottom } = option.singleAxis;
    assert.deepStrictEqual([left, right, top, bottom], [nameWidth, 24, 76, 30]);
    assert.strictEqual(option.series[0].label.align, "right");
    // Drawn by ECharts, each name ends left of the river, where its layer starts.
    const [rect, names] = withChart(
      option,
      (chart) => {
        const axis = (modelOf(chart) as unknown as Option).getComponent("singleAxis");
        const texts = new Set<Option>();
        for (const line of chart.getZr().storage.getDisplayList(true) as Option[]) {
          // The labels of the layers, not the entries of the legend.
          if (line.type === "tspan" && line.parent?.__hostTarget?.type === "ec-polygon") {
            texts.add(line.parent);
          }
        }
        const boxes = [...texts].map((text) => {
          const box = text.getBoundingRect().clone();
          box.applyTransform(text.getComputedTransform());
          return box;
        });
        return [axis.coordinateSystem.getRect(), boxes];
      },
      { width: 800, height: 500 },
    );
    assert.strictEqual(names.length, 2);
    for (const name of names) {
      assert.ok(name.x >= 0 && name.x + name.width <= rect.x, `${name.x} ${name.width} ${rect.x}`);
    }
    // In a narrow chart, the legend goes below, and a long name is cut short.
    const narrow = layout(river(["A name of a layer that goes on and on"]), { width: 400 });
    assert.deepStrictEqual([narrow.legend.bottom, narrow.singleAxis.bottom], [6, 62]);
    assert.deepStrictEqual(narrow.series[0].label, {
      align: "right",
      width: 100 - 12,
      overflow: "truncate",
    });
    assert.strictEqual(narrow.singleAxis.left, 100);
    // Names placed otherwise, or none, take no room; an axis placed by the option stays.
    for (const label of [{ show: false }, { align: "left" }]) {
      const placed = river(["Frontend"]);
      placed.series[0].label = label;
      assert.strictEqual(layout(placed).singleAxis.left, 24, JSON.stringify(label));
    }
    const own = layout(river(["Frontend"], { singleAxis: { type: "time", top: 10 } }));
    assert.deepStrictEqual([own.singleAxis.top, own.singleAxis.left], [10, undefined]);
    // A legend of many layers goes onto rows, as one of many series does, with room for them.
    const layers = ["Docs", "Bug fixes", "Features", "Refactoring", "Performance", "Security"];
    const many = layout(river([...layers, "Testing", "Releases"]), { width: 500, height: 650 });
    assert.deepStrictEqual([many.legend.type, many.singleAxis.bottom], ["plain", 62 + 24]);
  });

  test("spaces the names of a theme river's layers that start close, or leaves some out", () => {
    const names = ["Frontend", "Backend", "Infrastructure", "Docs", "Tests", "Design", "Security"];
    // Layers that start thin, whose names would go on top of each other.
    const data = names.flatMap((name, index) => [
      ["2026-01-01", 1 + (index % 2), name],
      ["2026-01-02", 10 + index, name],
      ["2026-01-03", 8, name],
    ]);
    const drawnNames = (option: Option, height: number) =>
      withChart(
        option,
        (chart) => {
          const texts = new Set<Option>();
          for (const line of chart.getZr().storage.getDisplayList(true) as Option[]) {
            if (line.type === "tspan" && line.parent?.__hostTarget?.type === "ec-polygon") {
              texts.add(line.parent);
            }
          }
          return [...texts]
            .filter((text) => !text.ignore && !text.invisible)
            .map((text) => {
              const box = text.getBoundingRect().clone();
              box.applyTransform(text.getComputedTransform());
              return box;
            });
        },
        { width: 800, height },
      );
    for (const height of [500, 160]) {
      const option = layout(
        { singleAxis: { type: "time" }, series: [{ type: "themeRiver", data }] },
        { width: 800, height },
      );
      // Moved apart where they fit beside the river, which they do not in a short chart.
      assert.deepStrictEqual(
        option.series[0].labelLayout,
        height > 200 ? { moveOverlap: "shiftY", hideOverlap: true } : { hideOverlap: true },
      );
      const boxes = drawnNames(option, height);
      assert.ok(boxes.length > (height > 200 ? 6 : 0), `${boxes.length} at ${height}`);
      boxes.forEach((a: Option, i: number) => {
        for (const b of boxes.slice(i + 1)) {
          const across = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
          const down = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
          assert.ok(across <= 1 || down <= 1, `${JSON.stringify(a)} ${JSON.stringify(b)}`);
        }
      });
    }
    // Unless the option lays them out itself.
    const own = { moveOverlap: "shiftX" };
    const placed = layout({
      singleAxis: { type: "time" },
      series: [{ type: "themeRiver", data, labelLayout: own }],
    });
    assert.deepStrictEqual(placed.series[0].labelLayout, own);
  });

  test("keeps the names of a theme river's layers beside it, clear of its axis labels and legend", () => {
    // Many layers that start thin, whose names spaced apart would reach past the river.
    const names = Array.from({ length: 20 }, (_, index) => `Team ${index + 1}`);
    const data = names.flatMap((name, index) => [
      ["2026-01-01", 1 + (index % 3), name],
      ["2026-01-02", 5 + (index % 7), name],
      ["2026-01-03", 8, name],
    ]);
    for (const [width, height] of [
      [800, 500],
      [800, 320],
      [420, 420],
      [420, 700],
    ] as const) {
      const option = layout(
        { legend: {}, singleAxis: { type: "time" }, series: [{ type: "themeRiver", data }] },
        { width, height },
      );
      withChart(
        option,
        (chart) => {
          const axis = (modelOf(chart) as Option).getComponent("singleAxis");
          const rect = axis.coordinateSystem.getRect();
          const texts = new Set<Option>();
          for (const line of chart.getZr().storage.getDisplayList(true) as Option[]) {
            if (line.type === "tspan" && line.parent?.__hostTarget?.type === "ec-polygon") {
              texts.add(line.parent);
            }
          }
          const shown = [...texts].filter((text) => !text.ignore && !text.invisible);
          // All of them where they fit, and else as many as there is room for.
          assert.ok(
            shown.length === 20 || (height < 500 && shown.length > 0),
            `${width}×${height}`,
          );
          for (const text of shown) {
            const box = text.getBoundingRect().clone();
            box.applyTransform(text.getComputedTransform());
            assert.ok(
              box.y >= rect.y - 1 && box.y + box.height <= rect.y + rect.height + 1,
              `${text.style.text} at ${box.y}–${box.y + box.height}, beside ${rect.y}–${rect.y + rect.height} at ${width}×${height}`,
            );
          }
        },
        { width, height },
      );
    }
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

  test("labels the days of a time axis with their month, fewer of them in a narrow plot", () => {
    const days = (start: string, count: number) =>
      Array.from({ length: count }, (_, index) => [
        new Date(Date.parse(start) + index * 86_400_000).toISOString().slice(0, 10),
        index % 5,
      ]);
    const line = (data: unknown[][], axis: Option = {}): Option => ({
      xAxis: { type: "time", ...axis },
      yAxis: { show: false },
      series: [{ type: "line", data }],
    });
    const labels = (option: Option, width: number) =>
      [
        ...svgOf(layout(option, { width }), { width, height: 500 }).matchAll(/>([^<>]+)<\/text>/g),
      ].map(([, text]) => text);
    // ECharts labels days by their number alone, as "3", among the numbers of other axes.
    assert.deepStrictEqual(labels(line(days("2026-02-02", 20)), 800), [
      "Feb 3",
      "Feb 5",
      "Feb 7",
      "Feb 9",
      "Feb 11",
      "Feb 13",
      "Feb 15",
      "Feb 17",
      "Feb 19",
      "Feb 21",
    ]);
    // The first of a month or year still names it, in bold.
    const jan = labels(line(days("2025-12-27", 14)), 800);
    assert.ok(
      ["Dec 31", "2026", "Jan 3"].every((text) => jan.includes(text)),
      String(jan),
    );
    assert.match(
      svgOf(layout(line(days("2025-12-27", 14))), { width: 800, height: 500 }),
      /font-weight:bold[^>]*>2026</,
    );
    // Fewer across a narrow plot, where ECharts would run them into each other.
    const narrow = layout(line(days("2026-02-02", 20)), { width: 400 });
    assert.strictEqual(narrow.xAxis.splitNumber, 3);
    assert.deepStrictEqual(labels(line(days("2026-02-02", 20)), 400), [
      "Feb 5",
      "Feb 9",
      "Feb 13",
      "Feb 17",
      "Feb 21",
    ]);
    // Of a single axis too, unless the axis says how many, or formats them itself.
    const river = layout(
      { singleAxis: { type: "time" }, series: [{ type: "themeRiver", data: [] }] },
      { width: 400 },
    );
    assert.strictEqual(river.singleAxis.splitNumber, 3);
    assert.deepStrictEqual(river.singleAxis.axisLabel.formatter.day, [
      "{MMM} {d}",
      "{primary|{MMM} {d}}",
    ]);
    assert.strictEqual(layout(line([], { splitNumber: 8 }), { width: 400 }).xAxis.splitNumber, 8);
    const formatted = layout(line([], { axisLabel: { formatter: "{d}" } }), { width: 400 }).xAxis;
    assert.deepStrictEqual(
      [formatted.splitNumber, formatted.axisLabel],
      [undefined, { formatter: "{d}" }],
    );
    // The label of a month's start, which ECharts adds between the ticks of days, a day before
    // "Feb 2" here: one of labels that would run into each other is left out.
    const shown = withChart(
      layout(line(days("2026-01-05", 30)), { width: 600 }),
      (chart) => {
        const boxes: { text: string; x: number; right: number }[] = [];
        for (const line of chart.getZr().storage.getDisplayList(true)) {
          const text = line.type === "tspan" ? (line.parent as unknown as Option) : undefined;
          if (text?.type !== "text" || text.ignore || text.invisible) continue;
          const box = text.getBoundingRect().clone();
          box.applyTransform(text.getComputedTransform());
          boxes.push({ text: String(text.style.text), x: box.x, right: box.x + box.width });
        }
        return boxes.sort((a, b) => a.x - b.x);
      },
      { width: 600, height: 500 },
    );
    assert.ok(
      shown.some(({ text }) => text.includes("Feb")) &&
        shown.every((box, index) => index === 0 || (shown[index - 1]?.right ?? 0) <= box.x),
      JSON.stringify(shown),
    );
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

  test("labels years on the value axis of a scatter chart as years", () => {
    const data = "year,sales\n2015,10\n2016,12\n2017,9\n2018,15";
    const option = layout(builtOption({ data, type: "scatter" } as ChartSpec, data));
    const svg = svgOf(option);
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

  test("places the nodes of a force layout at rest, the same each time, all in the chart", () => {
    const names = ["extension", "panel", "participant", "tools", "prompt", "charts", "protocol"];
    const pairs = [
      [0, 1],
      [0, 2],
      [2, 4],
      [2, 3],
      [3, 5],
      [1, 6],
      [3, 6],
    ];
    const graph = (nodes: string[], links: number[][], extra: Option = {}): Option => ({
      title: { text: "Modules" },
      series: [
        {
          type: "graph",
          layout: "force",
          label: { show: true, position: "right" },
          data: nodes.map((name, index) => ({ name, symbolSize: 10 + (index % 3) * 10 })),
          links: links.map(([source = 0, target = 0]) => ({
            source: nodes[source],
            target: nodes[target],
          })),
          ...extra,
        },
      ],
    });
    const modules = graph(names, pairs);
    const chain = graph(
      Array.from({ length: 12 }, (_, index) => `a-rather-long-module-${index}`),
      Array.from({ length: 11 }, (_, index) => [index, index + 1]),
    );
    const loose = graph(["one", "two", "three", "four", "five"], []);
    for (const option of [modules, chain, loose]) {
      for (const { width, height } of [
        { width: 404, height: 575 },
        { width: 1184, height: 675 },
      ]) {
        const laidOut = layout(option, { width, height });
        disableAnimation(laidOut);
        const [series] = laidOut.series;
        // Placed, for ECharts to draw where they are.
        assert.strictEqual(series.layout, "none");
        assert.ok(series.data.every((node: Option) => Number.isFinite(node.x + node.y)));
        // Nodes, links and labels are drawn within the chart.
        const outside = withChart(
          laidOut,
          (chart) =>
            (chart.getZr().storage.getDisplayList(true) as Option[]).filter((element) => {
              let owner: Option | undefined;
              for (let at = element; at && !owner; at = at.__hostTarget ?? at.parent) {
                owner = at.__ecComponentInfo;
              }
              const box = element.getBoundingRect().clone();
              box.applyTransform(element.getComputedTransform());
              return (
                owner?.mainType === "series" &&
                (box.x < -1 ||
                  box.y < -1 ||
                  box.x + box.width > width + 1 ||
                  box.y + box.height > height + 1)
              );
            }).length,
          { width, height },
        );
        assert.strictEqual(outside, 0, `${series.data[0].name} at ${width}x${height}`);
      }
    }
    // The same each time, and placed once for the same nodes and links, without changing them.
    const [first, again] = [layout(modules), layout(modules)].map((each) => each.series[0].data);
    assert.strictEqual(first, again);
    assert.strictEqual(modules.series[0].data[0].x, undefined);
    // By the option's edge length and repulsion, as ECharts' force layout would be.
    const placedBy = (force: Option) =>
      layout(graph(names, pairs, { force })).series[0].data.map(({ x }: Option) => x);
    assert.notDeepStrictEqual(placedBy({ repulsion: 80 }), placedBy({ repulsion: 800 }));
  });

  test("spreads the nodes of a force layout it does not place over the space there is", () => {
    const graph = (count: number, force?: Option, node: Option = {}) => ({
      series: [
        {
          type: "graph",
          layout: "force",
          ...(force && { force }),
          data: Array.from({ length: count }, (_, index) => ({ name: `N${index}`, ...node })),
        },
      ],
    });
    // A layout that the option starts or animates itself, or of nodes it places.
    const force = (count: number, size: { width: number; height: number }) =>
      layout(graph(count, { layoutAnimation: true }), size).series[0].force;
    // Longer edges for fewer nodes and more room, and repulsion to match.
    const few = force(4, { width: 1200, height: 800 });
    assert.ok(few.edgeLength > 150 && few.repulsion > 1000, JSON.stringify(few));
    const narrow = force(4, { width: 360, height: 400 });
    assert.ok(narrow.edgeLength < few.edgeLength && narrow.edgeLength > 60, JSON.stringify(narrow));
    assert.ok(layout(graph(250), { width: 360, height: 400 }).series[0].force.edgeLength < 30);
    for (const placed of [graph(4, { initLayout: "circular" }), graph(4, {}, { x: 1, y: 2 })]) {
      assert.strictEqual(layout(placed).series[0].layout, "force");
    }
    assert.deepStrictEqual(layout(graph(4, { repulsion: 80, friction: 0.3 })).series[0].force, {
      repulsion: 80,
      friction: 0.3,
    });
    // Nor of a graph whose nodes the steps of a timeline give, which ECharts merges over those of
    // the base option.
    const nodes = (prefix: string) => ["A", "B", "C"].map((name) => ({ name: `${prefix}${name}` }));
    const stepped = layout({
      baseOption: {
        timeline: { data: ["2025", "2026"] },
        series: [{ type: "graph", layout: "force", data: nodes("") }],
      },
      options: [{ series: [{ data: nodes("") }] }, { series: [{ data: nodes("next ") }] }],
    });
    assert.strictEqual(stepped.baseOption.series[0].layout, "force");
    const drawn = withChart(stepped, (chart) => {
      const data = (modelOf(chart).getSeriesByIndex(0) as Option).getData();
      return Array.from({ length: data.count() }, (_, index) => data.getItemLayout(index));
    });
    assert.ok(drawn.length === 3 && drawn.flat().every(Number.isFinite), JSON.stringify(drawn));
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

  test("makes room for the title that the timeline's current step sets", () => {
    const top = (base: Option, step: Option) =>
      layout({
        baseOption: bars({ timeline: { data: ["2025"] }, ...base }),
        options: [{ title: step }],
      }).baseOption.grid.top;
    assert.strictEqual(top({}, { text: "2025" }), 32 + 14);
    assert.strictEqual(top({ title: { text: "Sales" } }, { subtext: "2025" }), 50 + 14);
    assert.strictEqual(top({ title: { text: "Sales" } }, {}), 32 + 14);
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
    // Padded less than ECharts 6 does, to fit the room left for it.
    assert.strictEqual(option.baseOption.timeline.padding, 5);
    const placed = layout(bars({ timeline: { top: 0 } }));
    assert.strictEqual(placed.grid.bottom, 8);
    assert.strictEqual(placed.timeline.padding, undefined);
  });
});
