import * as assert from "node:assert";
import { bars, layout, type Option } from "./echartsModel";

suite("echartsLayout", () => {
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

  test("measures axis labels, legends and a radar's names in the theme's font, as ECharts draws them", () => {
    // The theme sets the font of each, which ECharts takes over the text style of the option.
    const big = { textStyle: { fontSize: 18, fontFamily: "monospace" } };
    const pairs = (option: Option, read: (laidOut: Option) => unknown, width = 600) =>
      [option, { ...option, ...big }].map((each) => read(layout(each, { width, height: 500 })));
    const labels = ["Alpha one", "Bravo two", "Charlie 3", "Delta four", "Echo five", "Foxtrot 6"];
    const columns = {
      xAxis: { type: "category", data: labels },
      yAxis: {},
      series: [{ type: "bar", data: [1, 2, 3, 4, 5, 6] }],
    };
    assert.deepStrictEqual(
      pairs(columns, ({ xAxis }) => xAxis.axisLabel?.rotate),
      [undefined, undefined],
    );
    const rows = { xAxis: {}, yAxis: { type: "category", data: labels }, series: columns.series };
    assert.deepStrictEqual(
      pairs(rows, ({ yAxis }) => yAxis.axisLabel?.width, 300),
      [undefined, undefined],
    );
    const pie = {
      legend: {},
      series: [{ type: "pie", data: labels.map((name) => ({ name, value: 1 })) }],
    };
    const [right, bigRight] = pairs(pie, ({ series }) => series[0].right, 800);
    assert.strictEqual(bigRight, right);
    const radar = {
      radar: { indicator: labels.map((name) => ({ name, max: 10 })) },
      series: [{ type: "radar", data: [{ value: labels.map(() => 5) }] }],
    };
    const [radius, bigRadius] = pairs(radar, (laidOut) => laidOut.radar.radius, 360);
    assert.strictEqual(bigRadius, radius);
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

  test("gives up a zoom slider, a subtitle and a title in turn for a plot too short to read", () => {
    const at = (height: number, categories = ["A", "B"]) => {
      const option = layout(
        bars({
          title: { text: "Latency", subtext: "p50 and p99" },
          dataZoom: [{ type: "slider" }],
          xAxis: { type: "category", data: categories },
          series: ["p50", "p99"].map((name) => ({
            type: "bar",
            name,
            data: categories.map((_, index) => index),
          })),
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
    // Category labels turned to fit take the plot's height too.
    const services =
      "Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliet Kilo Lima Mike November Oscar Papa Quebec Romeo Sierra Tango Uniform Victor Whiskey Yankee"
        .split(" ")
        .map((word) => `${word} service`);
    assert.deepStrictEqual(at(260), full);
    assert.deepStrictEqual(at(260, services), { ...full, zoom: "inside", subtext: "" });
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
