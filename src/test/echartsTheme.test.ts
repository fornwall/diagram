import * as assert from "node:assert";
import { parseColor } from "../cssColors";
import { contrast, LABEL_CONTRAST, type Rgba, type ThemeColors } from "../webview/colors";
import type { JsonObject } from "../webview/echartsOption";
import { buildEChartsTheme, colorLabelsOnItems } from "../webview/echartsTheme";
import { vscodeThemes } from "./vscodeThemes";

const rgb = (css: unknown): Rgba => parseColor(String(css)) as Rgba;
const ratio = (text: unknown, fill: unknown) => contrast(rgb(text), rgb(fill));

suite("ECharts theme", () => {
  test("labels the slices of pies and funnels legibly where the labels lie on them", () => {
    for (const [theme, colors] of vscodeThemes) {
      for (const type of ["pie", "funnel"]) {
        const names = ["A", "B", "C", "D", "E", "F", "G", "H", "A"];
        const series: JsonObject[] = [
          { type, label: { position: "inside" }, data: names.map((name) => ({ name, value: 1 })) },
        ];
        colorLabelsOnItems({ series }, series, colors);
        const items = series[0]?.data as JsonObject[];
        for (const { name, itemStyle, label } of items as {
          name: string;
          itemStyle: JsonObject;
          label: JsonObject;
        }[]) {
          const legible = ratio(label.color, itemStyle.color);
          assert.ok(legible >= LABEL_CONTRAST, `${theme} ${type} ${name}: ${legible.toFixed(2)}`);
        }
        // In the colors ECharts gives them: the next for each name, the same for a repeated one.
        assert.deepStrictEqual(items[8]?.itemStyle, items[0]?.itemStyle);
        assert.notDeepStrictEqual(items[1]?.itemStyle, items[0]?.itemStyle);
      }
    }
  });

  test("leaves labels beside slices, of their own color and on colors of a visual map alone", () => {
    const [, colors] = vscodeThemes[0] as [string, ThemeColors];
    const data = Object.freeze([{ name: "A", value: 1 }, 2]);
    const cases: [JsonObject, JsonObject][] = [
      [{}, { type: "pie", data }],
      [{}, { type: "funnel", label: { position: "outside" }, data }],
      [{}, { type: "pie", label: { position: "inside", color: "red" }, data }],
      [{ visualMap: {} }, { type: "pie", label: { position: "inside" }, data }],
    ];
    for (const [base, each] of cases) {
      colorLabelsOnItems(base, [each], colors);
      assert.strictEqual(each.data, data, JSON.stringify(each));
    }
    // An item labeled inside, beside one labeled in a color of its own.
    const series: JsonObject = {
      type: "pie",
      data: [
        { name: "A", value: 1, label: { position: "inside" } },
        { name: "B", value: 1, label: { position: "inside", color: "red" } },
        { name: "C", value: 1 },
      ],
    };
    colorLabelsOnItems({}, [series], colors);
    const [a, b, c] = series.data as JsonObject[];
    assert.ok(a?.itemStyle && a.label);
    assert.deepStrictEqual(
      [b, c],
      [
        { name: "B", value: 1, label: { position: "inside", color: "red" } },
        { name: "C", value: 1 },
      ],
    );
  });

  test("fills treemaps in tints of the chart colors that the text color reads on", () => {
    for (const [theme, colors] of vscodeThemes) {
      const data = Object.freeze([{ name: "A", value: 1 }]);
      const series: JsonObject = { type: "treemap", data };
      colorLabelsOnItems({}, [series], colors);
      // The nodes themselves are not copied, which a large hierarchy would take long to.
      assert.strictEqual(series.data, data);
      const [level] = series.levels as { color: string[] }[];
      const label = (series.label as JsonObject).color;
      assert.strictEqual((series.upperLabel as JsonObject).color, label);
      for (const fill of level?.color ?? []) {
        const legible = ratio(label, fill);
        assert.ok(legible >= LABEL_CONTRAST, `${theme} ${fill}: ${legible.toFixed(2)}`);
      }
      assert.strictEqual(level?.color.length, 12);
    }
    // Unless the option colors it.
    const [, colors] = vscodeThemes[0] as [string, ThemeColors];
    for (const [base, series] of [
      [{}, { type: "treemap", data: [], levels: [{}] }],
      [{}, { type: "treemap", data: [], color: ["red"] }],
      [{ color: ["red"] }, { type: "treemap", data: [] }],
    ] as [JsonObject, JsonObject][]) {
      colorLabelsOnItems(base, [series], colors);
      assert.strictEqual(series.label, undefined, JSON.stringify(series));
    }
  });

  test("labels graph nodes beside them", () => {
    const [, colors] = vscodeThemes[0] as [string, ThemeColors];
    const theme = buildEChartsTheme(colors) as { graph: { label: JsonObject } };
    assert.strictEqual(theme.graph.label.position, "right");
  });
});
