import type { Rgba, ThemeColors } from "../webview/colors";
import { themeColors } from "../webview/vscodeTheme";

/** Parses the colors that VS Code's themes write their variables in: #rrggbb and rgba(). */
function parse(css: string): Rgba | undefined {
  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(css.trim());
  if (hex) {
    const [r, g, b] = hex.slice(1).map((channel) => Number.parseInt(channel, 16)) as [
      number,
      number,
      number,
    ];
    return { r, g, b, a: 1 };
  }
  const rgba = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(css.trim());
  if (rgba) {
    const [r, g, b, a] = rgba.slice(1).map(Number) as [number, number, number, number];
    return { r, g, b, a };
  }
  return undefined;
}

/** The kind and the color variables of VS Code 1.140's built-in themes, as webviews get them. */
const THEMES: Record<string, [string, Record<string, string>]> = {
  "Light Modern": [
    "vscode-light",
    {
      "editor-background": "#ffffff",
      foreground: "#3b3b3b",
      descriptionForeground: "#3b3b3b",
      "charts-blue": "#0063d3",
      "charts-orange": "rgba(234, 92, 0, 0.33)",
      "charts-purple": "#652d90",
      "charts-green": "#388a34",
      "charts-yellow": "#bf8803",
      "charts-red": "#e51400",
      "charts-lines": "rgba(59, 59, 59, 0.5)",
    },
  ],
  "Dark Modern": [
    "vscode-dark",
    {
      "editor-background": "#1f1f1f",
      foreground: "#cccccc",
      descriptionForeground: "#9d9d9d",
      "charts-blue": "#59a4f9",
      "charts-orange": "rgba(234, 92, 0, 0.33)",
      "charts-purple": "#b180d7",
      "charts-green": "#89d185",
      "charts-yellow": "#cca700",
      "charts-red": "#f14c4c",
      "charts-lines": "rgba(204, 204, 204, 0.5)",
    },
  ],
  "Dark High Contrast": [
    "vscode-high-contrast",
    {
      "editor-background": "#000000",
      foreground: "#ffffff",
      descriptionForeground: "rgba(255, 255, 255, 0.7)",
      contrastBorder: "#6fc3df",
      "charts-blue": "#59a4f9",
      "charts-purple": "#b180d7",
      "charts-green": "#89d185",
      "charts-yellow": "#ffd370",
      "charts-red": "#f48771",
      "charts-lines": "rgba(255, 255, 255, 0.5)",
    },
  ],
  "Light High Contrast": [
    "vscode-high-contrast-light",
    {
      "editor-background": "#ffffff",
      foreground: "#292929",
      descriptionForeground: "rgba(41, 41, 41, 0.7)",
      contrastBorder: "#0f4a85",
      "charts-blue": "#0063d3",
      "charts-purple": "#652d90",
      "charts-green": "#374e06",
      "charts-yellow": "#895503",
      "charts-red": "#b5200d",
      "charts-lines": "rgba(41, 41, 41, 0.5)",
    },
  ],
  "Light 2026": [
    "vscode-light",
    {
      "editor-background": "#ffffff",
      foreground: "#202020",
      descriptionForeground: "#606060",
      "charts-blue": "#1a5cff",
      "charts-orange": "#d18616",
      "charts-purple": "#652d90",
      "charts-green": "#388a34",
      "charts-yellow": "#667309",
      "charts-red": "#ad0707",
      "charts-lines": "rgba(32, 32, 32, 0.4)",
    },
  ],
  "Dark 2026": [
    "vscode-dark",
    {
      "editor-background": "#121314",
      foreground: "#bfbfbf",
      descriptionForeground: "#8c8c8c",
      "charts-blue": "#57a3f8",
      "charts-orange": "#cd861a",
      "charts-purple": "#ad80d7",
      "charts-green": "#86cf86",
      "charts-yellow": "#e0b97f",
      "charts-red": "#ef8773",
      "charts-lines": "rgba(200, 202, 204, 0.5)",
    },
  ],
};

/** The colors that charts and diagrams take in each of VS Code's built-in themes, by its name. */
export const vscodeThemes: [string, ThemeColors][] = Object.entries(THEMES).map(
  ([name, [kind, variables]]) => [name, themeColors(kind, (key) => variables[key] ?? "", parse)],
);
