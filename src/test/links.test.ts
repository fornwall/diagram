import * as assert from "node:assert";
import * as path from "node:path";
import * as vscode from "vscode";
import { linkSelection, linkText, linkTexts, validateLinks } from "../links";

suite("links", () => {
  test("validateLinks accepts a file, a line and a range of lines", () => {
    const { links, problems } = validateLinks(
      {
        cli: "src/cli.ts",
        parse: "src/parser.ts#L42",
        check: "src/checker.ts#L10-L30",
        // Node ids and locations are trimmed, as a model may pad them.
        " home ": " ~/notes.md#L1 ",
        absolute: `${path.join(path.sep, "tmp", "out.log")}#L0007`,
        // A path may contain a "#"; the line follows the last one.
        hash: "src/a#b.ts#L3",
      },
      "mermaid",
    );
    assert.deepStrictEqual(problems, []);
    assert.deepStrictEqual(links, {
      cli: { file: "src/cli.ts" },
      parse: { file: "src/parser.ts", line: 42 },
      check: { file: "src/checker.ts", line: 10, endLine: 30 },
      home: { file: "~/notes.md", line: 1 },
      absolute: { file: path.join(path.sep, "tmp", "out.log"), line: 7 },
      hash: { file: "src/a#b.ts", line: 3 },
    });
  });

  test("validateLinks leaves out what is not a location, and says why", () => {
    const { links, problems } = validateLinks(
      {
        kept: "src/parser.ts#L1",
        "": "src/parser.ts",
        missing: null,
        number: 42,
        object: { file: "src/parser.ts", line: 1 },
        lowercase: "src/parser.ts#l1",
        columns: "src/parser.ts:12:3",
        huge: "src/parser.ts#L12345678",
        zero: "src/parser.ts#L0",
        backwards: "src/parser.ts#L30-L10",
        fragmentOnly: "#L12",
      },
      "mermaid",
    );
    assert.deepStrictEqual(links, { kept: { file: "src/parser.ts", line: 1 } });
    const report = problems.join("\n");
    const expected = [
      "A node id must not be empty.",
      '"missing": the location must be a non-empty string',
      '"number": the location must be a non-empty string',
      '"object": the location must be a non-empty string',
      '"lowercase": "src/parser.ts#l1" does not give its line as "#L42" or "#L42-L80".',
      '"columns": "src/parser.ts:12:3" gives its line after a colon; write it as "#L42"',
      // Seven digits at most, so a longer number is not read as a line at all.
      '"huge": "src/parser.ts#L12345678" does not give its line',
      '"zero": "src/parser.ts#L0" starts at line 0, but lines are counted from 1.',
      '"backwards": "src/parser.ts#L30-L10" ends before it starts.',
      '"fragmentOnly": "#L12" has no file path before its line.',
    ];
    for (const problem of expected) {
      assert.ok(report.includes(problem), `${problem} in ${report}`);
    }
    assert.strictEqual(problems.length, expected.length, report);
    // A long location is shortened rather than repeated in full.
    const [long = ""] = validateLinks({ a: `${"x".repeat(200)}.ts#L1x` }, "mermaid").problems;
    assert.ok(long.length > 0 && long.length < 120, long);
  });

  test("validateLinks preserves node ids that name object properties", () => {
    const locations = JSON.parse(
      '{"__proto__": "src/parser.ts#L2", "constructor": "src/cli.ts", "toString": "src/main.ts"}',
    );
    const { links, problems } = validateLinks(locations, "mermaid");
    assert.deepStrictEqual(problems, []);
    assert.ok(links);
    assert.strictEqual(Object.getPrototypeOf(links), Object.prototype);
    assert.deepStrictEqual(Object.keys(links), ["__proto__", "constructor", "toString"]);
    assert.deepStrictEqual(Object.getOwnPropertyDescriptor(links, "__proto__")?.value, {
      file: "src/parser.ts",
      line: 2,
    });
    assert.deepStrictEqual(linkTexts(links), locations);
  });

  test("validateLinks reports links that are not an object, or are for a chart", () => {
    for (const value of ["src/parser.ts", ["src/parser.ts"], 42]) {
      assert.deepStrictEqual(validateLinks(value, "mermaid"), {
        problems: [
          'Links must be an object mapping node ids to locations, e.g. {"parse": "src/parser.ts#L42"}.',
        ],
      });
    }
    const chart = validateLinks({ a: "src/parser.ts" }, "echarts");
    assert.strictEqual(chart.links, undefined);
    assert.match(chart.problems.join(), /only for the nodes of a Mermaid diagram/);
    // Models send null for the properties they leave out.
    for (const empty of [undefined, null]) {
      assert.deepStrictEqual(validateLinks(empty, "mermaid"), { problems: [] });
    }
    assert.deepStrictEqual(validateLinks({}, "mermaid"), { problems: [] });
  });

  test("linkText writes a location the way the model gave it", () => {
    assert.strictEqual(linkText({ file: "src/cli.ts" }), "src/cli.ts");
    assert.strictEqual(linkText({ file: "src/cli.ts", line: 42 }), "src/cli.ts#L42");
    assert.strictEqual(
      linkText({ file: "src/cli.ts", line: 42, endLine: 80 }),
      "src/cli.ts#L42-L80",
    );
    assert.deepStrictEqual(
      linkTexts({ a: { file: "src/cli.ts", line: 1 }, b: { file: "src/parser.ts" } }),
      { a: "src/cli.ts#L1", b: "src/parser.ts" },
    );
  });

  test("linkSelection selects the linked lines, within the document", async () => {
    const document = await vscode.workspace.openTextDocument({ content: "one\ntwo\nthree" });
    const selection = (line?: number, endLine?: number) => {
      const range = linkSelection({ file: "x", line, endLine }, document);
      return [range.start.line, range.start.character, range.end.line, range.end.character];
    };
    // A link without a line shows the file from the top, with nothing selected.
    assert.deepStrictEqual(selection(), [0, 0, 0, 0]);
    assert.deepStrictEqual(selection(2), [1, 0, 1, 3]);
    assert.deepStrictEqual(selection(1, 3), [0, 0, 2, 5]);
    // A diagram may outlive the file it links to, and name lines it no longer has.
    assert.deepStrictEqual(selection(9, 12), [2, 0, 2, 5]);
  });
});
