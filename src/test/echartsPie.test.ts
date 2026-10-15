import * as assert from "node:assert";
import { GUIDE_TOPICS } from "../guideTopics";
import { builtOption, layout, type Option, svgOf } from "./echartsModel";

suite("echartsPie", () => {
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
      assert.ok(words.has(word) || /(?:…|\.\.\.):?$/.test(word), `${word} of ${drawn.join(" ")}`);
    }
    // Too narrow for them even so: a legend names the slices, unless the option sets how to
    // label them, as with a template that tells their shares.
    const narrower = { width: 240, height: 575 };
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

  test("labels a pie by the legend alone where it adds one for want of room for the labels", () => {
    const option = {
      title: { text: "Bugs by component" },
      series: [
        {
          type: "pie",
          data: [
            { name: "Authentication service", value: 182 },
            { name: "Payment processing", value: 96 },
            { name: "Notification delivery", value: 64 },
            { name: "Search indexing", value: 31 },
            { name: "Reporting", value: 20 },
          ],
        },
      ],
    };
    // The legend takes the room of the labels below the pie, of which they would then seem to
    // fit beside a smaller one.
    for (let width = 240; width <= 560; width += 8) {
      for (const height of [380, 440, 500, 575, 640]) {
        const laidOut = layout(option, { width, height });
        if (laidOut.legend === undefined) continue;
        assert.strictEqual(laidOut.series[0].label?.show, false, `${width} × ${height}`);
      }
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

  test("cuts short only the words of a pie's labels that their font draws wider than the room", () => {
    const table = "component,bugs\nParser,42\nRenderer,31\nCommand line,9\nDocumentation,6";
    // "Parser:" is narrower than its 7 characters at the average width of one.
    const size = { width: 350, height: 575 };
    const option = layout(
      builtOption({ type: "doughnut", data: "unused", labelColumn: "component" }, table),
      size,
    );
    assert.match(svgOf(option, size), />Parser: ?</);
  });

  test("breaks the names of a pie's labels in Chinese onto lines rather than cutting them short", () => {
    const table =
      "component,bugs\n解析器与语法检查模块,42\n渲染器,31\n命令行界面工具集合,9\n文档,6\n安装脚本,5";
    const names = table
      .split("\n")
      .slice(1)
      .map((row) => row.split(",")[0] ?? "");
    for (const width of [350, 396]) {
      const size = { width, height: 575 };
      const option = layout(
        builtOption({ type: "pie", data: "unused", labelColumn: "component" }, table),
        size,
      );
      // ECharts breaks text in Chinese between any two characters, as it reads.
      const labels = [...svgOf(option, size).matchAll(/>([^<>]+)<\/text>/g)]
        .map(([, text = ""]) => text.trim())
        .join("");
      for (const name of names) assert.ok(labels.includes(`${name}:`), `${name} of ${labels}`);
      assert.doesNotMatch(labels, /…|\.\.\./);
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
          words.has(word) || shares.includes(word) || /(?:…|\.\.\.):?$/.test(word),
          `${word} of ${drawn}`,
        );
      }
    }
    // A formatter of the option's own, as a function, labels each slice still, cut short whole.
    const formatter = ({ name }: { name: string }) => `${name}!`;
    const own = builtOption({ type: "doughnut", data: "unused", labelColumn: "component" }, table);
    own.series[0].label = { formatter };
    const size = { width: 284, height: 575 };
    const labels = layout(own, size).series[0].data.map(({ label }: Option) => label);
    assert.ok(
      labels.some((label: Option) => label?.overflow === "truncate"),
      JSON.stringify(labels),
    );
    assert.ok(labels.every((label: Option) => label?.formatter === undefined));
    assert.match(svgOf(layout(own, size), size), />Renderer!</);
  });
});
