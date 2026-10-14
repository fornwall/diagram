// Mermaid's base theme, the one meant to be given colors, in the colors of the VS Code theme.

import {
  contrast,
  LABEL_CONTRAST,
  labelColorOn,
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
 * The colors of the sections of mind maps, timelines, kanban boards and pies, and of their labels:
 * VS Code's chart colors, mixed into the background as far as leaves the theme's text legible on
 * them. Kanban columns are drawn 10 points lighter, which their labels and headings must be
 * legible on too.
 */
function sectionColors({ dark, palette, background, foreground }: ThemeColors): Rgba[] {
  const legible = (color: Rgba) =>
    contrast(color, foreground) >= LABEL_CONTRAST &&
    contrast(lighten(color, 10), foreground) >= LABEL_CONTRAST;
  return palette.slice(0, 12).map((hue) => {
    let amount = dark ? 0.45 : 0.5;
    while (amount > 0.15 && !legible(mix(background, hue, amount))) amount -= 0.05;
    return mix(background, hue, amount);
  });
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
  const sections = sectionColors(colors);
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
