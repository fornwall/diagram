import * as assert from "node:assert";
import { init } from "echarts";
import type * as ECharts from "echarts/core";
import { CHART_TYPES, type ChartType } from "../chartSpec";
import { dataWarnings, layoutWarnings } from "../webview/echartsChecks";
import { disableAnimation } from "../webview/echartsLayout";
import { buildEChartsTheme } from "../webview/echartsTheme";
import { bars, builtOption, layout, type Option } from "./echartsModel";
import { testColors } from "./themeColors";

/**
 * What the panel tells a model about a chart of the option, as it lays it out and draws it, by
 * default at 800 × 500.
 */
function warningsOf(option: Option, { width = 800, height = 500 } = {}): string[] {
  const laidOut = layout(option, { width, height });
  disableAnimation(laidOut);
  const chart = init(null, buildEChartsTheme(testColors), {
    renderer: "svg",
    ssr: true,
    width,
    height,
  }) as unknown as ECharts.ECharts;
  try {
    chart.setOption(laidOut, { notMerge: true });
    return [...dataWarnings(chart, option), ...layoutWarnings(chart, option)];
  } finally {
    chart.dispose();
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DEPARTMENTS = [
  "Engineering",
  "Marketing",
  "Sales",
  "Customer Support",
  "Human Resources",
  "Finance",
  "Legal",
  "Operations",
  "Research",
  "Product Management",
  "Design",
  "Quality Assurance",
  "Information Technology",
  "Facilities",
  "Procurement",
  "Business Development",
  "Public Relations",
  "Data Science",
  "Security",
  "Training",
];
/** The slices of a pie: a few large, and many small. */
const slices = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    name: `Slice number ${index + 1}`,
    value: index < 3 ? 100 : 1 + (index % 3),
  }));
const LONG_LEAVES = {
  type: "tree",
  data: [
    {
      name: "root",
      children: [{ name: "a leaf with a long name that goes on" }, { name: "another leaf" }],
    },
  ],
};

suite("echartsChecks", () => {
  test("says nothing of typical charts of each type", () => {
    const sizes = [{}, { width: 520, height: 420 }];
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
              { name: "Visit", value: 100 },
              { name: "Cart", value: 60 },
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
    ];
    for (const option of options) {
      for (const size of sizes) {
        assert.deepStrictEqual(warningsOf(option, size), [], JSON.stringify(option).slice(0, 80));
      }
    }
  });

  test("says nothing of the charts that diagram_chart makes", () => {
    const table =
      "region,product,sales,cost\nNorth,Widgets,120,80\nSouth,Widgets,90,60\n" +
      "East,Gadgets,150,100\nWest,Gizmos,70,40\nNorth,Gadgets,60,30\nCentral,Gizmos,30,20";
    const daily = `day,visits,signups\n${Array.from(
      { length: 120 },
      (_, index) =>
        `${new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10)},${100 + ((index * 37) % 50)},${index % 7}`,
    ).join("\n")}`;
    const levels = new Set<ChartType>(["sankey", "treemap", "sunburst", "heatmap"]);
    for (const type of CHART_TYPES) {
      const labelColumn = levels.has(type)
        ? ["region", "product"]
        : type === "histogram"
          ? undefined
          : "region";
      for (const size of [{}, { width: 520, height: 420 }]) {
        const option = builtOption(
          { type, data: "unused", ...(labelColumn && { labelColumn }) },
          table,
        );
        assert.deepStrictEqual(warningsOf(option, size), [], type);
      }
    }
    for (const type of ["line", "area", "bar", "scatter", "stackedArea"] as const) {
      assert.deepStrictEqual(warningsOf(builtOption({ type, data: "unused" }, daily)), [], type);
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

  test("tells of category labels that ECharts leaves out, or cuts short alike", () => {
    const departments = (axis: "xAxis" | "yAxis", count = 20): Option => {
      const data = DEPARTMENTS.slice(0, count);
      return {
        [axis]: { type: "category", data },
        [axis === "xAxis" ? "yAxis" : "xAxis"]: {},
        series: [{ type: "bar", data: data.map((_, index) => index) }],
      };
    };
    const narrow = { width: 400, height: 500 };
    assert.deepStrictEqual(warningsOf(departments("xAxis"), narrow), [
      'xAxis shows only 10 of its 20 category labels at the panel\'s width of 400 pixels, leaving out the others for lack of room: put the categories on yAxis as a horizontal bar chart, shorten the names, or add a "dataZoom" to show fewer at a time.',
    ]);
    assert.deepStrictEqual(warningsOf(departments("yAxis"), narrow), []);
    assert.deepStrictEqual(warningsOf(departments("yAxis"), { width: 400, height: 200 }), [
      'yAxis shows only 10 of its 20 category labels at the panel\'s height of 200 pixels, leaving out the others for lack of room: show fewer categories, such as the largest and an "Other", or add a "dataZoom" on yAxis to show fewer at a time.',
    ]);
    // Labels in a sequence, of which a reader can tell those left out.
    const days = Array.from({ length: 90 }, (_, index) =>
      new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10),
    );
    for (const data of [
      days,
      MONTHS.map((month) => `${month} 2024`),
      days.map((_, index) => `Q${(index % 4) + 1} ${2000 + index}`),
    ]) {
      assert.deepStrictEqual(
        warningsOf(
          { xAxis: { data }, yAxis: {}, series: [{ type: "line", data: data.map(() => 1) }] },
          narrow,
        ),
        [],
      );
    }
    // Nor an axis that chooses which labels to show.
    const chosen = departments("xAxis");
    chosen.xAxis = { ...chosen.xAxis, axisLabel: { interval: 1 } };
    assert.deepStrictEqual(warningsOf(chosen, narrow), []);
    const regions = ["North America Region East", "North America Region West", "Europe"];
    assert.deepStrictEqual(
      warningsOf(
        {
          yAxis: { type: "category", data: regions },
          xAxis: {},
          series: [{ type: "bar", data: [1, 2, 3] }],
        },
        narrow,
      ),
      [
        'yAxis cuts its category labels short to fit, leaving 2 of them alike, such as "North America Regi...": use shorter names that differ at the start.',
      ],
    );
  });

  test("tells of texts cut off at the edge of the chart", () => {
    assert.deepStrictEqual(warningsOf({ series: [LONG_LEAVES] }, { width: 400, height: 400 }), [
      'series[0] has the text "a leaf with a long name that goes on" cut off at the right edge of the chart: leave room for them with the series\' "left", "right", "top" or "bottom", or shorten them.',
    ]);
    assert.deepStrictEqual(warningsOf({ title: { text: "Sales", left: 780 }, ...bars() }), [
      'title has the text "Sales" cut off at the right edge of the chart: place it within the chart with its "left", "right", "top" or "bottom", or shorten it.',
    ]);
  });

  test("tells of the slices of a pie whose labels ECharts leaves out, which no legend names", () => {
    assert.deepStrictEqual(warningsOf({ series: [{ type: "pie", data: slices(60) }] }), [
      'series[0] labels only 31 of its 60 slices, leaving out the labels of the others, such as "Slice number 4", for lack of room: show fewer slices, as the largest and an "Other" that sums up the rest.',
    ]);
    assert.deepStrictEqual(warningsOf({ series: [{ type: "pie", data: slices(12) }] }), []);
  });

  test("tells of a legend that pages its entries, or that covers other texts", () => {
    const lines = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        name: `Product line ${index + 1}`,
        type: "line",
        data: [1, 2, 3].map((value) => value * index),
      }));
    const chart = (series: Option[]) => ({
      xAxis: { type: "category", data: ["a", "b", "c"] },
      yAxis: {},
      series,
    });
    assert.deepStrictEqual(warningsOf(chart(lines(5))), []);
    assert.deepStrictEqual(warningsOf(chart(lines(12))), [
      'legend has more entries than fit the panel, which it pages through, 2 pages of them, so that a reader sees only some at a time: show fewer series, or name each line at its end with "endLabel": {"show": true, "formatter": "{a}"} instead of a legend.',
    ]);
    assert.match(
      warningsOf(
        { legend: {}, series: [{ type: "pie", data: slices(30) }] },
        { width: 400, height: 600 },
      ).join(),
      /^legend has more entries than fit the panel, which it pages through, \d+ pages of them, so that a reader sees only some at a time: show fewer slices, as the largest and an "Other" that sums up the rest\.$/,
    );
    assert.deepStrictEqual(
      warningsOf(
        chart([
          { name: "North", type: "bar", data: [1, 2, 3] },
          { name: "South", type: "bar", data: [2, 3, 1] },
        ]),
      ),
      [],
    );
    assert.deepStrictEqual(
      warningsOf(
        {
          title: { text: "Quarterly revenue by region and product line" },
          legend: { top: 0 },
          ...chart([
            { name: "North", type: "bar", data: [1, 2, 3] },
            { name: "South", type: "bar", data: [2, 3, 1] },
          ]),
        },
        { width: 400, height: 500 },
      ),
      [
        'legend is drawn on top of title ("Quarterly revenue by region and product …"): place them apart with their "left", "right", "top" or "bottom", or leave those out of the legend for the panel to place it.',
      ],
    );
  });
});
