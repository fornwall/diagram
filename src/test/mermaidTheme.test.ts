import * as assert from "node:assert";
import { contrast, LABEL_CONTRAST, type Rgba, toCss } from "../webview/colors";
import { mermaidThemeVariables } from "../webview/mermaidTheme";
import { vscodeThemes } from "./vscodeThemes";

/** Parses the #rrggbb colors that the theme variables are written in. */
const rgb = (css: unknown): Rgba => {
  assert.match(String(css), /^#[\da-f]{6}$/, `a color: ${css}`);
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(String(css).slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
  return { r, g, b, a: 1 };
};

suite("Mermaid theme", () => {
  test("labels each part of a diagram legibly on its fill, in each of VS Code's themes", () => {
    for (const [theme, colors] of vscodeThemes) {
      const variables = mermaidThemeVariables(colors);
      const v = (name: string) => rgb(variables[name]);
      const pairs: [string, string][] = [
        ["primaryTextColor", "primaryColor"],
        ["textColor", "background"],
        ["textColor", "tertiaryColor"],
        ["textColor", "secondaryColor"],
        ["textColor", "secondBkg"],
        ["noteTextColor", "noteBkgColor"],
        ["labelTextColor", "labelBoxBkgColor"],
        ["signalTextColor", "background"],
        ["relationLabelColor", "relationLabelBackground"],
        ...["taskBkgColor", "activeTaskBkgColor", "doneTaskBkgColor", "critBkgColor"].map(
          (fill): [string, string] => ["taskTextColor", fill],
        ),
        ...[1, 2, 3, 4].map((i): [string, string] => [`quadrant${i}TextFill`, `quadrant${i}Fill`]),
        ...Array.from({ length: 12 }, (_, i): [string, string] => [
          `cScaleLabel${i}`,
          `cScale${i}`,
        ]),
        ...Array.from({ length: 12 }, (_, i): [string, string] => [
          "pieSectionTextColor",
          `pie${i + 1}`,
        ]),
        ...Array.from({ length: 8 }, (_, i): [string, string] => [`gitBranchLabel${i}`, `git${i}`]),
      ];
      for (const [text, fill] of pairs) {
        const ratio = contrast(v(text), v(fill));
        assert.ok(ratio >= LABEL_CONTRAST, `${theme}: ${text} on ${fill}, ${ratio.toFixed(2)}`);
      }
    }
  });

  test("outlines nodes and draws lines that stand out from the background", () => {
    for (const [theme, colors] of vscodeThemes) {
      const variables = mermaidThemeVariables(colors);
      for (const name of [
        "primaryBorderColor",
        "lineColor",
        "taskBorderColor",
        "critBorderColor",
      ]) {
        const ratio = contrast(rgb(variables[name]), colors.background);
        assert.ok(ratio >= 3, `${theme}: ${name}, ${ratio.toFixed(2)}`);
      }
      // Flat, as VS Code draws its widgets: Mermaid's shadow is a light glow on a dark background.
      assert.strictEqual(variables.dropShadow, "none", theme);
      assert.strictEqual(variables.useGradient, false, theme);
      assert.strictEqual(variables.edgeLabelBackground, toCss(colors.background), theme);
    }
  });

  test("fills nothing and outlines nodes in the contrast border in high contrast themes", () => {
    const highContrast = vscodeThemes.filter(([, colors]) => colors.highContrast);
    assert.deepStrictEqual(
      highContrast.map(([theme]) => theme),
      ["Dark High Contrast", "Light High Contrast"],
    );
    for (const [theme, colors] of highContrast) {
      const variables = mermaidThemeVariables(colors);
      const background = toCss(colors.background);
      assert.deepStrictEqual(
        [variables.primaryColor, variables.tertiaryColor, variables.noteBkgColor],
        [background, background, background],
        theme,
      );
      assert.strictEqual(variables.primaryBorderColor, toCss(colors.contrastBorder), theme);
      assert.strictEqual(variables.lineColor, toCss(colors.foreground), theme);
    }
  });

  test("tints nodes with the theme's accent", () => {
    for (const [theme, colors] of vscodeThemes.filter(([, colors]) => !colors.highContrast)) {
      const fill = rgb(mermaidThemeVariables(colors).primaryColor);
      // Bluer than the background, as the accent is.
      assert.ok(fill.b - fill.r > colors.background.b - colors.background.r, theme);
    }
  });
});
