// Mermaid's base theme, the one meant to be given colors, in the colors of the VS Code theme.

import type { Mermaid, MermaidConfig } from "mermaid";
import { parseColor as parseCss } from "../cssColors";
import {
  contrast,
  LABEL_CONTRAST,
  labelColorOn,
  legibleTints,
  lighten,
  mix,
  type Rgba,
  type ThemeColors,
  toCss,
} from "./colors";
import { parseColor } from "./vscodeTheme";

/** The contrast that lines and borders need with the background, as WCAG asks of graphics. */
const GRAPHIC_CONTRAST = 3;

/**
 * The least of a color mixed into the background, from `from` up in steps of 5%, that contrasts
 * `ratio` with the background: as recessive as it can be while still seen.
 */
function atLeast(background: Rgba, color: Rgba, ratio: number, from: number): Rgba {
  for (let amount = from; amount < 1; amount += 0.05) {
    const mixed = mix(background, color, amount);
    if (contrast(mixed, background) >= ratio) return mixed;
  }
  return color;
}

/**
 * The theme variables of Mermaid's base theme for the colors of a VS Code theme. Nodes are tinted
 * with the theme's accent and outlined in it, lines and text take the theme's text color, groups
 * and other containers a hint of it, notes a hint of yellow. A high contrast theme fills nothing
 * and outlines everything in its contrast border. Mermaid derives the rest, such as the fill of
 * nodes from the primary color.
 */
export function mermaidThemeVariables(colors: ThemeColors): Record<string, unknown> {
  const { dark, highContrast, background, foreground, palette } = colors;
  // The chart colors, in the order of the palette.
  const accent = colors.blue;
  const [blue = accent, orange = accent, purple = accent, green = accent, , yellow = accent] =
    palette;
  const red = colors.red;
  const css = toCss;
  const text = css(foreground);
  const tint = (color: Rgba, amount: number) =>
    highContrast ? background : mix(background, color, amount);
  // An outline in a color: in a high contrast theme the color itself where it stands out, as its
  // chart colors do, else its contrast border.
  const outline = (color: Rgba) =>
    highContrast
      ? contrast(color, background) >= GRAPHIC_CONTRAST
        ? color
        : colors.contrastBorder
      : atLeast(background, color, GRAPHIC_CONTRAST, 0.4);

  const primary = tint(accent, dark ? 0.16 : 0.08);
  const primaryBorder = highContrast ? colors.contrastBorder : outline(accent);
  const line = highContrast ? foreground : atLeast(background, foreground, 4.5, 0.6);
  // Groups and other containers: a hint of the text color, outlined less than nodes.
  const group = tint(foreground, dark ? 0.06 : 0.04);
  const groupBorder = highContrast
    ? colors.contrastBorder
    : atLeast(background, foreground, 1.6, 0.15);
  const secondary = tint(foreground, dark ? 0.1 : 0.07);
  const note = tint(yellow, dark ? 0.16 : 0.2);
  const noteBorder = highContrast ? yellow : atLeast(background, yellow, 2, 0.3);
  // The sections of mind maps, timelines, kanban boards, pies and treemaps, labeled in the text
  // color. Kanban columns are drawn 10 points lighter, which their labels and headings must be
  // legible on too.
  const sections = legibleTints(colors, (color) => [lighten(color, 10)]);
  const hues = palette.slice(0, 8);
  const label = (color: Rgba) => css(labelColorOn(color, colors));

  const variables: Record<string, unknown> = {
    darkMode: dark,
    background: css(background),
    fontFamily: colors.fontFamily,
    // Flat, as VS Code draws its own widgets, rather than with Mermaid's light grey shadow, which
    // glows around every node on a dark background, and its gradient outlines.
    dropShadow: "none",
    useGradient: false,

    primaryColor: css(primary),
    primaryBorderColor: css(primaryBorder),
    primaryTextColor: text,
    secondaryColor: css(secondary),
    // What railroad diagrams fill terminals with, else Mermaid's default theme's cream.
    secondBkg: css(secondary),
    secondaryBorderColor: css(groupBorder),
    secondaryTextColor: text,
    tertiaryColor: css(group),
    tertiaryBorderColor: css(groupBorder),
    tertiaryTextColor: text,
    textColor: text,
    titleColor: text,
    lineColor: css(line),
    arrowheadColor: css(line),
    // Labels on lines cut them, rather than lie in a box of their own color.
    edgeLabelBackground: css(background),
    labelBackground: css(background),
    relationLabelBackground: css(background),
    relationLabelColor: text,
    noteBkgColor: css(note),
    noteBorderColor: css(noteBorder),
    noteTextColor: text,
    errorBkgColor: css(tint(red, 0.2)),
    errorTextColor: text,

    // Sequence diagrams: lifelines recede, as the messages between them matter.
    actorLineColor: css(groupBorder),
    signalColor: css(line),
    signalTextColor: text,
    labelBoxBkgColor: css(group),
    labelBoxBorderColor: css(groupBorder),
    labelTextColor: text,
    loopTextColor: text,
    activationBkgColor: css(secondary),
    activationBorderColor: css(line),
    sequenceNumberColor: css(background),

    // State diagrams.
    transitionColor: css(line),
    transitionLabelColor: text,
    specialStateColor: css(line),
    innerEndBackground: css(line),
    compositeBackground: css(group),
    compositeBorder: css(groupBorder),
    altBackground: css(group),
    stateLabelColor: text,

    // Gantt charts: bars in the accent, done in grey, critical in red.
    gridColor: css(colors.gridLine),
    sectionBkgColor: css(group),
    altSectionBkgColor: css(background),
    sectionBkgColor2: css(group),
    excludeBkgColor: css(secondary),
    taskBkgColor: css(tint(accent, dark ? 0.35 : 0.3)),
    taskBorderColor: css(primaryBorder),
    activeTaskBkgColor: css(tint(accent, dark ? 0.2 : 0.12)),
    activeTaskBorderColor: css(primaryBorder),
    doneTaskBkgColor: css(tint(foreground, 0.2)),
    doneTaskBorderColor: css(outline(foreground)),
    critBkgColor: css(tint(red, dark ? 0.35 : 0.25)),
    critBorderColor: css(outline(red)),
    todayLineColor: css(red),
    vertLineColor: css(accent),
    taskTextColor: text,
    taskTextDarkColor: text,
    taskTextLightColor: text,
    taskTextOutsideColor: text,

    // Class and ER diagrams.
    classText: text,
    attributeBackgroundColorOdd: css(background),
    attributeBackgroundColorEven: css(group),

    // Requirement diagrams.
    requirementTextColor: text,
    relationColor: css(line),

    // Architecture diagrams.
    archEdgeColor: css(line),
    archEdgeArrowColor: css(line),
    archGroupBorderColor: css(groupBorder),

    // Pie charts: no translucency, which dulls the sections, and gaps in the background color.
    pieOpacity: "1",
    pieStrokeColor: css(background),
    pieOuterStrokeColor: css(background),
    pieTitleTextColor: text,
    pieLegendTextColor: text,
    pieSectionTextColor: text,

    // Quadrant charts.
    quadrant1Fill: css(tint(accent, dark ? 0.14 : 0.08)),
    quadrant2Fill: css(tint(accent, dark ? 0.08 : 0.04)),
    quadrant3Fill: css(group),
    quadrant4Fill: css(tint(accent, dark ? 0.08 : 0.04)),
    quadrant1TextFill: text,
    quadrant2TextFill: text,
    quadrant3TextFill: text,
    quadrant4TextFill: text,
    quadrantPointFill: css(accent),
    quadrantPointTextFill: text,
    quadrantXAxisTextFill: text,
    quadrantYAxisTextFill: text,
    quadrantTitleFill: text,
    quadrantInternalBorderStrokeFill: css(groupBorder),
    quadrantExternalBorderStrokeFill: css(outline(foreground)),

    // Git graphs: a branch in each chart color, labeled legibly on it.
    commitLabelColor: text,
    commitLabelBackground: css(secondary),
    tagLabelColor: text,
    tagLabelBackground: css(primary),
    tagLabelBorder: css(primaryBorder),

    // User journeys: faces light in every theme, as Mermaid draws their eyes and mouths in grey.
    faceColor: css(mix({ r: 255, g: 255, b: 255, a: 1 }, yellow, 0.35)),

    // Venn diagrams.
    vennTitleTextColor: text,
    vennSetTextColor: text,

    // Event modeling: its kinds of box in the chart colors.
    emUiFill: css(background),
    emUiStroke: css(groupBorder),
    emCommandFill: css(tint(blue, 0.25)),
    emCommandStroke: css(outline(blue)),
    emEventFill: css(tint(orange, 0.25)),
    emEventStroke: css(outline(orange)),
    emReadModelFill: css(tint(green, 0.25)),
    emReadModelStroke: css(outline(green)),
    emProcessorFill: css(tint(purple, 0.25)),
    emProcessorStroke: css(outline(purple)),
    emSwimlaneBackgroundOdd: css(group),
    emSwimlaneBackgroundStroke: css(highContrast ? groupBorder : tint(foreground, 0.1)),
    emArrowhead: css(line),
    emRelationStroke: css(line),

    xyChart: {
      backgroundColor: css(background),
      titleColor: text,
      dataLabelColor: text,
      legendTextColor: text,
      xAxisTitleColor: text,
      xAxisLabelColor: css(colors.muted),
      xAxisTickColor: css(colors.axisLine),
      xAxisLineColor: css(colors.axisLine),
      yAxisTitleColor: text,
      yAxisLabelColor: css(colors.muted),
      yAxisTickColor: css(colors.axisLine),
      yAxisLineColor: css(colors.axisLine),
      plotColorPalette: hues.map(css).join(","),
    },
    radar: {
      axisColor: css(colors.axisLine),
      // Rings, unfilled: Mermaid fills each, which stacks into a disc darker toward the middle.
      graticuleColor: css(colors.gridLine),
      graticuleOpacity: 0,
    },
    treeView: {
      labelColor: text,
      lineColor: css(groupBorder),
      iconColor: css(colors.muted),
      // Muted, unless on a highlighted row that leaves muted text too faint.
      descriptionColor: css(
        contrast(colors.muted, note) >= LABEL_CONTRAST ? colors.muted : foreground,
      ),
      highlightBg: css(note),
      highlightStroke: css(noteBorder),
    },
    packet: {
      startByteColor: css(colors.muted),
      endByteColor: css(colors.muted),
      labelColor: text,
      titleColor: text,
      blockStrokeColor: css(primaryBorder),
      blockFillColor: css(primary),
    },
    cynefin: {
      complexBg: css(tint(green, 0.12)),
      complicatedBg: css(tint(blue, 0.12)),
      chaoticBg: css(tint(red, 0.12)),
      clearBg: css(tint(yellow, 0.12)),
      confusionBg: css(tint(purple, 0.12)),
      cliffColor: css(red),
      textColor: text,
      labelColor: text,
    },
    wardley: {
      backgroundColor: css(background),
      gridColor: css(colors.gridLine),
      axisColor: css(colors.axisLine),
      axisTextColor: text,
      componentFill: css(background),
      componentStroke: text,
      componentLabelColor: text,
      linkStroke: css(line),
      evolutionStroke: css(red),
      annotationStroke: css(line),
      annotationTextColor: text,
      annotationFill: css(background),
    },
  };

  sections.forEach((color, i) => {
    variables[`cScale${i}`] = css(color);
    // Outlines, and the line under a mind map's node, in a stronger shade of the same color.
    const peer = css(highContrast ? colors.contrastBorder : outline(color));
    variables[`cScalePeer${i}`] = peer;
    variables[`cScaleInv${i}`] = peer;
    variables[`cScaleLabel${i}`] = text;
    variables[`pie${i + 1}`] = css(color);
  });
  hues.forEach((hue, i) => {
    variables[`git${i}`] = css(hue);
    variables[`gitInv${i}`] = css(background);
    variables[`gitBranchLabel${i}`] = label(hue);
    variables[`fillType${i}`] = css(sections[i] ?? primary);
    variables[`venn${i + 1}`] = css(hue);
    if (i < 6) variables[`actor${i}`] = css(hue);
  });
  return variables;
}

/**
 * The Mermaid theme, and its variables, that draw a diagram of the type, the keyword that starts
 * it, in the colors of a VS Code theme. Most draw in the base theme. Agent flows tell the kinds of
 * their nodes apart by color only in Mermaid's color themes, which take their colors from the
 * variables given: the chart colors, as outlines, with faint fills of them. Radar charts draw
 * curves rather than areas that labels lie on: in the chart colors themselves, over a wash.
 */
export function mermaidTheme(
  colors: ThemeColors,
  type: string | undefined,
): { theme: "base" | "redux-color" | "redux-dark-color"; themeVariables: Record<string, unknown> } {
  const themeVariables = mermaidThemeVariables(colors);
  const hues = colors.palette.slice(0, 12).map(toCss);
  if (type === "agentflow-beta") {
    return {
      theme: colors.dark ? "redux-dark-color" : "redux-color",
      themeVariables: {
        ...themeVariables,
        borderColorArray: hues,
        // Fills as faint as those of the nodes of other diagrams, which flows lie on too.
        bkgColorArray: colors.highContrast
          ? []
          : colors.palette
              .slice(0, 12)
              .map((hue) => toCss(mix(colors.background, hue, colors.dark ? 0.16 : 0.08))),
      },
    };
  }
  if (type === "radar-beta") {
    hues.forEach((hue, i) => {
      themeVariables[`cScale${i}`] = hue;
    });
    themeVariables.radar = { ...(themeVariables.radar as object), curveOpacity: 0.2 };
  }
  return { theme: "base", themeVariables };
}

const clamp = (value: number, min: number, max: number) =>
  Math.round(Math.min(max, Math.max(min, value)));

/**
 * The charts that Mermaid draws at a size of its configuration, rather than of their content, by
 * the type that it detects: the section of the configuration and the settings in it that size
 * them, and their configuration for the width the panel has. Each is as wide as Mermaid draws it
 * at most, and as narrow as its text allows.
 */
const SIZED: Record<
  string,
  { section: string; keys: string[]; config: (width: number) => object }
> = {
  // A radar's labels lie in its margins, of 50 on each side.
  radar: {
    section: "radar",
    keys: ["width", "height"],
    config: (width) => {
      const side = clamp(width - 100, 300, 600);
      return { radar: { width: side, height: side } };
    },
  },
  xychart: {
    section: "xyChart",
    keys: ["width", "height"],
    config: (width) => {
      const wide = clamp(width, 400, 700);
      return { xyChart: { width: wide, height: Math.round((wide * 5) / 7) } };
    },
  },
  quadrantChart: {
    section: "quadrantChart",
    keys: ["chartWidth", "chartHeight"],
    config: (width) => {
      const side = clamp(width, 320, 500);
      return { quadrantChart: { chartWidth: side, chartHeight: side } };
    },
  },
  sankey: {
    section: "sankey",
    keys: ["width", "height"],
    config: (width) => {
      const wide = clamp(width, 320, 600);
      return { sankey: { width: wide, height: Math.round((wide * 2) / 3) } };
    },
  },
  // Fields of a single bit keep room for their number.
  packet: {
    section: "packet",
    keys: ["bitWidth", "bitsPerRow"],
    config: (width) => ({ packet: { bitWidth: clamp((width - 10) / 32, 16, 32) } }),
  },
  cynefin: {
    section: "cynefin",
    keys: ["width", "height"],
    config: (width) => {
      // Its width takes in a padding of 40 on each side.
      const wide = clamp(width - 80, 480, 800);
      return { cynefin: { width: wide, height: Math.round(wide * 0.75) } };
    },
  },
  venn: {
    section: "venn",
    keys: ["width", "height"],
    config: (width) => {
      const wide = clamp(width, 400, 800);
      return { venn: { width: wide, height: Math.round((wide * 9) / 16) } };
    },
  },
};

/** How Mermaid sizes a chart that starts with the keyword, if it draws it at a size of its own. */
const sizedBy = (keyword: string | undefined) => {
  const type = keyword?.replace(/-beta$/, "");
  return type !== undefined && Object.hasOwn(SIZED, type) ? SIZED[type] : undefined;
};

/**
 * Whether the panel lays a diagram of the type that Mermaid detected out at its width: a Gantt
 * chart, which takes the width it is drawn in, and a chart of a size of Mermaid's that the panel
 * sizes, as it does not size itself.
 */
export const drawnAtWidth = (type: string | undefined, ownSize: boolean) =>
  type === "gantt" || (!ownSize && sizedBy(type) !== undefined);

/** A size that no diagram gives a chart, for the configuration to tell those that it does. */
const UNSET_SIZE = 999_983;

/**
 * Whether the diagram that starts with the keyword sizes itself, as a chart of a size of Mermaid's,
 * with the settings of its front matter or directives that size it, also to Mermaid's own size:
 * as Mermaid reads those, by parsing the text with sizes that no diagram gives, which a setting of
 * the diagram replaces. Mermaid keeps the configuration that it parsed with.
 */
export async function setsOwnSize(
  mermaid: Mermaid,
  config: MermaidConfig,
  text: string,
  keyword: string | undefined,
): Promise<boolean> {
  const sized = sizedBy(keyword);
  // Only a diagram that names a setting can set it.
  if (!sized?.keys.some((key) => text.includes(key))) return false;
  const unset = Object.fromEntries(sized.keys.map((key) => [key, UNSET_SIZE]));
  mermaid.initialize({ ...config, [sized.section]: unset });
  await mermaid.parse(text, { suppressErrors: true }).catch(() => false);
  const read = ((mermaid.mermaidAPI.getConfig() as Record<string, unknown>)[sized.section] ??
    {}) as Record<string, unknown>;
  return sized.keys.some((key) => read[key] !== UNSET_SIZE);
}

/**
 * The configuration that draws a chart of a size of Mermaid's at the width that the panel has for
 * it, given the keyword that starts the diagram: in a narrow panel, its text would otherwise
 * shrink with it. A diagram that sizes itself keeps its size.
 */
export function sizeConfig(keyword: string | undefined, ownSize: boolean, width: number): object {
  const sized = sizedBy(keyword);
  return !sized || ownSize || width <= 0 ? {} : sized.config(width);
}

/** The fills that Mermaid outlines in a color it derives from them, unless given one. */
const BORDERS: [string, string][] = [
  ["primaryColor", "primaryBorderColor"],
  ["secondaryColor", "secondaryBorderColor"],
  ["tertiaryColor", "tertiaryBorderColor"],
  ["noteBkgColor", "noteBorderColor"],
];

/** The theme variables that color text, such as primaryTextColor and gitBranchLabel0. */
const TEXT_VARIABLE = /(?:text|label|title)(?:color|fill|\d+)?$/i;

/** The fills that the text in each of these colors lies on. */
const TEXT_ON: [string, string[]][] = [
  ["primaryColor", ["primaryTextColor"]],
  ["mainBkg", ["nodeTextColor"]],
  ["secondaryColor", ["secondaryTextColor"]],
  ["tertiaryColor", ["tertiaryTextColor", "titleColor", "labelTextColor", "loopTextColor"]],
  ["clusterBkg", ["titleColor"]],
  ["noteBkgColor", ["noteTextColor"]],
  ["actorBkg", ["actorTextColor"]],
];

/**
 * The panel's theme variables with those that a diagram sets merged over them, for Mermaid to
 * derive the rest from: what the panel's theme draws in the color of a variable that the diagram
 * sets, other than text and what is unfilled, in the background color, takes that color too,
 * outlines follow the fills that the diagram sets, and text on them takes a color legible there
 * unless the diagram sets one. The background stays the panel's, which the diagram cannot change.
 */
export function adoptThemeVariables(
  ours: Record<string, unknown>,
  own: Record<string, unknown>,
  colors: ThemeColors,
): Record<string, unknown> {
  const merged = { ...ours };
  for (const [key, value] of Object.entries(own)) {
    const mine = ours[key];
    if (typeof mine === "string" && typeof value === "string" && mine !== ours.background) {
      for (const [other, color] of Object.entries(ours)) {
        if (color === mine && !Object.hasOwn(own, other) && !TEXT_VARIABLE.test(other)) {
          merged[other] = value;
        }
      }
    }
    merged[key] = value;
  }
  for (const [fill, border] of BORDERS) {
    if (Object.hasOwn(own, fill) && !Object.hasOwn(own, border)) delete merged[border];
  }
  for (const [fill, texts] of TEXT_ON) {
    const color = typeof own[fill] === "string" ? parseCss(own[fill]) : undefined;
    if (!color) continue;
    const label = toCss(labelColorOn(mix(colors.background, { ...color, a: 1 }, color.a), colors));
    for (const text of texts) if (!Object.hasOwn(own, text)) merged[text] = label;
  }
  // Labels on lines take the color of the text on nodes: where that does not read on the panel's
  // background, they lie on the fill of the nodes, as in Mermaid's light themes.
  const nodeText = parseCss(String(merged.nodeTextColor ?? merged.primaryTextColor));
  const nodeFill = own.mainBkg ?? own.primaryColor;
  if (
    nodeText &&
    nodeFill !== undefined &&
    !Object.hasOwn(own, "edgeLabelBackground") &&
    contrast(mix(colors.background, nodeText, nodeText.a), colors.background) < LABEL_CONTRAST
  ) {
    merged.edgeLabelBackground = nodeFill;
  }
  return merged;
}

/**
 * The configuration, with the theme variables that the diagram sets without choosing a theme of
 * its own merged over the panel's (see adoptThemeVariables): Mermaid's base theme derives colors
 * only from those it is configured with, and merges those of a diagram over what it derived.
 * Mermaid reads them from the diagram's front matter and directives, parsing it.
 */
export async function withOwnThemeVariables(
  mermaid: Mermaid,
  config: MermaidConfig,
  text: string,
  colors: ThemeColors,
): Promise<MermaidConfig> {
  const ours = config.themeVariables as Record<string, unknown> | undefined;
  if (!ours || Object.keys(ours).length === 0 || !text.includes("themeVariables")) return config;
  mermaid.initialize(config);
  await mermaid.parse(text, { suppressErrors: true }).catch(() => false);
  const site: Record<string, unknown> = mermaid.mermaidAPI.getSiteConfig().themeVariables ?? {};
  const read: Record<string, unknown> = mermaid.mermaidAPI.getConfig().themeVariables ?? {};
  const own = Object.fromEntries(
    Object.entries(read).filter(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(site[key]),
    ),
  );
  return Object.keys(own).length === 0
    ? config
    : { ...config, themeVariables: adoptThemeVariables(ours, own, colors) };
}

/** The kinds of element of C4 diagrams, whose fonts Mermaid configures each on its own. */
const C4_ELEMENTS = ["person", "system", "container", "component"].flatMap((kind) =>
  [kind, `${kind}_db`, `${kind}_queue`].flatMap((each) => [each, `external_${each}`]),
);

/** Mermaid's fills of C4 elements, by kind, which it labels in white. */
const C4_FILLS: Record<string, string> = {
  person: "#08427b",
  external_person: "#686868",
  system: "#1168bd",
  external_system: "#999999",
  container: "#438dd5",
  external_container: "#b3b3b3",
  component: "#85bbf0",
  external_component: "#cccccc",
};

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };

/** A fill of Mermaid's C4 elements, darkened as far as its white labels need to read on it. */
function c4Fill(kind: string): string {
  const fill = parseCss(C4_FILLS[kind.replace(/_(?:db|queue)$/, "")] ?? "") ?? BLACK;
  let amount = 0;
  while (contrast(mix(fill, BLACK, amount), WHITE) < LABEL_CONTRAST) amount += 0.05;
  return toCss(mix(fill, BLACK, amount));
}

/**
 * Mermaid's configuration of fonts and fixed colors for the panel: C4 and use case diagrams take a
 * font of their own for each kind of element, Open Sans, rather than the diagram's, and user
 * journeys draw their titles in Trebuchet MS, at 4ex, twice the size of the titles of other
 * charts. C4 diagrams label elements in white, on fills of their own, some of them too light for
 * it, such as the grey of external systems: those are darkened as far as the labels need, in
 * every theme alike.
 */
export function elementConfig(fontFamily: string) {
  const fonts = (kinds: string[]) =>
    Object.fromEntries(kinds.map((kind) => [`${kind}FontFamily`, fontFamily]));
  const fills = Object.fromEntries(C4_ELEMENTS.map((kind) => [`${kind}_bg_color`, c4Fill(kind)]));
  return {
    fontFamily,
    c4: { ...fonts([...C4_ELEMENTS, "boundary", "message"]), ...fills },
    // As large as the titles of XY and quadrant charts.
    journey: { ...fonts(["title", "task"]), titleFontSize: "20px" },
    usecase: fonts(["actor", "usecase"]),
  };
}

/**
 * The colors that Mermaid draws parts of some diagrams in whatever the theme, by the type of the
 * diagram, with what to draw them in instead: on lines and shapes, and on text. C4 diagrams draw
 * relations, their labels and boundaries in a dark grey and arrowheads in black, and Wardley maps
 * label anchors and divide stages in black, which all but vanish on a dark background.
 */
const FIXED_COLORS: Record<string, Record<string, ["line" | "text", "line" | "text"]>> = {
  c4: { "#444444": ["line", "text"], black: ["line", "line"], "#000000": ["line", "line"] },
  wardley: { "#000": ["line", "text"] },
};

/** Draws what Mermaid colors the same in every theme in the theme's line and text colors. */
export function themeFixedColors(
  svg: SVGSVGElement,
  diagramType: string,
  colors: ThemeColors,
): void {
  const fixed = FIXED_COLORS[diagramType];
  if (!fixed) return;
  const { lineColor, textColor } = mermaidThemeVariables(colors);
  const color = { line: String(lineColor), text: String(textColor) };
  for (const element of svg.querySelectorAll("[fill], [stroke]")) {
    const text = element.matches("text, tspan");
    for (const attribute of ["stroke", "fill"]) {
      const roles = fixed[element.getAttribute(attribute)?.toLowerCase() ?? ""];
      const role = roles?.[attribute === "fill" && text ? 1 : 0];
      if (role) element.setAttribute(attribute, color[role]);
    }
  }
}

/**
 * Draws the text of a sequence diagram that lies on the background of a `rect` block or a `box` of
 * participants in a color legible there, where the theme's text color is not: the source colors
 * them, often light, such as Aqua, on which the light text of a dark theme vanishes. Text on what
 * is drawn over them, such as notes and participants, keeps its color. The drawing must be in the
 * document, where the browser resolves fills.
 */
export function colorLabelsOnBlocks(svg: SVGSVGElement, colors: ThemeColors): void {
  const blocks = svg.querySelectorAll("rect.rect");
  if (blocks.length === 0) return;
  // The filled shapes, in the order drawn, read before any color changes.
  const shapes = Array.from(
    svg.querySelectorAll<SVGGeometryElement>("rect, path, polygon, circle, ellipse"),
  )
    .filter((shape) => !shape.closest("defs, marker, text, foreignObject"))
    .flatMap((shape) => {
      const style = getComputedStyle(shape);
      const fill = parseColor(style.fill);
      const alpha = (fill?.a ?? 0) * Number(style.fillOpacity) * Number(style.opacity);
      const toShape = shape.getScreenCTM()?.inverse();
      return fill && alpha > 0 && toShape && style.display !== "none"
        ? [{ shape, box: shape.getBoundingClientRect(), fill, alpha, toShape }]
        : [];
    });
  const recolor: [SVGTextElement, string][] = [];
  for (const text of svg.querySelectorAll<SVGTextElement>("text")) {
    const box = text.getBoundingClientRect();
    if (!box.width || !text.textContent?.trim()) continue;
    const [x, y] = [box.left + box.width / 2, box.top + box.height / 2];
    let under = colors.background;
    let onBlock = false;
    for (const { shape, box: bounds, fill, alpha, toShape } of shapes) {
      if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) continue;
      if (!shape.isPointInFill(new DOMPoint(x, y).matrixTransform(toShape))) continue;
      under = mix(under, fill, alpha);
      // A shape drawn over a block covers it.
      onBlock = shape.matches("rect.rect");
    }
    const color = parseColor(getComputedStyle(text).fill);
    if (onBlock && color && contrast(mix(under, color, color.a), under) < LABEL_CONTRAST) {
      recolor.push([text, toCss(labelColorOn(under, colors))]);
    }
  }
  for (const [text, color] of recolor) text.style.fill = color;
}
