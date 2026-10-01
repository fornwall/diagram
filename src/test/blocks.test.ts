import * as assert from "node:assert";
import { DiagramBlockFilter, extractDiagramBlocks, guessTitle } from "../blocks";

suite("blocks", () => {
  test("extractDiagramBlocks finds all mermaid and echarts blocks in order", () => {
    const markdown = [
      "Here you go:",
      "```mermaid",
      "flowchart TD",
      "  A --> B",
      "```",
      "```ts",
      "const x = 1;",
      "```",
      "```mermaid  ",
      "sequenceDiagram",
      "  A->>B: hi",
      "```",
      "```echarts",
      '{"series": []}',
      "```",
    ].join("\n");
    assert.deepStrictEqual(extractDiagramBlocks(markdown), [
      { language: "mermaid", source: "flowchart TD\n  A --> B" },
      { language: "mermaid", source: "sequenceDiagram\n  A->>B: hi" },
      { language: "echarts", source: '{"series": []}' },
    ]);
  });

  test("extractDiagramBlocks ignores unterminated and empty blocks", () => {
    assert.deepStrictEqual(extractDiagramBlocks("```mermaid\n```\n```mermaid\nflowchart"), []);
  });

  test("guessTitle uses the frontmatter title", () => {
    assert.strictEqual(
      mermaidTitle('---\ntitle: "Login flow"\n---\nsequenceDiagram'),
      "Login flow",
    );
  });

  test("guessTitle falls back to the diagram type", () => {
    assert.strictEqual(mermaidTitle("%% comment\n\nflowchart LR\n  A --> B"), "flowchart");
    assert.strictEqual(mermaidTitle("---\nconfig:\n  theme: dark\n---\nerDiagram"), "erDiagram");
    assert.strictEqual(mermaidTitle(""), "Diagram");
  });

  test("guessTitle uses the title of an ECharts option", () => {
    const chartTitle = (source: string) => guessTitle({ language: "echarts", source });
    assert.strictEqual(chartTitle('{"title": {"text": "Sales"}, "series": []}'), "Sales");
    assert.strictEqual(chartTitle('{"title": [{"text": "First"}]}'), "First");
    assert.strictEqual(chartTitle('{"series": []}'), "Chart");
    assert.strictEqual(chartTitle("{not json"), "Chart");
  });

  function mermaidTitle(source: string): string {
    return guessTitle({ language: "mermaid", source });
  }

  function filterInFragments(markdown: string, fragmentLength: number): string {
    const filter = new DiagramBlockFilter();
    let output = "";
    for (let i = 0; i < markdown.length; i += fragmentLength) {
      output += filter.push(markdown.slice(i, i + fragmentLength));
    }
    return output + filter.flush();
  }

  function assertFiltered(markdown: string, expected: string): void {
    for (let fragmentLength = 1; fragmentLength <= markdown.length; fragmentLength++) {
      assert.strictEqual(
        filterInFragments(markdown, fragmentLength),
        expected,
        `fragments of ${fragmentLength}`,
      );
    }
  }

  test("DiagramBlockFilter removes mermaid blocks however the text is split", () => {
    assertFiltered(
      "Here is the flow:\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\nIt has two steps.",
      "Here is the flow:\n\n\nIt has two steps.",
    );
  });

  test("DiagramBlockFilter removes echarts blocks", () => {
    assertFiltered('Sales:\n```echarts\n{"series": []}\n```\nDone.', "Sales:\nDone.");
  });

  test("DiagramBlockFilter keeps other code blocks and inline mentions", () => {
    const markdown =
      "Use a ```mermaid``` block, e.g.:\n```ts\nconst x = 1;\n```\n  ```mermaidx\nkept\n";
    assertFiltered(markdown, markdown);
  });

  test("DiagramBlockFilter hides an unterminated block", () => {
    assertFiltered("Drawing:\n```mermaid\nflowchart TD\n  A -->", "Drawing:\n");
  });

  test("DiagramBlockFilter streams text before the end of a line", () => {
    const filter = new DiagramBlockFilter();
    assert.strictEqual(filter.push("Hello, wor"), "Hello, wor");
    assert.strictEqual(filter.push("ld\n``"), "ld\n");
    assert.strictEqual(filter.push("`mermaid\nA"), "");
    assert.strictEqual(filter.push("\n```\nDone"), "Done");
    assert.strictEqual(filter.flush(), "");
  });
});
