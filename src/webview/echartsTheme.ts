// An ECharts theme built from the colors and fonts of the current VS Code theme.

import { mix, type ThemeColors, toCss } from "./colors";

export function buildEChartsTheme(colors: ThemeColors): Record<string, unknown> {
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
  // Recessive axes: no axis line or ticks on value axes, only hairline grid lines.
  const valueAxis = {
    ...axis,
    axisLine: { ...axisLine, show: false },
    axisTick: { ...axisTick, show: false },
  };

  return {
    darkMode: colors.dark,
    color: colors.palette.map(toCss),
    backgroundColor: "transparent",
    textStyle: { color: foreground, ...font },
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
    valueAxis,
    logAxis: valueAxis,
    timeAxis: axis,
    radar: {
      ...axis,
      axisName: { color: muted, ...font },
      axisLine: { lineStyle: { color: gridColor } },
      splitArea: { show: false },
    },
    angleAxis: axis,
    radiusAxis: axis,
    singleAxis: axis,
    parallelAxis: axis,

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
      label: { color: foreground },
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
    heatmap: { itemStyle: { borderColor: background, borderWidth: 1 } },

    visualMap: {
      // Sequential: one hue, receding toward the background for small values.
      color: [accent, toCss(mix(colors.background, colors.blue, 0.15))],
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
}
