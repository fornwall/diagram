// Color arithmetic, free of the DOM so that chart layout can be unit tested.

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function toCss({ r, g, b, a }: Rgba): string {
  const channel = (value: number) => Math.round(Math.min(255, Math.max(0, value)));
  if (a >= 1) {
    return `#${[r, g, b].map((value) => channel(value).toString(16).padStart(2, "0")).join("")}`;
  }
  return `rgba(${channel(r)}, ${channel(g)}, ${channel(b)}, ${Math.round(a * 1000) / 1000})`;
}

/** Mixes `amount` (0..1) of `top` into `base`, giving an opaque color. */
export function mix(base: Rgba, top: Rgba, amount: number): Rgba {
  return {
    r: base.r + (top.r - base.r) * amount,
    g: base.g + (top.g - base.g) * amount,
    b: base.b + (top.b - base.b) * amount,
    a: 1,
  };
}

/** The colors of the VS Code theme that charts use, all opaque. */
export interface ThemeColors {
  dark: boolean;
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
  /** The size of chart text, a step below VS Code's font size. */
  fontSize: number;
}
