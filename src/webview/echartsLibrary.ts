// The parts of ECharts that an option can use in the panel, loaded as one chunk on the first
// chart. Custom series are included although they cost about 17 KB, the most of any series here,
// as a renderItem function draws what no built-in series can. Left out: the canvas renderer
// (charts draw as SVG; see below), map series and the geo component (there is no map data) and
// universal transitions (morphs between series types, which only animate a change).
//
// Charts draw as SVG rather than on a canvas, so that they stay sharp at any zoom and on any
// screen without redrawing for its pixel ratio, their text is real text, and the drawing can be
// handed out as a vector image. The cost is that a series with very many points becomes that many
// DOM elements, where a canvas would draw them in one pass: ECharts' progressive rendering and
// "large" series optimizations only apply to the canvas renderer.

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
  BrushComponent,
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
  BrushComponent,
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
