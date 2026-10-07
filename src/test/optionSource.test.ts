import * as assert from "node:assert";
import { evaluateSource } from "../webview/optionSource";

function errorOf(source: string): string {
  try {
    evaluateSource(source);
  } catch (error) {
    return (error as Error).message;
  }
  assert.fail("expected an error");
}

suite("optionSource", () => {
  /** Runs the action as the panel of an untrusted workspace, whose policy refuses to evaluate code. */
  function withoutEval<T>(action: () => T): T {
    const original = globalThis.Function;
    globalThis.Function = function refused() {
      throw new EvalError(
        "Refused to evaluate a string as JavaScript because 'unsafe-eval' is not allowed",
      );
    } as unknown as FunctionConstructor;
    try {
      return action();
    } finally {
      globalThis.Function = original;
    }
  }

  test("reads JavaScript syntax that JSON lacks", () => {
    assert.deepStrictEqual(
      evaluateSource(
        "{\n  // Comments, unquoted keys, single quotes and trailing commas are JavaScript, not JSON.\n" +
          "  xAxis: {type: 'category', data: ['A']},\n  yAxis: {},\n" +
          "  series: [{type: 'bar', data: [1,],},],\n}",
      ),
      { xAxis: { type: "category", data: ["A"] }, yAxis: {}, series: [{ type: "bar", data: [1] }] },
    );
    // A comment at the end must not swallow the parenthesis that closes the expression.
    assert.deepStrictEqual(evaluateSource('{"series": [{"type": "pie"}]} // done'), {
      series: [{ type: "pie" }],
    });
  });

  test("reads object literals without evaluating them, to the values JavaScript gives", () => {
    const literals = [
      "{a: 1, 'b': \"x\\ty\", c: [1,,2,], d: {e: -0.5e3, f: .5, g: 5., h: 0x1F, i: 0b101, j: 0o17, k: 1_000}, }",
      "{s: '\\u{1F600}\\u00e9\\x41\\0\\b\\f\\n\\r\\v\\'\\\"\\\\\\a', t: \"a\\\nb\", u: `raw\r\nline\\t\\``}",
      "{1: 'a', 0x10: 'b', 1.50: 'c', .5: 'd', 1e3: 'e', default: 1, get: 3, constructor: 4}",
      "{x: undefined, y: NaN, z: -Infinity, w: + 5, v: null, t: true, f: false, a: 1, a: 2} // done",
      "/* only */ ['\\uD83D\\uDE00', \"\u2028\"], ",
    ];
    for (const source of literals) {
      const [expected] = new Function(`"use strict"; return ([\n${source}\n]);`)();
      assert.deepStrictEqual(
        withoutEval(() => evaluateSource(source)),
        expected,
        source,
      );
    }
  });

  test("refuses JavaScript code where the panel may not evaluate it, saying where it is", () => {
    const source = "{\n  series: [{type: 'pie', data: [1], label: {formatter: (p) => p.name}}],\n}";
    assert.strictEqual(
      withoutEval(() => errorOf(source)),
      "The ECharts option has JavaScript code (line 2, column 56), which the panel runs only in " +
        "a trusted workspace. Write the option with literal values only, as JSON, or trust the " +
        "workspace (Workspaces: Manage Workspace Trust) to use functions such as callbacks.\n" +
        "2 |   series: [{type: 'pie', data: [1], label: {formatter: (p) => p.name}}],\n" +
        "  |                                                        ^",
    );
    // What literals cannot express goes to the engine, such as a prototype set by "__proto__".
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a template literal in a source
    for (const code of ["{a: Math.PI}", "{__proto__: {}}", "{a: 1n}", "{a: `${1}`}", "{a}"]) {
      assert.match(
        withoutEval(() => errorOf(code)),
        /^The ECharts option has JavaScript code/,
        code,
      );
    }
    // Syntax errors are still located as such.
    assert.match(
      withoutEval(() => errorOf("{a: 1,, }")),
      /^The ECharts option could not be parsed: Unexpected "," while expecting a property name/,
    );
  });

  test("refuses a source that holds more than one top-level value", () => {
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
    for (const source of [`${option},`, `${option} // the chart`, `(() => (${option}))()`]) {
      assert.deepStrictEqual(evaluateSource(source), JSON.parse(option), source);
    }
    assert.match(errorOf("  // nothing here\n"), /^The ECharts option is empty\./);
  });

  test("refuses a source that closes the brackets it is evaluated in, without running it", () => {
    const ran = "globalThis.optionSourceRan = true";
    const cases: [string, RegExp][] = [
      [`{a: 1}\n]); ${ran}; ([\n{}`, /Unexpected "\]" after the end of the option.*\(line 2, c/],
      [`{a: f}\n]); ${ran}; ([\n{}`, /Unexpected token '\]' \(line 2, column 1\)/],
      [`{a: g(1, [2])}]) && (${ran}) || ([{}`, /Unexpected token '\]' \(line 1, column 15\)/],
      [`{a: f}][0] && (${ran}) || [{}`, /Unexpected token '\]' \(line 1, column 7\)/],
      [`{a: f}\n); ${ran}; f(\n{}`, /Unexpected token '\)' \(line 2, column 1\)/],
      ["{a: f},,{}", /Unexpected token ',' \(line 1, column 8\)/],
    ];
    for (const [source, expected] of cases) {
      assert.match(errorOf(source), expected, source);
    }
    assert.strictEqual((globalThis as { optionSourceRan?: boolean }).optionSourceRan, undefined);
  });

  test("describes syntax errors that JavaScript also rejects, with their position", () => {
    const message = errorOf('{\n  "series": [{"type": "bar", "name": "A}');
    assert.match(
      message,
      /Unterminated string: missing the closing double quote \(line 2, column 38\)/,
    );
    assert.match(message, /2 \| {3}"series": \[\{"type": "bar", "name": "A\}\n {2}\| {38}\^/);
  });

  test("locates errors in JavaScript object literals, past syntax that only JSON forbids", () => {
    const message = errorOf(
      "{\n  // A comment, unquoted keys, single quotes and a trailing comma are fine.\n" +
        "  series: [{type: 'bar', data: [1, 2,]}],\n  xAxis: {type: 'category' data: ['A']},\n}",
    );
    assert.match(message, /Missing "," before this property \(line 4, column 28\)/);
    assert.match(message, /4 \| {3}xAxis: \{type: 'category' data/);
    assert.match(
      errorOf("{series: [{type: 'bar', data: [1,]}], xAxis: ,}"),
      /Unexpected "," while expecting a value \(line 1, column 46\)/,
    );
    assert.match(errorOf("{a: 1,, b: 2}"), /Unexpected "," while expecting a property name/);
    assert.match(errorOf("{a: '\\8'}"), /Invalid escape "\\8": there are no octal escapes/);
    assert.match(errorOf("{a: /* open"), /Unterminated comment: missing the closing "\*\/"/);
    assert.match(
      errorOf('{"title": {"text": "A\nB"}}'),
      /Unterminated string: missing the closing double quote before the end of the line.*\(line 1, column 20\)/,
    );
    // What is incomplete in both languages is still reported where it is.
    assert.match(
      errorOf('{"series": [{"type": "pie"}]'),
      /Unexpected end of input .*the option is incomplete/,
    );
  });

  test("locates errors beyond literal syntax, such as inside a function, as the engine finds them", () => {
    const message = errorOf("{renderItem: (p) => { return {a: 1,, b: 2}; }}");
    assert.match(
      message,
      /neither valid JSON nor a valid JavaScript object literal: Unexpected token ',' \(line 1, column 36\)\. Write it as one object/,
    );
    assert.match(message, /\n1 \| \{renderItem: .*\n {2}\| {36}\^$/);
    const cases: [string, RegExp][] = [
      ["{a: p => p.x.., b: 1}", /Unexpected token '\.' \(line 1, column 14\)/],
      ["{a: (p) => p.name, b: {c: d e}}", /Unexpected identifier 'e' \(line 1, column 29\)/],
      [
        "{a: x => { let y = 08; }}",
        /leading zeros are not allowed in strict mode \(line 1, column 20\)\./,
      ],
      ["{a: x => {\n  return x\n}}}", /Unexpected token '}' \(line 3, column 3\)/],
    ];
    for (const [source, expected] of cases) {
      assert.match(errorOf(source), expected, source);
    }
    // Where a start of the source cut short fails alike, the error cannot be located.
    assert.doesNotMatch(errorOf("{a: (p) => /open, b: 1}"), /\(line/);
  });

  test("locates a token the engine cannot read, such as a string left open after a function", () => {
    const cases: [string, RegExp][] = [
      ['{a: x => x, b: "open}', /Invalid or unexpected token \(line 1, column 16\)/],
      [
        "{\n  a: (p) => p.name + 'x', /* a 'comment\n  that goes on */ b: 'open,\n  c: 1,\n}",
        /Invalid or unexpected token \(line 3, column 22\)/,
      ],
      ["{a: (p) => p.name, b: “quoted”}", /Invalid or unexpected token \(line 1, column 23\)/],
      ["{a: (p) => '\\x4' + p}", /Invalid hexadecimal escape sequence \(line 1, column 13\)/],
    ];
    for (const [source, expected] of cases) {
      assert.match(errorOf(source), expected, source);
    }
  });

  test("blames what a JavaScript option throws, not its syntax", () => {
    assert.match(
      errorOf('{a: x => x, b: JSON.parse("{")}'),
      /^The ECharts option threw while being evaluated as JavaScript: .*JSON.*\(line 1, column 21\)\./,
    );
    // A message that ends a sentence continues without a second period.
    assert.match(
      errorOf('{a: x => x, b: (() => { throw new Error("Bad value."); })()}'),
      /^The ECharts option threw while being evaluated as JavaScript: Bad value \(line 1, column \d+\)\.(\n|$)/,
    );
  });

  test("locates what throws while a JavaScript option is evaluated", () => {
    const message = errorOf(
      '{\n  series: [{type: "bar", color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [])}],\n}',
    );
    assert.match(
      message,
      /threw while being evaluated as JavaScript: echarts is not defined \(line 2, column 37\)\. .*no libraries or variables in scope.*"colorStops"/,
    );
    assert.match(message, /\n2 \| {3}series: .*\n {2}\| {37}\^$/);
    const thrown = errorOf("(() => { const o = {}; return o.x.y; })()");
    assert.match(thrown, /Cannot read properties of undefined.*\(line 1, column 35\)\.\n/);
    assert.doesNotMatch(thrown, /in scope/);
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
      /Invalid number 05: write numbers such as 5.*\(line 1, column 7\)/,
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
      ['```json\n{"series": []}\n```', /^[^\n]*Remove the code fence/],
      ["option = {}", /Unexpected "option": write the option object itself, as JSON or as a Java/],
      ['{"a": {}}, "b": 1}', /check for a "}" that closes it too early/],
      ['{"data": [1, 2, ...]}', /no placeholders/],
      ['{"show": True}', /use true, false or null/],
      ['{"text": “A”}', /straight quotes/],
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
