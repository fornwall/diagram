import * as assert from "node:assert";
import * as vscode from "vscode";
import type { DiagramPanel } from "../panel";
import { searchSource } from "../stateSearch";
import { GetDiagramStateTool } from "../tools";
import { cancellationSource } from "./afterTest";
import { newFakePanel, newPanel } from "./newPanel";
import { invokeTool } from "./toolText";

suite("source search", () => {
  let panel: DiagramPanel;
  const source = 'flowchart TD\r\n  A["price.*"] --> B\r  B --> C\n  C --> A';
  setup(() => {
    panel = newPanel(
      new Map([
        ["diagram.state", { language: "mermaid", source, title: "Search", origin: "tool" }],
      ]),
    );
  });
  teardown(() => panel.dispose());
  const read = (input: object) => invokeTool(new GetDiagramStateTool(panel), input);

  test("finds literal text and returns exact context with original line endings", async () => {
    const result = await read({ query: "price.*", contextLines: 1 });
    assert.match(result, /^Revision: 0\. mermaid source search: 1 matching lines/);
    assert.match(result, /Match 1 at line 2; source lines 1-3/);
    assert.ok(
      result.includes(
        `\x60\x60\x60mermaid\n${source.slice(0, source.lastIndexOf("\n") + 1)}\n\x60\x60\x60`,
      ),
    );
    assert.match(result, /End of matches/);
    assert.match(result, /restart the search before editing/);
  });

  test("pages by matching line and keeps query and context in its continuation", async () => {
    const result = await read({ detail: "search", query: "B", maxMatches: 1, contextLines: 0 });
    assert.match(result, /2 matching lines/);
    assert.match(result, /Match 1 at line 2; source lines 2-2/);
    assert.match(result, /"query":"B","startMatch":2,"maxMatches":1,"contextLines":0/);
    const next = await read({ query: "B", startMatch: 2, maxMatches: 1, contextLines: 0 });
    assert.match(next, /Match 2 at line 3; source lines 3-3/);
    assert.ok(next.includes("  B --> C\n"));
    assert.match(next, /End of matches/);
    assert.doesNotMatch(next, /price/);
  });

  test("matches case-sensitively and explains missing or exhausted results", async () => {
    assert.match(await read({ query: "PRICE" }), /0 matching lines[\s\S]*No matches/);
    assert.match(await read({ query: "B", startMatch: 3 }), /Match 3 is past the end/);
    assert.match(await read({ query: "." }), /1 matching lines/);
    const result = await read({ query: " ", contextLines: 0 });
    assert.match(result, /4 matching lines/);
  });

  test("rejects incomplete search parameters and conflicting read modes", async () => {
    for (const input of [
      { detail: "search" },
      { query: "" },
      { query: 1 },
      { query: "A\nB" },
      { query: "A\rB" },
      { query: "A".repeat(1001) },
      { query: "A", detail: "full" },
      { query: "A", detail: "source" },
      { query: "A", startLine: 1 },
      { query: "A", endLine: 2 },
      { query: "A", startMatch: 0 },
      { query: "A", startMatch: 1.5 },
      { query: "A", maxMatches: 51 },
      { query: "A", maxMatches: "1" },
      { query: "A", contextLines: -1 },
      { query: "A", contextLines: 11 },
      { maxMatches: 1 },
      { contextLines: 0 },
    ]) {
      assert.match(await read(input), /^The diagram was not read:/, JSON.stringify(input));
    }
  });

  test("fits diagnostics without echoing an oversized or escaped query", async () => {
    panel.dispose();
    panel = newPanel(
      new Map([
        [
          "diagram.state",
          {
            language: "mermaid",
            source: "x".repeat(1000),
            title: "Long",
            origin: "tool",
          },
        ],
      ]),
    );
    for (const [input, expected] of [
      [{ query: "\t".repeat(1000) }, /No matches/],
      [{ query: "x".repeat(1000), startMatch: 2 }, /Match 2 is past the end/],
      [{ query: "x".repeat(1000) }, /Match 1 at line 1 needs a larger result budget/],
    ] as const) {
      const result = await invokeTool(new GetDiagramStateTool(panel), input, undefined, {
        tokenBudget: 100,
        countTokens: async (text) => text.length,
      });
      assert.ok(result.length <= 100, result);
      assert.match(result, /^Revision: 0\./);
      assert.match(result, expected);
      assert.doesNotMatch(result, /xxx|\\t/);
    }
  });

  test("fits a dense chart page without cutting a block or skipping matches", async () => {
    panel.dispose();
    const lines = Array.from({ length: 80 }, (_, i) => `  "label${i}": "${"value ".repeat(30)}",`);
    panel = newPanel(
      new Map([
        [
          "diagram.state",
          {
            language: "echarts",
            source: `{\n${lines.join("\n")}\n}`,
            title: "Chart",
            origin: "tool",
          },
        ],
      ]),
    );
    const result = await invokeTool(
      new GetDiagramStateTool(panel),
      { query: "label", contextLines: 0 },
      undefined,
      {
        tokenBudget: 1600,
        countTokens: async (text) => text.length,
      },
    );
    assert.ok(result.length <= 1600);
    const continuation = /"startMatch":(\d+)/.exec(result);
    assert.ok(continuation, result);
    const next = Number(continuation[1]);
    assert.ok(next > 1 && next <= 20);
    assert.ok(result.includes(`${lines[next - 2]}\n\n\x60\x60\x60`), result);
    assert.doesNotMatch(result, new RegExp(`"label${next - 1}"`));
    const page = await read({ query: "label", startMatch: next, maxMatches: 1, contextLines: 0 });
    assert.ok(page.includes(lines[next - 1] ?? assert.fail("missing match")));
  });

  test("reports an oversized matching line without returning partial source", async () => {
    panel.dispose();
    panel = newPanel(
      new Map([
        [
          "diagram.state",
          {
            language: "echarts",
            source: `{"data":[${"1,".repeat(1000)}1]}`,
            title: "Chart",
            origin: "tool",
          },
        ],
      ]),
    );
    const result = await invokeTool(new GetDiagramStateTool(panel), { query: "data" }, undefined, {
      tokenBudget: 400,
      countTokens: async (text) => text.length / 4,
    });
    assert.match(result, /Match 1 at line 1 does not fit/);
    assert.match(result, /"contextLines": 0/);
    assert.doesNotMatch(result, /```|1,1/);
  });

  test("merges overlapping context before building oversized result candidates", async () => {
    const large = [
      ...Array<string>(10).fill("label"),
      "x".repeat(100_000),
      ...Array<string>(10).fill("label"),
    ].join("\n");
    let largest = 0;
    const result = await searchSource(
      large,
      "echarts",
      7,
      { query: "label", contextLines: 10 },
      async (text) => {
        largest = Math.max(largest, text.length);
        return text.length <= 2000;
      },
    );
    assert.ok(largest < large.length + 2000, `Duplicated context: ${largest} characters`);
    assert.match(result, /no source was returned/);
    assert.ok(result.length <= 2000);
  });

  test("keeps source and revision together when token counting yields to another edit", async () => {
    const { panel: shown } = await newFakePanel();
    await shown.render({ language: "mermaid", source, title: "Original" }, "tool");
    const revision = shown.revision;
    let changed = false;
    const result = await invokeTool(new GetDiagramStateTool(shown), { query: "B" }, undefined, {
      tokenBudget: 1000,
      countTokens: async (text) => {
        if (!changed) {
          changed = true;
          await shown.render(
            { language: "mermaid", source: "flowchart TD\n Replacement", title: "New" },
            "tool",
          );
        }
        return text.length / 4;
      },
    });
    assert.ok(changed);
    assert.match(result, new RegExp(`^Revision: ${revision}\\.`));
    assert.match(result, /price/);
    assert.doesNotMatch(result, /Replacement/);
    assert.notStrictEqual(shown.revision, revision);
  });

  test("cancels while waiting for search token counts", async () => {
    const cancellation = cancellationSource();
    await assert.rejects(
      invokeTool(new GetDiagramStateTool(panel), { query: "B" }, cancellation.token, {
        tokenBudget: 200,
        countTokens: () => {
          cancellation.cancel();
          return new Promise<number>(() => {});
        },
      }),
      vscode.CancellationError,
    );
  });
});
