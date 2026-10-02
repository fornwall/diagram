import * as assert from "node:assert";
import { ComponentModel } from "echarts/core";
import "../webview/echartsLibrary";
import { type JsonObject, parseOption, SERIES_TYPES, seriesTypes } from "../webview/echartsOption";

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

  test("parses JavaScript syntax that JSON lacks", () => {
    const option = parseOption(
      "{\n  // Comments, unquoted keys, single quotes and trailing commas are JavaScript, not JSON.\n" +
        "  xAxis: {type: 'category', data: ['A']},\n  yAxis: {},\n" +
        "  series: [{type: 'bar', data: [1,],},],\n}",
    );
    assert.strictEqual(seriesTypes(option), "bar");
    // A comment at the end must not swallow the parenthesis that closes the expression.
    assert.strictEqual(seriesTypes(parseOption('{"series": [{"type": "pie"}]} // done')), "pie");
  });

  test("rejects a source that holds more than one top-level value", () => {
    const option =
      '{"series":[{"type":"bar","data":[1]}], "xAxis":{"type":"category","data":["a"]}, "yAxis":{}}';
    // Two objects with a "," between them are a JavaScript sequence expression, which keeps the
    // last value alone, so that the option itself would be thrown away.
    assert.match(
      errorOf(`${option}, {"foo": 1}`),
      /holds 2 top-level values separated by ",": only one top-level object is allowed/,
    );
    assert.match(
      errorOf(`${option}; {"foo": 1}`),
      /only one top-level object is allowed, so check for a "}" that closes it too early/,
    );
    // What evaluates to a single value is still that value, whatever follows it.
    assert.strictEqual(seriesTypes(parseOption(`${option},`)), "bar");
    assert.strictEqual(seriesTypes(parseOption(`${option} // the chart`)), "bar");
    assert.strictEqual(seriesTypes(parseOption(`(() => (${option}))()`)), "bar");
    assert.match(errorOf(`[${option}]`), /must be an object.*not an array/);
    assert.match(errorOf("  // nothing here\n"), /^The ECharts option is empty\./);
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

  test("describes syntax errors that JavaScript also rejects, with their position", () => {
    const message = errorOf('{\n  "series": [{"type": "bar", "name": "A}');
    assert.match(
      message,
      /Unterminated string: missing the closing double quote \(line 2, column 38\)/,
    );
    assert.match(message, /2 \| {3}"series": \[\{"type": "bar", "name": "A\}\n {2}\| {38}\^/);
  });

  test("blames the JavaScript error, not syntax that only JSON forbids", () => {
    const message = errorOf("{series: [{type: 'bar', data: [1,]}], xAxis: ,}");
    assert.match(message, /neither valid JSON nor a valid JavaScript object literal: Unexpected/);
    assert.match(message, /as JSON or as JavaScript when a callback needs a function/);
    assert.doesNotMatch(message, /double quotes|[Tt]railing comma/);
    // What is incomplete in both languages is still reported where it is.
    assert.match(
      errorOf('{"series": [{"type": "pie"}]'),
      /Unexpected end of input .*the JSON is incomplete/,
    );
  });

  test("blames the JavaScript error, not number forms that only JSON forbids", () => {
    for (const number of [".5", "5.", "+1", "0x1F", "0b1", "0o7", "1_000", "1n", ".5e3"]) {
      const message = errorOf(`{"a": ${number}, "b": (p) => }`);
      assert.match(message, /neither valid JSON nor a valid JavaScript object literal/, number);
      assert.doesNotMatch(message, /Invalid number/, number);
    }
    // A legacy octal is a syntax error in strict mode too, so it is reported where it is.
    assert.match(
      errorOf('{"a": 05, "b": (p) => }'),
      /Invalid number 05: JSON numbers are decimal.*\(line 1, column 7\)/,
    );
  });

  test("blames the error inside a source that is a JavaScript expression", () => {
    const message = errorOf('(() => ({series: [{type:"bar", data:[1,}]}))()');
    assert.match(message, /neither valid JSON nor a valid JavaScript object literal: Unexpected/);
    // The "(" that the expression starts with is not the error.
    assert.doesNotMatch(message, /Unexpected "\("|line 1, column 1/);
  });

  test("names the typical mistakes in option sources written by models", () => {
    const cases: [string, RegExp][] = [
      ['{"series": [{"type": "pie", "data": [1, 2', /incomplete, with "\]}\]}" left to close/],
      ['{"series": [{"type": "pie"} {"type": "bar"}]}', /Missing "," before this element/],
      ['{"title": {"text": "A"}\n "series": []}', /Missing "," before this property \(line 2/],
      ['{"series": [{"type": "pie"}}', /the array opened at line 1, column 12 must be closed/],
      [
        '{"color": new echarts.graphic.LinearGradient()}',
        /threw while being evaluated.*no libraries in scope.*"colorStops"/,
      ],
      ['```json\n{"series": []}\n```', /^[^\n]*Remove the code fence/],
      ["option = {}", /Unexpected "option": write the option object itself, as JSON or as a Java/],
      ['{"a": {}}, "b": 1}', /check for a "}" that closes it too early/],
      ['{"data": [1, 2, ...]}', /no placeholders/],
      ['{"show": True}', /use true, false or null/],
      ['{"text": “A”}', /straight double quotes/],
      ["() => ({})", /must be an object such as \{"series": \[\.\.\.\]}.*not a function/],
      ["42", /must be an object.*JavaScript object literal, not a number/],
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
