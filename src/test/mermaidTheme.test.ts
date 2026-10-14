import * as assert from "node:assert";
import { contrast, LABEL_CONTRAST, type Rgba, type ThemeColors, toCss } from "../webview/colors";
import {
  adoptThemeVariables,
  drawnAtWidth,
  elementConfig,
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
      // The grey eyes and mouths that Mermaid draws on a journey's faces show on them.
      assert.ok(contrast(rgb(variables.faceColor), rgb("#666666")) >= 3, theme);
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
    const config = elementConfig("Segoe UI");
    assert.strictEqual(config.fontFamily, "Segoe UI");
    // C4, use case and journey diagrams have fonts of their own for parts of them.
    const c4 = config.c4 as Record<string, string>;
    const fonts = [c4, config.usecase, config.journey]
      .flatMap((each) => Object.entries(each))
      .filter(([key]) => key.endsWith("FontFamily"))
      .map(([, font]) => font);
    assert.strictEqual(fonts.length, 30);
    assert.ok(fonts.every((font) => font === "Segoe UI"));
    assert.strictEqual(c4.external_system_dbFontFamily, "Segoe UI");
    // A journey's title in proportion to its text, rather than at 4ex.
    assert.strictEqual(config.journey.titleFontSize, "20px");
  });

  test("fills C4 elements so that their white labels read on them", () => {
    const c4 = elementConfig("Segoe UI").c4 as Record<string, string>;
    const fills = Object.entries(c4).filter(([key]) => key.endsWith("_bg_color"));
    assert.strictEqual(fills.length, 24);
    for (const [key, fill] of fills) {
      const ratio = contrast(rgb(fill), { r: 255, g: 255, b: 255, a: 1 });
      assert.ok(ratio >= LABEL_CONTRAST, `${key}: ${fill}, ${ratio.toFixed(2)}`);
    }
    // Mermaid's own where they read already.
    assert.deepStrictEqual([c4.person_bg_color, c4.system_db_bg_color], ["#08427b", "#1168bd"]);
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

  test("merges the theme variables of a diagram over the panel's, legibly", () => {
    const [, dark] = vscodeThemes.find(([theme]) => theme === "Dark Modern") as [
      string,
      ThemeColors,
    ];
    const ours = mermaidThemeVariables(dark);
    const pink = adoptThemeVariables(ours, { primaryColor: "#ffcccc" }, dark);
    assert.strictEqual(pink.primaryColor, "#ffcccc");
    // What the panel draws in the primary color follows it, and Mermaid derives its outline.
    assert.strictEqual(pink.tagLabelBackground, "#ffcccc");
    assert.strictEqual(pink.primaryBorderColor, undefined);
    // Text on it reads, and labels on lines that take its color lie on it.
    assert.ok(contrast(rgb(pink.primaryTextColor), rgb("#ffcccc")) >= LABEL_CONTRAST);
    assert.strictEqual(pink.edgeLabelBackground, "#ffcccc");
    assert.strictEqual(pink.textColor, ours.textColor);
    // A line color takes in the arrowheads and the lines of every diagram.
    const red = adoptThemeVariables(ours, { lineColor: "#e91e63" }, dark);
    for (const name of ["arrowheadColor", "signalColor", "transitionColor", "relationColor"]) {
      assert.strictEqual(red[name], "#e91e63", name);
    }
    assert.strictEqual(red.edgeLabelBackground, ours.edgeLabelBackground);
    // A high contrast theme fills nothing: its unfilled parts stay so.
    const [, highContrast] = vscodeThemes.find(([, colors]) => colors.highContrast) as [
      string,
      ThemeColors,
    ];
    const outlined = mermaidThemeVariables(highContrast);
    const filled = adoptThemeVariables(outlined, { primaryColor: "#ffcccc" }, highContrast);
    assert.deepStrictEqual(
      [filled.tertiaryColor, filled.edgeLabelBackground === "#ffcccc"],
      [outlined.tertiaryColor, true],
    );
  });
});
