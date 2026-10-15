import * as assert from "node:assert";
import { modelOf } from "../webview/echartsItems";
import { layout, type Option, svgOf, widthOf, withChart } from "./echartsModel";

suite("echartsCoordinates", () => {
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
    const narrow = { width: 370, height: 575 };
    const laidOut = layout(cars(), narrow);
    // Every other name a line higher, each as wide as the room between three axes.
    assert.deepStrictEqual(
      laidOut.parallelAxis.map((axis: Option) => axis.nameGap),
      [15, 32, 15, 32, 15],
    );
    const { left, right, top } = laidOut.parallel;
    const step = (narrow.width - left - right) / 4;
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
    assert.ok(radius(long, 360) <= (360 - 2 * widthOf("Intelligence")) / 2 - 20);
    // In a wide one, the height decides.
    assert.strictEqual(radius(long, 1200), radius(short, 1200));
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
    // Of ECharts' size of the names.
    const nameWidth = Math.round(widthOf("Frontend", 11) + 12);
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
});
