import * as assert from "node:assert";
import { contrast, LABEL_CONTRAST, type Rgba, toCss } from "../webview/colors";
import {
  drawnAtWidth,
  fontConfig,
  mermaidTheme,
  mermaidThemeVariables,
  sizeConfig,
} from "../webview/mermaidTheme";
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

  test("tells the kinds of an agent flow's nodes apart by the chart colors", () => {
    for (const [theme, colors] of vscodeThemes) {
      const { theme: mermaid, themeVariables } = mermaidTheme(colors, "agentflow-beta");
      // Mermaid colors the kinds only in its color themes, from the colors given.
      assert.strictEqual(mermaid, colors.dark ? "redux-dark-color" : "redux-color", theme);
      assert.deepStrictEqual(
        themeVariables.borderColorArray,
        colors.palette.slice(0, 12).map(toCss),
        theme,
      );
      const fills = themeVariables.bkgColorArray as string[];
      assert.strictEqual(fills.length, colors.highContrast ? 0 : 12, theme);
      for (const fill of fills) {
        const ratio = contrast(rgb(themeVariables.textColor), rgb(fill));
        assert.ok(ratio >= LABEL_CONTRAST, `${theme}: ${fill}, ${ratio.toFixed(2)}`);
      }
      // Other diagrams draw in the base theme.
      assert.strictEqual(mermaidTheme(colors, "flowchart").theme, "base");
    }
  });

  test("draws the curves of radar charts in the chart colors, over a wash", () => {
    for (const [theme, colors] of vscodeThemes) {
      const { themeVariables } = mermaidTheme(colors, "radar-beta");
      assert.deepStrictEqual(
        Array.from({ length: 12 }, (_, i) => themeVariables[`cScale${i}`]),
        colors.palette.slice(0, 12).map(toCss),
        theme,
      );
      assert.strictEqual((themeVariables.radar as { curveOpacity: number }).curveOpacity, 0.2);
      // Mind maps keep sections that their labels read on.
      assert.notStrictEqual(
        mermaidTheme(colors, "mindmap").themeVariables.cScale0,
        themeVariables.cScale0,
      );
    }
  });

  test("draws the text of every diagram in VS Code's font", () => {
    const config = fontConfig("Segoe UI");
    assert.strictEqual(config.fontFamily, "Segoe UI");
    // C4, use case and journey diagrams have fonts of their own for parts of them.
    const fonts = [config.c4, config.usecase, config.journey].flatMap(Object.values);
    assert.strictEqual(fonts.length, 30);
    assert.ok(fonts.every((font) => font === "Segoe UI"));
    assert.strictEqual(
      (config.c4 as Record<string, string>).external_system_dbFontFamily,
      "Segoe UI",
    );
  });

  test("sizes charts that Mermaid draws at a size of its own to the panel's width", () => {
    // As wide as the panel has room for, between as narrow as their text allows and Mermaid's size.
    assert.deepStrictEqual(sizeConfig("xychart-beta", "", 450), {
      xyChart: { width: 450, height: 321 },
    });
    assert.deepStrictEqual(sizeConfig("xychart", "", 300), {
      xyChart: { width: 400, height: 286 },
    });
    assert.deepStrictEqual(sizeConfig("xychart", "", 2000), {
      xyChart: { width: 700, height: 500 },
    });
    // A radar's labels lie in its margins.
    assert.deepStrictEqual(sizeConfig("radar-beta", "", 500), {
      radar: { width: 400, height: 400 },
    });
    assert.deepStrictEqual(sizeConfig("packet", "", 410), { packet: { bitWidth: 16 } });
    assert.deepStrictEqual(sizeConfig("packet-beta", "", 900), { packet: { bitWidth: 28 } });
    // Not one whose settings size it, nor other diagrams, nor without a width.
    assert.deepStrictEqual(sizeConfig("radar-beta", "config:\n  radar:\n    width: 300", 500), {});
    assert.deepStrictEqual(sizeConfig("packet", "config:\n  packet:\n    bitsPerRow: 16", 500), {});
    assert.deepStrictEqual(sizeConfig("flowchart", "", 500), {});
    assert.deepStrictEqual(sizeConfig("sankey", "", 0), {});
    // Mermaid's names for the types it detects, which are drawn again at a new width.
    for (const type of ["gantt", "radar", "xychart", "quadrantChart", "sankey", "packet", "venn"]) {
      assert.ok(drawnAtWidth(type), type);
    }
    assert.ok(!drawnAtWidth("flowchart-v2") && !drawnAtWidth(undefined));
  });
});
