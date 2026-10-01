// The current VS Code theme, as VS Code exposes it to webviews on the body element.

import { mix, type Rgba, type ThemeColors } from "./colors";

const fromHex = (hex: string): Rgba => ({
  r: Number.parseInt(hex.slice(1, 3), 16),
  g: Number.parseInt(hex.slice(3, 5), 16),
  b: Number.parseInt(hex.slice(5, 7), 16),
  a: 1,
});

let context: CanvasRenderingContext2D | null | undefined;

/** Parses any CSS color, by letting the canvas normalize it to "#rrggbb" or "rgba(…)". */
function parseColor(css: string): Rgba | undefined {
  context ??= document.createElement("canvas").getContext("2d");
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
  if (normalized.startsWith("#")) {
    return fromHex(normalized);
  }
  const [r = 0, g = 0, b = 0, a = 1] = normalized
    .slice(normalized.indexOf("(") + 1, -1)
    .split(",")
    .map(Number);
  return { r, g, b, a };
}

/** Reads the colors and font that charts use from VS Code's CSS variables. */
export function readThemeColors(): ThemeColors {
  const style = getComputedStyle(document.body);
  const kind = document.body.dataset.vscodeThemeKind;
  const dark = kind === "vscode-dark" || kind === "vscode-high-contrast";
  const highContrast = kind?.startsWith("vscode-high-contrast");
  const fontSize = Number.parseFloat(style.getPropertyValue("--vscode-font-size")) || 13;
  const variable = (name: string) => parseColor(style.getPropertyValue(`--vscode-${name}`));
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
  const blue = color("charts-blue");
  const green = color("charts-green");
  const red = color("charts-red");
  // VS Code has no aqua or magenta chart colors; these steps were validated against the others.
  const magenta = fromHex(dark ? "#d55181" : "#e87ba4");
  const aqua = fromHex(dark ? "#199e70" : "#1baf7a");
  // This order keeps neighboring series apart for color-blind readers (adjacent CVD ΔE ≥ 8 with
  // the default VS Code colors, in both light and dark themes, including the wrap-around).
  const hues = [
    blue,
    color("charts-orange"),
    color("charts-purple"),
    green,
    magenta,
    color("charts-yellow"),
    aqua,
    red,
  ];

  return {
    dark,
    background,
    foreground,
    muted: color("descriptionForeground"),
    gridLine: highContrast ? flatten(lines) : flatten({ ...lines, a: lines.a * 0.3 }),
    axisLine: highContrast ? foreground : flatten({ ...lines, a: lines.a * 0.75 }),
    focus: color("focusBorder"),
    hoverBackground: color("editorHoverWidget-background", background),
    hoverBorder: color("editorHoverWidget-border"),
    hoverForeground: color("editorHoverWidget-foreground"),
    // Beyond eight series, repeat the hues in a shade that stays distinct from the first round.
    palette: [...hues, ...hues.map((hue) => mix(hue, foreground, 0.4))],
    blue,
    green,
    red,
    fontFamily: style.getPropertyValue("--vscode-font-family").trim() || "system-ui, sans-serif",
    fontSize: Math.max(11, fontSize - 1),
  };
}
