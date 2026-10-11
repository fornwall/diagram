// CSS colors as diagram_style takes them: parsing, the form written into Mermaid source, which can
// carry no Mermaid syntax, and a readable text color for a fill. Free of the DOM, as is the color
// arithmetic it shares with the webview.

import { contrast, type Rgba } from "./webview/colors";

/** The CSS named colors (CSS Color Module Level 4), and transparent. */
const NAMED_COLORS: Record<string, string> = {
  aliceblue: "f0f8ff",
  antiquewhite: "faebd7",
  aqua: "00ffff",
  aquamarine: "7fffd4",
  azure: "f0ffff",
  beige: "f5f5dc",
  bisque: "ffe4c4",
  black: "000000",
  blanchedalmond: "ffebcd",
  blue: "0000ff",
  blueviolet: "8a2be2",
  brown: "a52a2a",
  burlywood: "deb887",
  cadetblue: "5f9ea0",
  chartreuse: "7fff00",
  chocolate: "d2691e",
  coral: "ff7f50",
  cornflowerblue: "6495ed",
  cornsilk: "fff8dc",
  crimson: "dc143c",
  cyan: "00ffff",
  darkblue: "00008b",
  darkcyan: "008b8b",
  darkgoldenrod: "b8860b",
  darkgray: "a9a9a9",
  darkgreen: "006400",
  darkgrey: "a9a9a9",
  darkkhaki: "bdb76b",
  darkmagenta: "8b008b",
  darkolivegreen: "556b2f",
  darkorange: "ff8c00",
  darkorchid: "9932cc",
  darkred: "8b0000",
  darksalmon: "e9967a",
  darkseagreen: "8fbc8f",
  darkslateblue: "483d8b",
  darkslategray: "2f4f4f",
  darkslategrey: "2f4f4f",
  darkturquoise: "00ced1",
  darkviolet: "9400d3",
  deeppink: "ff1493",
  deepskyblue: "00bfff",
  dimgray: "696969",
  dimgrey: "696969",
  dodgerblue: "1e90ff",
  firebrick: "b22222",
  floralwhite: "fffaf0",
  forestgreen: "228b22",
  fuchsia: "ff00ff",
  gainsboro: "dcdcdc",
  ghostwhite: "f8f8ff",
  gold: "ffd700",
  goldenrod: "daa520",
  gray: "808080",
  green: "008000",
  greenyellow: "adff2f",
  grey: "808080",
  honeydew: "f0fff0",
  hotpink: "ff69b4",
  indianred: "cd5c5c",
  indigo: "4b0082",
  ivory: "fffff0",
  khaki: "f0e68c",
  lavender: "e6e6fa",
  lavenderblush: "fff0f5",
  lawngreen: "7cfc00",
  lemonchiffon: "fffacd",
  lightblue: "add8e6",
  lightcoral: "f08080",
  lightcyan: "e0ffff",
  lightgoldenrodyellow: "fafad2",
  lightgray: "d3d3d3",
  lightgreen: "90ee90",
  lightgrey: "d3d3d3",
  lightpink: "ffb6c1",
  lightsalmon: "ffa07a",
  lightseagreen: "20b2aa",
  lightskyblue: "87cefa",
  lightslategray: "778899",
  lightslategrey: "778899",
  lightsteelblue: "b0c4de",
  lightyellow: "ffffe0",
  lime: "00ff00",
  limegreen: "32cd32",
  linen: "faf0e6",
  magenta: "ff00ff",
  maroon: "800000",
  mediumaquamarine: "66cdaa",
  mediumblue: "0000cd",
  mediumorchid: "ba55d3",
  mediumpurple: "9370db",
  mediumseagreen: "3cb371",
  mediumslateblue: "7b68ee",
  mediumspringgreen: "00fa9a",
  mediumturquoise: "48d1cc",
  mediumvioletred: "c71585",
  midnightblue: "191970",
  mintcream: "f5fffa",
  mistyrose: "ffe4e1",
  moccasin: "ffe4b5",
  navajowhite: "ffdead",
  navy: "000080",
  oldlace: "fdf5e6",
  olive: "808000",
  olivedrab: "6b8e23",
  orange: "ffa500",
  orangered: "ff4500",
  orchid: "da70d6",
  palegoldenrod: "eee8aa",
  palegreen: "98fb98",
  paleturquoise: "afeeee",
  palevioletred: "db7093",
  papayawhip: "ffefd5",
  peachpuff: "ffdab9",
  peru: "cd853f",
  pink: "ffc0cb",
  plum: "dda0dd",
  powderblue: "b0e0e6",
  purple: "800080",
  rebeccapurple: "663399",
  red: "ff0000",
  rosybrown: "bc8f8f",
  royalblue: "4169e1",
  saddlebrown: "8b4513",
  salmon: "fa8072",
  sandybrown: "f4a460",
  seagreen: "2e8b57",
  seashell: "fff5ee",
  sienna: "a0522d",
  silver: "c0c0c0",
  skyblue: "87ceeb",
  slateblue: "6a5acd",
  slategray: "708090",
  slategrey: "708090",
  snow: "fffafa",
  springgreen: "00ff7f",
  steelblue: "4682b4",
  tan: "d2b48c",
  teal: "008080",
  thistle: "d8bfd8",
  tomato: "ff6347",
  turquoise: "40e0d0",
  violet: "ee82ee",
  wheat: "f5deb3",
  white: "ffffff",
  whitesmoke: "f5f5f5",
  yellow: "ffff00",
  yellowgreen: "9acd32",
  transparent: "00000000",
};

const FUNCTION = /^(rgba?|hsla?)\(\s*(.*?)\s*\)$/;
/** A number and its unit, if any. */
const COMPONENT = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|deg|grad|rad|turn)?$/;

/** A CSS color: a name, #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba() or hsl()/hsla(). */
export function parseColor(text: string): Rgba | undefined {
  const value = text.trim().toLowerCase();
  if (Object.hasOwn(NAMED_COLORS, value)) {
    return parseHex(NAMED_COLORS[value] as string);
  }
  if (value.startsWith("#")) {
    return parseHex(value.slice(1));
  }
  const match = FUNCTION.exec(value);
  const components = match && splitComponents(match[2] as string);
  if (!match || !components) {
    return undefined;
  }
  const [first = "", second = "", third = "", alpha] = components;
  const a = alpha === undefined ? 1 : fraction(alpha, 1);
  if (a === undefined) {
    return undefined;
  }
  if ((match[1] as string).startsWith("rgb")) {
    const [r, g, b] = [first, second, third].map((channel) => fraction(channel, 255));
    return r === undefined || g === undefined || b === undefined ? undefined : { r, g, b, a };
  }
  const hue = degrees(first);
  const saturation = fraction(second, 100);
  const lightness = fraction(third, 100);
  if (hue === undefined || saturation === undefined || lightness === undefined) {
    return undefined;
  }
  return { ...hslToRgb(hue, saturation / 100, lightness / 100), a };
}

/**
 * The color as written into Mermaid source: a name in lowercase, or else hex, as Mermaid separates
 * style properties with commas, which functions have.
 */
export function sourceColor(text: string): string | undefined {
  const value = text.trim().toLowerCase();
  if (Object.hasOwn(NAMED_COLORS, value)) {
    return value;
  }
  const color = parseColor(value);
  return color && hexColor(color);
}

/** E.g. "#336699", or "#33669980" when translucent. */
export function hexColor({ r, g, b, a }: Rgba): string {
  const hex = (value: number) => Math.round(value).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}${a < 1 ? hex(a * 255) : ""}`;
}

const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

/** "black" or "white", whichever contrasts more with an opaque fill. */
export function readableTextColor(fill: Rgba): "black" | "white" {
  return contrast(BLACK, fill) >= contrast(WHITE, fill) ? "black" : "white";
}

function parseHex(hex: string): Rgba | undefined {
  if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(hex)) {
    return undefined;
  }
  const digits = hex.length <= 4 ? hex.replace(/./g, (digit) => digit + digit) : hex;
  const byte = (index: number) => Number.parseInt(digits.slice(index, index + 2), 16);
  return { r: byte(0), g: byte(2), b: byte(4), a: digits.length === 8 ? byte(6) / 255 : 1 };
}

/** "1, 2, 3", "1, 2, 3, 0.5", "1 2 3" or "1 2 3 / 50%". */
function splitComponents(text: string): string[] | undefined {
  if (text.includes(",")) {
    const parts = text.split(",").map((part) => part.trim());
    return parts.length === 3 || parts.length === 4 ? parts : undefined;
  }
  const [main = "", alpha, ...rest] = text.split("/").map((part) => part.trim());
  const parts = main.split(/\s+/).filter(Boolean);
  if (rest.length > 0 || parts.length !== 3 || alpha === "") {
    return undefined;
  }
  return alpha === undefined ? parts : [...parts, alpha];
}

/** A number, or a percentage of `max`, clamped to 0…max. */
function fraction(text: string, max: number): number | undefined {
  const match = COMPONENT.exec(text);
  const value = Number(match?.[1]);
  if (!match || !Number.isFinite(value) || (match[2] !== undefined && match[2] !== "%")) {
    return undefined;
  }
  return Math.min(Math.max(match[2] === "%" ? (value * max) / 100 : value, 0), max);
}

/** A hue in degrees, from 0 to 360. */
function degrees(text: string): number | undefined {
  const match = COMPONENT.exec(text);
  const value = Number(match?.[1]);
  if (!match || !Number.isFinite(value) || match[2] === "%") {
    return undefined;
  }
  const unit = { rad: 180 / Math.PI, grad: 0.9, turn: 360 }[match[2] ?? ""] ?? 1;
  return (((value * unit) % 360) + 360) % 360;
}

function hslToRgb(hue: number, saturation: number, lightness: number): Omit<Rgba, "a"> {
  const f = (n: number) => {
    const k = (n + hue / 30) % 12;
    const a = saturation * Math.min(lightness, 1 - lightness);
    return (lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
  };
  return { r: f(0), g: f(8), b: f(4) };
}
