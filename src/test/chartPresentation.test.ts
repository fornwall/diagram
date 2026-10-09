import * as assert from "node:assert";
import { captureChartPresentation, isChartPresentation, rebuildChart } from "../chartPresentation";
import { CHART_TYPES, type ChartSpec, type ChartType } from "../chartSpec";
import { buildChart } from "../charts";
import { type DataTable, parseTable } from "../data";
import type { Option } from "./echartsModel";

const spec: ChartSpec = { type: "bar", data: "unused" };
const oldTable = parseTable("name,sales,cost\nA,2,1\nB,4,3");
const newTable = parseTable("name,sales,cost\nC,20,10\nD,40,30");
function edited(change: (option: Option) => void, chart = spec) {
  const option = buildChart(chart, oldTable).option;
  const baseline = captureChartPresentation(JSON.stringify(option));
  change(option);
  return captureChartPresentation(JSON.stringify(option), baseline);
}

suite("chartPresentation", () => {
  test("captures generated options without retaining their data or mutable styling", () => {
    const option = buildChart(spec, oldTable).option as Option;
    option.series[0].label = { show: true };
    const expected = captureChartPresentation(JSON.stringify(option));
    const direct = captureChartPresentation(option);
    assert.deepStrictEqual(direct, expected);
    option.series[0].label.show = false;
    option.series[0].data[0] = 999;
    assert.deepStrictEqual(direct, expected);
    assert.doesNotMatch(JSON.stringify(direct.baseline), /"data"/);

    const styled = buildChart(spec, oldTable).option as Option;
    styled.series[0].label = { show: false };
    assert.deepStrictEqual(
      captureChartPresentation(styled, direct),
      captureChartPresentation(JSON.stringify(styled), expected),
    );
  });

  test("captures each generated chart's option as it captures the option's source", () => {
    // diagram_chart captures the option it generated, rather than parsing its source again.
    const table = parseTable(
      "region,city,day,sales,cost\nNorth,Paris,2025-01-01,2,1\nNorth,Rome,2025-01-02,4,3\n" +
        "South,Oslo,2025-01-03,5,-0\nSouth,Paris,2025-01-04,1,0.5",
    );
    const levels = new Set<ChartType>(["sankey", "treemap", "sunburst", "heatmap"]);
    for (const type of CHART_TYPES) {
      const labels = levels.has(type)
        ? ["region", "city"]
        : type === "histogram"
          ? undefined
          : "day";
      for (const labelColumn of [labels, undefined]) {
        const chart: ChartSpec = { type, data: "unused", ...(labelColumn && { labelColumn }) };
        const { option } = buildChart(chart, table);
        assert.deepStrictEqual(
          captureChartPresentation(option),
          captureChartPresentation(JSON.stringify(option, null, 2)),
          type,
        );
      }
    }
  });

  test("records only the edits of a source whose generated option has values JSON writes otherwise", () => {
    // The heatmap's scale starts at -0, which its source writes as 0.
    const chart: ChartSpec = { type: "heatmap", data: "unused", labelColumn: ["r", "c"] };
    const table = parseTable("r,c,v\na,x,-0.0\na,y,2\nb,x,3\nb,y,1");
    const { option, presentation } = rebuildChart(chart, table);
    assert.ok(Object.is((option as { visualMap: { min: unknown } }).visualMap.min, -0));
    const titled = JSON.stringify({ ...option, title: { text: "Heat" } }, null, 2);
    assert.deepStrictEqual(captureChartPresentation(titled, presentation).edits, [
      { path: ["title"], value: { text: "Heat" } },
    ]);
    // Nor do infinities and undefined properties of an option differ from their source.
    const odd = { series: [{ type: "bar", data: [1] }], yAxis: { max: Infinity, name: undefined } };
    assert.deepStrictEqual(
      captureChartPresentation(odd),
      captureChartPresentation(JSON.stringify(odd)),
    );
  });

  test("canonical data hashes retain compatibility with saved nested and numeric keys", () => {
    const option = {
      series: [
        {
          type: "scatter",
          data: [
            { value: [1, 2], name: "A", extra: { z: 3, a: 4 } },
            { name: "B", value: [3, 4], "10": "ten", "2": "two" },
          ],
        },
      ],
    };
    const source = JSON.stringify(option);
    const baseline = captureChartPresentation(source);
    assert.strictEqual(
      baseline.dataHash,
      "697174acbd23323f7971eef63f4d47210fef2982ccb513539c3bd654ecffe236",
    );
    const reorder = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reorder);
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([key, item]) => [key, reorder(item)]),
        );
      }
      return value;
    };
    assert.deepStrictEqual(captureChartPresentation(JSON.stringify(reorder(option))), baseline);
    assert.strictEqual(JSON.stringify(option), source);
    const first = option.series[0]?.data[0];
    assert.ok(first);
    first.value[0] = 99;
    assert.match(
      captureChartPresentation(JSON.stringify(option), baseline).blocked ?? "",
      /can't be kept, because the source changes the chart's data/,
    );
  });

  test("applying multiple styling edits leaves reusable inputs and earlier results unchanged", () => {
    const chart: ChartSpec = {
      ...spec,
      options: { series: { label: { show: true, position: "top" } } },
    };
    const presentation = edited((option) => {
      option.series[0].label.show = false;
      option.series[0].label.position = "inside";
      option.series[0].itemStyle = { color: "red" };
    }, chart);
    const before = structuredClone({ chart, presentation, table: newTable });
    const first = rebuildChart(chart, newTable, presentation);
    const second = rebuildChart(chart, newTable, presentation);
    const option = second.option as Option;
    assert.deepStrictEqual(option.series[0].label, { show: false, position: "inside" });
    assert.deepStrictEqual(option.series[1].label, { show: true, position: "top" });
    option.series[0].label.show = true;
    option.series[0].itemStyle.color = "blue";
    assert.strictEqual((first.option as Option).series[0].label.show, false);
    assert.strictEqual((first.option as Option).series[0].itemStyle.color, "red");
    assert.deepStrictEqual({ chart, presentation, table: newTable }, before);
  });

  test("facet styling follows component identities when groups reorder or disappear", () => {
    const chart: ChartSpec = { type: "bar", data: "unused", facetColumn: "service" };
    const original = parseTable("service,day,latency\na,Mon,1\nb,Tue,2");
    const option = buildChart(chart, original).option as Option;
    const baseline = captureChartPresentation(JSON.stringify(option));
    const styledId = option.series[0].id;
    const axisId = option.yAxis[0].id;
    option.series[0].itemStyle = { color: "red" };
    option.yAxis[0].axisLabel = { formatter: "{value} ms" };
    option.title[0].textStyle = { color: "blue" };
    const presentation = captureChartPresentation(JSON.stringify(option), baseline);
    assert.strictEqual(presentation.blocked, undefined);
    const reordered = rebuildChart(
      chart,
      parseTable("service,day,latency\nb,Wed,20\na,Thu,10"),
      presentation,
    ).option as Option;
    assert.strictEqual(
      reordered.series.find((item: Option) => item.id === styledId).itemStyle.color,
      "red",
    );
    assert.strictEqual(
      reordered.yAxis.find((item: Option) => item.id === axisId).axisLabel.formatter,
      "{value} ms",
    );
    assert.strictEqual(
      reordered.title.find((item: Option) => item.id === axisId).textStyle.color,
      "blue",
    );
    const removed = rebuildChart(chart, parseTable("service,day,latency\nb,Wed,20"), presentation);
    const removedOption = removed.option as Option;
    assert.strictEqual(removedOption.series[0].itemStyle, undefined);
    assert.strictEqual(removedOption.yAxis[0].axisLabel?.formatter, undefined);
    assert.notStrictEqual(removedOption.title[0].textStyle?.color, "blue");
    // The panel's styling comes back with the panel.
    const back = rebuildChart(chart, original, removed.presentation).option as Option;
    assert.strictEqual(back.series[0].itemStyle.color, "red");
    assert.strictEqual(back.yAxis[0].axisLabel.formatter, "{value} ms");
    assert.strictEqual(back.title[0].textStyle.color, "blue");
  });

  test("moving a facet axis to another grid is a structural edit", () => {
    const chart: ChartSpec = { type: "bar", data: "unused", facetColumn: "service" };
    const table = parseTable("service,day,latency\na,Mon,1\nb,Tue,2");
    const option = buildChart(chart, table).option as Option;
    const baseline = captureChartPresentation(JSON.stringify(option));
    option.yAxis[0].gridIndex = 1;
    assert.match(
      captureChartPresentation(JSON.stringify(option), baseline).blocked ?? "",
      /structure/,
    );
  });

  test("histograms recompute bin edges on refresh while retaining presentation", () => {
    const chart: ChartSpec = { type: "histogram", data: "unused", bins: 2 };
    const option = buildChart(chart, parseTable("latency\n1\n2\n3")).option as Option;
    const baseline = captureChartPresentation(JSON.stringify(option));
    option.series[0].itemStyle = { color: "red" };
    const presentation = captureChartPresentation(JSON.stringify(option), baseline);
    const refreshed = rebuildChart(chart, parseTable("latency\n10\n20\n30"), presentation)
      .option as Option;
    assert.deepStrictEqual(refreshed.xAxis.data, ["[10, 20)", "[20, 30]"]);
    assert.strictEqual(refreshed.series[0].itemStyle.color, "red");
  });

  test("refreshes values and categories while keeping axis labels, formatting, colors and legend", () => {
    const presentation = edited((option) => {
      option.yAxis.name = "Revenue";
      option.yAxis.axisLabel = { formatter: "USD {value}" };
      option.legend = { show: false };
      option.series[0].itemStyle = { color: "red" };
      option.color = ["red", "blue"];
    });
    const result = rebuildChart(spec, newTable, presentation);
    const option: Option = result.option;
    assert.deepStrictEqual(option.series[0].data, [20, 40]);
    assert.deepStrictEqual(option.xAxis.data, ["C", "D"]);
    assert.strictEqual(option.yAxis.name, "Revenue");
    assert.strictEqual(option.yAxis.axisLabel.formatter, "USD {value}");
    assert.strictEqual(option.legend.show, false);
    assert.strictEqual(option.series[0].itemStyle.color, "red");
    assert.deepStrictEqual(option.color, ["red", "blue"]);
    assert.strictEqual(result.presentation.blocked, undefined);
    assert.doesNotMatch(JSON.stringify(result.presentation.baseline), /"data"/);
    assert.deepStrictEqual(
      rebuildChart(spec, oldTable, JSON.parse(JSON.stringify(result.presentation))).option.series,
      rebuildChart(spec, oldTable, presentation).option.series,
    );
  });

  test("deleted settings stay deleted and reverting edits restores generated defaults", () => {
    const chart: ChartSpec = {
      ...spec,
      options: { yAxis: { name: "Revenue" }, series: { label: { show: true } } },
    };
    const presentation = edited((option) => {
      delete option.yAxis.name;
      delete option.series[0].label;
    }, chart);
    const option: Option = rebuildChart(chart, newTable, presentation).option;
    assert.strictEqual(option.yAxis.name, undefined);
    assert.strictEqual(option.series[0].label, undefined);
    assert.strictEqual(option.series[1].label.show, true);
    const restored = captureChartPresentation(
      JSON.stringify(buildChart(chart, oldTable).option),
      presentation,
    );
    assert.deepStrictEqual(restored.edits, []);
    assert.strictEqual(
      (rebuildChart(chart, newTable, restored).option as Option).yAxis.name,
      "Revenue",
    );
  });

  test("matches series styling by name when columns change order and skips removed series", () => {
    const presentation = edited((option) => {
      option.series[0].itemStyle = { color: "red" };
    });
    const reordered = rebuildChart(
      { ...spec, valueColumns: ["cost", "sales"] },
      newTable,
      presentation,
    ).option as Option;
    assert.strictEqual(reordered.series[0].itemStyle, undefined);
    assert.strictEqual(reordered.series[1].itemStyle.color, "red");
    assert.deepStrictEqual(reordered.series[1].data, [20, 40]);
    const removed = rebuildChart({ ...spec, valueColumns: ["cost"] }, newTable, presentation)
      .option as Option;
    assert.strictEqual(removed.series.length, 1);
    assert.strictEqual(removed.series[0].itemStyle, undefined);
  });

  test("unedited scales recalculate, while explicit scale edits are retained", () => {
    const chart: ChartSpec = { ...spec, type: "heatmap" };
    const presentation = edited((option) => {
      option.visualMap.inRange = { color: ["white", "red"] };
    }, chart);
    const option = rebuildChart(chart, newTable, presentation).option as Option;
    assert.strictEqual(option.visualMap.max, 40);
    assert.deepStrictEqual(option.visualMap.inRange.color, ["white", "red"]);
  });

  test("changing chart type drops styling for components the new chart does not use", () => {
    for (const type of ["bar", "radar", "heatmap"] as const) {
      const presentation = edited(
        (option) => {
          const component = option.yAxis ?? option.radar;
          component.name = "Custom axis";
          if (option.visualMap) option.visualMap.inRange = { color: ["white", "red"] };
          option.series[0].itemStyle = { color: "blue" };
        },
        { ...spec, type },
      );
      const option: Option = rebuildChart({ ...spec, type: "pie" }, newTable, presentation).option;
      for (const key of ["xAxis", "yAxis", "radar", "visualMap"]) {
        assert.ok(!Object.hasOwn(option, key), `${type} left an unused ${key} in the pie chart`);
      }
      // A bar's color would color every slice of the pie alike.
      assert.strictEqual(option.series[0].itemStyle, undefined, type);
    }
  });

  test("series styling follows a series to a chart that draws it alike, and saved styling still loads", () => {
    const presentation = edited((option) => {
      option.series[0].itemStyle = { color: "blue" };
    });
    assert.deepStrictEqual(presentation.seriesTypes, ["bar", "bar"]);
    for (const type of ["line", "stackedArea", "horizontalBar"] as const) {
      const option = rebuildChart({ ...spec, type }, newTable, presentation).option as Option;
      assert.deepStrictEqual(option.series[0].itemStyle, { color: "blue" }, type);
    }
    // Styling saved before series types were, which is matched by name alone.
    const { seriesTypes: _, ...saved } = presentation;
    assert.ok(isChartPresentation(saved));
    assert.ok(!isChartPresentation({ ...saved, seriesTypes: [1] }));
    const pie = rebuildChart({ ...spec, type: "pie" }, newTable, saved);
    assert.deepStrictEqual((pie.option as Option).series[0].itemStyle, { color: "blue" });
    assert.deepStrictEqual(pie.presentation.seriesTypes, ["pie"]);
  });

  test("a title or legend added to a chart joins the panel titles and legend of facets", () => {
    const single: ChartSpec = { type: "bar", data: "unused", valueColumns: ["latency", "errors"] };
    const faceted: ChartSpec = { ...single, facetColumn: "service" };
    const table = parseTable("service,day,latency,errors\na,Mon,1,0\nb,Tue,2,1");
    const option = buildChart(single, table).option as Option;
    const baseline = captureChartPresentation(JSON.stringify(option));
    const title = { text: "Latency", left: "center" };
    option.title = title;
    option.legend = { top: 30 };
    option.grid = { left: 80 };
    const presentation = captureChartPresentation(JSON.stringify(option), baseline);
    const generated = (table: DataTable) => buildChart(faceted, table).option as Option;
    const facets = rebuildChart(faceted, table, presentation);
    const facetOption = facets.option as Option;
    assert.deepStrictEqual(facetOption.title, [...generated(table).title, title]);
    assert.deepStrictEqual(facetOption.legend, { ...generated(table).legend, top: 30 });
    // One grid would lay the panels over each other.
    assert.deepStrictEqual(facetOption.grid, generated(table).grid);
    // A refresh with another facet titles every panel.
    const more = parseTable("service,day,latency,errors\na,Mon,1,0\nb,Tue,2,1\nc,Wed,3,2");
    const refreshed = rebuildChart(faceted, more, facets.presentation);
    assert.deepStrictEqual((refreshed.option as Option).title, [...generated(more).title, title]);
    assert.strictEqual((refreshed.option as Option).legend.top, 30);
    const back = rebuildChart(single, table, refreshed.presentation);
    assert.deepStrictEqual((back.option as Option).title, title);
    assert.deepStrictEqual((back.option as Option).grid, { left: 80 });
    // The place of a legend that the chart does not generate waits for one that does.
    assert.strictEqual((back.option as Option).legend, undefined);
    const again = rebuildChart(faceted, table, back.presentation).option as Option;
    assert.strictEqual(again.legend.top, 30);
  });

  test("a title that replaced the titles of facets replaces them again, and waits out a single chart", () => {
    const single: ChartSpec = { type: "bar", data: "unused" };
    const faceted: ChartSpec = { ...single, facetColumn: "service" };
    const table = parseTable("service,day,latency\na,Mon,1\nb,Tue,2");
    const option = buildChart(faceted, table).option as Option;
    const baseline = captureChartPresentation(JSON.stringify(option));
    const title = { text: "Latency" };
    option.title = title;
    const presentation = captureChartPresentation(JSON.stringify(option), baseline);
    const more = parseTable("service,day,latency\na,Mon,1\nb,Tue,2\nc,Wed,3");
    const refreshed = rebuildChart(faceted, more, presentation);
    assert.deepStrictEqual((refreshed.option as Option).title, title);
    const unfaceted = rebuildChart(single, table, refreshed.presentation);
    assert.strictEqual((unfaceted.option as Option).title, undefined);
    assert.ok(isChartPresentation(JSON.parse(JSON.stringify(unfaceted.presentation))));
    const again = rebuildChart(faceted, table, unfaceted.presentation).option as Option;
    assert.deepStrictEqual(again.title, title);
  });

  test("styling that a chart cannot use comes back with a chart that can", () => {
    const presentation = edited((option) => {
      option.series[0].itemStyle = { color: "red" };
      option.xAxis.axisLabel = { rotate: 45 };
    });
    const pie = rebuildChart({ ...spec, type: "pie" }, newTable, presentation);
    assert.strictEqual((pie.option as Option).series[0].itemStyle, undefined);
    assert.strictEqual(pie.presentation.kept?.length, 2);
    // Saved and loaded again, as the panel's state is.
    const saved = JSON.parse(JSON.stringify(pie.presentation));
    assert.ok(isChartPresentation(saved));
    assert.ok(!isChartPresentation({ ...saved, kept: [{ path: ["series"], shape: "panels" }] }));
    const bar = rebuildChart(spec, newTable, saved);
    assert.deepStrictEqual((bar.option as Option).series[0].itemStyle, { color: "red" });
    assert.deepStrictEqual((bar.option as Option).xAxis.axisLabel, { rotate: 45 });
    assert.strictEqual(bar.presentation.kept, undefined);
    assert.strictEqual(bar.presentation.edits.length, 2);
    // A removed column's styling comes back with the column.
    const without = rebuildChart({ ...spec, valueColumns: ["cost"] }, newTable, presentation);
    const restored = rebuildChart(spec, newTable, without.presentation).option as Option;
    assert.deepStrictEqual(restored.series[0].itemStyle, { color: "red" });
  });

  test("edits that a chart has nothing for, or generates already, wait for one that differs", () => {
    const pie: ChartSpec = { ...spec, type: "pie" };
    // A legend deleted in a pie, which a bar chart does not generate.
    const hidden = edited((option) => {
      delete option.legend;
    }, pie);
    const bar = rebuildChart(spec, newTable, hidden);
    assert.strictEqual((bar.option as Option).legend, undefined);
    assert.strictEqual(rebuildChart(pie, newTable, bar.presentation).option.legend, undefined);
    // A legend placed in a pie, which a bar chart does not get.
    const placed = edited((option) => {
      option.legend.top = 30;
    }, pie);
    const unplaced = rebuildChart(spec, newTable, placed);
    assert.strictEqual((unplaced.option as Option).legend, undefined);
    const replaced = rebuildChart(pie, newTable, unplaced.presentation).option as Option;
    assert.deepStrictEqual(replaced.legend, { top: 30 });
    // A scale set in a bar chart, which a line chart has already.
    const scaled = edited((option) => {
      option.yAxis.scale = true;
    });
    const line = rebuildChart({ ...spec, type: "line" }, newTable, scaled);
    assert.strictEqual((line.option as Option).yAxis.scale, true);
    const rescaled = rebuildChart(spec, newTable, line.presentation).option as Option;
    assert.strictEqual(rescaled.yAxis.scale, true);
  });

  test("keeps the newest of the edits that wait for a chart, and a bounded number of them", () => {
    const presentation = edited((option) => {
      option.series[0].itemStyle = { color: "red" };
    });
    const target = { shape: "array", item: { key: "name", value: "gone", type: "bar", count: 2 } };
    const waiting = (count: number, color: (i: number) => string) =>
      Array.from({ length: count }, (_, i) => ({
        ...target,
        path: ["series", 0, "itemStyle", "color"],
        value: color(i),
        item: { ...target.item, value: `gone ${i}` },
      }));
    const many = rebuildChart(spec, newTable, {
      ...presentation,
      kept: waiting(150, (i) => `#${i}`) as never,
    }).presentation.kept;
    assert.strictEqual(many?.length, 100);
    assert.strictEqual(many?.at(-1)?.value, "#149");
    const repeated = [
      { ...target, path: ["series", 0, "itemStyle", "color"], value: "red" },
      { ...target, path: ["series", 0, "itemStyle", "color"], value: "blue" },
    ];
    const once = rebuildChart(spec, newTable, { ...presentation, kept: repeated as never })
      .presentation.kept;
    assert.deepStrictEqual(
      once?.map(({ value }) => value),
      ["blue"],
    );
  });

  test("removing facets does not turn a single axis into a partial array", () => {
    const unfaceted: ChartSpec = { type: "bar", data: "unused" };
    const chart: ChartSpec = { ...unfaceted, facetColumn: "service" };
    const table = parseTable("service,day,latency\na,Mon,1\nb,Tue,2");
    const option = buildChart(chart, table).option as Option;
    const baseline = captureChartPresentation(JSON.stringify(option));
    option.yAxis[0].axisLabel = { formatter: "{value} ms" };
    const presentation = captureChartPresentation(JSON.stringify(option), baseline);
    const single = rebuildChart(unfaceted, table, presentation);
    assert.deepStrictEqual(single.option.yAxis, buildChart(unfaceted, table).option.yAxis);
    assert.strictEqual(single.presentation.blocked, undefined);
  });

  test("data and structural edits block refresh until reverted or explicitly reset", () => {
    for (const change of [
      (option: Option) => {
        option.series[0].data[0] = 999;
      },
      (option: Option) => {
        option.series.push({ type: "bar", data: [5, 6] });
      },
      (option: Option) => {
        option.series[0].type = "line";
      },
      (option: Option) => {
        option.dataset = { source: [[1, 2]] };
      },
    ]) {
      const presentation = edited(change);
      assert.throws(
        () => rebuildChart(spec, newTable, presentation),
        /source is kept.*Reset Styling/,
      );
      const restored = captureChartPresentation(
        JSON.stringify(buildChart(spec, oldTable).option),
        presentation,
      );
      assert.strictEqual(restored.blocked, undefined);
    }
  });

  test("never evaluates JavaScript source and allows correcting invalid JSON", () => {
    const baseline = captureChartPresentation(JSON.stringify(buildChart(spec, oldTable).option));
    const presentation = captureChartPresentation(
      '(()=>{throw new Error("executed")})()',
      baseline,
    );
    assert.match(
      presentation.blocked ?? "",
      /because the source is not JSON.*JavaScript callbacks/,
    );
    assert.throws(() => rebuildChart(spec, newTable, presentation), /JavaScript callbacks/);
    assert.strictEqual(
      captureChartPresentation(JSON.stringify(buildChart(spec, oldTable).option), presentation)
        .blocked,
      undefined,
    );
  });

  test("says which JSON cannot keep styling, rather than blaming callbacks", () => {
    const baseline = captureChartPresentation(JSON.stringify(buildChart(spec, oldTable).option));
    for (const [source, message] of [
      ["[]", /because the source is an array, not one JSON object of chart options\./],
      ["null", /because the source is null,/],
      [
        '{"__proto__": {"color": ["red"]}}',
        /because the source has the key "__proto__", which is not a chart option/,
      ],
      [
        '{"series": [{"itemStyle": {"constructor": 1}}]}',
        /the key "constructor" in series\[0\]\.itemStyle,/,
      ],
    ] as const) {
      const blocked = captureChartPresentation(source, baseline).blocked ?? "";
      assert.match(blocked, message);
      assert.match(blocked, /Your source is kept\./);
      assert.doesNotMatch(blocked, /JavaScript callbacks|Refresh/);
    }
    assert.match(captureChartPresentation("[]").blocked ?? "", /source is an array/);
  });

  test("ignores the order of JSON keys, and keeps null as an option value", () => {
    const presentation = edited((option) => {
      option.series[0].itemStyle = { color: null };
      option.series[0] = Object.fromEntries(Object.entries(option.series[0]).reverse());
    });
    assert.strictEqual(presentation.blocked, undefined);
    assert.strictEqual(
      (rebuildChart(spec, newTable, presentation).option as Option).series[0].itemStyle.color,
      null,
    );
  });
});
