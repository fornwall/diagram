import * as assert from "node:assert";
import { parseColor } from "../cssColors";
import { contrast, type Rgba, type ThemeColors, toCss } from "../webview/colors";
import type { JsonObject } from "../webview/echartsOption";
import { buildEChartsTheme } from "../webview/echartsTheme";
import { vscodeThemes } from "./vscodeThemes";

const rgb = (css: unknown): Rgba => parseColor(String(css)) as Rgba;

suite("ECharts theme", () => {
  test("keeps the smallest heatmap cells apart from a high contrast theme's background", () => {
    for (const [theme, colors] of vscodeThemes) {
      const built = buildEChartsTheme(colors) as {
        heatmap: { itemStyle: { borderColor: string } };
        visualMap: { color: [string, string] };
      };
      const [, smallest] = built.visualMap.color;
      const apart = contrast(rgb(smallest), colors.background);
      if (colors.highContrast) {
        assert.ok(apart >= 1.5, `${theme}: ${apart.toFixed(2)}`);
        assert.strictEqual(built.heatmap.itemStyle.borderColor, toCss(colors.contrastBorder));
      } else {
        assert.strictEqual(built.heatmap.itemStyle.borderColor, toCss(colors.background));
      }
    }
  });

  test("labels graph nodes beside them", () => {
    const [, colors] = vscodeThemes[0] as [string, ThemeColors];
    const theme = buildEChartsTheme(colors) as { graph: { label: JsonObject } };
    assert.strictEqual(theme.graph.label.position, "right");
  });
});
