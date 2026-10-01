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
    assert.match(errorOf('{"series": [{"type": "line"}]}'), /needs both "xAxis" and "yAxis"/);
    assert.match(errorOf('{"series": [{"type": "radar"}]}'), /needs a "radar" component/);
    parseOption('{"series": [{"type": "scatter", "coordinateSystem": "polar"}]}');
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
    assert.match(errorOf('{"a": 1} // note'), /Unexpected content after the end/);
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
