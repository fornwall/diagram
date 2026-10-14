// The current VS Code theme, as VS Code exposes it to webviews on the body element.

import { mix, type Rgba, type ThemeColors } from "./colors";

const fromHex = (hex: string): Rgba => ({
  r: Number.parseInt(hex.slice(1, 3), 16),
  g: Number.parseInt(hex.slice(3, 5), 16),
  b: Number.parseInt(hex.slice(5, 7), 16),
  a: 1,
});

let context: CanvasRenderingContext2D | null | undefined;

/** Parses any CSS color, in any color space, by painting a pixel in it. */
export function parseColor(css: string): Rgba | undefined {
  context ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const value = css.trim();
  if (!value || !context) {
    return undefined;
  }
  // An invalid color leaves fillStyle unchanged: detect that by trying two different defaults.
  context.fillStyle = "#000000";
  context.fillStyle = value;
  const normalized = String(context.fillStyle);
  context.fillStyle = "#ffffff";
  context.fillStyle = value;
  if (String(context.fillStyle) !== normalized) {
    return undefined;
  }
  context.clearRect(0, 0, 1, 1);
  context.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
  return { r, g, b, a: a / 255 };
}

/** Reads the colors and font that charts use from VS Code's CSS variables. */
export function readThemeColors(): ThemeColors {
  const style = getComputedStyle(document.body);
  return themeColors(document.body.dataset.vscodeThemeKind, (name) =>
    style.getPropertyValue(`--vscode-${name}`),
  );
}

/**
 * The colors and font that charts use, given the kind of VS Code's theme, as the body's data
 * attribute has it, and the values of its CSS variables by name, without `--vscode-`.
 */
export function themeColors(
  kind: string | undefined,
  property: (name: string) => string,
  parse: (css: string) => Rgba | undefined = parseColor,
): ThemeColors {
  const dark = kind === "vscode-dark" || kind === "vscode-high-contrast";
  const highContrast = kind?.startsWith("vscode-high-contrast") ?? false;
  const fontSize = Number.parseFloat(property("font-size")) || 13;
  const variable = (name: string) => parse(property(name));
  // VS Code always defines these variables; the fallbacks only keep the chart legible without.
  const background = {
    ...(variable("editor-background") ?? fromHex(dark ? "#1f1f1f" : "#ffffff")),
    a: 1,
  };
  const flatten = (color: Rgba) => mix(background, color, color.a);
  const foreground = flatten(variable("foreground") ?? fromHex(dark ? "#cccccc" : "#3b3b3b"));
  const color = (name: string, fallback = foreground) => flatten(variable(name) ?? fallback);

  // charts.lines is the foreground at 50% opacity: far too loud for grid lines, so tone it down.
  const lines = variable("charts-lines") ?? { ...foreground, a: 0.5 };
  // The colors of series, as the theme sets them but opaque: Dark and Light Modern make
  // charts.orange a translucent highlight, which over the background reads as brown or peach, and
  // the high contrast themes leave it out, which would draw a series in the foreground color.
  const hue = (name: string, fallback = foreground) => ({ ...(variable(name) ?? fallback), a: 1 });
  const blue = hue("charts-blue");
  const green = hue("charts-green");
  const red = hue("charts-red");
  // VS Code's own orange, and a darker one that keeps its contrast on a light background.
  const orange = hue("charts-orange", fromHex(dark ? "#d18616" : "#b35900"));
  // VS Code has no aqua or magenta chart colors; these steps were validated against the others.
  const magenta = fromHex(dark ? "#d55181" : "#e87ba4");
  const aqua = fromHex(dark ? "#199e70" : "#1baf7a");
  // This order keeps neighboring series apart for color-blind readers (adjacent CVD ΔE ≥ 8 with
  // the default VS Code colors, in both light and dark themes, including the wrap-around).
  const hues = [
    blue,
    orange,
    hue("charts-purple"),
    green,
    magenta,
    hue("charts-yellow"),
    aqua,
    red,
  ];

  return {
    dark,
    highContrast,
    background,
    foreground,
    muted: color("descriptionForeground"),
    gridLine: highContrast ? flatten(lines) : flatten({ ...lines, a: lines.a * 0.3 }),
    axisLine: highContrast ? foreground : flatten({ ...lines, a: lines.a * 0.75 }),
    focus: color("focusBorder"),
    contrastBorder: color("contrastBorder"),
    hoverBackground: color("editorHoverWidget-background", background),
    hoverBorder: color("editorHoverWidget-border"),
    hoverForeground: color("editorHoverWidget-foreground"),
    // Beyond eight series, repeat the hues in a shade that stays distinct from the first round.
    palette: [...hues, ...hues.map((each) => mix(each, foreground, 0.4))],
    blue,
    green,
    red,
    fontFamily: property("font-family").trim() || "system-ui, sans-serif",
    fontSize: Math.max(11, fontSize - 1),
  };
}
