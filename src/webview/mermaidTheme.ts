// Mermaid's base theme, the one meant to be given colors, in the colors of the VS Code theme.

import {
  contrast,
  labelColorOn,
  legibleTints,
  lighten,
  mix,
  type Rgba,
  type ThemeColors,
  toCss,
} from "./colors";

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

    // User journeys.
    faceColor: css(highContrast ? background : mix(background, yellow, dark ? 0.5 : 0.35)),

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
      descriptionColor: css(colors.muted),
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

/** The kinds of element of C4 diagrams, whose fonts Mermaid configures each on its own. */
const C4_ELEMENTS = ["person", "system", "container", "component"].flatMap((kind) =>
  [kind, `${kind}_db`, `${kind}_queue`].flatMap((each) => [each, `external_${each}`]),
);

/**
 * Mermaid's configuration of fonts for VS Code's: C4 and use case diagrams take a font of their
 * own for each kind of element, Open Sans, rather than the diagram's, and user journeys draw their
 * titles in Trebuchet MS.
 */
export function fontConfig(fontFamily: string) {
  const fonts = (kinds: string[]) =>
    Object.fromEntries(kinds.map((kind) => [`${kind}FontFamily`, fontFamily]));
  return {
    fontFamily,
    c4: fonts([...C4_ELEMENTS, "boundary", "message"]),
    journey: fonts(["title", "task"]),
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
