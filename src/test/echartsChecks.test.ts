import * as assert from "node:assert";
import { capWarnings, dataWarnings } from "../webview/echartsChecks";
import { bars, type Option, withChart } from "./echartsModel";

/** What the panel tells a model about the data of a chart of the option. */
const warningsOf = (option: Option) => withChart(option, (chart) => dataWarnings(chart, option));

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

suite("echartsChecks", function () {
  // Each test draws dozens of charts, which takes a while on a busy machine.
  this.timeout(20_000);

  test("says nothing of typical charts of each type", () => {
    const options: Option[] = [
      {
        title: { text: "Sales", subtext: "2025 and 2026" },
        tooltip: {},
        xAxis: { type: "category", data: MONTHS },
        yAxis: { type: "value", name: "units" },
        series: [
          { name: "2025", type: "bar", data: MONTHS.map((_, index) => 10 + index) },
          {
            name: "2026",
            type: "bar",
            data: MONTHS.map((_, index) => 12 + index),
            label: { show: true, position: "top" },
          },
        ],
      },
      {
        legend: {},
        xAxis: { type: "category", boundaryGap: false, data: MONTHS },
        yAxis: { min: 0, max: 100 },
        series: ["A", "B", "C"].map((name, at) => ({
          name,
          type: "line",
          stack: "total",
          areaStyle: {},
          data: MONTHS.map((_, index) => at * 10 + index),
        })),
      },
      {
        tooltip: { trigger: "item" },
        series: [
          {
            type: "pie",
            radius: ["40%", "70%"],
            data: [
              { name: "Chrome", value: 63 },
              { name: "Safari", value: 20 },
              { name: "Edge", value: 5 },
              { name: "Firefox", value: 3 },
              { name: "Opera", value: 0.5 },
              { name: "Other", value: 8.5 },
            ],
          },
        ],
      },
      {
        xAxis: { name: "height" },
        yAxis: { name: "weight" },
        series: [
          {
            type: "scatter",
            symbolSize: 8,
            data: [
              [150, 50],
              [160, 58.5],
              [172, 70],
              [185, 90],
            ],
          },
        ],
      },
      {
        xAxis: { type: "time" },
        yAxis: {},
        dataZoom: [{ type: "inside" }, { type: "slider" }],
        series: [
          {
            type: "line",
            data: [
              ["2024-01-01", 5],
              ["2024-02-01", 8],
              [Date.UTC(2024, 2, 1), 6],
              ["2024-04-01T10:00:00Z", 7],
            ],
          },
        ],
      },
      {
        dataset: {
          source: [
            ["product", "2015", "2016", "2017"],
            ["Matcha Latte", 43.3, 85.8, 93.7],
            ["Milk Tea", 83.1, 73.4, 55.1],
            ["Cheese Cocoa", 86.4, 65.2, 82.5],
          ],
        },
        legend: {},
        xAxis: { type: "category" },
        yAxis: {},
        series: [
          { type: "bar" },
          { type: "bar", encode: { x: "product", y: "2016" } },
          { type: "bar", encode: { x: 0, y: 3 } },
        ],
      },
      {
        dataset: {
          source: [
            { city: "Oslo", temperature: 4 },
            { city: "Rome", temperature: 18 },
          ],
        },
        xAxis: { type: "category" },
        yAxis: {},
        series: [{ type: "bar", encode: { x: "city", y: "temperature" } }],
      },
      { series: [{ type: "gauge", data: [{ value: 72, name: "Score" }] }] },
      { series: [{ type: "gauge", min: 0, max: 400, data: [{ value: 250, name: "Speed" }] }] },
      {
        radar: {
          indicator: ["Sales", "Admin", "Tech", "Support"].map((name) => ({ name, max: 100 })),
        },
        series: [{ type: "radar", data: [{ value: [60, 70, 80, 100], name: "Team" }] }],
      },
      {
        xAxis: { type: "value" },
        yAxis: { type: "category", data: ["Brazil", "Indonesia", "USA", "India", "China"] },
        series: [{ type: "bar", data: [18203, 23489, 29034, 104970, 131744] }],
      },
      {
        series: [
          {
            type: "sankey",
            data: [{ name: "Visits" }, { name: "Signups" }, { name: "Bounces" }],
            links: [
              { source: "Visits", target: "Signups", value: 5 },
              { source: "Visits", target: "Bounces", value: 3 },
            ],
          },
        ],
      },
      {
        series: [
          {
            type: "treemap",
            data: [
              {
                name: "src",
                children: [
                  { name: "a.ts", value: 4 },
                  { name: "b.ts", value: 6 },
                ],
              },
              { name: "test", value: 20 },
            ],
          },
        ],
      },
      {
        series: [
          {
            type: "sunburst",
            data: [
              { name: "A", children: [{ name: "A1", value: 4 }] },
              { name: "B", value: 3 },
            ],
          },
        ],
      },
      {
        series: [
          {
            type: "tree",
            data: [
              {
                name: "app",
                children: [{ name: "src", children: [{ name: "main" }] }, { name: "docs" }],
              },
            ],
          },
        ],
      },
      {
        series: [
          {
            type: "graph",
            layout: "force",
            data: [{ name: "A" }, { name: "B" }, { name: "C" }],
            links: [
              { source: "A", target: "B" },
              { source: "B", target: "C" },
            ],
            label: { show: true },
          },
        ],
      },
      {
        xAxis: { data: ["2017-10-24", "2017-10-25", "2017-10-26"] },
        yAxis: { scale: true },
        series: [
          {
            type: "candlestick",
            data: [
              [20, 34, 10, 38],
              [40, 35, 30, 50],
              [31, 38, 33, 44],
            ],
          },
        ],
      },
      {
        xAxis: { type: "category", data: ["Mon", "Tue", "Wed"] },
        yAxis: { type: "category", data: ["Morning", "Noon", "Evening"] },
        visualMap: { min: 0, max: 10 },
        series: [
          {
            type: "heatmap",
            data: [
              [0, 0, 5],
              [1, 1, 9],
              [2, 2, 1],
              [0, 2, "-"],
            ],
          },
        ],
      },
      {
        xAxis: { type: "category", data: ["A", "B"] },
        yAxis: {},
        series: [
          {
            type: "boxplot",
            data: [
              [1, 2, 3, 4, 5],
              [2, 3, 4, 5, 6],
            ],
          },
        ],
      },
      {
        series: [
          {
            type: "funnel",
            data: [
              { name: "Visited the product page", value: 100 },
              { name: "Added a product to the cart", value: 60 },
              { name: "Order", value: 20 },
            ],
          },
        ],
      },
      {
        xAxis: { type: "category", data: ["A", "B", "C"] },
        yAxis: { type: "log" },
        series: [{ type: "line", data: [1, 100, null] }],
      },
      {
        parallelAxis: [
          { dim: 0, name: "Price" },
          { dim: 1, name: "Weight" },
        ],
        series: [
          {
            type: "parallel",
            data: [
              [12, 3],
              [9, 4],
            ],
          },
        ],
      },
      {
        visualMap: { min: 0, max: 10 },
        calendar: { range: "2026" },
        series: [
          {
            type: "heatmap",
            coordinateSystem: "calendar",
            data: [
              ["2026-01-05", 3],
              ["2026-06-30", 8],
            ],
          },
        ],
      },
    ];
    for (const option of options) {
      assert.deepStrictEqual(warningsOf(option), [], JSON.stringify(option).slice(0, 80));
    }
  });

  test("tells of values that ECharts cannot read, which it draws nothing for", () => {
    assert.deepStrictEqual(
      warningsOf(bars({ series: [{ type: "bar", data: ["12%", "1,200"] }] })),
      [
        'series[0].data has 2 values that ECharts cannot read as a number, such as "12%", and draws nothing for: write plain numbers, without units, "%" or thousands separators.',
      ],
    );
    // Values missing on purpose are no mistake.
    assert.deepStrictEqual(warningsOf(bars({ series: [{ type: "bar", data: [null, "-"] }] })), []);
    assert.match(
      warningsOf({
        dataset: {
          source: [
            ["city", "share"],
            ["Oslo", "4 %"],
            ["Rome", 5],
          ],
        },
        xAxis: { type: "category" },
        yAxis: {},
        series: { type: "bar" },
      }).join(),
      /^The dataset that series reads has 1 value that ECharts cannot read as a number, such as "4 %"/,
    );
    const time = (data: unknown[]) => ({
      xAxis: { type: "time" },
      yAxis: {},
      series: [{ type: "line", data }],
    });
    assert.deepStrictEqual(
      warningsOf(
        time([
          ["Q1 2024", 1],
          ["Q2 2024", 2],
          ["2024-07", 3],
        ]),
      ),
      [
        'series[0].data has 2 dates that the time axis cannot read, such as "Q1 2024", and draws nothing for: write dates as "2024-03-31" or "2024-03-31 14:30", or put labels such as quarters on a "category" axis.',
      ],
    );
    assert.deepStrictEqual(
      warningsOf(
        time([
          [2019, 1],
          [2020, 2],
        ]),
      ),
      [
        'series[0].data has years as numbers on a time axis, such as 2019, which it reads as milliseconds since 1970: write them as text, as "2024", or use a "category" axis.',
      ],
    );
    assert.deepStrictEqual(
      warningsOf({ xAxis: {}, yAxis: {}, series: [{ type: "scatter", data: [{ x: 1, y: 2 }] }] }),
      [
        'series[0].data has 1 item without a "value", such as {"x":1,"y":2}, which ECharts draws nothing for: write each as {"value": [x, y]} or [x, y].',
      ],
    );
    assert.match(
      warningsOf({ series: [{ type: "pie", data: [{ name: "A", count: 2 }] }] }).join(),
      /without a "value", such as \{"name":"A","count":2\}.*write each as \{"name": "A", "value": 3\}/,
    );
  });

  test("tells of the same problem of several series once, naming them", () => {
    const percent = (count: number) =>
      bars({
        series: Array.from({ length: count }, () => ({ type: "bar", data: ["12%", "8%"] })),
      });
    assert.deepStrictEqual(warningsOf(percent(2)), [
      'series[0].data and series[1].data have 4 values that ECharts cannot read as a number, such as "12%", and draws nothing for: write plain numbers, without units, "%" or thousands separators.',
    ]);
    assert.deepStrictEqual(warningsOf(percent(6)), [
      'series[0].data, series[1].data and 4 more series have 12 values that ECharts cannot read as a number, such as "12%", and draws nothing for: write plain numbers, without units, "%" or thousands separators.',
    ]);
    assert.deepStrictEqual(
      warningsOf(
        bars({
          yAxis: { max: 10 },
          series: [
            { type: "bar", data: [1, 2, 30] },
            { type: "bar", data: [1, 20, 3] },
          ],
        }),
      ),
      [
        "series[0].data and series[1].data have more values than the 2 categories of xAxis.data, which ECharts pairs by position: those past the last category are drawn past the end of the axis. Add the categories, or remove the values.",
        'series[0] and series[1] have values up to 30, above the "max" of yAxis, 10, which ECharts cuts off at the edge of the plot: raise "max", or leave it out.',
      ],
    );
  });

  test("tells of the same problem of several series apart where the remedy or the dataset differs", () => {
    // Items without a value, which a pie and a scatter series each write in a shape of their own.
    assert.deepStrictEqual(
      warningsOf({
        xAxis: {},
        yAxis: {},
        series: [
          { type: "scatter", data: [{ x: 1, y: 2 }] },
          { type: "pie", radius: "20%", data: [{ name: "A", count: 2 }] },
        ],
      }).filter((warning) => warning.includes("without a")),
      [
        'series[0].data has 1 item without a "value", such as {"x":1,"y":2}, which ECharts draws nothing for: write each as {"value": [x, y]} or [x, y].',
        'series[1].data has 1 item without a "value", such as {"name":"A","count":2}, which ECharts draws nothing for: write each as {"name": "A", "value": 3}.',
      ],
    );
    const datasets = (indexes: number[]) => ({
      dataset: [
        {
          source: [
            ["city", "share"],
            ["Oslo", "4 %"],
          ],
        },
        {
          source: [
            ["city", "share"],
            ["Rome", "5 %"],
          ],
        },
      ],
      xAxis: { type: "category" },
      yAxis: {},
      series: indexes.map((datasetIndex) => ({ type: "bar", datasetIndex })),
    });
    assert.deepStrictEqual(warningsOf(datasets([0, 1])), [
      'The dataset that series[0] reads has 1 value that ECharts cannot read as a number, such as "4 %", and draws nothing for: write plain numbers, without units, "%" or thousands separators.',
      'The dataset that series[1] reads has 1 value that ECharts cannot read as a number, such as "5 %", and draws nothing for: write plain numbers, without units, "%" or thousands separators.',
    ]);
    // Those that read the same dataset have it once.
    assert.match(
      warningsOf(datasets([1, 1])).join("\n"),
      /^The dataset that series\[0\] and series\[1\] read has /,
    );
  });

  test("counts each value of a dataset that several series read once", () => {
    // Each line reads the column of days, which has one ECharts cannot read, and a column of its
    // own; two read the same column, which has one too.
    const lines = (y: string[]) => ({
      dataset: {
        source: [
          ["day", "a", "b"],
          ["2026-01-05", 1, "n/a"],
          ["soon", 2, 3],
          ["2026-01-07", 3, 4],
        ],
      },
      xAxis: { type: "time" },
      yAxis: {},
      series: y.map((column) => ({ type: "line", encode: { x: "day", y: column } })),
    });
    assert.deepStrictEqual(warningsOf(lines(["a", "b", "b"])), [
      'The dataset that series[0], series[1] and series[2] read has 1 date that the time axis cannot read, such as "soon", and draws nothing for: write dates as "2024-03-31" or "2024-03-31 14:30", or put labels such as quarters on a "category" axis.',
      'The dataset that series[1] and series[2] read has 1 value that ECharts cannot read as a number, such as "n/a", and draws nothing for: write plain numbers, without units, "%" or thousands separators.',
    ]);
  });

  test("tells a model of the first warnings, up to a length, and how many more there are", () => {
    const warnings = Array.from({ length: 30 }, (_, index) => `Warning ${index}`.padEnd(200, "."));
    const capped = capWarnings(warnings);
    assert.strictEqual(capped.length, 11);
    assert.strictEqual(capped[9], warnings[9]);
    assert.strictEqual(capped[10], "20 more warnings left out, to tell once these are fixed.");
    assert.deepStrictEqual(capWarnings(warnings.slice(0, 3)), warnings.slice(0, 3));
    // A first warning however long.
    assert.deepStrictEqual(capWarnings(["x".repeat(3000)]), ["x".repeat(3000)]);
  });

  test("tells of values alone of other than one for each category, which ECharts pairs by position", () => {
    assert.deepStrictEqual(warningsOf(bars({ series: [{ type: "bar", data: [1, 2, 3] }] })), [
      "series[0].data has 3 values for the 2 categories of xAxis.data, which ECharts pairs by position: the last value is drawn past the end of the axis. Add the categories, or remove the values.",
    ]);
    assert.deepStrictEqual(
      warningsOf({
        yAxis: [{ type: "category", data: MONTHS }],
        xAxis: {},
        series: [
          { type: "bar", data: [1] },
          { type: "bar", data: MONTHS.map(() => 1) },
        ],
      }),
      [
        "series[0].data has 1 value for the 12 categories of yAxis[0].data, which ECharts pairs by position, so the last 11 have no value from it, and with a value left out, every value after it is drawn at the wrong category: give a value for each category, null where one is missing on purpose.",
      ],
    );
    // Values that name their category, and a category axis without categories of its own.
    assert.deepStrictEqual(warningsOf(bars({ series: [{ type: "line", data: [["B", 1]] }] })), []);
    assert.deepStrictEqual(
      warningsOf({
        xAxis: { type: "category" },
        yAxis: {},
        series: [{ type: "bar", data: [1, 2, 3] }],
      }),
      [],
    );
  });

  test("tells of an encode that names a dimension the dataset does not have", () => {
    const option = (encode: Option) => ({
      dataset: {
        source: [
          ["product", "2015", "2016"],
          ["A", 1, 2],
        ],
      },
      xAxis: { type: "category" },
      yAxis: {},
      series: [{ type: "bar", encode }],
    });
    assert.deepStrictEqual(warningsOf(option({ x: "product", y: "2017" })), [
      'series[0].encode.y names the dimension "2017", which its dataset does not have, so ECharts draws another in its place: use one of "product", "2015", "2016".',
    ]);
    assert.deepStrictEqual(
      warningsOf(option({ x: "product", y: ["2015", "2016"], tooltip: [0, 1] })),
      [],
    );
  });

  test("tells of values beyond the bounds of an axis, a gauge or a radar", () => {
    assert.deepStrictEqual(
      warningsOf(bars({ yAxis: { max: 100 }, series: [{ type: "bar", data: [50, 150] }] })),
      [
        'series[0] has values up to 150, above the "max" of yAxis, 100, which ECharts cuts off at the edge of the plot: raise "max", or leave it out.',
      ],
    );
    assert.deepStrictEqual(
      warningsOf(
        bars({
          yAxis: { min: 0, max: 100 },
          series: [
            { type: "bar", stack: "s", data: [60, -5] },
            { type: "bar", stack: "s", data: [60, 0] },
          ],
        }),
      ),
      [
        'series[0] stacks down to -5, below the "min" of yAxis, 0, which ECharts cuts off at the edge of the plot: lower "min", or leave it out.',
        'series[1] stacks up to 120, above the "max" of yAxis, 100, which ECharts cuts off at the edge of the plot: raise "max", or leave it out.',
      ],
    );
    assert.deepStrictEqual(
      warningsOf(bars({ yAxis: { type: "log" }, series: [{ type: "bar", data: [0, 10] }] })),
      [
        'series[0] has values of 0 or less on the log axis yAxis, which ECharts cannot draw: use a "value" axis, or leave those values out.',
      ],
    );
    // What a data zoom leaves out, it leaves out on purpose.
    assert.deepStrictEqual(
      warningsOf(
        bars({ yAxis: { max: 100 }, dataZoom: {}, series: [{ type: "bar", data: [1, 150] }] }),
      ),
      [],
    );
    assert.deepStrictEqual(warningsOf({ series: [{ type: "gauge", data: [{ value: 250 }] }] }), [
      'series[0] is a gauge of 0 to 100, the default scale, whose pointer stops at the end for the value 250: set "min" and "max" to the range of the value.',
    ]);
    assert.deepStrictEqual(
      warningsOf({
        radar: { indicator: [{ name: "a", max: 10 }, { name: "b", max: 10 }, { name: "c" }] },
        series: [{ type: "radar", data: [{ value: [5, 20, 50] }] }],
      }),
      [
        'series[0] has values up to 20 for indicator 2 ("b"), above its "max" of 10, which ECharts draws outside the radar: raise "max", or leave it out for ECharts to fit the data.',
      ],
    );
  });
});
