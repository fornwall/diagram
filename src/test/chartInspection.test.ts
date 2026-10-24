import * as assert from "node:assert";
import { chartContributors } from "../chartInspection";
import type { ChartSpec } from "../chartSpec";
import { buildChart } from "../charts";
import { parseTable } from "../data";
import { collectItemPage } from "../itemPage";
import type { DiagramNode } from "../protocol";
import { itemsOf } from "./echartsModel";

function inspect(spec: ChartSpec, refs: [number, number][], source?: string) {
  const table = parseTable(spec.data ?? "");
  const items = refs.map(
    ([seriesIndex, dataIndex]): DiagramNode => ({
      id: `series ${seriesIndex}, item ${dataIndex}`,
      label: "item",
      chart: { seriesIndex, dataIndex },
    }),
  );
  return chartContributors(
    spec,
    table,
    source ?? JSON.stringify(buildChart(spec, table).option),
    items,
  );
}

function actual(spec: ChartSpec) {
  const table = parseTable(spec.data ?? "");
  const option = buildChart(spec, table).option;
  const chart = itemsOf(option);
  const { items } = collectItemPage((visit) => chart.each(visit, true), {
    startItem: 1,
    maxItems: 100,
  });
  return {
    items,
    rows: (item: DiagramNode | undefined) => {
      assert.ok(item);
      return chartContributors(spec, table, JSON.stringify(option), [item]).rows;
    },
  };
}

suite("chartInspection", () => {
  test("resolves actual rendered duplicate identities to raw indices only when requested", () => {
    const spec: ChartSpec = { type: "bar", data: "name,value\na,1\na,3\nb,2", sort: "descending" };
    const table = parseTable(spec.data ?? "");
    const option = buildChart(spec, table).option;
    const items = itemsOf(option);
    const plain = collectItemPage((visit) => items.each(visit), { startItem: 1, maxItems: 100 });
    assert.ok(plain.items.every((item) => item.chart === undefined));
    const selected = collectItemPage((visit) => items.each(visit, true), {
      itemIds: ["a (item 3)"],
      startItem: 1,
      maxItems: 100,
    });
    assert.strictEqual(selected.items.length, 1);
    assert.strictEqual(selected.items[0]?.chart?.dataIndex, 2);
    assert.deepStrictEqual(
      chartContributors(spec, table, JSON.stringify(option), selected.items).rows,
      [1],
    );
  });

  test("tracks distinct duplicate labels after filters, sorting and limits", () => {
    const spec: ChartSpec = {
      type: "bar",
      data: "name,value\na,1\nb,4\na,3\na,2",
      sort: "descending",
      limit: 2,
      filters: [{ column: "value", op: "gte", value: 2 }],
    };
    assert.deepStrictEqual(inspect(spec, [[0, 1]]).rows, [3]);
    assert.deepStrictEqual(
      inspect(spec, [
        [0, 0],
        [0, 1],
      ]).rows,
      [2, 3],
    );
  });

  test("aggregates numeric contributors while count includes missing values", () => {
    const spec: ChartSpec = {
      type: "bar",
      data: "name,value\na,1\na,NULL\na,3\nb,5",
      aggregate: "mean",
    };
    assert.deepStrictEqual(inspect(spec, [[0, 0]]).rows, [1, 3]);
    assert.deepStrictEqual(inspect({ ...spec, aggregate: "count" }, [[0, 0]]).rows, [1, 2, 3]);
  });

  test("keeps totals out of contributors and follows Other slices", () => {
    const spec: ChartSpec = { type: "pie", data: "name,value\na,10\nb,3\nc,2\nTotal,15", limit: 1 };
    assert.deepStrictEqual(inspect(spec, [[0, 0]]).rows, [1]);
    assert.deepStrictEqual(inspect(spec, [[0, 1]]).rows, [2, 3]);
  });

  test("assigns histogram boundaries and the inclusive maximum to exact source rows", () => {
    const spec: ChartSpec = { type: "histogram", data: "duration\n0\n2\n4\n6\n8\nNULL", bins: 2 };
    assert.deepStrictEqual(inspect(spec, [[0, 0]]).rows, [1, 2]);
    assert.deepStrictEqual(inspect(spec, [[0, 1]]).rows, [3, 4, 5]);
  });

  test("tracks histogram source units and shared facet bins", () => {
    const spec: ChartSpec = {
      type: "histogram",
      data: "service,latency (ms)\na,100\nb,300\na,500\nb,900",
      bins: 2,
      facetColumn: "service",
      valueColumns: ["latency (ms)"],
    };
    assert.deepStrictEqual(inspect(spec, [[0, 0]]).rows, [1]);
    assert.deepStrictEqual(inspect(spec, [[0, 1]]).rows, [3]);
    assert.deepStrictEqual(inspect(spec, [[1, 0]]).rows, [2]);
    assert.deepStrictEqual(inspect(spec, [[1, 1]]).rows, [4]);
  });

  test("tracks empty aligned facet categories without assigning another row", () => {
    const spec: ChartSpec = {
      type: "bar",
      data: "service,day,value\na,Mon,3\nb,Tue,7",
      facetColumn: "service",
      labelColumn: "day",
      valueColumns: ["value"],
    };
    assert.deepStrictEqual(inspect(spec, [[0, 0]]).rows, [1]);
    assert.deepStrictEqual(inspect(spec, [[0, 1]]).rows, []);
    assert.deepStrictEqual(inspect(spec, [[1, 0]]).rows, []);
    assert.deepStrictEqual(inspect(spec, [[1, 1]]).rows, [2]);
  });

  test("tracks long-form series with implicit sums and distinct missing measurements", () => {
    const spec: ChartSpec = {
      type: "bar",
      data: "day,service,value\nMon,a,2\nTue,b,3\nMon,a,4\nTue,a,NULL",
      labelColumn: ["day", "service"],
      valueColumns: ["value"],
    };
    assert.deepStrictEqual(inspect(spec, [[0, 0]]).rows, [1, 3]);
    assert.deepStrictEqual(inspect(spec, [[0, 1]]).rows, []);
    assert.deepStrictEqual(inspect(spec, [[1, 0]]).rows, []);
    assert.deepStrictEqual(inspect(spec, [[1, 1]]).rows, [2]);
  });

  test("tracks sorted time points and series that omit absent times", () => {
    const spec: ChartSpec = {
      type: "line",
      data: "date,service,value\n2025-01-03,a,3\n2025-01-01,b,1\n2025-01-02,a,2",
      labelColumn: ["date", "service"],
      valueColumns: ["value"],
    };
    // Time ordering makes b the first series, then a.
    assert.deepStrictEqual(inspect(spec, [[0, 0]]).rows, [2]);
    assert.deepStrictEqual(inspect(spec, [[1, 0]]).rows, [3]);
    assert.deepStrictEqual(inspect(spec, [[1, 1]]).rows, [1]);
  });

  test("tracks heatmap pivot sums and null filtering", () => {
    const spec: ChartSpec = {
      type: "heatmap",
      data: "region,day,value\nWest,Tue,2\nEast,Mon,3\nWest,Tue,4\nEast,Mon,NULL",
      labelColumn: ["region", "day"],
      valueColumns: ["value"],
    };
    assert.deepStrictEqual(inspect(spec, [[0, 0]]).rows, [1, 3]);
    assert.deepStrictEqual(inspect(spec, [[0, 1]]).rows, [2]);
  });

  test("tracks heatmap value columns independently", () => {
    const spec: ChartSpec = {
      type: "heatmap",
      data: "name,first,second\na,NULL,2\nb,3,4",
      labelColumn: "name",
      valueColumns: ["first", "second"],
    };
    assert.deepStrictEqual(inspect(spec, [[0, 0]]).rows, [1]);
    assert.deepStrictEqual(
      inspect(spec, [
        [0, 1],
        [0, 2],
      ]).rows,
      [2],
    );
  });

  test("preserves both coordinates' contributors in aggregated scatter charts", () => {
    const spec: ChartSpec = {
      type: "scatter",
      data: "name,x,y\na,1,NULL\na,NULL,2\nb,4,5",
      labelColumn: "name",
      valueColumns: ["x", "y"],
      aggregate: "sum",
    };
    assert.deepStrictEqual(inspect(spec, [[0, 0]]).rows, [1, 2]);
  });

  test("maps boxes and duplicate outliers to their original observations", () => {
    const values = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 100, 100];
    const spec: ChartSpec = {
      type: "boxplot",
      data: `group,value\n${values.map((value) => `a,${value}`).join("\n")}\nb,3\nb,4`,
      labelColumn: "group",
      valueColumns: ["value"],
      sort: "descending",
    };
    assert.deepStrictEqual(inspect(spec, [[0, 0]]).rows, [13, 14]);
    assert.deepStrictEqual(
      inspect(spec, [[0, 1]]).rows,
      values.map((_, i) => i + 1),
    );
    assert.deepStrictEqual(inspect(spec, [[1, 0]]).rows, [11]);
    assert.deepStrictEqual(inspect(spec, [[1, 1]]).rows, [12]);
  });

  test("accepts styling but refuses changed data, structures and JavaScript", () => {
    const spec: ChartSpec = { type: "bar", data: "name,value\na,1\nb,2" };
    const option = buildChart(spec, parseTable(spec.data ?? "")).option;
    assert.deepStrictEqual(
      inspect(spec, [[0, 0]], JSON.stringify({ ...option, backgroundColor: "red" })).rows,
      [1],
    );
    assert.throws(
      () =>
        inspect(
          spec,
          [[0, 0]],
          JSON.stringify({ ...option, series: [{ type: "bar", data: [99] }] }),
        ),
      /changes the generated data/,
    );
    assert.throws(() => inspect(spec, [[0, 0]], "{series: []}"), /uses JavaScript/);
    assert.throws(
      () => inspect({ ...spec, options: { series: { data: [99] } } }, [[0, 0]]),
      /changes the generated data/,
    );
  });

  for (const type of ["treemap", "sunburst"] as const) {
    test(`maps ${type} parents and duplicate leaves after dropping shared roots`, () => {
      const spec: ChartSpec = {
        type,
        data: "path,value\nroot/a/file,2\nroot/a/second,3\nroot/b/file,5\nroot/a,5\nroot/b/empty,0",
      };
      const { rows, items } = actual(spec);
      assert.deepStrictEqual(rows(items.find((item) => item.label === "a")), [1, 2]);
      const leaves = items.filter((item) => item.label === "file");
      assert.strictEqual(leaves.length, 2);
      assert.deepStrictEqual(leaves.map(rows), [[1], [3]]);
      assert.deepStrictEqual(rows(items.find((item) => item.label === "b")), [3]);
    });

    test(`maps ${type} aggregated numeric contributors and count separately`, () => {
      const spec: ChartSpec = {
        type,
        data: "path,value\na/file,2\na/file,NULL\na/other,3\nb/file,4",
        aggregate: "sum",
      };
      const summed = actual(spec);
      assert.deepStrictEqual(summed.rows(summed.items.find((item) => item.label === "a")), [1, 3]);
      const counted = actual({ ...spec, aggregate: "count" });
      assert.deepStrictEqual(
        counted.rows(counted.items.find((item) => item.label === "a")),
        [1, 2, 3],
      );
    });
  }

  test("maps Sankey joined nodes and merged edges to all contributing rows", () => {
    const { rows, items } = actual({
      type: "sankey",
      data: "from,to,value\na,b,2\na,b,3\nb,c,4\na,c,5",
      labelColumn: ["from", "to"],
    });
    assert.deepStrictEqual(rows(items.find((item) => item.label === "a")), [1, 2, 4]);
    assert.deepStrictEqual(rows(items.find((item) => item.label === "b")), [1, 2, 3]);
    const edges = items.filter((item) => item.chart?.dataType === "edge");
    assert.deepStrictEqual(edges.map(rows), [[1, 2], [3], [4]]);
  });

  test("maps Sankey flows per numeric column without attributing absent values", () => {
    const { rows, items } = actual({
      type: "sankey",
      data: "name,yes,no\na,2,NULL\na,NULL,3\nb,4,0",
      labelColumn: "name",
      valueColumns: ["yes", "no"],
      aggregate: "sum",
    });
    assert.deepStrictEqual(rows(items.find((item) => item.label === "a")), [1, 2]);
    assert.deepStrictEqual(rows(items.find((item) => item.label === "yes")), [1, 3]);
    assert.deepStrictEqual(rows(items.find((item) => item.label === "no")), [2]);
    assert.deepStrictEqual(items.filter((item) => item.chart?.dataType === "edge").map(rows), [
      [1],
      [2],
      [3],
    ]);
  });

  test("retains provenance when Sankey columns fold small nodes into Other", () => {
    const { rows, items } = actual({
      type: "sankey",
      data: `from,to,value\n${Array.from({ length: 35 }, (_, index) => `n${index + 1},end,${index + 1}`).join("\n")}`,
      labelColumn: ["from", "to"],
    });
    assert.deepStrictEqual(rows(items.find((item) => item.label === "Other")), [1, 2, 3, 4, 5, 6]);
    assert.deepStrictEqual(
      rows(items.find((item) => item.chart?.dataType === "edge")),
      [1, 2, 3, 4, 5, 6],
    );
  });
});
