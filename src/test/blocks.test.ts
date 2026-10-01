import * as assert from "node:assert";
import { codeFence, type DiagramBlock, DiagramBlockFilter, guessTitle } from "../blocks";

function lastDiagramBlock(markdown: string): DiagramBlock | undefined {
  const filter = new DiagramBlockFilter();
  filter.push(markdown);
  filter.flush();
  return filter.diagrams.at(-1);
}

suite("blocks", () => {
  test("lastDiagramBlock finds the last mermaid or echarts block", () => {
    const mermaid =
      "Here you go:\n```mermaid\nflowchart TD\n  A --> B\n```\n```ts\nconst x = 1;\n```\n";
    assert.deepStrictEqual(lastDiagramBlock(mermaid), {
      language: "mermaid",
      source: "flowchart TD\n  A --> B",
    });
    assert.deepStrictEqual(lastDiagramBlock(`${mermaid}\`\`\`echarts  \n{"series": []}\n\`\`\``), {
      language: "echarts",
      source: '{"series": []}',
    });
  });

  test("lastDiagramBlock ignores unterminated and empty blocks", () => {
    assert.strictEqual(lastDiagramBlock("```mermaid\n```\n```mermaid\nflowchart"), undefined);
  });

  test("codeFence uses a fence longer than any backticks in the text", () => {
    assert.strictEqual(codeFence("A --> B", "mermaid"), "```mermaid\nA --> B\n```");
    assert.strictEqual(codeFence('A["````"]'), '`````\nA["````"]\n`````');
  });

  test("codeFence handles large sources with many backtick runs", () => {
    const source = `${"`x".repeat(200_000)}\n\`\`\`\`\`\``;
    assert.strictEqual(codeFence(source), `\`\`\`\`\`\`\`\n${source}\n\`\`\`\`\`\`\``);
  });

  test("guessTitle uses the frontmatter title", () => {
    assert.strictEqual(
      mermaidTitle('---\ntitle: "Login flow"\n---\nsequenceDiagram'),
      "Login flow",
    );
  });

  test("guessTitle uses a title statement", () => {
    assert.strictEqual(mermaidTitle('pie title Pets\n  "Dogs" : 386'), "Pets");
    assert.strictEqual(mermaidTitle("pie showData title Key elements"), "Key elements");
    assert.strictEqual(
      mermaidTitle("gantt\n  dateFormat YYYY-MM-DD\n  title A Gantt Diagram %% comment"),
      "A Gantt Diagram",
    );
    assert.strictEqual(mermaidTitle('xychart-beta\n  title "Sales Revenue"'), "Sales Revenue");
    assert.strictEqual(mermaidTitle("sequenceDiagram\n  title: Login\n  A->>B: hi"), "Login");
    assert.strictEqual(
      mermaidTitle('---\ntitle: "Front"\n---\njourney\n  title Statement'),
      "Front",
    );
  });

  test("guessTitle ignores title lines in diagrams without title statements", () => {
    assert.strictEqual(mermaidTitle("flowchart LR\n  title Here --> B"), "flowchart");
    assert.strictEqual(mermaidTitle("mindmap\n  root\n    title Here"), "mindmap");
    assert.strictEqual(mermaidTitle("gantt\n  section title\n  title"), "gantt");
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
    for (const source of ["{not json", "null", "[]", '{"title": null}', '{"title": [5]}']) {
      assert.strictEqual(chartTitle(source), "Chart", source);
    }
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

  test("DiagramBlockFilter follows CommonMark fences", () => {
    const cases: { markdown: string; source?: string; shown: string; unterminated?: true }[] = [
      { markdown: "```mermaid\nA\n```", source: "A", shown: "" },
      { markdown: "  ```mermaid  \nA\n  ```  \nB", source: "A", shown: "B" },
      { markdown: "```mermaid\r\nA\r\n```\r\nB", source: "A", shown: "B" },
      // Like CommonMark, a longer closing fence also ends the block.
      { markdown: "Intro\n```mermaid\nA\n````\nend", source: "A", shown: "Intro\nend" },
      // Fences that are not on lines of their own neither open nor close a block.
      { markdown: '```mermaid\nA["```"] ```\n```\n', source: 'A["```"] ```', shown: "" },
      { markdown: "x ```mermaid\nA\n```\n", shown: "x ```mermaid\nA\n```\n" },
      { markdown: "```mermaid\nA\n``` x\n", shown: "", unterminated: true },
      { markdown: "Drawing:\n```echarts", shown: "Drawing:\n", unterminated: true },
      // Longer fences, tilde fences and info strings after the language.
      { markdown: '````mermaid\nA["```"]\n```\n````\nB', source: 'A["```"]\n```', shown: "B" },
      { markdown: "~~~ mermaid title\nA\n~~~~\nB", source: "A", shown: "B" },
      { markdown: "~~~mermaid\nA\n```\n", shown: "", unterminated: true },
      // A diagram fence inside another code block is just code.
      {
        markdown: "````md\n```mermaid\nA\n```\n````\n",
        shown: "````md\n```mermaid\nA\n```\n````\n",
      },
    ];
    for (const { markdown, source, shown, unterminated = false } of cases) {
      assertFiltered(markdown, shown);
      const filter = new DiagramBlockFilter();
      filter.push(markdown);
      filter.flush();
      assert.strictEqual(filter.diagrams.at(-1)?.source, source, markdown);
      assert.strictEqual(filter.unterminated, unterminated, markdown);
    }
  });
});
