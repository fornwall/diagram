import * as assert from "node:assert";
import { buildChart } from "../charts";
import { parseTable } from "../data";
import { describeChartParameters, describeDiagram, withoutValueRuns } from "../describe";
import { lineDiff } from "../lineDiff";
import type { DiagramState } from "../panel";
import { formatOption } from "../webview/optionSource";

suite("describe", () => {
  const chart: DiagramState = {
    language: "echarts",
    source: '{"series":[{"type":"pie","data":[{"name":"Sales","value":42}]}]}',
    title: "Sales",
    origin: "tool",
    editedByUser: false,
    chart: { type: "pie", file: "sales.csv" },
  };
  const flowchart = (source: string): DiagramState => ({
    language: "mermaid",
    source,
    title: "Flow",
    origin: "tool",
    editedByUser: false,
  });

  test("keeps chart data and parameters available without repeating its origin", () => {
    const description = describeDiagram(chart);
    assert.ok(description.includes(chart.source ?? ""));
    assert.ok(description.includes(JSON.stringify(chart.chart)));
    assert.strictEqual(description.match(/sales\.csv/g)?.length, 1);
    assert.match(
      description,
      /Its data is not loaded, .* ask the user to press Refresh in the diagram panel first\./,
    );
    assert.doesNotMatch(description, /diagram_inspectData/);
    // Loaded, the data is updated and inspected with the chart tools.
    const loaded = describeDiagram(chart, { chartTable: parseTable("name,value\nSales,42") });
    assert.match(loaded, /use diagram_updateChart with the loaded data/);
    assert.match(loaded, /diagram_inspectData shows its columns/);
  });

  test("tells the units that sizes and durations were converted to", () => {
    const table = parseTable("name,Latency (ms),Size (KB),Wait,share\na,1.5,2,3s,5%");
    assert.match(
      describeDiagram(chart, { chartTable: table }),
      /\n"Size \(KB\)" is in bytes; "Latency \(ms\)", "Wait" are in seconds\.\n/,
    );
    assert.doesNotMatch(
      describeDiagram(chart, { chartTable: parseTable("name,share\na,5%") }),
      / is in /,
    );
  });

  test("manual chart edits are preserved rather than regenerated", () => {
    const description = describeDiagram({ ...chart, editedByUser: true });
    assert.ok(description.includes(chart.source ?? ""));
    assert.match(description, /Preserve their edits/);
    assert.doesNotMatch(description, /call diagram_chart/);
  });

  test("lists the manual styling of a generated chart, shortening long values", () => {
    const edits = [
      { path: ["title", "text"], value: "Q3" },
      { path: ["series", 1, "itemStyle", "color"], value: "#c00" },
      { path: ["legend"], remove: true },
      { path: ["title"], value: { text: "Note" }, append: true },
      { path: ["graphic"], value: { elements: "x".repeat(100) } },
    ];
    const styled = {
      ...chart,
      editedByUser: true,
      chartPresentation: { baseline: {}, dataHash: "", edits },
    };
    const listed =
      'title.text = "Q3", series[1].itemStyle.color = "#c00", legend removed, title added {"text":"Note"}, ' +
      `graphic = {"elements":"${"x".repeat(47)}…`;
    const description = describeDiagram(styled);
    assert.ok(
      description.includes(
        `Manual styling of the generated option, which diagram_updateChart keeps: ${listed}. Replacing the chart with diagram_chart or diagram_render must make these changes again.`,
      ),
      description,
    );
    assert.doesNotMatch(description, /The user edited/);
    // As for /explain, which may read the chart but not update it.
    assert.match(
      describeDiagram(styled, { tools: new Set(["diagram_getState"]) }),
      /^Manual styling of the generated option: title\.text = "Q3", .*…\.$/m,
    );
    const many = Array.from({ length: 25 }, (_, i) => ({ path: [`k${i}`], value: i }));
    assert.match(
      describeDiagram({
        ...styled,
        chartPresentation: { baseline: {}, dataHash: "", edits: many },
      }),
      /k19 = 19 and 5 more edits\./,
    );
    // Blocked styling says why, and that the user edited the source.
    const blocked = describeDiagram({
      ...styled,
      chartPresentation: { baseline: {}, dataHash: "", edits, blocked: "Blocked." },
    });
    assert.doesNotMatch(blocked, /Manual styling/);
    assert.match(blocked, /Blocked\.[\s\S]*The user edited this source/);
  });

  test("large inline data does not bypass the source limit or hide chart settings", () => {
    const data = "name,value\nPrivate row,42\n".repeat(10_000);
    const description = describeDiagram(
      { ...chart, source: data, chart: { type: "bar", data, aggregate: "sum" } },
      { chartTable: parseTable(data) },
    );
    assert.ok(description.length < 1_000);
    assert.doesNotMatch(description, /Private row/);
    assert.match(description, /"aggregate":"sum"/);
    assert.ok(
      description.includes(`inline data: ${data.length.toLocaleString("en-US")} characters`),
    );
    assert.match(description, /diagram_inspectData/);
  });

  test("a long Mermaid source is left out of requests, but given in full when asked for", () => {
    const source = `flowchart TD\n${"  A --> B\n".repeat(4_000)}`;
    const state = flowchart(source);
    const summary = describeDiagram(state);
    assert.doesNotMatch(summary, /A --> B/);
    assert.match(summary, /too long to repeat in every request; diagram_getState gives it in full/);
    assert.ok(describeDiagram(state, { detail: "full" }).includes(source));
  });

  test("a long chart option is given without its long runs of values, and in full when asked for", () => {
    const rows = Array.from({ length: 4_000 }, (_, i) => `r${i},${i * 7}`).join("\n");
    const spec = { type: "bar", data: `name,value\n${rows}` } as const;
    const source = formatOption(JSON.stringify(buildChart(spec, parseTable(spec.data)).option));
    assert.ok(source.length > 30_000, String(source.length));
    const generated = { ...chart, chart: spec, source };
    const brief = describeDiagram(generated);
    assert.match(
      brief,
      /The source is [\d,]+ characters long, too long to repeat in every request; diagram_getState gives it in full\. Here it is with long runs of lines of values left out, each marked by a line of "…", which diagram_edit's oldText must not include:\n```echarts\n\{\n/,
    );
    assert.ok(brief.length < 2_000, brief);
    // The other lines are those of the source, from which an edit takes its text.
    const shown = /```echarts\n([\s\S]*)\n```/.exec(brief)?.[1]?.split("\n") ?? [];
    const marks = shown.filter((line) => line.includes("…"));
    assert.deepStrictEqual(
      marks.map((line) => line.trim().replace(/[\d,]+/, "N")),
      ["… N more lines of values …", "… N more lines of values …"],
    );
    const lines = new Set(source.split("\n"));
    assert.ok(shown.every((line) => line.includes("…") || lines.has(line)));
    assert.ok(shown.some((line) => /"type": "bar"/.test(line)));
    // Asked for, it is given in full, unless the room left is too small, when it is shortened.
    assert.ok(describeDiagram(generated, { detail: "full" }).includes(source));
    assert.match(
      describeDiagram(generated, { detail: "summary" }),
      /too long for the room left in your input\. Here it is with long runs of lines/,
    );
    // Neither a source without such runs, nor a Mermaid one, is shortened.
    const oneLine = { ...chart, source: `{"dataset":${"[1,2],".repeat(10_000)}}` };
    assert.match(
      describeDiagram(oneLine),
      /too long to repeat in every request; diagram_getState gives it in full\.\)/,
    );
    assert.match(
      describeDiagram(oneLine, { tools: new Set() }),
      /^\(The source is [\d,]+ characters long, too long to show here\.\)$/m,
    );
    assert.match(
      describeDiagram(oneLine, { detail: "summary" }),
      /\(The source, [\d,]+ characters long, is left out, as the room left in your input is too small for it\.\)/,
    );
    assert.strictEqual(
      withoutValueRuns(`{\n${"  1,\n".repeat(20)}  2\n}`),
      "{\n  1,\n  1,\n  … 18 more lines of values …\n  2\n}",
    );
    assert.strictEqual(withoutValueRuns('{\n  "a": [\n    1,\n    2\n  ]\n}'), undefined);
  });

  test("many relationships are left out of requests, but listed in full when asked for", () => {
    const relationships = Array.from({ length: 100 }, (_, index) => ({
      id: `edge:L_A_B_${index}`,
      label: "A → B",
      relationship: { kind: "edge", source: "A", target: "B", direction: "forward" } as const,
    }));
    const state = flowchart("flowchart LR\n  A --> B");
    const summary = describeDiagram(state, { relationships });
    assert.doesNotMatch(summary, /L_A_B_/);
    assert.match(
      summary,
      /It has 100 selectable relationships, .*diagram_getState lists their ids/,
    );
    assert.doesNotMatch(
      describeDiagram(state, { relationships, tools: new Set<string>() }),
      /relation/,
    );
    assert.match(
      describeDiagram(state, { relationships, detail: "full" }),
      /: "A → B" \(id: "edge:L_A_B_0"\), .*, "A → B" \(id: "edge:L_A_B_99"\)\.$/m,
    );
    // Labels tell the ends and direction of each, and ids their kind, in about 30 characters.
    assert.match(
      describeDiagram(state, { relationships: relationships.slice(0, 90) }),
      /^Selectable relationships \(use these exact ids for diagram_annotate\): .*"edge:L_A_B_89"\)\.$/m,
    );
    // As for /explain, which may read the diagram but not mark it.
    const readOnly = describeDiagram(state, {
      relationships,
      tools: new Set(["diagram_getState"]),
    });
    assert.match(
      readOnly,
      /It has 100 selectable relationships, .*diagram_getState lists their ids/,
    );
    const long = flowchart(`flowchart LR\n%% ${"x".repeat(40_000)}`);
    assert.match(
      describeDiagram(long, { tools: new Set(["diagram_getState"]) }),
      /too long to repeat in every request; diagram_getState gives it in full/,
    );
    assert.match(describeDiagram(long, { tools: new Set() }), /too long to show here/);
  });

  test("a model that calls no tools is told of the drawing, but of no tool", () => {
    const edge = { kind: "edge", source: "A", target: "B", direction: "forward" } as const;
    const drawing = {
      relationships: [{ id: "L_A_B", label: "A → B", relationship: edge }],
      repeatedNames: [{ name: "Sales", ids: ["Sales", "Sales/1"], count: 2 }],
      annotation: { marks: [{ id: "A", kind: "problem" as const }], dim: false },
    };
    const state = { ...chart, links: { A: { file: "src/a.ts", line: 3 } } };
    assert.match(describeDiagram(state, drawing), /diagram_annotate.*\n.*diagram_annotate/);
    const described = describeDiagram(state, { ...drawing, tools: new Set<string>() });
    assert.doesNotMatch(described, /diagram_/);
    assert.match(described, /Chart parameters: \{"type":"pie","file":"sales\.csv"\}\. Refresh/);
    // As for /explain, which may read the chart but not update it.
    const readOnly = describeDiagram(state, { ...drawing, tools: new Set(["diagram_getState"]) });
    assert.match(readOnly, /^Chart parameters: \{"type":"pie","file":"sales\.csv"\}\./m);
    assert.doesNotMatch(readOnly, /diagram_(updateChart|chart|render|inspectData)/);
    assert.match(described, /Code links: A → src\/a\.ts#L3\.\n/);
    assert.match(described, /Selectable relationships: "A → B" \(id: "L_A_B"\)\.\n/);
    assert.match(described, /Marked chart items: "A" \(problem\)\./);
  });

  test("diffs lines with a line of context, joining hunks whose context meets", () => {
    const before = [
      "flowchart TD",
      "  A --> B",
      "  B --> C",
      "  C --> D",
      "  D --> E",
      "  E --> F",
    ];
    const after = [
      "flowchart TD",
      "  A --> B",
      "  B -->|ok| C",
      "  C --> D",
      "  D --> E",
      "  E --> F",
    ];
    assert.strictEqual(
      lineDiff(before.join("\n"), after.join("\n")),
      "@@ -2,3 +2,3 @@\n   A --> B\n-  B --> C\n+  B -->|ok| C\n   C --> D",
    );
    assert.strictEqual(lineDiff("a\nb", "a\nb"), "");
    // Separate changes, and changes two lines apart, whose context meets.
    assert.strictEqual(
      lineDiff("1\n2\n3\n4\n5\n6\n7", "0\n1\n2\n3\n4\n5\n6"),
      "@@ -1,1 +1,2 @@\n+0\n 1\n@@ -6,2 +7,1 @@\n 6\n-7",
    );
    assert.strictEqual(
      lineDiff("1\n2\n3\n4", "x\n2\n3\ny"),
      "@@ -1,4 +1,4 @@\n-1\n+x\n 2\n 3\n-4\n+y",
    );
    assert.strictEqual(lineDiff("a\nb\nc", "a\nc"), "@@ -1,3 +1,2 @@\n a\n-b\n c");
    // Too many changed lines to compare quickly.
    const many = (prefix: string) => Array.from({ length: 1_500 }, (_, i) => `${prefix}${i}`);
    assert.strictEqual(lineDiff(many("a").join("\n"), many("b").join("\n")), undefined);
  });

  test("tells what the user changed since an agent drew the diagram, and not a stale edit", () => {
    const from = "flowchart TD\n  A --> B\n  B --> C";
    const to = "flowchart TD\n  A --> B\n  B -->|retry| A\n  B --> C";
    const edited = { ...flowchart(to), editedByUser: true, userEdit: { from, to } };
    const description = describeDiagram(edited);
    assert.ok(
      description.includes(
        "The user changed the source since an agent drew it, as this diff from the agent's version shows. Preserve their changes unless asked otherwise.\n" +
          "```diff\n@@ -2,2 +2,3 @@\n   A --> B\n+  B -->|retry| A\n   B --> C\n```",
      ),
      description,
    );
    assert.doesNotMatch(description, /The user edited this source/);
    // The source changed since the user's edit, as when an agent styled it.
    const styled = describeDiagram({ ...edited, source: `${to}\n  style A fill:red` });
    assert.doesNotMatch(styled, /diff/);
    assert.match(styled, /The user edited this source\. Preserve their edits/);
    // A rewrite is told by the source alone.
    const rewritten = `flowchart LR\n${"  X --> Y\n".repeat(200)}`;
    const rewrite = describeDiagram({
      ...flowchart(rewritten),
      editedByUser: true,
      userEdit: { from: `flowchart TD\n${"  P --> Q\n".repeat(200)}`, to: rewritten },
    });
    assert.doesNotMatch(rewrite, /diff/);
    assert.match(rewrite, /The user edited this source/);
    assert.doesNotMatch(describeDiagram(edited, { detail: "summary" }), /diff/);
    // The user edits a one-line option as the source view formats it.
    const option = '{"title":{"text":"Sales"},"series":[{"type":"pie","data":[1,2]}]}';
    const retitled = formatOption(option).replace('"Sales"', '"Revenue"');
    const described = describeDiagram({
      language: "echarts",
      source: retitled,
      title: "Revenue",
      origin: "tool",
      editedByUser: true,
      userEdit: { from: option, to: retitled },
    });
    assert.ok(
      described.includes(
        '```diff\n@@ -2,3 +2,3 @@\n   "title": {\n-    "text": "Sales"\n+    "text": "Revenue"\n   },\n```',
      ),
      described,
    );
  });

  test("oversized chart options are omitted from model context", () => {
    const description = describeChartParameters({
      type: "bar",
      options: { series: { data: Array(50_000).fill(42) } },
    });
    assert.ok(description.length < 100);
    assert.match(description, /parameters omitted/);
  });
});
