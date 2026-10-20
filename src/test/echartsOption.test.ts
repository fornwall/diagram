import * as assert from "node:assert";
import * as fullECharts from "echarts";
import { ComponentModel } from "echarts/core";
import { init } from "../webview/echartsLibrary";
import {
  COMPONENT_TYPES,
  GRAPHIC_TYPES,
  type JsonObject,
  optionWarnings,
  parseOption,
  SERIES_TYPES,
  seriesTypes,
  TOP_LEVEL_KEYS,
} from "../webview/echartsOption";
import { thrown } from "./thrown";

// ECharts' registry of series and component classes, which its typings leave out.
const registry = ComponentModel as unknown as {
  getClassesByMainType(main: string): { type: string }[];
};

const BAR = '"xAxis": {"type": "category", "data": ["A"]}, "yAxis": {}';

const errorOf = (source: string) => thrown(parseOption, source);

/** Whether ECharts throws on the option, as it does on what it cannot draw, without its logs. */
function drawingThrows(option: Record<string, unknown>): boolean {
  const { error } = console;
  console.error = () => {};
  try {
    drawn(option);
    return false;
  } catch {
    return true;
  } finally {
    console.error = error;
  }
}

/** Draws the option with the ECharts of the panel, which throws on what it cannot draw. */
function drawn(option: Record<string, unknown>): void {
  const chart = init(null, undefined, { renderer: "svg", ssr: true, width: 400, height: 300 });
  try {
    chart.setOption(option);
  } finally {
    chart.dispose();
  }
}

suite("echartsOption", () => {
  test("parses a valid option", () => {
    const option = parseOption(`{${BAR}, "series": [{"type": "bar", "data": [1]}]}`);
    assert.strictEqual(seriesTypes(option), "bar");
  });

  test("parses a JavaScript object literal, as a custom series needs", () => {
    const option = parseOption(
      `{${BAR}, "series": [{"type": "custom", "data": [[0, 1]], "renderItem": (params, api) => ` +
        '({type: "circle", shape: {cx: api.coord([api.value(0), api.value(1)])[0], cy: 10, r: 6}, ' +
        "style: api.style()})}]}",
    );
    assert.strictEqual(seriesTypes(option), "custom");
    const [series] = option.series as JsonObject[];
    assert.strictEqual(typeof series?.renderItem, "function");
  });

  test("refuses an option that is not an object", () => {
    const option = '{"series":[{"type":"bar","data":[1]}]}';
    assert.match(errorOf(`[${option}]`), /must be an object.*not an array/);
    assert.match(
      errorOf("() => ({})"),
      /must be an object such as \{"series": \[\.\.\.\]}.*not a function/,
    );
    assert.match(errorOf("42"), /must be an object.*JavaScript object literal, not a number/);
  });

  test("checks the series of a timeline's base option", () => {
    const option = parseOption(
      '{"baseOption": {"timeline": {}, "series": {"type": "pie"}}, "options": [{"series": [{"type": "funnel"}]}]}',
    );
    assert.strictEqual(seriesTypes(option), "pie, funnel");
    assert.match(errorOf('{"baseOption": {}, "series": [{"type": "pie"}]}'), /no "series"/);
  });

  test("checks the series where timeline steps and media queries have them", () => {
    const timeline = '"timeline": {"data": ["2025", "2026"]}';
    const pie = '{"type": "pie", "data": [1]}';
    // The series may be in the steps or queries alone, and ECharts draws them.
    for (const source of [
      `{"baseOption": {${timeline}}, "options": [{"series": [${pie}]}, {"series": [${pie}]}]}`,
      `{${timeline}, "options": [{"series": ${pie}}]}`,
      `{"media": [{"option": {"series": [${pie}]}}]}`,
      `{"baseOption": {}, "media": [{"query": {"maxWidth": 500}, "option": {"series": [${pie}]}}]}`,
    ]) {
      assert.strictEqual(seriesTypes(parseOption(source)), "pie", source);
    }
    // A step patches the series of the base option, matched by id, by name, then in order.
    const base =
      '{"type": "pie", "name": "A"}, {"type": "custom", "coordinateSystem": "none", "name": "B"}';
    assert.match(
      errorOf(
        `{"baseOption": {${timeline}, "series": [${base}]}, "options": [{"series": [{"name": "B"}, {"type": "bar"}]}]}`,
      ),
      /^options\[0\]\.series\[1\] \(type "bar"\) is drawn on the cartesian2d coordinate system/,
    );
    assert.match(
      errorOf(
        `{"baseOption": {${timeline}, "series": [${base}]}, "options": [{"series": [{"data": [1]}, {"name": "A"}]}]}`,
      ),
      /^options\[0\]\.series\[0\] is a "custom" series/,
    );
    assert.match(
      errorOf(`{${timeline}, "options": [{"series": [{"data": [1]}]}]}`),
      /^options\[0\]\.series\[0\] has no "type"/,
    );
    // One with an id of no series of the base option is another series, as ECharts adds it, and
    // a name already matched leads on to the next free place.
    const patched = (patch: string) =>
      `{"baseOption": {${timeline}, "series": [{"type": "pie", "id": "1", "name": "A"}, ${pie}]}, "options": [{"series": [${patch}]}]}`;
    assert.match(errorOf(patched('{"id": "x", "data": [1]}')), /^options\[0\]\.series\[0\] has no/);
    assert.strictEqual(seriesTypes(parseOption(patched('{"id": 1, "data": [2]}, 5'))), "pie");
    assert.match(
      errorOf(patched('{"name": "A"}, {"name": "A"}, {"name": "A"}')),
      /^options\[0\]\.series\[2\] has no "type"/,
    );
    // ECharts merges each step into what the steps before it showed.
    const steps = `"options": [{"series": [${pie}]}, {"series": [{"data": [2]}]}]`;
    assert.strictEqual(seriesTypes(parseOption(`{${timeline}, ${steps}}`)), "pie");
    assert.match(
      errorOf(`{${timeline}, "options": [{"series": [${pie}]}, {"series": [{"type": "line"}]}]}`),
      /^options\[1\]\.series\[0\] \(type "line"\) is drawn on the cartesian2d coordinate system/,
    );
    assert.match(
      errorOf(
        `{"media": [{"option": {}}, {"query": {}, "option": {"series": [{"type": "donut"}]}}]}`,
      ),
      /^media\[1\]\.option\.series\[0\] has the unknown type "donut"/,
    );
    // A media query merges into what each step shows.
    const narrow = (patch: string) => `"media": [{"option": {"series": [${patch}]}}]`;
    const option = parseOption(`{${timeline}, ${steps}, ${narrow('{"radius": "50%"}')}}`);
    assert.strictEqual(seriesTypes(option), "pie");
    assert.match(
      errorOf(`{${timeline}, ${steps}, ${narrow('{"type": "line"}')}}`),
      /^media\[0\]\.option\.series\[0\] \(type "line"\) is drawn on the cartesian2d coordinate system/,
    );
    // Without a timeline, ECharts ignores the steps, which is wrong only when nothing else draws.
    assert.match(
      errorOf(`{"options": [{"series": [${pie}]}]}`),
      /timeline steps in "options" but no "timeline"/,
    );
  });

  test("warns of timeline steps without a timeline, which ECharts ignores to draw the rest", () => {
    const option = parseOption(
      '{"series": [{"type": "pie", "data": [1]}], "options": [{"series": [{"type": "line"}]}]}',
    );
    assert.deepStrictEqual(optionWarnings(option), [
      'The ECharts option has timeline steps in "options" but no "timeline" to show them, so ' +
        'ECharts ignores them. To show them, add one, e.g. "timeline": {"data": ["2025", "2026"]}.',
    ]);
    const timeline = parseOption(
      '{"timeline": {}, "series": [{"type": "pie", "data": [1]}], "options": [{"series": [{"data": [2]}]}]}',
    );
    assert.deepStrictEqual(optionWarnings(timeline), []);
  });

  test("explains missing and unknown series types", () => {
    assert.match(errorOf('{"series": [{"data": [1]}]}'), /series\[0\] has no "type"/);
    assert.match(errorOf('{"series": [{"type": "donut"}]}'), /unknown type "donut".*"radius"/);
    assert.match(errorOf('{"series": [{"type": "themeriver"}]}'), /case-sensitive: "themeRiver"/);
    assert.match(errorOf('{"series": [1]}'), /series\[0\] must be an object.*not a number/);
  });

  test("accepts exactly the series types that the panel's ECharts has", () => {
    const registered = registry
      .getClassesByMainType("series")
      .map((series) => series.type.replace(/^series\./, ""))
      // Such as __base_bar__, which bar and pictorialBar extend.
      .filter((type) => !type.startsWith("__"));
    // Map is left out, as the panel has no map data.
    assert.deepStrictEqual([...SERIES_TYPES].sort(), registered.sort());
  });

  test("rejects series that the panel has no data for", () => {
    assert.match(errorOf('{"series": [{"type": "map"}]}'), /unsupported type "map".*map data/);
    assert.doesNotMatch(errorOf('{"series": [{}]}'), /\bmap\b/);
  });

  test("rejects a custom series without a renderItem function", () => {
    assert.match(
      errorOf(`{${BAR}, "series": [{"type": "custom", "data": [[0, 1]]}]}`),
      /series\[0\] is a "custom" series.*"renderItem" function.*JavaScript object literal/,
    );
    assert.match(
      errorOf(`{${BAR}, "series": [{"type": "custom", "renderItem": "(p, api) => ({})"}]}`),
      /without a "renderItem" function/,
    );
    // A custom series is drawn on a grid unless it says otherwise.
    assert.match(errorOf('{"series": [{"type": "custom"}]}'), /needs "xAxis" and "yAxis"/);
  });

  test("accepts a custom series drawn in pixels without axes", () => {
    const option = parseOption(
      '{series: [{type: "custom", coordinateSystem: null, data: [1], ' +
        'renderItem: () => ({type: "circle", shape: {cx: 20, cy: 20, r: 10}})}]}',
    );
    assert.strictEqual(seriesTypes(option), "custom");
  });

  test("requires the coordinate system of grid and radar series", () => {
    assert.match(errorOf('{"series": [{"type": "line"}]}'), /needs "xAxis" and "yAxis", e\.g\./);
    assert.match(
      errorOf('{"series": [{"type": "radar"}]}'),
      /radar coordinate system and needs "radar"/,
    );
    assert.match(
      errorOf('{"angleAxis": {}, "series": [{"type": "bar", "coordinateSystem": "polar"}]}'),
      /needs "polar", "angleAxis" and "radiusAxis"/,
    );
    assert.match(errorOf('{"series": [{"type": "parallel"}]}'), /needs "parallelAxis"/);
    assert.match(errorOf('{"series": [{"type": "themeRiver"}]}'), /needs "singleAxis"/);
    parseOption(
      '{"polar": {}, "angleAxis": {}, "radiusAxis": {}, "series": [{"type": "scatter", "coordinateSystem": "polar"}]}',
    );
    parseOption(
      `{${BAR}, "series": [{"type": "lines", "coordinateSystem": "cartesian2d", "data": []}]}`,
    );
  });

  test("rejects series that would draw nothing", () => {
    assert.match(errorOf('{"series": [{"type": "lines"}]}'), /drawn on a map by default/);
    assert.match(
      errorOf(`{${BAR}, "series": [{"type": "heatmap", "data": [[0, 0, 1]]}]}`),
      /needs a "visualMap"/,
    );
    const graph = (extra: string) =>
      `{"series": [{"type": "graph", "data": [{"name": "A"}, {"name": "B"}]${extra}}]}`;
    assert.match(errorOf(graph("")), /set "layout": "force" or "circular"/);
    parseOption(graph(', "layout": "force"'));
    parseOption('{"series": [{"type": "graph", "data": [{"name": "A", "x": 0, "y": 0}]}]}');
    for (const value of ["NaN", "Infinity", "-Infinity"]) {
      for (const axis of ["x", "y"]) {
        assert.match(
          errorOf(`{series: [{type: "graph", data: [{x: 0, y: 0, ${axis}: ${value}}]}]}`),
          /nodes need "x" and "y"/,
        );
      }
    }
  });

  test("explains empty or malformed coordinate components", () => {
    for (const xAxis of [null, [], false, "category", 0]) {
      assert.match(
        errorOf(JSON.stringify({ xAxis, yAxis: {}, series: [{ type: "bar", data: [1] }] })),
        /needs "xAxis" and "yAxis"/,
      );
    }
    for (const visualMap of [null, [], false]) {
      assert.match(
        errorOf(
          JSON.stringify({
            xAxis: {},
            yAxis: {},
            visualMap,
            series: [{ type: "heatmap", data: [[0, 0, 1]] }],
          }),
        ),
        /needs a "visualMap"/,
      );
    }
  });

  test("explains unknown coordinate systems, including inherited property names", () => {
    for (const coordinateSystem of ["cartesian", "constructor", "toString", "__proto__"]) {
      assert.match(
        errorOf(JSON.stringify({ series: [{ type: "scatter", coordinateSystem }] })),
        /unknown coordinate system/,
      );
    }
    parseOption(
      '{"series": [{"type": "graph", "coordinateSystem": "view", "layout": "circular"}]}',
    );
    parseOption('{"series": [{"type": "pie", "coordinateSystem": "none"}]}');
  });

  test("finds callbacks written as strings, which ECharts draws as text", () => {
    const formatter = errorOf(
      `{${BAR}, "series": [{"type": "bar", "label": {"formatter": "function (p) { return p.name; }"}}]}`,
    );
    assert.match(formatter, /^series\[0\]\.label\.formatter is JavaScript code in a string/);
    assert.match(formatter, /Write it as a function.*string template such as "\{b\}: \{c\}"/);
    assert.match(
      errorOf('{"series": [{"type": "pie", "symbolSize": "(v) => v[2]"}]}'),
      /symbolSize/,
    );
    // The function itself is what ECharts wants, so it is fine anywhere.
    parseOption(
      `{${BAR}, "series": [{"type": "bar", "data": [1], "label": {"formatter": (p) => p.name}}]}`,
    );
  });

  test("checks callbacks inside data objects while skipping primitive data points", () => {
    const option = {
      series: [
        {
          type: "pie",
          data: [
            null,
            1,
            "function (p) { return p; }",
            [
              2,
              {
                value: 3,
                label: { formatter: "p => p.value" },
              },
            ],
          ],
        },
      ],
    };
    assert.match(
      errorOf(JSON.stringify(option)),
      /^series\[0\]\.data\[3\]\[1\]\.label\.formatter is JavaScript code/,
    );
    parseOption('{"series": [{"type": "pie", "data": [null, 1, "p => p.value"]}]}');
  });

  test("accepts text that merely looks like code", () => {
    parseOption(
      `{"title": {"text": "function of time", "subtext": "Input => Output"}, ${BAR}, ` +
        '"series": [{"type": "bar", "name": "x => y", "data": [1], "label": {"formatter": "{b} => {c}"}}]}',
    );
  });

  test("treats dataset columns as data even when their names match callbacks", () => {
    const dataset = {
      source: [{ formatter: "x => x + 1", color: "function (x) { return x; }", value: 3 }],
    };
    for (const source of [dataset, [dataset]]) {
      const option = { dataset: source, series: [{ type: "pie" }] };
      parseOption(JSON.stringify(option));
      parseOption(JSON.stringify({ baseOption: option }));
      assert.match(
        errorOf(JSON.stringify({ ...option, tooltip: { formatter: "x => x" } })),
        /^tooltip\.formatter is JavaScript code/,
      );
    }
    assert.match(
      errorOf(`(() => {
        const source = [];
        source.push(source);
        return {dataset: {source}, series: [{type: "pie"}]};
      })()`),
      /^dataset\.source\[0\] refers back to an object/,
    );
  });

  test("rejects an option that contains itself, which no chart can be drawn from", () => {
    assert.match(
      errorOf(
        '(() => { const o = {series: [{type: "bar", data: [1]}], xAxis: {}, yAxis: {}}; ' +
          "o.self = o; return o; })()",
      ),
      /^self refers back to an object that contains it, and a chart cannot be drawn from a cycle/,
    );
    // The same value used in two places is not a cycle.
    const shared = parseOption(
      "(() => { const style = {width: 2}; return {xAxis: {}, yAxis: {}, series: [" +
        '{type: "line", data: [1], lineStyle: style}, ' +
        '{type: "line", data: [2], lineStyle: style}]}; })()',
    );
    assert.strictEqual(seriesTypes(shared), "line");
  });

  test("validates inherited properties that the layout copies", () => {
    assert.match(
      errorOf(
        '(() => { const parent = {series: [{type: "pie"}]}; ' +
          "const option = Object.create(parent); parent.self = option; return option; })()",
      ),
      /^self refers back to an object that contains it/,
    );
    assert.match(
      errorOf('{series: [{type: "pie", label: Object.create({formatter: "p => p.name"})}]}'),
      /^series\[0\]\.label\.formatter is JavaScript code in a string/,
    );
  });

  test("suggests the series type that a misspelled one likely means", () => {
    assert.match(
      errorOf('{"series": [{"type": "bars"}]}'),
      /unknown type "bars" \(did you mean "bar"\?\)/,
    );
    assert.match(errorOf('{"series": [{"type": "scater"}]}'), /\(did you mean "scatter"\?\)/);
    assert.match(errorOf('{"series": [{"type": "sanky"}]}'), /\(did you mean "sankey"\?\)/);
    assert.doesNotMatch(errorOf('{"series": [{"type": "waterfall"}]}'), /did you mean/);
  });

  test("names the kind that a component of a kind ECharts does not have likely means", () => {
    const option = (extra: string) =>
      `{${BAR}, "series": [{"type": "bar", "data": [1]}], ${extra}}`;
    const cases: [string, string][] = [
      [
        '"dataZoom": [{"type": "inside"}, {"type": "slide"}]',
        'dataZoom[1] has the unknown type "slide" (did you mean "slider"?). Valid types: inside, slider, select.',
      ],
      [
        '"visualMap": {"type": "continous"}',
        'visualMap has the unknown type "continous" (did you mean "continuous"?). Valid types: continuous, piecewise.',
      ],
      [
        '"legend": {"type": "scrollable"}',
        'legend has the unknown type "scrollable" (did you mean "scroll"?). Valid types: plain, scroll.',
      ],
      [
        '"singleAxis": {"type": "categorie"}',
        'singleAxis has the unknown type "categorie" (did you mean "category"?). Valid types: category, value, time, log.',
      ],
      [
        '"graphic": [{"type": "rectangle"}]',
        'graphic[0] has the unknown type "rectangle" (did you mean "rect"?). Valid types: group, image, text, rect, circle, ellipse, ring, sector, arc, polygon, polyline, line, bezierCurve.',
      ],
      [
        '"graphic": {"elements": [{"type": "group", "children": [{"type": "txt"}]}]}',
        'graphic.elements[0].children[0] has the unknown type "txt" (did you mean "text"?)',
      ],
      [
        '"timeline": {"data": [1]}, "options": [{"xAxis": {"type": "times"}}]',
        'options[0].xAxis has the unknown type "times" (did you mean "time"?)',
      ],
    ];
    for (const [extra, message] of cases) {
      assert.ok(errorOf(option(extra)).startsWith(message), extra);
      // ECharts throws on them, saying that it is "used but not imported" at best.
      assert.ok(drawingThrows(JSON.parse(option(extra))), extra);
    }
    // Every kind that the panel's ECharts has, and the graphic elements it draws.
    for (const [main, types] of Object.entries(COMPONENT_TYPES)) {
      const registered = registry.getClassesByMainType(main).map(({ type }) => type.split(".")[1]);
      assert.deepStrictEqual([...types].sort(), registered.filter(Boolean).sort(), main);
    }
    for (const type of GRAPHIC_TYPES) {
      drawn(
        parseOption(
          `{"graphic": {"elements": [{"type": "${type}"}]}, "series": [{"type": "pie"}]}`,
        ),
      );
    }
    assert.throws(() => drawn({ graphic: { elements: [{ type: "rectangle" }] } }), /graphic type/);
  });

  test("refuses references to components that the option lacks, which ECharts throws on", () => {
    const bar = '{"type": "bar", "data": [1]';
    const cases: [string, string][] = [
      [
        `{${BAR}, "series": [${bar}, "xAxisIndex": 2}]}`,
        'series[0].xAxisIndex is 2, but the option has only one "xAxis" (index 0): refer to one that exists, or add it.',
      ],
      [
        `{${BAR}, "series": [${bar}}, ${bar}, "yAxisId": "right"}]}`,
        'series[1].yAxisId is "right", but no "yAxis" has that id: refer to one that exists, or add it.',
      ],
      [
        `{"xAxis": {"data": ["A"], "gridIndex": 1}, "yAxis": {}, "series": [${bar}}]}`,
        'xAxis.gridIndex is 1, but the option has only one "grid" (index 0): refer to one that exists, or add it.',
      ],
      [
        `{"polar": {}, "angleAxis": {"data": ["A"]}, "radiusAxis": {"polarIndex": 1}, "series": [${bar}, "coordinateSystem": "polar"}]}`,
        'radiusAxis.polarIndex is 1, but the option has only one "polar" (index 0): refer to one that exists, or add it.',
      ],
      [
        `{"dataset": [{"source": [["A", 1]]}, {"fromDatasetIndex": 2}], ${BAR}, "series": [{"type": "bar", "datasetIndex": 1}]}`,
        'dataset[1].fromDatasetIndex is 2, but the option has 2 "dataset" (index 0 to 1): refer to one that exists, or add it.',
      ],
      [
        `{"singleAxis": [{}, {}], "series": [{"type": "themeRiver", "singleAxisIndex": 2, "data": []}]}`,
        'series[0].singleAxisIndex is 2, but the option has 2 "singleAxis" (index 0 to 1): refer to one that exists, or add it.',
      ],
    ];
    for (const [source, message] of cases) {
      assert.strictEqual(errorOf(source), message);
      assert.ok(drawingThrows(JSON.parse(source)), source);
    }
    // Axes on grids that ECharts adds, components by id, and one that a timeline step adds.
    for (const source of [
      `{${BAR}, "series": [${bar}, "xAxisIndex": 0, "yAxisIndex": 0}]}`,
      `{"grid": [{}, {"id": "g"}], "xAxis": [{"data": ["A"]}, {"data": ["A"], "gridId": "g", "id": 2}], "yAxis": [{}, {"gridIndex": 1}], "series": [${bar}}, ${bar}, "xAxisId": 2, "yAxisIndex": 1}]}`,
      `{${BAR}, "series": [{"type": "pie", "xAxisIndex": 4, "data": [1]}]}`,
      `{"timeline": {"data": [1]}, ${BAR}, "series": [${bar}}], "options": [{"yAxis": [{}, {}], "series": [{"yAxisIndex": 1}]}]}`,
    ]) {
      drawn(parseOption(source));
    }
  });

  test("warns of references to components that the option lacks, which ECharts ignores", () => {
    const warnings = (source: string) => {
      const option = parseOption(source);
      drawn(option);
      return optionWarnings(option);
    };
    const bars = `${BAR}, "series": [{"type": "bar", "data": [1]}]`;
    assert.deepStrictEqual(
      warnings(
        `{"dataset": {"source": [["A", 1]]}, ${BAR}, "series": [{"type": "bar", "datasetIndex": 1}]}`,
      ),
      [
        'series[0].datasetIndex is 1, but the option has only one "dataset" (index 0), so ECharts draws nothing for the series: refer to one that exists, or add it.',
      ],
    );
    assert.deepStrictEqual(warnings(`{${bars}, "dataZoom": [{"yAxisIndex": [0, 3]}]}`), [
      'dataZoom[0].yAxisIndex is 3, but the option has only one "yAxis" (index 0), which ECharts ignores, zooming no such axis: refer to one that exists, or add it.',
    ]);
    assert.deepStrictEqual(warnings(`{${bars}, "visualMap": {"seriesIndex": 1}}`), [
      'visualMap.seriesIndex is 1, but the option has only one "series" (index 0), which ECharts ignores, coloring no such series: refer to one that exists, or add it.',
    ]);
    assert.match(
      warnings(
        '{"radar": {"indicator": [{"name": "a"}]}, "series": [{"type": "radar", "radarIndex": 1, "data": [[1]]}]}',
      ).join(),
      /^series\[0\]\.radarIndex is 1, but the option has only one "radar" \(index 0\), so ECharts draws nothing/,
    );
    assert.deepStrictEqual(
      warnings(`{${bars}, "dataZoom": [{"xAxisIndex": "all"}], "visualMap": {"seriesIndex": [0]}}`),
      [],
    );
  });

  test("warns of top-level keys that ECharts ignores, with those that were likely meant", () => {
    const warnings = (extra: string) =>
      optionWarnings(parseOption(`{${BAR}, "series": [{"type": "bar", "data": [1]}], ${extra}}`));
    assert.deepStrictEqual(
      warnings(
        '"xaxis": {}, "tooltips": {}, "legends": {}, "serie": [], "titel": {}, "smooth": true, "notes": "x"',
      ),
      [
        'ECharts ignores what it does not know at the top level of the option: "xaxis" (did you mean "xAxis"?), "tooltips" (did you mean "tooltip"?), "legends" (did you mean "legend"?), "serie" (did you mean "series"?), "titel" (did you mean "title"?), "smooth" (a setting of each series: set it in "series"), "notes".',
      ],
    );
    assert.deepStrictEqual(
      optionWarnings(
        parseOption(
          `{"baseOption": {"timeline": {"data": [1]}, ${BAR}, "series": [{"type": "bar"}], "colors": []}, "options": [{"datazoom": {}}]}`,
        ),
      ),
      [
        'ECharts ignores what it does not know at the top level of the option: "baseOption.colors" (did you mean "color"?), "options[0].datazoom" (did you mean "dataZoom"?).',
      ],
    );
    assert.deepStrictEqual(
      warnings('"color": [], "backgroundColor": "#fff", "animation": false, "aria": {}'),
      [],
    );
    // Every component that ECharts has.
    const full = (
      fullECharts as unknown as { ComponentModel: { getAllClassMainTypes(): string[] } }
    ).ComponentModel;
    for (const main of full.getAllClassMainTypes()) {
      if (!["component", "markPoint", "markLine", "markArea"].includes(main)) {
        assert.ok(TOP_LEVEL_KEYS.includes(main), main);
      }
    }
  });

  test("refuses nodes of the same name, and sankey links in a cycle, which ECharts throws on", () => {
    const network = (type: string, data: unknown[], links: unknown[] = []) =>
      JSON.stringify({ series: [{ type, layout: "circular", data, links }] });
    const cases: [string, string][] = [
      [
        network("graph", [{ name: "a" }, { name: "b" }, { name: "a" }]),
        'series[0].data[0] and [2] have the same name, "a", which ECharts cannot tell nodes apart without: give each node a name of its own, or an "id".',
      ],
      [
        network("chord", [
          { id: 1, name: "a" },
          { id: "1", name: "b" },
        ]),
        'series[0].data[0] and [1] have the same id, "1", which ECharts cannot tell nodes apart without: give each node a name of its own, or an "id".',
      ],
      [
        network("sankey", [{ name: "Other" }, { name: "Other" }]),
        'series[0].data[0] and [1] have the same name, "Other", which ECharts cannot tell nodes apart without: give each node a name of its own, as "Other (2024)" and "Other (2025)" for a node in two stages, or an "id".',
      ],
      [
        network(
          "sankey",
          [{ name: "a" }, { name: "b" }, { name: "c" }],
          [
            { source: "a", target: "b", value: 1 },
            { source: "b", target: "c", value: 1 },
            { source: 2, target: "a", value: 1 },
          ],
        ),
        'series[0] has links that go around in a cycle, "a" → "b" → "c" → "a", which a sankey cannot draw, as its flows go one way: leave out a link of the cycle, or draw a "graph" with "layout": "force" instead.',
      ],
      [
        network("sankey", [{ name: "a" }], [{ source: "a", target: "a", value: 1 }]),
        'series[0] has links that go around in a cycle, "a" → "a", which a sankey cannot draw',
      ],
      [
        network(
          "sankey",
          ["a", "b", "c", "d"].map((name) => ({ name })),
          [
            { source: "a", target: "b", value: 1 },
            { source: "c", target: "d", value: 1 },
            { source: "d", target: "c", value: 1 },
          ],
        ),
        'series[0] has links that go around in a cycle, "c" → "d" → "c", which a sankey cannot draw',
      ],
    ];
    for (const [source, message] of cases) {
      assert.ok(errorOf(source).startsWith(message), errorOf(source));
      assert.ok(drawingThrows(JSON.parse(source)), source);
    }
    // Nodes of the same name with ids of their own, and flows that meet again.
    for (const source of [
      network("graph", [
        { id: "x", name: "a" },
        { id: "y", name: "a" },
      ]),
      network(
        "sankey",
        [{ name: "a" }, { name: "b" }, { name: "c" }],
        [
          { source: "a", target: "b", value: 1 },
          { source: "a", target: "c", value: 1 },
          { source: "b", target: "c", value: 1 },
        ],
      ),
    ]) {
      drawn(parseOption(source));
    }
  });

  test("checks long sankey chains and wide branches without recursive or quadratic traversal", () => {
    const count = 12_000;
    const data = Array.from({ length: count }, (_, index) => ({ name: String(index) }));
    const links = Array.from({ length: count - 1 }, (_, index) => ({
      source: index,
      target: index + 1,
      value: 1,
    }));
    const source = () => JSON.stringify({ series: [{ type: "sankey", data, links }] });
    assert.doesNotThrow(() => parseOption(source()));
    links.push({ source: count - 1, target: count - 2, value: 1 });
    assert.match(errorOf(source()), /"11998" → "11999" → "11998"/);
    links.pop();
    for (const link of links) link.source = 0;
    assert.doesNotThrow(() => parseOption(source()));
  });

  test("does not treat links to missing nodes as sankey cycles", () => {
    const data = [{ name: "a" }, { name: "2" }];
    for (const missing of ["missing", 2, 0.5]) {
      const option = parseOption(
        JSON.stringify({
          series: [
            {
              type: "sankey",
              data,
              links: [
                { source: "a", target: "2", value: 1 },
                { source: "2", target: missing, value: 1 },
                { source: missing, target: "a", value: 1 },
              ],
            },
          ],
        }),
      );
      drawn(option);
      assert.match(optionWarnings(option).join("\n"), /2 links to nodes.*does not have/);
    }
  });

  test("resolves unnamed network nodes by their default index ids", () => {
    const links = [{ source: "0", target: "1", value: 1 }];
    for (const type of ["graph", "sankey", "chord"]) {
      for (const data of [
        [{}, {}],
        [1, 2],
      ]) {
        const option = parseOption(
          JSON.stringify({ series: [{ type, layout: "circular", data, links }] }),
        );
        drawn(option);
        assert.deepStrictEqual(optionWarnings(option), []);
      }
      for (const data of [
        [{}, { id: "0" }],
        [{ name: "1" }, {}],
      ]) {
        const option = { series: [{ type, layout: "circular", data }] };
        assert.match(errorOf(JSON.stringify(option)), /have the same id, "[01]"/);
        assert.ok(drawingThrows(option));
      }
    }
    for (const target of ["0", 0]) {
      const option = {
        series: [
          { type: "sankey", data: [{}, {}], links: [...links, { source: "1", target, value: 1 }] },
        ],
      };
      assert.match(errorOf(JSON.stringify(option)), /"0" → "1" → "0"/);
      assert.ok(drawingThrows(option));
    }
  });

  test("warns of links to nodes that a series does not have, which ECharts leaves out", () => {
    const warnings = (type: string, data: unknown[], links: unknown[]) => {
      const option = parseOption(
        JSON.stringify({ series: [{ type, layout: "circular", data, links }] }),
      );
      drawn(option);
      return optionWarnings(option);
    };
    const nodes = [{ name: "a" }, { name: "b" }];
    assert.deepStrictEqual(
      warnings("sankey", nodes, [
        { source: "a", target: "b", value: 1 },
        { source: "a", target: "c", value: 1 },
        { source: "d", target: "b", value: 1 },
      ]),
      [
        'series[0].links has 2 links to nodes that series[0].data does not have, such as "c", which ECharts leaves out: add the nodes, or name them by their "id", else their "name".',
      ],
    );
    assert.deepStrictEqual(
      warnings(
        "graph",
        [
          { id: "1", name: "a" },
          { id: "2", name: "b" },
        ],
        [{ source: "a", target: "2" }],
      ),
      [
        'series[0].links has a link to nodes that series[0].data does not have, such as "a", which ECharts leaves out: name a node that has an "id" by its id.',
      ],
    );
    assert.match(warnings("graph", nodes, [{ source: 0, target: 2 }]).join(), /such as 2,/);
    assert.deepStrictEqual(
      warnings(
        "graph",
        [{ id: 7, name: "a" }, { name: "b" }],
        [
          { source: "7", target: "b" },
          { source: 0, target: 1 },
        ],
      ),
      [],
    );
  });
});
