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

/** The WCAG contrast ratio of two opaque colors, from 1 to 21. */
export function contrast(a: Rgba, b: Rgba): number {
  const luminance = ({ r, g, b }: Rgba) => {
    const linear = (value: number) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** The contrast that labels need with the color they are drawn on, as WCAG asks of small text. */
export const LABEL_CONTRAST = 4.5;

const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

/**
 * The color to draw a label in on an opaque color: the theme's text color if it is legible there,
 * else the theme's background if that is, else black or white, whichever contrasts more.
 */
export function labelColorOn(
  color: Rgba,
  { foreground, background }: Pick<ThemeColors, "foreground" | "background">,
): Rgba {
  return (
    [foreground, background].find((text) => contrast(color, text) >= LABEL_CONTRAST) ??
    (contrast(color, BLACK) > contrast(color, WHITE) ? BLACK : WHITE)
  );
}

/** Raises the HSL lightness of a color by `points` percentage points, as Mermaid's lighten does. */
export function lighten({ r, g, b }: Rgba, points: number): Rgba {
  const [red, green, blue] = [r / 255, g / 255, b / 255] as [number, number, number];
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  const d = max - min;
  const saturation = d === 0 ? 0 : d / (1 - Math.abs(2 * lightness - 1));
  const hue =
    d === 0
      ? 0
      : max === red
        ? ((green - blue) / d + 6) % 6
        : max === green
          ? (blue - red) / d + 2
          : (red - green) / d + 4;
  const l = Math.min(1, lightness + points / 100);
  const chroma = (1 - Math.abs(2 * l - 1)) * saturation;
  const x = chroma * (1 - Math.abs((hue % 2) - 1));
  const [r1, g1, b1] = [
    [chroma, x, 0],
    [x, chroma, 0],
    [0, chroma, x],
    [0, x, chroma],
    [x, 0, chroma],
    [chroma, 0, x],
  ][Math.floor(hue) % 6] as [number, number, number];
  const m = l - chroma / 2;
  return { r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255, a: 1 };
}

/** The colors of the VS Code theme that charts use, all opaque. */
export interface ThemeColors {
  dark: boolean;
  /** A high contrast theme, which outlines rather than fills. */
  highContrast: boolean;
  background: Rgba;
  foreground: Rgba;
  muted: Rgba;
  /** Hairline grid lines. */
  gridLine: Rgba;
  /** Axis lines and other recessive chrome, one step stronger than grid lines. */
  axisLine: Rgba;
  focus: Rgba;
  /** The border that a high contrast theme draws around everything, else the text color. */
  contrastBorder: Rgba;
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
