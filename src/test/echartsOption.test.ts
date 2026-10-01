import * as assert from "node:assert";
import { ComponentModel } from "echarts/core";
import "../webview/echartsLibrary";
import { parseOption, SERIES_TYPES, seriesTypes } from "../webview/echartsOption";

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

  test("checks the series of a timeline's base option", () => {
    const option = parseOption(
      '{"baseOption": {"series": {"type": "pie"}}, "options": [{"series": [{"type": "funnel"}]}]}',
    );
    assert.strictEqual(seriesTypes(option), "pie, funnel");
    assert.match(errorOf('{"baseOption": {}, "series": [{"type": "pie"}]}'), /no "series"/);
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
    assert.ok(!hasSeries("map"));
    assert.ok(!hasSeries("custom"));
  });

  test("rejects series that cannot work from JSON", () => {
    assert.match(errorOf('{"series": [{"type": "map"}]}'), /unsupported type "map".*map data/);
    assert.match(
      errorOf('{"series": [{"type": "custom"}]}'),
      /unsupported type "custom".*renderItem/,
    );
    assert.doesNotMatch(errorOf('{"series": [{}]}'), /Valid types:.*\b(map|custom)\b/);
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

  test("finds JavaScript functions where ECharts accepts callbacks", () => {
    const formatter = errorOf(
      `{${BAR}, "series": [{"type": "bar", "label": {"formatter": "function (p) { return p.name; }"}}]}`,
    );
    assert.match(formatter, /^series\[0\]\.label\.formatter is JavaScript code/);
    assert.match(
      errorOf('{"series": [{"type": "pie", "symbolSize": "(v) => v[2]"}]}'),
      /symbolSize/,
    );
  });

  test("accepts text that merely looks like code", () => {
    parseOption(
      `{"title": {"text": "function of time", "subtext": "Input => Output"}, ${BAR}, ` +
        '"series": [{"type": "bar", "name": "x => y", "data": [1], "label": {"formatter": "{b} => {c}"}}]}',
    );
  });

  test("describes JSON syntax errors with their position", () => {
    const message = errorOf('{\n  "series": [\n    {"type": "pie",}\n  ]\n}');
    assert.match(message, /Trailing comma before "}" is not allowed in JSON \(line 3, column 19\)/);
    assert.match(message, /3 \| {5}\{"type": "pie",\}\n {2}\| {19}\^/);
    assert.match(message, /Write the option as strict JSON/);
  });

  test("only suggests strict JSON for JavaScript-isms", () => {
    const message = errorOf('{"series": [{"type": "pie"}]');
    assert.match(message, /Unexpected end of input .*the JSON is incomplete/);
    assert.doesNotMatch(message, /strict JSON/);
    assert.match(errorOf("{series: []}"), /instead of series[\s\S]*strict JSON/);
    assert.match(errorOf("{'series': []}"), /double quotes, not single quotes/);
    assert.match(errorOf('{"a": 1} // note'), /Comments are not allowed[\s\S]*strict JSON/);
  });

  test("names the typical mistakes in JSON written by models", () => {
    const cases: [string, RegExp][] = [
      ['{"series": [{"type": "pie", "data": [1, 2', /incomplete, with "\]}\]}" left to close/],
      ['{"series": [{"type": "pie"} {"type": "bar"}]}', /Missing "," before this element/],
      ['{"title": {"text": "A"}\n "series": []}', /Missing "," before this property \(line 2/],
      ['{"series": [{"type": "pie"}}', /the array opened at line 1, column 12 must be closed/],
      ['{"a": {"formatter": (p) => p.name}}', /JavaScript functions are not allowed/],
      ['{"a": {"formatter": p => p.name}}', /JavaScript functions are not allowed/],
      ['{"color": new echarts.graphic.LinearGradient()}', /"colorStops"/],
      ['```json\n{"series": []}\n```', /^[^\n]*Remove the code fence/],
      ["option = {}", /Unexpected "option": the source must be the JSON object alone/],
      ['{"a": {}}, "b": 1}', /check for a "}" that closes it too early/],
      ['{"data": [0x1F]}', /Invalid number 0x1F: JSON numbers are decimal/],
      ['{"data": [.5, 1]}', /Invalid number \.5/],
      ['{"data": [-Infinity]}', /-Infinity is not valid JSON/],
      ['{"data": [1, 2, ...]}', /no placeholders/],
      ['{"show": True}', /use true, false or null/],
      ['{"text": “A”}', /straight double quotes/],
      ['{"a": []}', /Unexpected " " \(U\+00A0\)/],
    ];
    for (const [source, expected] of cases) {
      assert.match(errorOf(source), expected, source);
    }
  });

  test("keeps tabs in the caret line of an excerpt", () => {
    const message = errorOf('{\n\t\t"series": [}\n}');
    assert.match(message, /2 \| \t\t"series": \[\}\n {2}\| \t\t {11}\^/);
  });

  test("crops long lines around the error", () => {
    const message = errorOf(`{"series": [${"1, ".repeat(100)}x, ${"2, ".repeat(100)}]}`);
    const [, excerpt = "", caret = ""] = message.split("\n");
    assert.ok(excerpt.startsWith("1 | …") && excerpt.endsWith("…"), excerpt);
    assert.strictEqual(excerpt.indexOf("x"), caret.indexOf("^"));
  });
});
