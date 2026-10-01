import * as assert from "node:assert";
import { extractMermaidBlocks, guessTitle, MermaidBlockFilter } from "../mermaid";

suite("mermaid", () => {
  test("extractMermaidBlocks finds all mermaid blocks in order", () => {
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
    ].join("\n");
    assert.deepStrictEqual(extractMermaidBlocks(markdown), [
      "flowchart TD\n  A --> B",
      "sequenceDiagram\n  A->>B: hi",
    ]);
  });

  test("extractMermaidBlocks ignores unterminated and empty blocks", () => {
    assert.deepStrictEqual(extractMermaidBlocks("```mermaid\n```\n```mermaid\nflowchart"), []);
  });

  test("guessTitle uses the frontmatter title", () => {
    assert.strictEqual(guessTitle('---\ntitle: "Login flow"\n---\nsequenceDiagram'), "Login flow");
  });

  test("guessTitle falls back to the diagram type", () => {
    assert.strictEqual(guessTitle("%% comment\n\nflowchart LR\n  A --> B"), "flowchart");
    assert.strictEqual(guessTitle("---\nconfig:\n  theme: dark\n---\nerDiagram"), "erDiagram");
    assert.strictEqual(guessTitle(""), "Diagram");
  });

  function filterInFragments(markdown: string, fragmentLength: number): string {
    const filter = new MermaidBlockFilter();
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

  test("MermaidBlockFilter removes mermaid blocks however the text is split", () => {
    assertFiltered(
      "Here is the flow:\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\nIt has two steps.",
      "Here is the flow:\n\n\nIt has two steps.",
    );
  });

  test("MermaidBlockFilter keeps other code blocks and inline mentions", () => {
    const markdown =
      "Use a ```mermaid``` block, e.g.:\n```ts\nconst x = 1;\n```\n  ```mermaidx\nkept\n";
    assertFiltered(markdown, markdown);
  });

  test("MermaidBlockFilter hides an unterminated block", () => {
    assertFiltered("Drawing:\n```mermaid\nflowchart TD\n  A -->", "Drawing:\n");
  });

  test("MermaidBlockFilter streams text before the end of a line", () => {
    const filter = new MermaidBlockFilter();
    assert.strictEqual(filter.push("Hello, wor"), "Hello, wor");
    assert.strictEqual(filter.push("ld\n``"), "ld\n");
    assert.strictEqual(filter.push("`mermaid\nA"), "");
    assert.strictEqual(filter.push("\n```\nDone"), "Done");
    assert.strictEqual(filter.flush(), "");
  });
});
