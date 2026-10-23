import * as assert from "node:assert";
import type { ChartSpec } from "../chartSpec";
import { drawnWidth } from "../webview/echartsLibrary";
import { bars, builtOption, layout, type Option, svgOf, withChart } from "./echartsModel";

suite("echartsGrid", () => {
  test("lays out the grid of an option with an empty list of grids", () => {
    const option = layout(bars({ title: { text: "T" }, grid: [] }));
    assert.deepStrictEqual(option.grid, layout(bars({ title: { text: "T" } })).grid);
    assert.strictEqual(option.grid.top, 46);
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

  test("rotates category labels that would overlap", () => {
    const labels = Array.from({ length: 20 }, (_, index) => `Category ${index}`);
    const option = layout(bars({ xAxis: { type: "category", data: labels } }));
    assert.deepStrictEqual(option.xAxis.axisLabel, { rotate: 30, hideOverlap: true });
    assert.strictEqual(layout(bars()).xAxis.axisLabel, undefined);
    // Labels that the option shows every one of, or every other one, stay shown, turned to fit.
    const every = (interval: number, width: number) =>
      layout(bars({ xAxis: { type: "category", data: labels, axisLabel: { interval } } }), {
        width,
      }).xAxis.axisLabel;
    assert.deepStrictEqual(every(0, 800), { rotate: 30, interval: 0 });
    assert.deepStrictEqual(every(0, 400), { rotate: 45, interval: 0 });
    assert.deepStrictEqual(every(1, 400), { rotate: 30, interval: 1 });
  });

  test("tells long category labels apart by lines, or else by what follows the start they share", () => {
    const table = (count: number, name = (index: number) => `Northern Regional Center ${index}`) =>
      `center,shipments\n${Array.from({ length: count }, (_, index) => `${name(index)},${index + 1}`).join("\n")}`;
    const bars = (type: "bar" | "horizontalBar", data: string, height = 700) =>
      layout(builtOption({ type, data: "unused", labelColumn: "center" }, data), {
        width: 400,
        height,
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
    // Columns name their axis below their labels, which then go across, where the labels would
    // be cut short slanted.
    const columns = bars("bar", table(6), 500).xAxis;
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
      ["Site", "…Regional Center 12", undefined],
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

  test("measures a sample of the labels of a dense axis, and the longest", () => {
    let measured = 0;
    const counted = (text: string, font: string) => {
      measured++;
      return drawnWidth(text, font);
    };
    const data = Array.from({ length: 20_000 }, (_, index) => `Category ${index}`);
    // Off the sample, which the panel cuts short all the same.
    data[12_345] = "A category of a name much longer than any other";
    const option = layout(bars({ xAxis: { type: "category", data } }), { drawnWidth: counted });
    assert.ok(measured < 1000, `${measured} labels measured`);
    assert.strictEqual(option.xAxis.axisLabel.overflow, "truncate");
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
    // A label of each, and of the vertical one again for the room it takes beside the plot.
    assert.strictEqual(reads, 3);
  });

  test("keeps the plot of hundreds of rows tall, telling ECharts which of their labels to show", () => {
    // ECharts sizes a grid to keep its axis labels inside it, and shrinks one of hundreds of
    // category labels on an inverse axis, as of a heatmap's rows from the top, to a strip.
    const rows = (count: number, inverse = true): Option => ({
      xAxis: { type: "category", data: ["a", "b"] },
      yAxis: {
        type: "category",
        data: Array.from({ length: count }, (_, i) => `row ${i}`),
        inverse,
      },
      visualMap: { min: 0, max: 1, show: false },
      series: [{ type: "heatmap", data: [[0, 0, 1]] }],
    });
    const plotHeight = (option: Option) =>
      withChart(
        option,
        (chart) => {
          const model = (chart as unknown as { getModel(): Option }).getModel();
          return Math.round(model.getComponent("grid").coordinateSystem.getRect().height);
        },
        { width: 1176, height: 593 },
      );
    const many = layout(rows(250), { width: 1176, height: 593 });
    assert.ok(many.yAxis.axisLabel.interval >= 1, JSON.stringify(many.yAxis.axisLabel));
    assert.ok(plotHeight(many) > 400, String(plotHeight(many)));
    // The last label shown clear of the end: the 249th row's would stick out of it.
    const { interval } = many.yAxis.axisLabel;
    assert.ok(249 - Math.floor(249 / (interval + 1)) * (interval + 1) >= 3, String(interval));
    // No fewer labels than ECharts shows on its own: every other of 20 rows in 200 pixels.
    const some = layout(rows(20), { width: 400, height: 200 });
    assert.strictEqual(some.yAxis.axisLabel.interval, 1);
    // Not of an axis whose categories all fit, nor one that the option spaces itself, nor one
    // that is not inverse, whose labels ECharts sizes the grid for rightly.
    const few = layout(rows(20), { width: 1176, height: 593 });
    assert.strictEqual(few.yAxis.axisLabel?.interval, undefined);
    const plain = layout(rows(250, false), { width: 1176, height: 593 });
    assert.strictEqual(plain.yAxis.axisLabel?.interval, undefined);
    // Nor one that a data zoom zooms, whose labels ECharts spaces for the window it shows.
    const zooms = (dataZoom: unknown[]) =>
      layout({ ...rows(250), dataZoom }, { width: 1176, height: 593 }).yAxis.axisLabel?.interval;
    for (const dataZoom of [
      [{ yAxisIndex: 0 }],
      [{ yAxisIndex: [1, 0], start: 0, end: 10 }],
      [{ yAxisIndex: "all" }],
      [{ orient: "vertical" }],
    ]) {
      assert.strictEqual(zooms(dataZoom), undefined, JSON.stringify(dataZoom));
    }
    for (const dataZoom of [[{ xAxisIndex: 0 }], [{}], [{ yAxisIndex: 1 }]]) {
      assert.ok((zooms(dataZoom) ?? 0) >= 1, JSON.stringify(dataZoom));
    }
    const own = rows(250);
    own.yAxis.axisLabel = { interval: 49 };
    assert.strictEqual(layout(own, { width: 1176, height: 593 }).yAxis.axisLabel.interval, 49);
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
    assert.strictEqual(narrow.xAxis.splitNumber, 4);
    assert.deepStrictEqual(labels(line(days("2026-02-02", 20)), 400), [
      "Feb 5",
      "Feb 9",
      "Feb 13",
      "Feb 17",
      "Feb 21",
    ]);
    // A least interval, as a generated chart of months sets, keeps the ticks a month apart rather
    // than at the weeks between, and fewer still across a narrow plot.
    const months = Array.from({ length: 6 }, (_, i) => [
      `2026-${String(i + 1).padStart(2, "0")}`,
      i,
    ]);
    const monthly = line(months, { minInterval: 28 * 86_400_000 });
    assert.deepStrictEqual(labels(monthly, 800), ["2026", "Feb", "Mar", "Apr", "May", "Jun"]);
    assert.ok((layout(monthly, { width: 300 }).xAxis.splitNumber ?? 6) < 6);
    // Of a single axis too, unless the axis says how many, or formats them itself.
    const river = layout(
      { singleAxis: { type: "time" }, series: [{ type: "themeRiver", data: [] }] },
      { width: 400 },
    );
    assert.strictEqual(river.singleAxis.splitNumber, 4);
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
});
