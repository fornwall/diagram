import type { Rgba, ThemeColors } from "../webview/colors";

const gray: Rgba = { r: 128, g: 128, b: 128, a: 1 };

/** The colors of a dark theme, to lay out and draw charts with in tests. */
export const testColors: ThemeColors = {
  dark: true,
  background: { r: 31, g: 31, b: 31, a: 1 },
  foreground: { r: 204, g: 204, b: 204, a: 1 },
  muted: gray,
  gridLine: gray,
  axisLine: gray,
  focus: { r: 0, g: 120, b: 212, a: 1 },
  hoverBackground: gray,
  hoverBorder: gray,
  hoverForeground: gray,
  // Numbered by their red channel, so that a test can tell which palette color was used.
  palette: Array.from({ length: 16 }, (_, index) => ({ r: index, g: 0, b: 0, a: 1 })),
  blue: gray,
  green: gray,
  red: gray,
  fontFamily: "sans-serif",
  fontSize: 12,
};
