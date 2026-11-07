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
import { SeriesModel, use } from "echarts/core";
import { AxisBreak, LabelLayout, LegacyGridContainLabel, ScatterJitter } from "echarts/features";
import { SVGRenderer } from "echarts/renderers";
import { ensureFontMeasureInfo, measureCharWidth } from "zrender/lib/contain/text.js";

/** What ECharts' selection reads of a series and its data. */
interface SelectableData {
  dataType?: string;
  getRawIndex(index: number): number;
  getItemModel(index: number): { get(path: string[]): unknown };
}
interface SelectableSeries {
  option: { selectedMode?: unknown; selectedMap?: Record<string, boolean> | "all" };
  _selectedDataIndicesMap: Record<string, number>;
  getData(dataType?: string): SelectableData;
  _innerSelect(data: SelectableData, indices: number[]): void;
  unselect(indices: number[], dataType?: string): void;
  isSelected(index: number, dataType?: string): boolean;
}

/**
 * ECharts keeps the selection of a series by item name, which selects every item of that name, as
 * each cell of a heatmap's column: keep it by the item's index instead, as the panel does.
 */
const selectionKey = (data: SelectableData, index: number) =>
  `${data.dataType ?? ""}:${data.getRawIndex(index)}`;
const series = SeriesModel.prototype as unknown as SelectableSeries;
series._innerSelect = function (data, indices) {
  const { option } = this;
  const mode = option.selectedMode;
  const last = indices.at(-1);
  if (!mode || last === undefined) return;
  if (mode === "series") {
    option.selectedMap = "all";
  } else if (mode === "multiple") {
    if (typeof option.selectedMap !== "object") option.selectedMap = {};
    for (const index of indices) {
      const key = selectionKey(data, index);
      option.selectedMap[key] = true;
      this._selectedDataIndicesMap[key] = data.getRawIndex(index);
    }
  } else if (mode === "single" || mode === true) {
    const key = selectionKey(data, last);
    option.selectedMap = { [key]: true };
    this._selectedDataIndicesMap = { [key]: data.getRawIndex(last) };
  }
};
series.unselect = function (indices, dataType) {
  const { option } = this;
  if (!option.selectedMap) return;
  if (option.selectedMode === "series" || option.selectedMap === "all") {
    option.selectedMap = {};
    this._selectedDataIndicesMap = {};
    return;
  }
  const data = this.getData(dataType);
  for (const index of indices) {
    const key = selectionKey(data, index);
    option.selectedMap[key] = false;
    this._selectedDataIndicesMap[key] = -1;
  }
};
series.isSelected = function (index, dataType) {
  const { selectedMap } = this.option;
  if (!selectedMap) return false;
  const data = this.getData(dataType);
  return (
    (selectedMap === "all" || selectedMap[selectionKey(data, index)] === true) &&
    !data.getItemModel(index).get(["select", "disabled"])
  );
};

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
