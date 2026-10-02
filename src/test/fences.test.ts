import * as assert from "node:assert";
import {
  type DiagramFence,
  fenceAt,
  findDiagramFences,
  isDiagramFence,
  relocateFence,
} from "../fences";

/**
 * The diagrams in a document, as "<opening fence line>-<last content line> <language> <indentation>".
 */
function sources(markdown: string): string[] {
  return findDiagramFences(markdown).map(
    ({ language, source, openingLine, lastLine, indent }) =>
      `${openingLine}-${lastLine} ${language} ${JSON.stringify(indent)}: ${JSON.stringify(source)}`,
  );
}

suite("fences", () => {
  test("findDiagramFences finds mermaid and echarts blocks with their content lines", () => {
    const markdown = [
      "# Notes",
      "",
      "```mermaid",
      "flowchart TD",
      "  A --> B",
      "```",
      "",
      "```echarts",
      '{"series": []}',
      "```",
      "",
    ].join("\n");
    assert.deepStrictEqual(findDiagramFences(markdown), [
      {
        language: "mermaid",
        source: "flowchart TD\n  A --> B",
        openingLine: 2,
        lastLine: 4,
        indent: "",
      },
      { language: "echarts", source: '{"series": []}', openingLine: 7, lastLine: 8, indent: "" },
    ]);
  });

  test("findDiagramFences reads an info string with words after the language", () => {
    assert.deepStrictEqual(sources("```mermaid title=Flow {highlight}\nflowchart TD\n```"), [
      '0-1 mermaid "": "flowchart TD"',
    ]);
    // The language must be the whole first word.
    assert.deepStrictEqual(sources("```mermaidx\nflowchart TD\n```"), []);
  });

  test("findDiagramFences handles longer fences and tilde fences", () => {
    assert.deepStrictEqual(sources("````mermaid\n```\nflowchart TD\n```\n````"), [
      '0-3 mermaid "": "```\\nflowchart TD\\n```"',
    ]);
    assert.deepStrictEqual(sources("~~~ echarts\n{}\n~~~~~\n"), ['0-1 echarts "": "{}"']);
    // A shorter closing fence, or one of the other character, does not close the block.
    assert.deepStrictEqual(sources("````mermaid\nA --> B\n```\n"), [
      '0-2 mermaid "": "A --> B\\n```"',
    ]);
    assert.deepStrictEqual(sources("~~~mermaid\nA --> B\n```\n"), [
      '0-2 mermaid "": "A --> B\\n```"',
    ]);
  });

  test("findDiagramFences keeps the indentation of a fence in a list item", () => {
    const markdown = [
      "1. The flow:",
      "",
      "   ```mermaid",
      "   flowchart TD",
      "       A --> B",
      "",
      "   ```",
      "",
      "2. Done.",
    ].join("\n");
    // The fence's own indentation is removed from each line, and deeper indentation is kept.
    assert.deepStrictEqual(sources(markdown), ['2-5 mermaid "   ": "flowchart TD\\n    A --> B"']);
    // A tab counts as one character of indentation.
    assert.deepStrictEqual(sources("\t```mermaid\n\t\tflowchart TD\n\t```"), [
      '0-1 mermaid "\\t": "\\tflowchart TD"',
    ]);
  });

  test("findDiagramFences takes a fence that is never closed to the end of the document", () => {
    assert.deepStrictEqual(sources("```mermaid\nflowchart TD\n  A --> B\n"), [
      '0-2 mermaid "": "flowchart TD\\n  A --> B"',
    ]);
    assert.deepStrictEqual(sources("```mermaid\nflowchart TD"), ['0-1 mermaid "": "flowchart TD"']);
    assert.deepStrictEqual(sources("```mermaid\n"), []);
    assert.deepStrictEqual(sources("```mermaid"), []);
  });

  test("findDiagramFences skips other languages, their contents and empty blocks", () => {
    // A diagram fence inside another code block is code, not a diagram of its own.
    assert.deepStrictEqual(sources("````md\n```mermaid\nflowchart TD\n```\n````\n"), []);
    assert.deepStrictEqual(sources("```ts\nconst x = 1;\n```\n"), []);
    assert.deepStrictEqual(sources("```\nflowchart TD\n```\n"), []);
    assert.deepStrictEqual(sources("```mermaid\n```\n```mermaid\n\n  \n```\n"), []);
    // Fences that are not on a line of their own neither open nor close a block.
    assert.deepStrictEqual(sources("Use a ```mermaid``` block.\n"), []);
  });

  test("findDiagramFences counts lines as VS Code does, whatever the line endings", () => {
    assert.deepStrictEqual(sources("# Notes\r\n```mermaid\r\nflowchart TD\r\n```\r\n"), [
      '1-2 mermaid "": "flowchart TD"',
    ]);
  });

  test("fenceAt finds the fence at, below and above the cursor", () => {
    //         0     1            2   3     4            5   6
    const text = "a\n```mermaid\nA\n```\n```mermaid\nB\n```\nz\n";
    const fences = findDiagramFences(text);
    assert.deepStrictEqual(
      [0, 1, 2, 3, 4, 5, 6, 7].map((line) => fenceAt(fences, line)?.source),
      ["A", "A", "A", "A", "B", "B", "B", "B"],
    );
    assert.strictEqual(fenceAt([], 0), undefined);
  });

  test("relocateFence finds a fence that moved, and nothing when it changed", () => {
    const read: DiagramFence = {
      language: "mermaid",
      source: "flowchart TD\n  A --> B",
      openingLine: 2,
      lastLine: 4,
      indent: "",
    };
    const moved = findDiagramFences(
      "# Notes\n\nText was added above.\n\n```mermaid\nflowchart TD\n  A --> B\n```\n",
    );
    assert.strictEqual(relocateFence(moved, read)?.openingLine, 4);
    // Edited in the document, gone from it, or now written in another language.
    const edited = findDiagramFences("```mermaid\nflowchart TD\n  A --> C\n```\n");
    assert.strictEqual(relocateFence(edited, read), undefined);
    assert.strictEqual(relocateFence([], read), undefined);
    const other = findDiagramFences("```echarts\nflowchart TD\n  A --> B\n```\n");
    assert.strictEqual(relocateFence(other, read), undefined);
  });

  test("relocateFence takes the copy nearest to where the fence was", () => {
    const text = "```mermaid\nA\n```\n```mermaid\nA\n```\n```mermaid\nA\n```\n";
    const fences = findDiagramFences(text);
    const read = { language: "mermaid", source: "A", indent: "" } as const;
    const near = (openingLine: number) =>
      relocateFence(fences, { ...read, openingLine, lastLine: openingLine + 1 })?.openingLine;
    assert.deepStrictEqual([near(0), near(3), near(5), near(9)], [0, 3, 6, 6]);
  });

  test("isDiagramFence accepts only fences, as a command may be called with anything", () => {
    const fence: DiagramFence = {
      language: "mermaid",
      source: "flowchart TD",
      openingLine: 0,
      lastLine: 1,
      indent: "",
    };
    assert.ok(isDiagramFence(fence));
    const malformed: unknown[] = [
      null,
      undefined,
      "```mermaid",
      [fence],
      { ...fence, language: "dot" },
      { ...fence, source: 1 },
      { ...fence, indent: undefined },
      { ...fence, openingLine: -1 },
      { ...fence, openingLine: 1.5 },
      // The content must be at least one line long, below the opening fence.
      { ...fence, lastLine: 0 },
    ];
    for (const value of malformed) {
      assert.ok(!isDiagramFence(value), JSON.stringify(value));
    }
  });
});
