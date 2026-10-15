// Small multiples: a chart per value of a facet column, as the panels of one ECharts option.

import { columnName, findColumn, findColumns } from "./chartColumns";
import { timeOrder } from "./chartDates";
import { facetBoxes } from "./chartFacetLayout";
import { inLabelOrder, roundStep, stepsOf } from "./chartRows";
import { type ChartSpec, FACET_TYPES } from "./chartSpec";
import type { Chart } from "./charts";
import type { Cell, DataTable } from "./data";
import { asArray, errorMessage, isPlainObject } from "./protocol";
import { formatCount, plural, quoteAll } from "./text";

type Option = Record<string, unknown>;
const MAX_FACETS = 12;
/** More rows of panels would leave each too short to read in a panel of usual height. */
const MAX_ROWS = 4;

/** Exclude the facet column from inference, unless it is also a label or value column. */
function facetTable(spec: ChartSpec, table: DataTable, index: number): DataTable {
  const labels = findColumns(table, [spec.labelColumn ?? []].flat(), "labelColumn");
  const values = findColumns(table, spec.valueColumns ?? [], "valueColumns");
  if (labels.includes(index) || values.includes(index)) return table;
  return {
    ...table,
    columns: table.columns.filter((_, i) => i !== index),
    rows: table.rows.map((row) => row.filter((_, i) => i !== index)),
  };
}

interface Panel extends Chart {
  key: string;
  name: string;
}

/** Child charts are unmerged; the caller applies manual options once to this combined chart. */
export function buildFacetedChart(
  spec: ChartSpec,
  table: DataTable,
  buildSingle: (spec: ChartSpec, table: DataTable, allFacets: DataTable) => Chart,
): Chart {
  if (!FACET_TYPES.includes(spec.type)) {
    throw new Error(
      `Faceting is not supported for ${spec.type} charts. Use one of ${quoteAll(FACET_TYPES)}, or leave out "facetColumn".`,
    );
  }
  const index = findColumn(table, spec.facetColumn ?? "", "facet");
  const facetName = columnName(table, index);
  const groups = Map.groupBy(table.rows.keys(), (row): Cell => table.rows[row]?.[index] ?? null);
  if (groups.size > MAX_FACETS) {
    throw new Error(
      `The facet column ${JSON.stringify(facetName)} has ${formatCount(groups.size)} values, more than the ` +
        `${MAX_FACETS} panels a chart can have. Keep fewer of them with "filters", or choose a ` +
        "column with fewer values.",
    );
  }
  const allFacets = facetTable(spec, table, index);
  const { facetColumn: _column, facetColumns: _columns, facetScales: _scales, ...childSpec } = spec;
  // A typed key keeps missing values, literal labels and numbers distinct, including on refresh.
  // Panels of numbers, dates or weekdays follow their order rather than that of the rows, as the
  // categories of an axis do, and the panel of rows without a value comes last.
  const facets = inLabelOrder(
    [...groups].filter(([value]) => value !== null),
    ([value]) => String(value),
  );
  const missing = groups.get(null);
  if (missing !== undefined) facets.push([null, missing]);
  const labels = facets.map(([value]) => (value === null ? "(missing)" : String(value)));
  const ambiguous = new Set(labels).size !== labels.length;
  const panels = facets.map(([value, indices], i): Panel => {
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
      throw new Error(`Facet ${JSON.stringify(name)}: ${errorMessage(error)}`);
    }
    return { key: JSON.stringify(value), name, ...chart };
  });
  // A facet with nothing to draw is an empty panel beside others, but alone they chart nothing.
  const [{ empty } = {}] = panels;
  if (empty !== undefined && panels.every((panel) => panel.empty !== undefined)) {
    throw new Error(empty);
  }
  if (spec.facetScales !== "independent") {
    // Categories in an order of their own keep it, unless "sort" orders the rows by value.
    const ordered = spec.sort === undefined;
    shareAxes(panels, "xAxis", 0, ordered);
    shareAxes(panels, "yAxis", 1, ordered);
  }
  const wanted = spec.facetColumns ?? Math.min(2, Math.ceil(Math.sqrt(panels.length)));
  const columns = Math.min(panels.length, Math.max(wanted, Math.ceil(panels.length / MAX_ROWS)));
  const boxes = facetBoxes(panels.length, columns);
  const grids: Option[] = [];
  const titles: Option[] = [];
  const xAxes: Option[] = [];
  const yAxes: Option[] = [];
  const series: Option[] = [];
  const seriesIds = new Set<string>();
  panels.forEach((panel, i) => {
    const id = `facet:${panel.key}`;
    const box = boxes[i];
    // The webview lays these boxes out again in pixels, for the size of its panel.
    grids.push({ id, ...box?.grid, outerBoundsMode: "same" });
    titles.push({
      id,
      text: `${facetName} = ${panel.name}`,
      ...box?.title,
      // The webview truncates the title to the width of the panel's grid, of the same id.
      textStyle: { fontSize: 13 },
    });
    xAxes.push({ ...asArray(panel.option.xAxis)[0], id, gridIndex: i });
    yAxes.push({ ...asArray(panel.option.yAxis)[0], id, gridIndex: i });
    asArray(panel.option.series).forEach((each, seriesIndex) => {
      // ECharts colors series and lists them in the legend by name, so a measure keeps its name,
      // color and legend entry in every panel. Selection tells the panels apart by series id.
      const name = String(each.name ?? `Series ${seriesIndex + 1}`);
      const panelName = `${panel.name} · ${name}`;
      let seriesId = panelName;
      let suffix = 2;
      while (seriesIds.has(seriesId)) seriesId = `${panelName} (${suffix++})`;
      seriesIds.add(seriesId);
      series.push({
        ...each,
        id: seriesId,
        name,
        xAxisIndex: i,
        yAxisIndex: i,
        ...(each.stack === undefined ? {} : { stack: `${id}:${String(each.stack)}` }),
      });
    });
  });
  const layout =
    spec.facetColumns !== undefined && columns > spec.facetColumns
      ? ` in ${columns} columns, as "facetColumns": ${spec.facetColumns} would leave them too short to read,`
      : "";
  // What every panel reads alike is said once, and what each panel's rows gave by panel.
  const noted = panels.filter((panel) => panel.summary !== "");
  const alike = noted.length === panels.length && new Set(noted.map((p) => p.summary)).size === 1;
  const byPanel =
    alike && panels.length > 1
      ? ` Each panel: ${noted[0]?.summary}.`
      : noted.map((panel) => ` ${JSON.stringify(panel.name)}: ${panel.summary}.`).join("");
  return {
    option: {
      title: titles,
      grid: grids,
      xAxis: xAxes,
      yAxis: yAxes,
      series,
      // A single measure is named by its axis, and an entry for it would toggle every panel.
      legend:
        new Set(series.map(({ name }) => name)).size > 1
          ? { type: "scroll", bottom: 0, left: "center" }
          : { show: false },
      // Panels of one type have the same tooltip, such as a histogram's; the webview adds others.
      ...(panels[0]?.option.tooltip === undefined ? {} : { tooltip: panels[0].option.tooltip }),
    },
    summary:
      `Faceted by ${JSON.stringify(facetName)} into ${plural(panels.length, "panel")}${layout} ` +
      `with ${spec.facetScales === "independent" ? "independent" : "shared"} scales. ` +
      `${panels[0]?.shared ?? ""}.${byPanel}`,
  };
}

/** Align category occurrences as well as numeric ranges; equal labels need not be aggregated. */
function shareAxes(
  panels: Panel[],
  key: "xAxis" | "yAxis",
  dimension: number,
  ordered: boolean,
): void {
  const axes = panels.map((panel) => asArray(panel.option[key])[0] ?? {});
  // Negative values in one panel extend every panel's range, so all keep this axis at the edge.
  if (axes.some((axis) => axis.axisLine !== undefined)) {
    for (const axis of axes) axis.axisLine = { onZero: false };
  }
  if (axes.every((axis) => axis.type === "category")) {
    const domain = new Map<string, unknown>();
    const panelKeys = axes.map((axis) => {
      const seen = new Map<string, number>();
      return (Array.isArray(axis.data) ? axis.data : []).map((category) => {
        const label = JSON.stringify(category);
        const occurrence = seen.get(label) ?? 0;
        seen.set(label, occurrence + 1);
        const key = `${occurrence} ${label}`;
        domain.set(key, category);
        return key;
      });
    });
    // Panels list numbers, dates and weekdays in the order of their own rows, and missing ones
    // come after the categories of earlier panels.
    const entries = ordered
      ? inLabelOrder([...domain], ([, category]) => String(category))
      : [...domain];
    const keys = entries.map(([key]) => key);
    // ECharts reads the categories without changing them, so the panels share one array.
    const categories = entries.map(([, category]) => category);
    panels.forEach((panel, i) => {
      const axis = axes[i];
      if (!axis) return;
      axis.data = categories;
      const indices = new Map((panelKeys[i] ?? []).map((key, index) => [key, index]));
      for (const series of asArray(panel.option.series)) {
        const data = Array.isArray(series.data) ? series.data : [];
        series.data = keys.map((key) => {
          const index = indices.get(key);
          return index === undefined ? null : (data[index] ?? null);
        });
      }
    });
    return;
  }
  // The columns, and with them the axis types, are read once for every facet.
  const type = axes[0]?.type;
  let minimum = Infinity;
  let maximum = -Infinity;
  let minimumTime: unknown;
  let maximumTime: unknown;
  const include = (value: unknown) => {
    const number =
      typeof value === "number"
        ? value
        : type === "time" && typeof value === "string"
          ? timeOrder(value)
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
    const stacks = new Map<unknown, [number, number][]>();
    for (const series of asArray(panel.option.series)) {
      if (!Array.isArray(series.data)) continue;
      let stack: [number, number][] | undefined;
      if (series.stack !== undefined && type !== "time") {
        stack = stacks.get(series.stack);
        if (stack === undefined) {
          stack = [];
          stacks.set(series.stack, stack);
        }
      }
      series.data.forEach((item, index) => {
        const point = isPlainObject(item) ? item.value : item;
        const value = Array.isArray(point) ? point[dimension] : point;
        include(value);
        if (stack !== undefined && typeof value === "number") {
          // Generated series share row order, including separate observations at the same time.
          const totals = stack[index] ?? [0, 0];
          stack[index] = totals;
          const sign = value < 0 ? 0 : 1;
          totals[sign] += value;
          if (!Number.isFinite(totals[sign])) {
            throw new Error(
              "The stacked facet total exceeds the numeric range. Rescale the values before charting them.",
            );
          }
        }
      });
    }
    for (const stack of stacks.values()) {
      // Missing observations leave holes in the stack's array.
      for (const totals of stack) totals?.forEach(include);
    }
  }
  if (!Number.isFinite(minimum)) return;
  if (type === "time") {
    // Unzoned dates belong to the viewer's timezone, which may differ from the extension host's.
    // Keep their text so ECharts interprets bounds and observations in the same timezone.
    for (const axis of axes) Object.assign(axis, { min: minimumTime, max: maximumTime });
    return;
  }
  if (axes.some((axis) => axis.scale !== true)) {
    minimum = Math.min(0, minimum);
    maximum = Math.max(0, maximum);
  }
  // ECharts labels the bounds as ticks of their own, as 1,234 just above 1,200, so round them out
  // to an interval that splits the range into 3 to 7 parts, as ECharts' own ticks do, and give
  // every panel those ticks.
  let bounds: Option = { min: minimum, max: maximum };
  if (maximum > minimum) {
    const { minInterval } = axes[0] ?? {};
    const interval = Math.max(
      roundStep((maximum - minimum) / 7),
      typeof minInterval === "number" ? minInterval : 0,
    );
    const steps = stepsOf(interval);
    const min = steps.at(Math.floor(steps.count(minimum)));
    const max = steps.at(Math.ceil(steps.count(maximum)));
    if (Number.isFinite(min) && Number.isFinite(max)) bounds = { min, max, interval };
  }
  for (const axis of axes) Object.assign(axis, bounds);
}
