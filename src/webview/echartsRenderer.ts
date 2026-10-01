// Renders Apache ECharts options, given as JSON, adapted to the panel size and VS Code theme.

import * as echarts from "echarts";
import type { ThemeColors } from "./colors";
import { asArray, isCartesian, isObject, type JsonObject, layoutOption } from "./echartsLayout";
import { buildEChartsTheme } from "./echartsTheme";
import { describeJsonError } from "./jsonErrors";
import type { Hit, RenderContext, Renderer, RendererHost } from "./renderer";
import { readThemeColors } from "./vscodeTheme";

const THEME_NAME = "vscode";

const SERIES_TYPES = [
  "line",
  "bar",
  "pie",
  "scatter",
  "effectScatter",
  "radar",
  "tree",
  "treemap",
  "sunburst",
  "map",
  "graph",
  "chord",
  "gauge",
  "funnel",
  "parallel",
  "sankey",
  "boxplot",
  "candlestick",
  "lines",
  "heatmap",
  "pictorialBar",
  "themeRiver",
  "custom",
];

/** Map series need map data, which the panel does not have. */
const AVAILABLE_TYPES = SERIES_TYPES.filter((type) => type !== "map").join(", ");

const TYPE_HINTS: Record<string, string> = {
  donut: 'for a donut chart, use "pie" with "radius": ["40%", "70%"]',
  doughnut: 'for a donut chart, use "pie" with "radius": ["40%", "70%"]',
  ring: 'for a donut chart, use "pie" with "radius": ["40%", "70%"]',
  area: 'for an area chart, use "line" with "areaStyle": {}',
  column: 'for a column chart, use "bar"',
  histogram: 'for a histogram, use "bar"',
  bubble: 'for a bubble chart, use "scatter" with "symbolSize"',
  spline: 'for a smooth line, use "line" with "smooth": true',
  network: 'for a network, use "graph"',
  flow: 'for flows between nodes, use "sankey"',
};

/** Keys whose values are bulk data, skipped when looking for mistakes in the option. */
const DATA_KEYS = new Set(["data", "nodes", "links", "edges", "source", "dimensions"]);
const JAVASCRIPT = /^\s*(?:function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/;

function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  return Array.isArray(value) ? "an array" : `a ${typeof value}`;
}

/** Throws an actionable error for mistakes that ECharts would silently render as nothing. */
function validateOption(option: JsonObject): void {
  const base = isObject(option.baseOption) ? option.baseOption : option;
  // Timeline options only patch the series of the base option, so only those are checked.
  const list: unknown[] = Array.isArray(base.series)
    ? base.series
    : base.series === undefined
      ? []
      : [base.series];
  const series = list.map((entry, index) => {
    if (!isObject(entry)) {
      throw new Error(
        `series[${index}] must be an object such as {"type": "bar", "data": [5, 20, 36]}, not ${describe(entry)}.`,
      );
    }
    return entry;
  });
  if (series.length === 0) {
    throw new Error(
      'The ECharts option has no "series". Add at least one, e.g. "series": [{"type": "bar", ' +
        '"data": [5, 20, 36]}] with "xAxis": {"type": "category", "data": ["A", "B", "C"]} and ' +
        '"yAxis": {"type": "value"}.',
    );
  }
  series.forEach((each, index) => {
    const type = each.type;
    if (typeof type !== "string" || !type) {
      throw new Error(`series[${index}] has no "type". Set it to one of: ${AVAILABLE_TYPES}.`);
    }
    if (!SERIES_TYPES.includes(type)) {
      const hint = TYPE_HINTS[type.toLowerCase()];
      throw new Error(
        `series[${index}] has the unknown type "${type}"${hint ? ` (${hint})` : ""}. ` +
          `Valid types: ${AVAILABLE_TYPES}.`,
      );
    }
    if (type === "map") {
      throw new Error(
        `series[${index}] is a "map", but geographic maps are not available in the diagram panel ` +
          "(no map data is registered). Use another chart type, such as a bar chart by region.",
      );
    }
    if (isCartesian(each) && (base.xAxis === undefined || base.yAxis === undefined)) {
      throw new Error(
        `series[${index}] (type "${type}") is drawn on a grid and needs both "xAxis" and "yAxis", ` +
          'e.g. "xAxis": {"type": "category", "data": ["Mon", "Tue"]}, "yAxis": {"type": "value"}.',
      );
    }
    if (type === "radar" && base.radar === undefined) {
      throw new Error(
        `series[${index}] is a "radar" series and needs a "radar" component, e.g. "radar": ` +
          '{"indicator": [{"name": "Speed", "max": 100}, {"name": "Cost", "max": 100}]}.',
      );
    }
  });
  if (base.geo !== undefined) {
    throw new Error(
      'The "geo" component is not available in the diagram panel (no map data is registered). ' +
        "Use another chart type.",
    );
  }
  findJavaScript(option, "option");
}

function findJavaScript(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (JAVASCRIPT.test(value)) {
      throw new Error(
        `${path} is JavaScript code, but the option is JSON and cannot contain functions. ` +
          'Use a string template instead, such as "{b}: {c}" (name and value) or "{d}%" (pie percentage).',
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      findJavaScript(item, `${path}[${index}]`);
    });
  } else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (!DATA_KEYS.has(key)) {
        findJavaScript(item, path === "option" ? key : `${path}.${key}`);
      }
    }
  }
}

function parseOption(source: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(describeJsonError(source, error));
  }
  if (!isObject(parsed)) {
    throw new Error(
      `The ECharts option must be a JSON object such as {"series": [...]}, not ${describe(parsed)}.`,
    );
  }
  validateOption(parsed);
  return parsed;
}

function seriesTypes(option: JsonObject): string {
  const base = isObject(option.baseOption) ? option.baseOption : option;
  const types = [base, ...asArray(option.options)]
    .flatMap((each) => asArray(each.series))
    .flatMap((each) => (typeof each.type === "string" ? [each.type] : []));
  return Array.from(new Set(types)).join(", ");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function valueText(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  if (Array.isArray(value)) {
    return `(${value.map((item) => String(item)).join(", ")})`;
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

interface SelectedItems {
  seriesIndex: number;
  dataType?: string;
  dataIndex: number[];
}

const itemKey = (seriesIndex: number, dataIndex: number, dataType?: string) =>
  `${seriesIndex}:${dataType ?? ""}:${dataIndex}`;

function parseItemKey(key: string): { seriesIndex: number; dataIndex: number; dataType?: string } {
  const [series, dataType, data] = key.split(":");
  return {
    seriesIndex: Number(series),
    dataIndex: Number(data),
    ...(dataType ? { dataType } : {}),
  };
}

const withModifier = (event: unknown) =>
  event instanceof MouseEvent && (event.ctrlKey || event.metaKey || event.shiftKey);

export class EChartsRenderer implements Renderer {
  readonly language = "echarts";
  readonly zoomable = false;
  readonly itemNoun = "item";

  private readonly container: HTMLElement;
  private chart: echarts.ECharts | undefined;
  private colors: ThemeColors | undefined;
  private option: JsonObject | undefined;
  private title = "";
  private signature = "";
  private selectedKeys: ReadonlySet<string> = new Set();
  /** What ECharts shows as selected, as last reported by its selectchanged event. */
  private shownSelected: SelectedItems[] = [];
  private legendSelected: Record<string, boolean> | undefined;
  private resizeFrame = 0;
  private relayoutTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  constructor(
    private readonly host: RendererHost,
    private readonly canvas: HTMLElement,
  ) {
    this.container = document.createElement("div");
    this.container.id = "chart";
    this.container.hidden = true;
    canvas.append(this.container);
    new ResizeObserver(() => this.scheduleResize()).observe(this.container);
  }

  async render(source: string, context: RenderContext): Promise<string> {
    const option = parseOption(source);
    const previous = this.chart ? { option: this.option, title: this.title } : undefined;
    this.show();
    this.option = option;
    this.title = context.title;
    this.legendSelected = undefined;
    this.selectedKeys = new Set();
    try {
      this.apply(true);
    } catch (error) {
      // A failed setOption can leave the instance broken: start over, with the previous chart.
      this.disposeChart();
      if (previous?.option) {
        this.option = previous.option;
        this.title = previous.title;
        try {
          this.apply(false);
        } catch {
          this.disposeChart();
        }
      }
      throw new Error(`ECharts could not render this option: ${errorText(error)}`);
    }
    return seriesTypes(option);
  }

  hide(): void {
    this.disposeChart();
    this.option = undefined;
    this.container.hidden = true;
    this.canvas.classList.remove("chart-mode");
  }

  showSelection(keys: ReadonlySet<string>): void {
    this.selectedKeys = new Set(keys);
    // ECharts toggles the selection of clicked items itself, after our click handlers ran.
    queueMicrotask(() => this.syncSelection());
  }

  async themeChanged(): Promise<void> {
    this.colors = undefined;
    if (this.chart && this.option) {
      this.disposeChart();
      this.apply(false);
    }
  }

  formatForEditing(source: string): string {
    if (source.includes("\n")) {
      return source;
    }
    try {
      return JSON.stringify(JSON.parse(source), null, 2);
    } catch {
      return source;
    }
  }

  private show(): void {
    this.canvas.classList.add("chart-mode");
    this.container.hidden = false;
  }

  private ensureChart(): echarts.ECharts {
    if (this.chart) {
      return this.chart;
    }
    if (!this.colors) {
      this.colors = readThemeColors();
      echarts.registerTheme(THEME_NAME, buildEChartsTheme(this.colors));
    }
    const chart = echarts.init(this.container, THEME_NAME, { renderer: "canvas" });
    chart.on("click", (params: echarts.ECElementEvent) => {
      if (params.componentType !== "series") {
        return;
      }
      this.host.itemClicked(this.hitFor(params), withModifier(params.event?.event));
      queueMicrotask(() => this.syncSelection());
    });
    chart.getZr().on("click", (event) => {
      if (!event.target) {
        this.host.itemClicked(undefined, withModifier(event.event));
      }
    });
    chart.on("selectchanged", (event) => {
      this.shownSelected = (event as { selected?: SelectedItems[] }).selected ?? [];
    });
    chart.on("legendselectchanged", (event) => {
      const selected = (event as { selected?: Record<string, boolean> }).selected;
      if (selected) {
        this.legendSelected = selected;
      }
    });
    this.chart = chart;
    return chart;
  }

  private disposeChart(): void {
    cancelAnimationFrame(this.resizeFrame);
    clearTimeout(this.relayoutTimer);
    this.chart?.dispose();
    this.chart = undefined;
    this.shownSelected = [];
    this.signature = "";
  }

  private layout() {
    if (!this.colors) {
      this.colors = readThemeColors();
      echarts.registerTheme(THEME_NAME, buildEChartsTheme(this.colors));
    }
    return layoutOption(this.option ?? {}, {
      width: this.container.clientWidth,
      height: this.container.clientHeight,
      title: this.title,
      colors: this.colors,
      reducedMotion: this.reducedMotion.matches,
      ...(this.legendSelected ? { legendSelected: this.legendSelected } : {}),
    });
  }

  /** Sets the option, laid out for the current size, replacing what the chart showed before. */
  private apply(animate: boolean): void {
    const { option, signature } = this.layout();
    const chart = this.ensureChart();
    if (!animate) {
      option.animation = false;
    }
    chart.setOption(option, { notMerge: true });
    this.signature = signature;
    this.shownSelected = [];
    this.syncSelection();
  }

  private scheduleResize(): void {
    if (!this.chart) {
      return;
    }
    cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = requestAnimationFrame(() => {
      this.chart?.resize();
      // Layout decisions (legend position, label rotation, …) follow once resizing settles.
      clearTimeout(this.relayoutTimer);
      this.relayoutTimer = setTimeout(() => {
        if (this.chart && this.option && this.layout().signature !== this.signature) {
          try {
            this.apply(false);
          } catch {
            // The option rendered before; keep what is shown.
          }
        }
      }, 150);
    });
  }

  private hitFor(params: echarts.ECElementEvent): Hit {
    const { seriesIndex = 0, dataIndex } = params;
    const dataType = typeof params.dataType === "string" ? params.dataType : undefined;
    const data: unknown = params.data;
    let label: string | undefined;
    if (dataType === "edge" && isObject(data)) {
      label = `${String(data.source)} → ${String(data.target)}`;
    } else if (typeof params.name === "string" && params.name.trim()) {
      label = params.name.trim();
    }
    label ??= valueText(params.value) ?? `Item ${dataIndex + 1}`;
    const base = isObject(this.option?.baseOption) ? this.option.baseOption : this.option;
    const seriesCount = asArray(base?.series).length;
    const rawName = params.seriesName;
    const name =
      typeof rawName === "string" && rawName && !rawName.includes("\u0000")
        ? rawName
        : `Series ${seriesIndex + 1}`;
    return {
      key: itemKey(seriesIndex, dataIndex, dataType),
      node: { id: seriesCount > 1 ? `${name}/${label}` : label, label },
    };
  }

  /** Makes the items ECharts shows as selected match the selection. */
  private syncSelection(): void {
    const chart = this.chart;
    if (!chart) {
      return;
    }
    const shown = new Set<string>();
    const stale: { seriesIndex: number; dataIndex: number; dataType?: string }[] = [];
    for (const { seriesIndex, dataType, dataIndex } of this.shownSelected) {
      for (const index of dataIndex) {
        const key = itemKey(seriesIndex, index, dataType);
        shown.add(key);
        if (!this.selectedKeys.has(key)) {
          stale.push({ seriesIndex, dataIndex: index, ...(dataType ? { dataType } : {}) });
        }
      }
    }
    for (const item of stale) {
      chart.dispatchAction({ type: "unselect", ...item });
    }
    for (const key of this.selectedKeys) {
      if (!shown.has(key)) {
        chart.dispatchAction({ type: "select", ...parseItemKey(key) });
      }
    }
  }
}
