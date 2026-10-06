import * as assert from "node:assert";
import { ComponentModel } from "echarts/core";
import "../webview/echartsLibrary";
import {
  type JsonObject,
  optionWarnings,
  parseOption,
  SERIES_TYPES,
  seriesTypes,
} from "../webview/echartsOption";

// ECharts' registry of series and component classes, which its typings leave out.
const registry = ComponentModel as unknown as { getClass(main: string, sub: string): unknown };
const hasSeries = (type: string) => registry.getClass("series", type) !== undefined;

const BAR = '"xAxis": {"type": "category", "data": ["A"]}, "yAxis": {}';

function errorOf(source: string): string {
  try {
    parseOption(source);
  } catch (error) {
    return (error as Error).message;
  }
  assert.fail("expected an error");
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
    for (const type of SERIES_TYPES) {
      assert.ok(hasSeries(type), type);
    }
    // A custom series needs a renderItem function, which a JavaScript source can express.
    assert.ok(SERIES_TYPES.includes("custom"));
    assert.ok(!hasSeries("map"));
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
});
