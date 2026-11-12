import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { EditDiagramTool } from "../editTool";
import { findDiagramFences } from "../fences";
import type { DiagramPanel, Drawn } from "../panel";
import { applySourceEdits, errorContext, type SourceEdit } from "../sourceEdits";
import { lineAndColumn } from "../text";
import { RenderDiagramTool } from "../tools";
import { afterTest, assertLinearTime, recordMessages, tempDir } from "./afterTest";
import { type FakeWebview, newFakePanel } from "./newPanel";
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

  test("reject empty matches without committing other edits", () => {
    for (const replaceAll of [false, true]) {
      assert.deepStrictEqual(
        applySourceEdits(source, [edit("C[Done]", "C[Finished]"), edit("", "x", replaceAll)]),
        { ok: false, problems: ["Edit 2: oldText must not be empty."] },
      );
    }
  });

  test("count nonoverlapping replacements and keep replacement text literal", () => {
    assert.deepStrictEqual(applySourceEdits("aab", [edit("ab", "$&")]), {
      ok: true,
      source: "a$&",
      replaced: [1],
    });
    assert.deepStrictEqual(applySourceEdits("aaaaa", [edit("aa", "$&", true)]), {
      ok: true,
      source: "$&$&a",
      replaced: [2],
    });
  });

  test("locate whitespace-only differences in the original lines", () => {
    const source = "header\r\n\r\n  first[]\r\n \tvalue(*)  \r\n  last?\r\nfooter";
    assert.match(
      problems(source, [edit("first[] value(*) last?", "")])[0] ?? "",
      /differs from lines 3-5 only in whitespace.*\n3: {3}first\[\]\n4: {2}\tvalue\(\*\) {2}\n5: {3}last\?/,
    );
  });

  test("handle unmatched edits in large runs of repeated chart values", () => {
    const values = "1, ".repeat(20_000);
    assert.match(
      problems(`{\n  data: [${values}2]\n}`, [edit(`${values}3`, "")])[0] ?? "",
      /oldText is not in the source.*The closest lines are:/,
    );
  });

  test("compare long unmatched replacements with many short lines in linear time", () => {
    assertLinearTime((count) => {
      const source = "a b\n".repeat(count);
      const labels = Array.from({ length: count }, (_, i) => String.fromCharCode(0x3400 + i)).join(
        "",
      );
      const edits = [edit(`a b ${labels}`, "")];
      return () =>
        assert.deepStrictEqual(problems(source, edits), [
          "Edit 1: oldText is not in the source. The closest lines are:\n1: a b\n2: a b",
        ]);
    }, 750);
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
    // Overlapping occurrences, which would leave which one to change to chance, and of which
    // "replaceAll" changes only those that do not overlap.
    assert.deepStrictEqual(problems('{"data": [5, 5, 5]}', [edit("5, 5", "5, 6")]), [
      'Edit 1: oldText occurs 2 times, on line 1, overlapping, so "replaceAll" would not change every one. Include more of the text around the one to change:\n1: {"data": [5, 5, 5]}',
    ]);
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
      "There is no diagram to edit. Render one with diagram_render first.",
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
      'Nothing was changed: Edit 1 needs a non-empty "oldText" and a "newText" string.',
    );
  });

  test("replaces exact text, keeping the title, click prompt and code links", async () => {
    await draw({ clickPrompt: "Explain {label}", links: { A: { file: "sizes.tsv", line: 1 } } });
    const result = await editing({
      // As a JSON string, as some models send arrays.
      edits: JSON.stringify([
        { oldText: "--> B[Checker]", newText: "--> C[Cache] --> B[Checker]" },
      ]),
    });
    assert.strictEqual(result, "Edited the flowchart-v2 diagram.");
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
      "Nothing was changed:\n\nEdit 2: oldText is not in the source, as the edits before it left it. The closest lines are:\n1: flowchart LR\n2:   A[Lexer] --> B[Checker]",
    );
    assert.match(
      await editing({
        edits: [
          { oldText: "-->", newText: "---" },
          { oldText: "]", newText: "]" },
        ],
      }),
      /^Nothing was changed:[\s\S]*Edit 2: oldText occurs 2 times, on line 2\./,
    );
    assert.strictEqual(panel.current?.source, flow);
    assert.strictEqual(panel.revision, revision);
    assert.strictEqual(renders(), sent);
  });

  test("adds, moves and removes code links, and names those of nodes it no longer has", async () => {
    await draw({ links: { A: { file: "sizes.tsv" }, B: { file: "sizes.tsv", line: 2 } } });
    const removed = await editing({ edits: [{ oldText: "A[Parser]", newText: "P[Parser]" }] });
    assert.match(
      removed,
      /^Edited the flowchart-v2 diagram\.\n\nThese links name nodes the diagram does not have: "A"\. Its node ids are "P", "B"\.$/,
    );
    assert.deepStrictEqual(Object.keys(panel.current?.links ?? {}), ["A", "B"]);

    const moved = await editing({
      edits: [],
      links: { A: null, P: "sizes.tsv#L3", Q: "made-up.ts", R: "sizes.tsv:4" },
    });
    assert.match(
      moved,
      /^Edited the flowchart-v2 diagram\.\n\nThese links were left out:\n- "R": "sizes\.tsv:4" gives its line after a colon; .*\n- "Q": made-up\.ts does not exist\.\n/,
    );
    assert.deepStrictEqual(panel.current?.links, {
      B: { file: "sizes.tsv", line: 2 },
      P: { file: "sizes.tsv", line: 3 },
    });
    assert.deepStrictEqual(webview.render.links, { B: "sizes.tsv#L2", P: "sizes.tsv#L3" });
    await editing({ edits: [], links: { B: null, P: null } });
    assert.strictEqual(panel.current?.links, undefined);
  });

  test("takes a title, which otherwise follows the source if it was taken from it", async () => {
    const titled = "---\ntitle: Pipeline\n---\nflowchart LR\n  A --> B";
    await draw({ source: titled, title: "Pipeline" });
    await editing({ edits: [{ oldText: "Pipeline", newText: "Stages" }] });
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
      'The diagram fails to render:\n\nParse error on line 3, column 5: unexpected "-->".\n\nLines 1-4 of the source:\n1: flowchart LR\n2:   A[Parser] --> B[Checker]\n3:   B -->--> C\n4:   C --> D\n\nThe panel shows the error. Fix it with diagram_edit or diagram_render.',
    );
    assert.match(panel.current?.error ?? "", /Parse error on line 3/);
    assert.match(panel.current?.source ?? "", /B -->--> C/);
    assert.match(
      await editing({ edits: [{ oldText: "-->-->", newText: "-->" }] }),
      /^Edited the flowchart-v2 diagram\.$/,
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
          { id: "A", kind: "info" },
          { id: "C", kind: "problem" },
        ],
        dim: false,
      }).ok,
    );
    assert.match(await editing({ edits: [{ oldText: "\n  B --> C", newText: "" }] }), /^Edited/);
    assert.deepStrictEqual(webview.render.selection, ["A"]);
    const described = panel.describeForModel() ?? "";
    assert.match(described, /Marked: "A" \(info\)\./);
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
    assert.match(result, /^Edited the flowchart-v2 diagram\.$/);
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

  test("corrects the links that diagram_render could not add, without the source", async () => {
    const rendered = await invokeTool(new RenderDiagramTool(panel), {
      source: flow,
      links: { Parser: "sizes.tsv", B: "sizes.tsv:2" },
    });
    assert.match(
      rendered,
      /\n\nThese links name nodes the diagram does not have: "Parser"\. Its node ids are "A", "B"\.$/,
    );
    assert.match(rendered, /- "B": "sizes\.tsv:2" gives its line after a colon/);
    assert.strictEqual(
      await editing({ edits: [], links: { Parser: null, A: "sizes.tsv", B: "sizes.tsv#L2" } }),
      "Edited the flowchart-v2 diagram.",
    );
    assert.strictEqual(panel.current?.source, flow);
  });

  test("diagram_render gives the lines around an error, to fix with an edit", async () => {
    const result = await invokeTool(new RenderDiagramTool(panel), {
      source: `${flow}\n  B -->--> C`,
    });
    assert.match(
      result,
      /^The diagram fails to render:\n\nParse error on line 3, column 5: unexpected "-->"\.\n\nLines 1-3 of the source:\n1: flowchart LR\n2: {3}A\[Parser\] --> B\[Checker\]\n3: {3}B -->--> C\n\nThe panel shows the error\. Fix it with diagram_edit or diagram_render\.$/,
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
      /^The diagram fails to render:\n\n.*line 3[\s\S]*\n\nLines 1-4 of the source:\n1: flowchart LR\n2: {3}A --> B\n3: {3}B --> --> C\n4: {3}C --> D\n\nThe panel shows the error\. Fix it with diagram_edit or diagram_render\.$/,
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
    assert.match(failed, /^The chart fails to render:\n\n.*\(line 4, column \d+\)/);
    assert.match(
      failed,
      /\n\nLines 1-5 of the source:\n1: \{\n[\s\S]*4: {3}"series": \[\{"type": "bar", "data": \[1 2\]\}\]\n5: \}\n\n/,
    );
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
