// An ECharts theme built from the colors and fonts of the current VS Code theme.

import { mix, type ThemeColors, toCss } from "./colors";
import { SERIES_TYPES } from "./echartsOption";

export function buildEChartsTheme(colors: ThemeColors, reducedMotion = false): object {
  const foreground = toCss(colors.foreground);
  const muted = toCss(colors.muted);
  const background = toCss(colors.background);
  const gridColor = toCss(colors.gridLine);
  const axisColor = toCss(colors.axisLine);
  const disabled = toCss(mix(colors.background, colors.muted, 0.45));
  const accent = toCss(colors.blue);
  const accentWash = toCss({ ...colors.blue, a: 0.15 });
  const subtleFill = toCss({ ...colors.foreground, a: colors.dark ? 0.06 : 0.04 });
  const font = { fontFamily: colors.fontFamily, fontSize: colors.fontSize };

  const axisLine = { lineStyle: { color: axisColor } };
  const axisTick = { lineStyle: { color: axisColor } };
  const axis = {
    axisLine,
    axisTick,
    axisLabel: { color: muted, ...font },
    nameTextStyle: { color: muted, ...font },
    splitLine: { lineStyle: { color: gridColor } },
    minorSplitLine: { lineStyle: { color: toCss({ ...colors.gridLine, a: 0.5 }) } },
    splitArea: { areaStyle: { color: [subtleFill, "transparent"] } },
  };
  const theme: Record<string, unknown> = {
    darkMode: colors.dark,
    color: colors.palette.map(toCss),
    backgroundColor: "transparent",
    textStyle: { color: foreground, ...font },
    aria: { enabled: true },
    ...(reducedMotion && { animation: false }),
    animationDuration: 500,
    animationDurationUpdate: 350,
    animationEasing: "cubicOut",
    animationEasingUpdate: "cubicInOut",
    stateAnimation: { duration: 150, easing: "cubicOut" },

    title: {
      left: 4,
      top: 4,
      textStyle: {
        color: foreground,
        fontFamily: colors.fontFamily,
        fontSize: 14,
        fontWeight: 600,
      },
      subtextStyle: { color: muted, ...font },
    },
    legend: {
      textStyle: { color: foreground, ...font },
      inactiveColor: disabled,
      inactiveBorderColor: disabled,
      itemGap: 14,
      itemWidth: 12,
      itemHeight: 12,
      icon: "roundRect",
      pageTextStyle: { color: muted, ...font },
      pageIconColor: foreground,
      pageIconInactiveColor: disabled,
      pageIconSize: 11,
    },
    tooltip: {
      confine: true,
      backgroundColor: toCss(colors.hoverBackground),
      borderColor: toCss(colors.hoverBorder),
      padding: [6, 10],
      textStyle: { color: toCss(colors.hoverForeground), ...font },
      extraCssText: "box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.3));",
    },
    axisPointer: {
      lineStyle: { color: axisColor },
      crossStyle: { color: axisColor },
      shadowStyle: { color: subtleFill },
      label: {
        color: toCss(colors.hoverForeground),
        backgroundColor: toCss(colors.hoverBackground),
        borderColor: toCss(colors.hoverBorder),
        borderWidth: 1,
      },
    },
    categoryAxis: { ...axis, axisTick: { ...axisTick, alignWithLabel: true } },
    valueAxis: axis,
    logAxis: axis,
    timeAxis: axis,
    radar: {
      ...axis,
      axisName: { color: muted, ...font },
      axisLine: { lineStyle: { color: gridColor } },
      splitArea: { show: false },
    },

    line: {
      symbol: "circle",
      symbolSize: 7,
      lineStyle: { cap: "round", join: "round" },
      // A ring in the background color keeps markers legible where they cross lines.
      itemStyle: { borderColor: background, borderWidth: 1.5 },
    },
    bar: { barMaxWidth: 28 },
    scatter: {
      symbolSize: 10,
      itemStyle: { opacity: 0.85, borderColor: background, borderWidth: 1 },
    },
    pie: {
      itemStyle: { borderColor: background, borderWidth: 2, borderRadius: 3 },
      label: { color: foreground },
      labelLine: { lineStyle: { color: axisColor } },
    },
    funnel: {
      itemStyle: { borderColor: background, borderWidth: 2 },
      label: { color: foreground },
    },
    sunburst: { itemStyle: { borderColor: background, borderWidth: 2 } },
    treemap: {
      itemStyle: { borderColor: background, gapWidth: 2 },
      breadcrumb: {
        itemStyle: { color: subtleFill, borderColor: gridColor, textStyle: { color: foreground } },
        emphasis: { itemStyle: { color: gridColor } },
      },
    },
    graph: {
      lineStyle: { color: axisColor, opacity: 0.8 },
      // Beside the node rather than on it, where a label in the text color may not read and a
      // long one runs off a small node onto the background.
      label: { color: foreground, position: "right" },
      itemStyle: { borderColor: background, borderWidth: 1 },
    },
    sankey: {
      lineStyle: { color: "gradient", opacity: 0.25 },
      label: { color: foreground },
      itemStyle: { borderWidth: 0 },
      emphasis: { lineStyle: { opacity: 0.5 } },
    },
    tree: {
      lineStyle: { color: axisColor },
      label: { color: foreground },
      itemStyle: { borderColor: accent },
    },
    gauge: {
      axisLine: { lineStyle: { color: [[1, gridColor]] } },
      axisTick: { lineStyle: { color: axisColor } },
      splitLine: { lineStyle: { color: axisColor } },
      axisLabel: { color: muted },
      title: { color: muted },
      detail: { color: foreground },
      anchor: { itemStyle: { color: background, borderColor: accent } },
    },
    candlestick: {
      itemStyle: {
        color: toCss(colors.green),
        color0: toCss(colors.red),
        borderColor: toCss(colors.green),
        borderColor0: toCss(colors.red),
      },
    },
    boxplot: { itemStyle: { color: "transparent", borderWidth: 1.5 } },
    // A high contrast theme outlines its elements in its contrast border, where a gap in the
    // background color would leave a cell of a small value all but one with it.
    heatmap: {
      itemStyle: {
        borderColor: colors.highContrast ? toCss(colors.contrastBorder) : background,
        borderWidth: 1,
      },
    },

    visualMap: {
      // Sequential: one hue, receding toward the background for small values, though not as far
      // in a high contrast theme, in which the smallest would be lost on it.
      color: [
        accent,
        toCss(mix(colors.background, colors.blue, colors.highContrast ? 0.35 : 0.15)),
      ],
      textStyle: { color: foreground, ...font },
      handleStyle: { borderColor: background },
    },
    dataZoom: {
      borderColor: gridColor,
      fillerColor: accentWash,
      textStyle: { color: muted, ...font },
      handleStyle: { color: background, borderColor: accent },
      moveHandleStyle: { color: gridColor },
      brushStyle: { color: accentWash },
      emphasis: { handleStyle: { borderColor: foreground }, moveHandleStyle: { color: axisColor } },
      dataBackground: { lineStyle: { color: axisColor }, areaStyle: { color: gridColor } },
      selectedDataBackground: { lineStyle: { color: accent }, areaStyle: { color: accentWash } },
    },
    timeline: {
      lineStyle: { color: axisColor },
      label: { color: muted },
      itemStyle: { color: axisColor },
      checkpointStyle: { color: accent, borderColor: background },
      controlStyle: { color: foreground, borderColor: foreground },
    },
    toolbox: {
      iconStyle: { borderColor: muted },
      emphasis: { iconStyle: { borderColor: foreground, textFill: foreground } },
      feature: {
        dataView: {
          backgroundColor: background,
          textColor: foreground,
          textareaColor: background,
          textareaBorderColor: gridColor,
          buttonColor: accent,
          buttonTextColor: background,
        },
      },
    },
    calendar: {
      itemStyle: { color: "transparent", borderColor: gridColor },
      splitLine: { lineStyle: { color: axisColor } },
      dayLabel: { color: muted },
      monthLabel: { color: muted },
      yearLabel: { color: muted },
    },
    markLine: { label: { color: foreground }, lineStyle: { color: axisColor } },
  };
  // The panel's selection, which Ctrl+click adds to, outlined in the foreground color in a glow
  // of the focus color: an outline of the focus color alone would hardly show on an item of a
  // color like it.
  const select = {
    itemStyle: {
      borderColor: foreground,
      borderWidth: 2.5,
      shadowBlur: 14,
      shadowColor: toCss({ ...colors.focus, a: 0.7 }),
    },
    label: { fontWeight: "bold" },
  };
  for (const type of SERIES_TYPES) {
    theme[type] = { selectedMode: "multiple", select, ...(theme[type] as object) };
  }
  return theme;
}
