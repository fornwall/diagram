// Renders Apache ECharts options, given as JSON, adapted to the panel size and VS Code theme.

import type * as ECharts from "echarts";
import { errorMessage } from "../protocol";
import type { ThemeColors } from "./colors";
import { keepUserState, layoutOption } from "./echartsLayout";
import {
  asArray,
  baseOption,
  isObject,
  type JsonObject,
  parseOption,
  seriesTypes,
} from "./echartsOption";
import { buildEChartsTheme } from "./echartsTheme";
import { type Hit, type Renderer, type RendererHost, withModifier } from "./renderer";
import { readThemeColors } from "./vscodeTheme";

/** A data item, or a node or edge of a graph, as ECharts' select actions refer to it. */
interface ItemRef {
  seriesIndex: number;
  dataType?: string | undefined;
  dataIndex: number;
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

const itemKey = ({ seriesIndex, dataType, dataIndex }: ItemRef) =>
  `${seriesIndex}:${dataType ?? ""}:${dataIndex}`;

function parseItemKey(key: string): ItemRef {
  const [series, dataType, data] = key.split(":");
  return { seriesIndex: Number(series), dataType: dataType || undefined, dataIndex: Number(data) };
}

export class EChartsRenderer implements Renderer {
  readonly noun = "chart";
  readonly itemNoun = "chart item";
  readonly sourceName = "ECharts option (JSON)";

  private readonly container: HTMLElement;
  /** The library, loaded on the first chart. */
  private echarts: typeof ECharts | undefined;
  private chart: ECharts.ECharts | undefined;
  /** The current VS Code theme, read again after it changed. */
  private theme: { colors: ThemeColors; echarts: object } | undefined;
  private option: JsonObject | undefined;
  private title = "";
  /** The laid-out option as last set, to skip relayouts that change nothing. */
  private laidOut = "";
  private selectedKeys: ReadonlySet<string> = new Set();
  /** What ECharts shows as selected, as last reported by its selectchanged event. */
  private shownSelected: ECharts.SelectChangedEvent["selected"] = [];
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
    new ResizeObserver(() => this.scheduleRelayout()).observe(this.container);
  }

  async render(source: string, title: string): Promise<string> {
    const option = parseOption(source);
    this.echarts ??= await import("echarts");
    const previous = this.chart && this.option && { option: this.option, title: this.title };
    this.canvas.classList.add("chart-mode");
    this.container.hidden = false;
    this.option = option;
    this.title = title;
    this.selectedKeys = new Set();
    try {
      this.apply(true);
    } catch (error) {
      // A failed setOption can leave the instance broken: start over, with the previous chart.
      this.disposeChart();
      if (previous) {
        this.option = previous.option;
        this.title = previous.title;
        try {
          this.apply(false);
        } catch {
          this.disposeChart();
        }
      }
      throw new Error(`ECharts could not render this option: ${errorMessage(error)}`);
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
    this.selectedKeys = keys;
    // ECharts toggles the selection of clicked items itself, after our click handlers ran.
    queueMicrotask(() => this.syncSelection());
  }

  async themeChanged(): Promise<void> {
    this.theme = undefined;
    this.relayout();
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

  private createChart(echarts: typeof ECharts, theme: object): ECharts.ECharts {
    const chart = echarts.init(this.container, theme);
    chart.on("click", (params: ECharts.ECElementEvent) => {
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
      this.shownSelected = (event as ECharts.SelectChangedEvent).selected;
    });
    return chart;
  }

  private disposeChart(): void {
    cancelAnimationFrame(this.resizeFrame);
    clearTimeout(this.relayoutTimer);
    this.chart?.dispose();
    this.chart = undefined;
    this.shownSelected = [];
    this.laidOut = "";
  }

  /**
   * Sets the option, laid out for the current size and theme. A relayout of the shown chart keeps
   * what the user changed in it, and is skipped when the layout stays the same.
   */
  private apply(animate: boolean, relayout = false): void {
    const echarts = this.echarts;
    if (!echarts) {
      return;
    }
    if (!this.theme) {
      const colors = readThemeColors();
      this.theme = { colors, echarts: buildEChartsTheme(colors) };
      this.chart?.setTheme(this.theme.echarts);
    }
    const option = layoutOption(this.option ?? {}, {
      width: this.container.clientWidth,
      height: this.container.clientHeight,
      title: this.title,
      colors: this.theme.colors,
      reducedMotion: this.reducedMotion.matches,
    });
    const laidOut = JSON.stringify(option);
    if (relayout && laidOut === this.laidOut) {
      return;
    }
    if (!animate) {
      option.animation = false;
    }
    this.chart ??= this.createChart(echarts, this.theme.echarts);
    if (relayout) {
      keepUserState(option, this.chart.getOption() as JsonObject);
    }
    this.chart.setOption(option, { notMerge: true });
    this.laidOut = laidOut;
    this.shownSelected = [];
    this.syncSelection();
  }

  /** Lays out the shown chart again, keeping what is shown if that fails. */
  private relayout(): void {
    if (this.chart && this.option) {
      try {
        this.apply(false, true);
      } catch (error) {
        console.error(error);
      }
    }
  }

  private scheduleRelayout(): void {
    // Without a size, e.g. while VS Code hides the panel, there is nothing to lay out.
    if (!this.chart || this.container.clientWidth === 0) {
      return;
    }
    cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = requestAnimationFrame(() => {
      this.chart?.resize();
      // Layout decisions (legend position, label rotation, …) follow once resizing settles.
      clearTimeout(this.relayoutTimer);
      this.relayoutTimer = setTimeout(() => this.relayout(), 150);
    });
  }

  private hitFor(params: ECharts.ECElementEvent): Hit {
    const { seriesIndex = 0, dataIndex, dataType } = params;
    const data: unknown = params.data;
    let label: string | undefined;
    if (dataType === "edge" && isObject(data)) {
      label = `${String(data.source)} → ${String(data.target)}`;
    } else if (typeof params.name === "string" && params.name.trim()) {
      label = params.name.trim();
    }
    label ??= valueText(params.value) ?? `Item ${dataIndex + 1}`;
    const seriesCount = asArray(baseOption(this.option ?? {}).series).length;
    const rawName = params.seriesName;
    // ECharts names unnamed series "series\0<index>".
    const name =
      typeof rawName === "string" && rawName && !rawName.includes("\u0000")
        ? rawName
        : `Series ${seriesIndex + 1}`;
    return {
      key: itemKey({ seriesIndex, dataType, dataIndex }),
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
    const stale: ItemRef[] = [];
    for (const { dataIndex, ...series } of this.shownSelected) {
      for (const index of dataIndex) {
        const item = { ...series, dataIndex: index };
        const key = itemKey(item);
        shown.add(key);
        if (!this.selectedKeys.has(key)) {
          stale.push(item);
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
