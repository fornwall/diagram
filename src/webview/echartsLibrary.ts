// Loaded on the first chart. SVG gives sharp text and vector export but lacks canvas's
// progressive/large-data optimizations. Omit maps (no map data), canvas and universal transitions
// to reduce bundle size. Registering BrushComponent would restore the toolbox brush removed by
// the panel's layout, so leave it out too.

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
import { ensureFontMeasureInfo, measureCharWidth } from "zrender/lib/contain/text.js";

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
/** ZRender's cached drawn-text measurement, used for positioning. */
export { getWidth as drawnWidth } from "zrender/lib/contain/text.js";

/**
 * Match ECharts' wrapping measurement, which approximates non-ASCII character widths.
 * Use ZRender's per-font cache so layout and rendering agree.
 */
export function textWidth(text: string, font: string): number {
  const measures = ensureFontMeasureInfo(font);
  let sum = 0;
  for (let index = 0; index < text.length; index++) {
    sum += measureCharWidth(measures, text.charCodeAt(index));
  }
  return sum;
}
