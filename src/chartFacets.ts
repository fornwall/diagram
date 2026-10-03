// Compose generated Cartesian charts into independently selectable small multiples.
import type { ChartSpec } from "./chartSpec";
import type { Chart } from "./charts";
import { type Cell, type DataTable, findColumn } from "./data";
import { isPlainObject } from "./protocol";

type Option = Record<string, unknown>;
const FACET_TYPES = new Set([
  "bar",
  "horizontalBar",
  "stackedBar",
  "line",
  "area",
  "stackedArea",
  "scatter",
  "histogram",
]);
const MAX_FACETS = 12;

const objects = (value: unknown): Option[] =>
  Array.isArray(value) ? value.filter(isPlainObject) : isPlainObject(value) ? [value] : [];

/** Exclude the grouping field from inference, unless explicitly requested as a chart field. */
export function facetTable(spec: ChartSpec, table: DataTable): DataTable {
  const index = findColumn(table, spec.facetColumn ?? "", "facet");
  const explicit = [spec.labelColumn ?? []].flat().concat(spec.valueColumns ?? []);
  const keep = explicit.some((name) => findColumn(table, name, "chart") === index);
  if (keep) return table;
  return {
    ...table,
    columns: table.columns.filter((_, i) => i !== index),
    rows: table.rows.map((row) => row.filter((_, i) => i !== index)),
  };
}

interface Panel {
  key: string;
  name: string;
  option: Option;
  summary: string;
}

/** Child charts are unmerged; the caller applies manual options once to this combined chart. */
export function buildFacetedChart(
  spec: ChartSpec,
  table: DataTable,
  buildSingle: (spec: ChartSpec, table: DataTable, allFacets: DataTable) => Chart,
): Chart {
  if (!FACET_TYPES.has(spec.type)) {
    throw new Error(
      `Faceting is not supported for ${spec.type}. Use bar, horizontalBar, stackedBar, line, area, stackedArea, scatter or histogram, or clear facetColumn.`,
    );
  }
  const index = findColumn(table, spec.facetColumn ?? "", "facet");
  const groups = new Map<Cell, number[]>();
  table.rows.forEach((row, rowIndex) => {
    const value = row[index] ?? null;
    const indices = groups.get(value) ?? [];
    indices.push(rowIndex);
    groups.set(value, indices);
    if (groups.size > MAX_FACETS) {
      throw new Error(
        `The facet column has more than ${MAX_FACETS} groups; at most ${MAX_FACETS} panels are supported. Filter the data or choose a column with fewer groups.`,
      );
    }
  });
  if (!groups.size) throw new Error("No rows remain to facet. Adjust the filters or data source.");
  const allFacets = facetTable(spec, table);
  const { facetColumn: _column, facetColumns: _columns, facetScales: _scales, ...childSpec } = spec;
  // A typed key keeps missing values, literal labels and numbers distinct, including on refresh.
  const labels = [...groups.keys()].map((value) => (value === null ? "(missing)" : String(value)));
  const ambiguous = new Set(labels).size !== labels.length;
  const panels = [...groups].map(([value, indices], i): Panel => {
    const label = labels[i] ?? "";
    // Quoting every string when labels collide is injective even for literal "(missing)" and
    // "(missing value)" strings alongside null, or string "1" alongside numeric 1.
    const name = ambiguous && typeof value === "string" ? JSON.stringify(value) : label;
    let chart: Chart;
    try {
      chart = buildSingle(
        childSpec,
        { ...allFacets, rows: indices.map((i) => allFacets.rows[i] ?? []) },
        allFacets,
      );
    } catch (error) {
      throw new Error(
        `Facet ${JSON.stringify(name)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { key: JSON.stringify(value), name, ...chart };
  });
  if (spec.facetScales !== "independent") {
    shareAxes(panels, "xAxis", 0);
    shareAxes(panels, "yAxis", 1);
  }
  const columns = Math.min(
    panels.length,
    spec.facetColumns ?? Math.min(2, Math.ceil(Math.sqrt(panels.length))),
  );
  const rows = Math.ceil(panels.length / columns);
  const grids: Option[] = [];
  const titles: Option[] = [];
  const xAxes: Option[] = [];
  const yAxes: Option[] = [];
  const series: Option[] = [];
  const seriesNames = new Set<string>();
  panels.forEach((panel, i) => {
    const id = `facet:${panel.key}`;
    const left = 2 + ((i % columns) * 96) / columns;
    const top = 3 + (Math.floor(i / columns) * 87) / rows;
    const width = 96 / columns - 4;
    grids.push({
      id,
      left: `${left}%`,
      top: `${top + Math.min(7, 20 / rows)}%`,
      width: `${width}%`,
      height: `${87 / rows - Math.min(7, 20 / rows) - 4}%`,
      outerBoundsMode: "same",
      outerBoundsContain: "all",
    });
    titles.push({
      id,
      text: `${table.columns[index]?.name} = ${panel.name}`,
      left: `${left}%`,
      top: `${top}%`,
      textStyle: { fontSize: 13, overflow: "truncate", width: 180 },
    });
    xAxes.push({ ...objects(panel.option.xAxis)[0], id, gridIndex: i });
    yAxes.push({ ...objects(panel.option.yAxis)[0], id, gridIndex: i });
    objects(panel.option.series).forEach((each, seriesIndex) => {
      const name = String(each.name ?? `Series ${seriesIndex + 1}`);
      const displayName = `${panel.name} · ${name}`;
      let uniqueName = displayName;
      let suffix = 2;
      while (seriesNames.has(uniqueName)) uniqueName = `${displayName} (${suffix++})`;
      seriesNames.add(uniqueName);
      series.push({
        ...each,
        id: `${id}:${JSON.stringify(name)}`,
        name: uniqueName,
        xAxisIndex: i,
        yAxisIndex: i,
        ...(each.stack === undefined ? {} : { stack: `${id}:${String(each.stack)}` }),
      });
    });
  });
  return {
    option: {
      title: titles,
      grid: grids,
      xAxis: xAxes,
      yAxis: yAxes,
      series,
      legend: { type: "scroll", bottom: 0, left: "center" },
      tooltip: { trigger: spec.type === "scatter" ? "item" : "axis", confine: true },
    },
    summary: `Faceted by ${JSON.stringify(table.columns[index]?.name)} into ${panels.length} panels with ${spec.facetScales === "independent" ? "independent" : "shared"} scales. ${panels.map((panel) => `${JSON.stringify(panel.name)}: ${panel.summary}`).join(" ")}`,
  };
}

function values(series: Option): unknown[] {
  return Array.isArray(series.data) ? series.data : [];
}

function valueAt(item: unknown, dimension: number): unknown {
  const value = isPlainObject(item) ? item.value : item;
  return Array.isArray(value) ? value[dimension] : value;
}

/** Align category occurrences as well as numeric ranges; equal labels need not be aggregated. */
function shareAxes(panels: Panel[], key: "xAxis" | "yAxis", dimension: number): void {
  const axes = panels.map((panel) => objects(panel.option[key])[0] ?? {});
  if (axes.every((axis) => axis.type === "category")) {
    const domain = new Map<string, unknown>();
    const panelKeys = axes.map((axis) => {
      const seen = new Map<string, number>();
      return (Array.isArray(axis.data) ? axis.data : []).map((category) => {
        const label = JSON.stringify(category);
        const occurrence = seen.get(label) ?? 0;
        seen.set(label, occurrence + 1);
        const key = JSON.stringify([label, occurrence]);
        domain.set(key, category);
        return key;
      });
    });
    panels.forEach((panel, i) => {
      const axis = axes[i];
      if (!axis) return;
      axis.data = [...domain.values()];
      const indices = new Map((panelKeys[i] ?? []).map((key, index) => [key, index]));
      for (const series of objects(panel.option.series)) {
        const data = values(series);
        series.data = [...domain.keys()].map((key) => {
          const index = indices.get(key);
          return index === undefined ? null : (data[index] ?? null);
        });
      }
    });
    return;
  }
  if (!axes.every((axis) => axis.type === axes[0]?.type)) {
    throw new Error(
      "Facets inferred different axis types. Specify consistent labelColumn and valueColumns, or use independent facetScales.",
    );
  }
  let minimum = Infinity;
  let maximum = -Infinity;
  let minimumTime: unknown;
  let maximumTime: unknown;
  const include = (value: unknown) => {
    const number =
      typeof value === "number"
        ? value
        : axes[0]?.type === "time" && typeof value === "string"
          ? Date.parse(value)
          : NaN;
    if (Number.isFinite(number)) {
      if (number < minimum) {
        minimum = number;
        minimumTime = value;
      }
      if (number > maximum) {
        maximum = number;
        maximumTime = value;
      }
    }
  };
  for (const panel of panels) {
    const stacks = new Map<string, [number, number]>();
    for (const series of objects(panel.option.series)) {
      values(series).forEach((item, index) => {
        const value = valueAt(item, dimension);
        include(value);
        if (series.stack !== undefined && axes[0]?.type !== "time" && typeof value === "number") {
          // Generated series share row order, including separate observations at the same time.
          const key = JSON.stringify([series.stack, index]);
          const totals = stacks.get(key) ?? [0, 0];
          const sign = value < 0 ? 0 : 1;
          totals[sign] += value;
          if (!Number.isFinite(totals[sign]))
            throw new Error(
              "The stacked facet total exceeds the numeric range. Rescale the values before charting them.",
            );
          stacks.set(key, totals);
        }
      });
    }
    for (const totals of stacks.values()) totals.forEach(include);
  }
  if (!Number.isFinite(minimum)) return;
  if (axes[0]?.type !== "time" && axes.some((axis) => axis.scale !== true)) {
    minimum = Math.min(0, minimum);
    maximum = Math.max(0, maximum);
  }
  for (const axis of axes) {
    // Unzoned dates belong to the viewer's timezone, which may differ from the extension host's.
    // Keep their text so ECharts interprets bounds and observations in the same timezone.
    axis.min = axis.type === "time" ? minimumTime : minimum;
    axis.max = axis.type === "time" ? maximumTime : maximum;
  }
}
