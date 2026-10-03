import * as assert from "node:assert";
import { captureChartPresentation, rebuildChart } from "../chartPresentation";
import type { ChartSpec } from "../chartSpec";
import { buildChart } from "../charts";
import { parseTable } from "../data";

// biome-ignore lint/suspicious/noExplicitAny: ECharts options have an open schema.
type Option = Record<string, any>;
const spec: ChartSpec = { type: "bar", data: "unused" };
const oldTable = parseTable("name,sales,cost\nA,2,1\nB,4,3");
const newTable = parseTable("name,sales,cost\nC,20,10\nD,40,30");
function edited(change: (option: Option) => void, chart = spec) {
  const option = buildChart(chart, oldTable).option;
  const baseline = captureChartPresentation(JSON.stringify(option));
  change(option);
  return captureChartPresentation(JSON.stringify(option), baseline);
}

suite("chart presentation", () => {
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
    const removed = rebuildChart(chart, parseTable("service,day,latency\nb,Wed,20"), presentation)
      .option as Option;
    assert.strictEqual(removed.series[0].itemStyle, undefined);
    assert.strictEqual(removed.yAxis[0].axisLabel?.formatter, undefined);
    assert.notStrictEqual(removed.title[0].textStyle?.color, "blue");
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
    assert.strictEqual(refreshed.series[0].data[0].lower, 10);
    assert.strictEqual(refreshed.series[0].data[1].upper, 30);
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
    assert.match(presentation.blocked ?? "", /JavaScript callbacks/);
    assert.throws(() => rebuildChart(spec, newTable, presentation), /JavaScript callbacks/);
    assert.strictEqual(
      captureChartPresentation(JSON.stringify(buildChart(spec, oldTable).option), presentation)
        .blocked,
      undefined,
    );
  });

  test("JSON key order is immaterial and null is preserved as an explicit option value", () => {
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
