// Loaded on the first chart. SVG supports sharp text and vector export, but not the canvas
// renderer's progressive/large-data optimizations. Maps (no map data), the canvas renderer and
// universal transitions are omitted to keep the bundle smaller, and the brush component, which
// would add the toolbox's brush back to the chart that echartsLayout.ts takes it out of.

import {
  BarChart,
  BoxplotChart,
  CandlestickChart,
  ChordChart,
  CustomChart,
  EffectScatterChart,
  FunnelChart,
  GaugeChart,
  GraphChart,
  HeatmapChart,
  LineChart,
  LinesChart,
  ParallelChart,
  PictorialBarChart,
  PieChart,
  RadarChart,
  SankeyChart,
  ScatterChart,
  SunburstChart,
  ThemeRiverChart,
  TreeChart,
  TreemapChart,
} from "echarts/charts";
import {
  AriaComponent,
  CalendarComponent,
  DatasetComponent,
  DataZoomComponent,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  MarkPointComponent,
  MatrixComponent,
  ParallelComponent,
  PolarComponent,
  SingleAxisComponent,
  ThumbnailComponent,
  TimelineComponent,
  TitleComponent,
  ToolboxComponent,
  TooltipComponent,
  TransformComponent,
  VisualMapComponent,
} from "echarts/components";
import { use } from "echarts/core";
import { AxisBreak, LabelLayout, LegacyGridContainLabel, ScatterJitter } from "echarts/features";
import { SVGRenderer } from "echarts/renderers";
import { ensureFontMeasureInfo, getWidth, measureCharWidth } from "zrender/lib/contain/text.js";

use([
  BarChart,
  BoxplotChart,
  CandlestickChart,
  ChordChart,
  CustomChart,
  EffectScatterChart,
  FunnelChart,
  GaugeChart,
  GraphChart,
  HeatmapChart,
  LineChart,
  LinesChart,
  ParallelChart,
  PictorialBarChart,
  PieChart,
  RadarChart,
  SankeyChart,
  ScatterChart,
  SunburstChart,
  ThemeRiverChart,
  TreeChart,
  TreemapChart,
  AriaComponent,
  CalendarComponent,
  DatasetComponent,
  DataZoomComponent,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  MarkPointComponent,
  MatrixComponent,
  ParallelComponent,
  PolarComponent,
  SingleAxisComponent,
  ThumbnailComponent,
  TimelineComponent,
  TitleComponent,
  ToolboxComponent,
  TooltipComponent,
  TransformComponent,
  VisualMapComponent,
  AxisBreak,
  LabelLayout,
  LegacyGridContainLabel,
  ScatterJitter,
  SVGRenderer,
]);

export { init } from "echarts/core";

/**
 * The width of a text in a CSS font as ECharts measures it to break it onto lines: character by
 * character, any but ASCII as wide as one of Chinese. Of the library's own measures, which it
 * keeps for each font.
 */
export function textWidth(text: string, font: string): number {
  const measures = ensureFontMeasureInfo(font);
  let sum = 0;
  for (let index = 0; index < text.length; index++) {
    sum += measureCharWidth(measures, text.charCodeAt(index));
  }
  return sum;
}

/**
 * The width of a text in a CSS font as drawn, as ECharts measures it to place it: of the
 * library's own measures, which it keeps for each font and text.
 */
export function drawnWidth(text: string, font: string): number {
  return getWidth(text, font);
}
