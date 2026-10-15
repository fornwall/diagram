import * as assert from "node:assert";
import { toolWarnings } from "../webview/echartsAround";
import { bars, layout, type Option } from "./echartsModel";

suite("echartsAround", () => {
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
});
