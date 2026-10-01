// Colors of the current VS Code theme, read from the CSS variables VS Code defines in webviews.

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const context = document.createElement("canvas").getContext("2d");

/** Parses any CSS color, by letting the canvas normalize it to "#rrggbb" or "rgba(…)". */
export function parseColor(css: string): Rgba | undefined {
  const value = css.trim();
  if (!value || !context) {
    return undefined;
  }
  // An invalid color leaves fillStyle unchanged: detect that by trying two different defaults.
  context.fillStyle = "#000000";
  context.fillStyle = value;
  const first = String(context.fillStyle);
  context.fillStyle = "#ffffff";
  context.fillStyle = value;
  if (String(context.fillStyle) !== first) {
    return undefined;
  }
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(first);
  if (hex) {
    return {
      r: Number.parseInt(hex[1] ?? "0", 16),
      g: Number.parseInt(hex[2] ?? "0", 16),
      b: Number.parseInt(hex[3] ?? "0", 16),
      a: 1,
    };
  }
  const rgba = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(first);
  if (rgba) {
    return {
      r: Number(rgba[1]),
      g: Number(rgba[2]),
      b: Number(rgba[3]),
      a: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }
  return undefined;
}

export function toCss({ r, g, b, a }: Rgba): string {
  const channel = (value: number) => Math.round(Math.min(255, Math.max(0, value)));
  if (a >= 1) {
    return `#${[r, g, b].map((value) => channel(value).toString(16).padStart(2, "0")).join("")}`;
  }
  return `rgba(${channel(r)}, ${channel(g)}, ${channel(b)}, ${Math.round(a * 1000) / 1000})`;
}

/** Mixes `amount` (0..1) of `top` into `base`, both opaque. */
export function mix(base: Rgba, top: Rgba, amount: number): Rgba {
  return {
    r: base.r + (top.r - base.r) * amount,
    g: base.g + (top.g - base.g) * amount,
    b: base.b + (top.b - base.b) * amount,
    a: 1,
  };
}

/** Composites a possibly translucent color over an opaque background. */
export function flatten(color: Rgba, background: Rgba): Rgba {
  return mix(background, { ...color, a: 1 }, color.a);
}

export function withAlpha(color: Rgba, alpha: number): Rgba {
  return { ...color, a: alpha };
}

function luminance({ r, g, b }: Rgba): number {
  const linear = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export interface ThemeColors {
  dark: boolean;
  highContrast: boolean;
  background: Rgba;
  foreground: Rgba;
  muted: Rgba;
  /** Hairline grid lines. */
  gridLine: Rgba;
  /** Axis lines and other recessive chrome, one step stronger than grid lines. */
  axisLine: Rgba;
  focus: Rgba;
  hoverBackground: Rgba;
  hoverBorder: Rgba;
  hoverForeground: Rgba;
  /** Categorical series colors, in a fixed order. */
  palette: Rgba[];
  blue: Rgba;
  green: Rgba;
  red: Rgba;
  fontFamily: string;
  fontSize: number;
}

/** Reads the theme colors that charts use from VS Code's CSS variables, with sensible fallbacks. */
export function readThemeColors(): ThemeColors {
  const style = getComputedStyle(document.body);
  const classes = document.body.classList;
  const highContrast = classes.contains("vscode-high-contrast");
  const variable = (name: string) => parseColor(style.getPropertyValue(`--vscode-${name}`));

  const background = variable("editor-background") ??
    parseColor(style.backgroundColor) ??
    parseColor(classes.contains("vscode-light") ? "#ffffff" : "#1f1f1f") ?? {
      r: 31,
      g: 31,
      b: 31,
      a: 1,
    };
  const opaqueBackground = { ...background, a: 1 };
  const dark = luminance(opaqueBackground) < 0.4;
  const color = (name: string, fallback: string): Rgba =>
    flatten(
      variable(name) ?? parseColor(fallback) ?? { r: 128, g: 128, b: 128, a: 1 },
      opaqueBackground,
    );

  const foreground = color("foreground", dark ? "#cccccc" : "#3b3b3b");
  const muted = color("descriptionForeground", dark ? "#9d9d9d" : "#717171");
  // charts.lines is the foreground at 50% opacity: far too loud for grid lines, so tone it down.
  const lines = variable("charts-lines") ?? variable("panel-border") ?? withAlpha(foreground, 0.5);
  const gridLine = highContrast
    ? flatten(lines, opaqueBackground)
    : flatten(withAlpha(lines, lines.a * 0.3), opaqueBackground);
  const axisLine = highContrast
    ? foreground
    : flatten(withAlpha(lines, lines.a * 0.75), opaqueBackground);

  const blue = color("charts-blue", dark ? "#3794ff" : "#1a85ff");
  const orange = color("charts-orange", "#d18616");
  const purple = color("charts-purple", dark ? "#b180d7" : "#652d90");
  const green = color("charts-green", dark ? "#89d185" : "#388a34");
  const yellow = color("charts-yellow", dark ? "#cca700" : "#bf8803");
  const red = color("charts-red", dark ? "#f14c4c" : "#e51400");
  // VS Code has no aqua or magenta chart colors; these steps were validated against the others.
  const magenta = parseColor(dark ? "#d55181" : "#e87ba4") ?? red;
  const aqua = parseColor(dark ? "#199e70" : "#1baf7a") ?? green;
  // This order keeps neighboring series apart for color-blind readers (adjacent CVD ΔE ≥ 8 with
  // the default VS Code colors, in both light and dark themes, including the wrap-around).
  const base = [blue, orange, purple, green, magenta, yellow, aqua, red];
  // Beyond eight series, repeat the hues in a shade that stays distinct from the first round.
  const palette = [...base, ...base.map((hue) => mix(hue, foreground, 0.4))];

  const fontSize = Number.parseFloat(style.getPropertyValue("--vscode-font-size")) || 13;
  return {
    dark,
    highContrast,
    background: opaqueBackground,
    foreground,
    muted,
    gridLine,
    axisLine,
    focus: color("focusBorder", dark ? "#0078d4" : "#005fb8"),
    hoverBackground: color("editorHoverWidget-background", dark ? "#252526" : "#f8f8f8"),
    hoverBorder: color("editorHoverWidget-border", dark ? "#454545" : "#c8c8c8"),
    hoverForeground: color("editorHoverWidget-foreground", dark ? "#cccccc" : "#3b3b3b"),
    palette,
    blue,
    green,
    red,
    fontFamily:
      style.getPropertyValue("--vscode-font-family").trim() ||
      'system-ui, -apple-system, "Segoe UI", sans-serif',
    fontSize,
  };
}
