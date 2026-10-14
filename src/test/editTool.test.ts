import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { ChartTool, UpdateChartTool } from "../chartTools";
import { EditDiagramTool } from "../editTool";
import { findDiagramFences } from "../fences";
import type { DiagramPanel, Drawn } from "../panel";
import { applySourceEdits, errorContext, type SourceEdit } from "../sourceEdits";
import { StyleDiagramTool } from "../styleTool";
import { lineAndColumn } from "../text";
import { RenderDiagramTool } from "../tools";
import { afterTest, recordMessages, tempDir } from "./afterTest";
import { type FakeWebview, newFakePanel, newPanel } from "./newPanel";
import { invokeTool } from "./toolText";
import { suitePage, UNTIL } from "./webviewHarness";

const edit = (oldText: string, newText: string, replaceAll = false): SourceEdit => ({
  oldText,
  newText,
  replaceAll,
});

/** Why the edits do not apply, which they must not. */
function problems(source: string, edits: SourceEdit[]): string[] {
  const edited = applySourceEdits(source, edits);
  assert.ok(!edited.ok, `The edits applied: ${JSON.stringify(edited)}`);
  return edited.problems;
}

suite("source edits", () => {
  const source = "flowchart LR\n  A[Parser] --> B[Checker]\n  B --> C[Done]\n  B --> D[Retry]";

  test("replace text that occurs once, each in the source that the edits before it left", () => {
    assert.deepStrictEqual(
      applySourceEdits(source, [
        edit("C[Done]", "C[Finished]"),
        edit("C[Finished]", "C[Ended]"),
        edit("B -->", "B ==>", true),
        edit("A[Parser] ", ""),
      ]),
      {
        ok: true,
        source: "flowchart LR\n  --> B[Checker]\n  B ==> C[Ended]\n  B ==> D[Retry]",
        replaced: [1, 1, 2, 1],
      },
    );
  });

  test("quote the closest lines of text that is not in the source", () => {
    assert.deepStrictEqual(problems(source, [edit("B --> C[Don]", "")]), [
      "Edit 1: oldText is not in the source. The closest lines are:\n2:   A[Parser] --> B[Checker]\n3:   B --> C[Done]\n4:   B --> D[Retry]",
    ]);
    assert.deepStrictEqual(problems(source, [edit("A[Parser] --> B[Checker]\nB --> C", "")]), [
      "Edit 1: oldText is not in the source. It differs from lines 2-3 only in whitespace, such as indentation or line breaks, which must match exactly:\n2:   A[Parser] --> B[Checker]\n3:   B --> C[Done]",
    ]);
    assert.match(
      problems(source, [edit("3:   B --> C[Done]", "")])[0] ?? "",
      /Leave out the line numbers, such as "12: "/,
    );
    assert.match(
      problems(source, [edit("B --> C[Done]\\n  B --> D", "")])[0] ?? "",
      /line breaks are written as "\\n"/,
    );
    assert.deepStrictEqual(problems(source, [edit("%%", "")]), [
      "Edit 1: oldText is not in the source. ",
    ]);
  });

  test("name the lines of text that occurs more than once", () => {
    assert.deepStrictEqual(problems(source, [edit("B -->", "B ==>")]), [
      'Edit 1: oldText occurs 2 times, on lines 3 and 4. Include more of the text around the one to change, or set "replaceAll": true to change every one:\n3:   B --> C[Done]\n4:   B --> D[Retry]',
    ]);
    const many = `flowchart LR\n${Array.from({ length: 8 }, (_, i) => `  A --> N${i}`).join("\n")}`;
    assert.match(
      problems(many, [edit("A -->", "")])[0] ?? "",
      /^Edit 1: oldText occurs 8 times, on lines 2, 3, 4, 5 and 6 and 3 more\./,
    );
    // Lines end as in the editor, also with "\r\n" or "\r".
    assert.match(
      problems("x\r\nx x\ry\nx", [edit("x", "")])[0] ?? "",
      /^Edit 1: oldText occurs 4 times, on lines 1, 2 and 4\./,
    );
    // Text that a large chart has on each of its lines.
    const large = `{\n${Array.from({ length: 100_000 }, (_, i) => `  "k${i}": ${i},`).join("\n")}\n}`;
    assert.match(
      problems(large, [edit('"', "")])[0] ?? "",
      /^Edit 1: oldText occurs 200,000 times, on lines 2, 3, 4, 5 and 6 and 99,995 more\./,
    );
    assert.match(
      problems(large, [edit('"k53017": 53071,\n"k53018"', "")])[0] ?? "",
      /The closest lines are:\n53018: {3}"k53016": 53016,\n53019: {3}"k53017": 53017,\n/,
    );
  });

  test("report every edit that does not apply, after those that do", () => {
    const reported = problems(source, [
      edit("C[Done]", "C[Finished]"),
      edit("C[Done]", "C[Ended]"),
      edit("B -->", "B ==>"),
    ]);
    assert.strictEqual(reported.length, 2);
    assert.match(
      reported[0] ?? "",
      /^Edit 2: oldText is not in the source, as the edits before it left it\. The closest lines are:\n2: .*\n3: {3}B --> C\[Finished\]/,
    );
    assert.match(reported[1] ?? "", /^Edit 3: oldText occurs 2 times/);
  });

  test("quote the lines around the place of an error, or else around the change", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
    assert.strictEqual(
      errorContext(lines, "Parse error on line 9, column 3: unexpected"),
      "Lines 6-12 of the source:\n6: line 6\n7: line 7\n8: line 8\n9: line 9\n10: line 10\n11: line 11\n12: line 12",
    );
    assert.strictEqual(
      errorContext(lines, 'Missing "," (line 1, column 4).'),
      "Lines 1-4 of the source:\n1: line 1\n2: line 2\n3: line 3\n4: line 4",
    );
    assert.strictEqual(
      errorContext(lines, "No diagram type", lines.replace("line 5", "line five")),
      "Lines 4-6 of the source, where it changed:\n4: line 4\n5: line 5\n6: line 6",
    );
    assert.strictEqual(errorContext(lines, "No diagram type"), "");
  });
});

/** Single capital letters, as the nodes that the fake page reports drawing. */
const nodeIds = (source: string) => [...new Set(source.match(/\b[A-Z]\b/g))];

/**
 * A page that draws Mermaid sources, reporting their single-letter node ids, and fails those with
 * "-->-->" with a parse error where it is.
 */
function drawMermaid(webview: FakeWebview): void {
  webview.answer = (message) => {
    if (message.type !== "render") return undefined;
    const { requestId, source } = message;
    const broken = source.indexOf("-->-->");
    if (broken >= 0) {
      const { line, column } = lineAndColumn(source, broken);
      const error = `Parse error on line ${line}, column ${column}: unexpected "-->".`;
      return { type: "renderError", requestId, message: error };
    }
    return { type: "rendered", requestId, diagramType: "flowchart-v2", nodeIds: nodeIds(source) };
  };
}

suite("diagram_edit", function () {
  this.timeout(10_000);

  let panel: DiagramPanel;
  let webview: FakeWebview;
  const flow = "flowchart LR\n  A[Parser] --> B[Checker]";
  const editing = (input: unknown) => invokeTool(new EditDiagramTool(panel), input);
  const renders = () => webview.sent.filter((message) => message.type === "render").length;

  setup(async () => {
    ({ panel, webview } = await newFakePanel());
    drawMermaid(webview);
  });

  async function draw(
    diagram: Partial<Parameters<DiagramPanel["render"]>[0]> = {},
  ): Promise<Drawn> {
    const drawn = await panel.render(
      { language: "mermaid", source: flow, title: "Flow", ...diagram },
      "tool",
    );
    assert.ok(drawn.ok, drawn.ok ? "" : drawn.error);
    return drawn;
  }

  test("says what it edits, and that there is nothing to edit without a diagram", async () => {
    const tool = new EditDiagramTool(panel);
    assert.strictEqual(tool.prepareInvocation().invocationMessage, "Editing the diagram");
    assert.strictEqual(
      await editing({ edits: [{ oldText: "A", newText: "B" }] }),
      "Nothing was changed: There is no diagram to edit. Draw one with diagram_render or diagram_chart first. Revision: 0.",
    );
    await draw();
    assert.strictEqual(tool.prepareInvocation().invocationMessage, 'Editing the diagram "Flow"');
    assert.strictEqual(
      await editing({
        edits: [
          { old: "A", newText: "B" },
          { oldText: "", newText: "B" },
        ],
      }),
      `Nothing was changed, as the input is invalid. Fix it and call diagram_edit again. Revision: ${panel.revision}.\n\nInvalid input:\n- Edit 1: Unknown property "old"; the properties are "oldText", "newText", "replaceAll".\n- Edit 2: "oldText" must be the exact text to replace, as a non-empty string. To add lines, replace a line next to where they go with that line and them.`,
    );
    assert.match(await editing({}), /Give "edits"/);
    assert.match(await editing({ edits: [], titel: "X" }), /Unknown property "titel"/);
  });

  test("replaces exact text, keeping the title, click prompt and code links, and says what changed", async () => {
    await draw({ clickPrompt: "Explain {label}", links: { A: { file: "sizes.tsv", line: 1 } } });
    const revision = panel.revision;
    const result = await editing({
      // As a JSON string, as some models send arrays.
      edits: JSON.stringify([
        { oldText: "--> B[Checker]", newText: "--> C[Cache] --> B[Checker]" },
      ]),
      revision,
    });
    assert.strictEqual(
      result,
      `Edited the flowchart-v2 diagram with 1 edit, in line 2 of 2. Nodes added: "C".\n\nRevision: ${revision + 1}.`,
    );
    assert.strictEqual(
      panel.current?.source,
      "flowchart LR\n  A[Parser] --> C[Cache] --> B[Checker]",
    );
    assert.strictEqual(panel.current?.title, "Flow");
    assert.strictEqual(panel.current?.clickPrompt, "Explain {label}");
    assert.deepStrictEqual(panel.current?.links, { A: { file: "sizes.tsv", line: 1 } });
    assert.strictEqual(panel.current?.origin, "tool");
    assert.deepStrictEqual(webview.render.links, { A: "sizes.tsv#L1" });
    assert.strictEqual(webview.render.clickPrompt, "Explain {label}");

    assert.match(
      await editing({ edits: [{ oldText: "C[Cache] --> ", newText: "" }] }),
      /^Edited the flowchart-v2 diagram with 1 edit, in line 2 of 2\. Nodes removed: "C"\.\n\nRevision: \d+\.$/,
    );
    assert.match(
      await editing({ edits: [{ oldText: "A[Parser]", newText: "A[Parser]" }] }),
      /^Nothing was changed, as the edits leave the diagram as it is\. Revision: \d+\.$/,
    );
  });

  test("changes nothing when an edit does not apply, quoting the closest lines", async () => {
    await draw();
    const revision = panel.revision;
    const sent = renders();
    assert.strictEqual(
      await editing({
        edits: [
          { oldText: "A[Parser]", newText: "A[Lexer]" },
          { oldText: "B[Checkr]", newText: "B[Typer]" },
        ],
      }),
      `Nothing was changed, as 1 of 2 edits does not apply. Send them all again, with it corrected. Revision: ${revision}.\n\nEdit 2: oldText is not in the source, as the edits before it left it. The closest lines are:\n1: flowchart LR\n2:   A[Lexer] --> B[Checker]`,
    );
    assert.match(
      await editing({
        edits: [
          { oldText: "-->", newText: "---" },
          { oldText: "]", newText: "]" },
        ],
      }),
      /^Nothing was changed, as 1 of 2 edits does not apply\.[\s\S]*Edit 2: oldText occurs 2 times, on line 2\./,
    );
    assert.strictEqual(panel.current?.source, flow);
    assert.strictEqual(panel.revision, revision);
    assert.strictEqual(renders(), sent);
  });

  test("refuses edits of a revision that is not the current one", async () => {
    await draw();
    const revision = panel.revision;
    await webview.edit(`${flow}\n  B --> D`);
    assert.strictEqual(
      await editing({ edits: [{ oldText: "B[Checker]", newText: "B[Typer]" }], revision }),
      `Nothing was changed: The diagram changed since revision ${revision}. Read diagram_getState and make the edits to its current source. Revision: ${panel.revision}.`,
    );
    // The user's edit stays, and is still theirs after an agent's edit of it.
    assert.match(
      await editing({ edits: [{ oldText: "B[Checker]", newText: "B[Typer]" }] }),
      /^Edited/,
    );
    assert.strictEqual(panel.current?.source, "flowchart LR\n  A[Parser] --> B[Typer]\n  B --> D");
    assert.strictEqual(panel.current?.editedByUser, true);
    assert.match(panel.describeForModel() ?? "", /The user edited this source/);
  });

  test("adds, moves and removes code links, and names those of nodes it no longer has", async () => {
    await draw({ links: { A: { file: "sizes.tsv" }, B: { file: "sizes.tsv", line: 2 } } });
    const removed = await editing({ edits: [{ oldText: "A[Parser]", newText: "P[Parser]" }] });
    assert.match(
      removed,
      /^Edited the flowchart-v2 diagram with 1 edit, in line 2 of 2\. Nodes added: "P"\. Nodes removed: "A"\.\n\nThese links name nodes the diagram does not have, so nothing opens from them: "A"\. Its node ids are "P", "B"\. Correct them with "links" in diagram_edit, e\.g\. \{"newId": "src\/file\.ts#L3", "oldId": null\}\.\n\nRevision: \d+\.$/,
    );
    assert.deepStrictEqual(Object.keys(panel.current?.links ?? {}), ["A", "B"]);

    const moved = await editing({
      edits: [],
      links: { A: null, P: "sizes.tsv#L3", Q: "made-up.ts", R: "sizes.tsv:4" },
    });
    assert.match(moved, /^Updated the flowchart-v2 diagram\. Its code links are on "B", "P"\./);
    assert.match(
      moved,
      /These links were left out:\n- "R": "sizes\.tsv:4" gives its line after a colon; .*\n- "Q": made-up\.ts does not exist\.\n.*Correct them with "links" in diagram_edit\.\n\nRevision: \d+\.$/,
    );
    assert.deepStrictEqual(panel.current?.links, {
      B: { file: "sizes.tsv", line: 2 },
      P: { file: "sizes.tsv", line: 3 },
    });
    assert.deepStrictEqual(webview.render.links, { B: "sizes.tsv#L2", P: "sizes.tsv#L3" });
    assert.match(
      await editing({ edits: [], links: { B: null, P: null } }),
      /It has no code links any more\./,
    );
    assert.strictEqual(panel.current?.links, undefined);
  });

  test("takes a title, which otherwise follows the source if it was taken from it", async () => {
    const titled = "---\ntitle: Pipeline\n---\nflowchart LR\n  A --> B";
    await draw({ source: titled, title: "Pipeline" });
    assert.match(
      await editing({ edits: [{ oldText: "Pipeline", newText: "Stages" }] }),
      /It is titled "Stages"\./,
    );
    assert.strictEqual(panel.current?.title, "Stages");
    await editing({ edits: [], title: "Build" });
    assert.strictEqual(panel.current?.title, "Build");
    await editing({ edits: [{ oldText: "Stages", newText: "Steps" }] });
    assert.strictEqual(panel.current?.title, "Build");
  });

  test("keeps a failed edit shown with its error and the lines around it, for the next edit to fix", async () => {
    await draw({ source: `${flow}\n  B --> C\n  C --> D`, links: { A: { file: "sizes.tsv" } } });
    const failed = await editing({ edits: [{ oldText: "B --> C", newText: "B -->--> C" }] });
    assert.strictEqual(
      failed,
      `The edited diagram failed to render with this error:\n\nParse error on line 3, column 5: unexpected "-->".\n\nLines 1-4 of the source:\n1: flowchart LR\n2:   A[Parser] --> B[Checker]\n3:   B -->--> C\n4:   C --> D\n\nThe panel shows it with this error. Fix it with diagram_edit.\n\nRevision: ${panel.revision}.`,
    );
    assert.match(panel.current?.error ?? "", /Parse error on line 3/);
    assert.match(panel.current?.source ?? "", /B -->--> C/);
    assert.match(
      await editing({ edits: [{ oldText: "-->-->", newText: "-->" }] }),
      /^Edited the flowchart-v2 diagram with 1 edit, in line 3 of 4\.\n\nRevision/,
    );
    assert.strictEqual(panel.current?.error, undefined);
    assert.deepStrictEqual(panel.current?.links, { A: { file: "sizes.tsv" } });
  });

  test("keeps the selection and the marks of the items that the edit keeps", async () => {
    await draw({ source: `${flow}\n  B --> C` });
    await webview.select([{ id: "A", label: "Parser" }]);
    assert.ok(
      panel.annotate({
        marks: [
          { id: "A", kind: "info", note: "reads" },
          { id: "C", kind: "problem", note: "slow" },
        ],
        dim: false,
      }).ok,
    );
    assert.match(await editing({ edits: [{ oldText: "\n  B --> C", newText: "" }] }), /^Edited/);
    assert.deepStrictEqual(webview.render.selection, ["A"]);
    const described = panel.describeForModel() ?? "";
    assert.match(described, /reads/);
    assert.doesNotMatch(described, /slow/);
    const marks = webview.sent.findLast((message) => message.type === "annotate");
    assert.deepStrictEqual(marks?.type === "annotate" && marks.marks.map(({ id }) => id), ["A"]);
  });

  test("leaves a diagram opened from Markdown to Apply or Write to, which ask first", async () => {
    const file = path.join(tempDir("diagram-edit-"), "notes.md");
    const markdown = `# Notes\n\n\`\`\`mermaid\n${flow}\n\`\`\`\n`;
    fs.writeFileSync(file, markdown);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const [fence] = findDiagramFences(document.getText());
    assert.ok(fence);
    const opened = await panel.render(
      {
        language: "mermaid",
        source: fence.source,
        title: "Notes",
        document: { uri: document.uri.toString(), fence },
      },
      "document",
    );
    assert.ok(opened.ok);
    const result = await editing({ edits: [{ oldText: "B[Checker]", newText: "B[Typer]" }] });
    assert.match(
      result,
      /^Edited .*\n\nThe diagram was opened from a code block in notes\.md\. The change is in the panel only, until the user writes it to that file with Apply or Write to\.\n\nRevision: \d+\.$/,
    );
    assert.strictEqual(document.getText(), markdown);
    assert.strictEqual(panel.current?.document?.replaced, true);
    const details: unknown[] = [];
    const warnings = recordMessages("showWarningMessage", (_, options) => {
      details.push((options as vscode.MessageOptions).detail);
    });
    await webview.receive({ type: "writeToDocument", requestId: webview.render.requestId });
    assert.match(warnings[0] ?? "", /^Write this diagram to notes\.md\?/);
    assert.match(
      String(details[0]),
      /^An agent changed the diagram that was opened from notes\.md\./,
    );
    assert.strictEqual(document.getText(), markdown);
  });

  test("edits a chart's styling as the user's own edit, which chart updates keep", async () => {
    webview.answer = (message) =>
      message.type === "render"
        ? { type: "rendered", requestId: message.requestId, diagramType: "bar" }
        : undefined;
    const chart = { type: "bar", data: "name,amount\na,1\nb,2\nc,3" };
    assert.match(await invokeTool(new ChartTool(panel), chart), /^Rendered the bar chart/);
    const source = panel.current?.source ?? "";
    // The end of the option, which no nested object shares, as they are indented.
    const styled = await editing({
      edits: [{ oldText: "\n}", newText: ',\n  "backgroundColor": "#123456"\n}' }],
    });
    assert.match(
      styled,
      /^Edited the bar chart with 1 edit, in lines \d+-\d+ of \d+\. As an edit of its styling, it stays when diagram_updateChart or Refresh rebuilds the chart\.\n\nRevision: \d+\.$/,
    );
    assert.deepStrictEqual(panel.current?.chartPresentation?.edits, [
      { path: ["backgroundColor"], value: "#123456" },
    ]);
    assert.match(
      await invokeTool(new UpdateChartTool(panel), { type: "line" }),
      /^Updated the bar chart/,
    );
    assert.strictEqual(JSON.parse(panel.current?.source ?? "").backgroundColor, "#123456");
    assert.strictEqual(JSON.parse(panel.current?.source ?? "").series[0].type, "line");

    const before = panel.current;
    const structural = await editing({
      edits: [{ oldText: '"type": "line"', newText: '"type": "bar"' }],
    });
    assert.match(
      structural,
      /^Nothing was changed, as the source changes the chart's data or structure: Refresh and diagram_updateChart rebuild this chart from its data, keeping only edits of its styling\. Change its type, columns, grouping, sort, limit or filters with diagram_updateChart, and its data with diagram_chart\. To draw what they cannot, write the whole option with diagram_render\. Revision: \d+\.$/,
    );
    const invalid = await editing({
      edits: [{ oldText: '"backgroundColor": "#123456"', newText: '"backgroundColor": #123456' }],
    });
    assert.match(
      invalid,
      /^Nothing was changed, as a chart made by diagram_chart must stay JSON, for Refresh and diagram_updateChart to rebuild it, and the edited option is not JSON: Unexpected token '#'\. Revision: \d+\.\n\nLines \d+-\d+ of the source, where it changed:\n(?:\d+: .*\n)*\d+: {3}"backgroundColor": #123456\n[\s\S]*Correct the edits\. For callbacks, write the whole option with diagram_render\.$/,
    );
    assert.match(
      await editing({
        edits: [{ oldText: '"#123456"', newText: '"#123456" "color": ["red"]' }],
      }),
      /the edited option is not JSON: Expected ',' or '\}' after property value in JSON at position \d+ \(line \d+ column \d+\)\. Revision: \d+\.\n\nLines \d+-\d+ of the edited option:\n[\s\S]*\n\d+: {3}"backgroundColor": "#123456" "color": \["red"\]\n/,
    );
    assert.match(
      await editing({ edits: [], title: "Sales" }),
      /Change the title of a chart made by diagram_chart with diagram_updateChart\./,
    );
    assert.strictEqual(panel.current, before);
    assert.notStrictEqual(source, panel.current?.source);
  });

  test("edits a chart whose source was not kept only once it is drawn again", async () => {
    const values = new Map<string, unknown>([
      [
        "diagram.state",
        {
          language: "echarts",
          title: "Sizes",
          chart: { type: "bar", file: "sizes.tsv" },
          origin: "tool",
          editedByUser: false,
        },
      ],
    ]);
    const restored = newPanel(values);
    try {
      assert.match(
        await invokeTool(new EditDiagramTool(restored), {
          edits: [{ oldText: "bar", newText: "line" }],
        }),
        /^Nothing was changed: The chart's source was not kept when VS Code restarted\. Ask the user to press Refresh/,
      );
    } finally {
      restored.dispose();
    }
  });

  test("corrects the links that diagram_render could not add, without the source", async () => {
    const rendered = await invokeTool(new RenderDiagramTool(panel), {
      source: flow,
      links: { Parser: "sizes.tsv", B: "sizes.tsv:2" },
    });
    assert.match(
      rendered,
      /These links name nodes the diagram does not have, so nothing opens from them: "Parser"\. Its node ids are "A", "B"\. Correct them with "links" in diagram_edit, e\.g\. \{"newId": "src\/file\.ts#L3", "oldId": null\}\.\n\nRevision: \d+\.$/,
    );
    assert.match(rendered, /- "B": "sizes\.tsv:2" gives its line after a colon/);
    assert.strictEqual(
      await editing({ edits: [], links: { Parser: null, A: "sizes.tsv", B: "sizes.tsv#L2" } }),
      `Updated the flowchart-v2 diagram. Its code links are on "A", "B".\n\nRevision: ${panel.revision}.`,
    );
    assert.strictEqual(panel.current?.source, flow);
  });

  test("diagram_render gives the lines around an error, to fix with an edit", async () => {
    const result = await invokeTool(new RenderDiagramTool(panel), {
      source: `${flow}\n  B -->--> C`,
    });
    assert.match(
      result,
      /^The diagram failed to render with this error:\n\nParse error on line 3, column 5: unexpected "-->"\.\n\nLines 1-3 of the source:\n1: flowchart LR\n2: {3}A\[Parser\] --> B\[Checker\]\n3: {3}B -->--> C\n\nFix the Mermaid syntax with diagram_edit, or call diagram_render again with the complete corrected source\./,
    );
    assert.match(await editing({ edits: [{ oldText: "-->-->", newText: "-->" }] }), /^Edited/);
    assert.strictEqual(panel.current?.error, undefined);
  });
});

suite("diagram_edit in the webview", function () {
  // The first render loads the webview and the libraries, which can take a while.
  this.timeout(20_000);

  const page = suitePage();
  const { evaluate, draw } = page;
  const editing = (input: unknown) => invokeTool(new EditDiagramTool(page.panel), input);

  test("gives the lines around a Mermaid error, which the next edit fixes", async () => {
    await draw({ source: "flowchart LR\n  A --> B\n  B --> C\n  C --> D" });
    const failed = await editing({ edits: [{ oldText: "B --> C", newText: "B --> --> C" }] });
    assert.match(
      failed,
      /^The edited diagram failed to render with this error:\n\n.*line 3[\s\S]*\n\nLines 1-4 of the source:\n1: flowchart LR\n2: {3}A --> B\n3: {3}B --> --> C\n4: {3}C --> D\n\nThe panel shows it with this error\. Fix it with diagram_edit\.\n\nRevision: \d+\.$/,
    );
    assert.match(await editing({ edits: [{ oldText: "--> -->", newText: "-->" }] }), /^Edited/);
    assert.strictEqual(page.panel.current?.error, undefined);
  });

  test("gives the lines around an ECharts error", async () => {
    await draw({
      language: "echarts",
      source:
        '{\n  "xAxis": {"data": ["a", "b"]},\n  "yAxis": {},\n  "series": [{"type": "bar", "data": [1, 2]}]\n}',
    });
    const failed = await editing({ edits: [{ oldText: "[1, 2]", newText: "[1 2]" }] });
    assert.match(
      failed,
      /^The edited chart failed to render with this error:\n\n.*\(line 4, column \d+\)/,
    );
    assert.match(
      failed,
      /\n\nLines 1-5 of the source:\n1: \{\n[\s\S]*4: {3}"series": \[\{"type": "bar", "data": \[1 2\]\}\]\n5: \}\n\n/,
    );
  });

  test("gives a subgraph the id that diagram_style asks for, to color it", async () => {
    await draw({ source: 'flowchart LR\n  subgraph "Payment flow"\n    A --> B\n  end' });
    const style = (id: string) =>
      invokeTool(new StyleDiagramTool(page.panel), { styles: [{ id, fill: "green" }] });
    assert.match(
      await style("Payment flow"),
      /"Payment flow" is a label, not an id in the source, so no style line can name it\. Give the subgraph an id with diagram_edit first, e\.g\. `subgraph pay \[Payment flow\]`\./,
    );
    assert.match(
      await editing({
        edits: [{ oldText: 'subgraph "Payment flow"', newText: 'subgraph pay ["Payment flow"]' }],
      }),
      /^Edited the flowchart-v2 diagram with 1 edit, in line 2 of 4\./,
    );
    assert.match(await style("pay"), /^Styled "pay" \(fill green/);
  });

  test("keeps the user's unapplied edits of the source, as with any incoming diagram", async () => {
    await draw({ source: "flowchart LR\n  A --> B" });
    const draft = "flowchart LR\n  A --> B\n  B --> Draft";
    afterTest(() => evaluate('document.getElementById("view-visual").click()'));
    await evaluate(`(() => {
      document.getElementById("view-split").click();
      const input = document.getElementById("source");
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      document.execCommand("insertText", false, "\\n  B --> Draft");
    })()`);
    assert.match(await editing({ edits: [{ oldText: "A --> B", newText: "A --> C" }] }), /^Edited/);
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        ${UNTIL}
        await until(() => !document.getElementById("stale-note").hidden, "the stale note");
        return {source: document.getElementById("source").value,
          apply: !document.getElementById("apply").disabled};
      })()`),
      { source: draft, apply: true },
    );
    assert.strictEqual(page.panel.current?.source, "flowchart LR\n  A --> C");
  });
});
