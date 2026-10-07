import * as assert from "node:assert";
import { codeFence, DiagramBlockFilter, guessTitle } from "../blocks";

suite("blocks", () => {
  test("collects each mermaid and echarts block with its language, but no empty or unfinished one", () => {
    const filter = new DiagramBlockFilter();
    filter.push(
      "Here you go:\n```mermaid\nflowchart TD\n  A --> B\n```\n```ts\nconst x = 1;\n```\n" +
        '```echarts  \n{"series": []}\n```\n```mermaid\n```\n```mermaid\nflowchart',
    );
    filter.flush();
    assert.deepStrictEqual(filter.diagrams, [
      { language: "mermaid", source: "flowchart TD\n  A --> B" },
      { language: "echarts", source: '{"series": []}' },
    ]);
  });

  test("fences text in more backticks than any run of them in it", () => {
    assert.strictEqual(codeFence("A --> B", "mermaid"), "```mermaid\nA --> B\n```");
    assert.strictEqual(codeFence('A["````"]'), '`````\nA["````"]\n`````');
  });

  test("fences a large source with many runs of backticks", () => {
    const source = `${"`x".repeat(200_000)}\n\`\`\`\`\`\``;
    assert.strictEqual(codeFence(source), `\`\`\`\`\`\`\`\n${source}\n\`\`\`\`\`\`\``);
  });

  test("keeps the whitespace of attached source and selections in their fence", () => {
    const source = "    if ready:\n        run()\n\n";
    assert.strictEqual(codeFence(source, "python"), `\`\`\`python\n${source}\n\`\`\``);
  });

  test("titles a diagram by its front matter", () => {
    assert.strictEqual(
      mermaidTitle('---\ntitle: "Login flow"\n---\nsequenceDiagram'),
      "Login flow",
    );
    assert.strictEqual(
      mermaidTitle("---\ntitle: 'Login flow'\n---\nsequenceDiagram"),
      "Login flow",
    );
    assert.strictEqual(
      mermaidTitle("---\ntitle: Users' requests\n---\nflowchart LR"),
      "Users' requests",
    );
    assert.strictEqual(mermaidTitle("---\ntitle: James'\n---\nflowchart LR"), "James'");
  });

  test("titles a diagram by its title statement", () => {
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

  test("ignores title lines in diagrams that have no title statement", () => {
    assert.strictEqual(mermaidTitle("flowchart LR\n  title Here --> B"), "flowchart");
    assert.strictEqual(mermaidTitle("mindmap\n  root\n    title Here"), "mindmap");
    assert.strictEqual(mermaidTitle("gantt\n  section title\n  title"), "gantt");
  });

  test("titles an untitled diagram by its type", () => {
    assert.strictEqual(mermaidTitle("%% comment\n\nflowchart LR\n  A --> B"), "flowchart");
    assert.strictEqual(mermaidTitle("---\nconfig:\n  theme: dark\n---\nerDiagram"), "erDiagram");
    assert.strictEqual(mermaidTitle(""), "Diagram");
  });

  test("titles a chart by the title of its ECharts option", () => {
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

  test("collects a long chart line streamed in small fragments", () => {
    const source = JSON.stringify({ series: [{ type: "line", data: Array(100_000).fill(42) }] });
    const markdown = `Chart:\n\`\`\`echarts\n${source}\n\`\`\`\nDone.`;
    const filter = new DiagramBlockFilter();
    let shown = "";
    for (let offset = 0; offset < markdown.length; offset += 100) {
      shown += filter.push(markdown.slice(offset, offset + 100));
    }
    shown += filter.flush();
    assert.strictEqual(shown, "Chart:\nDone.");
    assert.deepStrictEqual(filter.diagrams, [{ language: "echarts", source }]);
  });

  test("streams long prose before a diagram without losing text", () => {
    const prose = "Ordinary prose. ".repeat(50_000);
    const markdown = `${prose}\n\`\`\`mermaid\nflowchart LR\nA --> B\n\`\`\`\nDone.`;
    assert.strictEqual(filterInFragments(markdown, 100), `${prose}\nDone.`);
  });

  test("streams text before the end of its line", () => {
    const filter = new DiagramBlockFilter();
    assert.strictEqual(filter.push("Hello, wor"), "Hello, wor");
    assert.strictEqual(filter.push("ld\n``"), "ld\n");
    assert.strictEqual(filter.push("`mermaid\nA"), "");
    assert.strictEqual(filter.push("\n```\nDone"), "Done");
    assert.strictEqual(filter.flush(), "");
  });

  test("finds diagram blocks in streamed text as CommonMark does", () => {
    const cases: { markdown: string; source?: string; shown: string; unterminated?: true }[] = [
      { markdown: "```mermaid\nA\n```", source: "A", shown: "" },
      { markdown: "Flow:\n\n```mermaid\nA\n```\n\nDone.", source: "A", shown: "Flow:\n\n\nDone." },
      {
        markdown: 'Sales:\n```echarts\n{"series": []}\n```\nDone.',
        source: '{"series": []}',
        shown: "Sales:\nDone.",
      },
      {
        markdown: "Drawing:\n```mermaid\nflowchart TD\n  A -->",
        shown: "Drawing:\n",
        unterminated: true,
      },
      // Other code blocks, and mentions in a line of text.
      {
        markdown:
          "Use a ```mermaid``` block, e.g.:\n```ts\nconst x = 1;\n```\n  ```mermaidx\nkept\n",
        shown: "Use a ```mermaid``` block, e.g.:\n```ts\nconst x = 1;\n```\n  ```mermaidx\nkept\n",
      },
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
      // A fence indented by 4 or more columns more than the opening fence is content.
      { markdown: "```mermaid\nA\n    ```\n```\nB", source: "A\n    ```", shown: "B" },
      { markdown: "  ```mermaid\nA\n   ```\nB", source: "A", shown: "B" },
      // Indented by 4 columns, a fence is indented code.
      { markdown: "    ```mermaid\n    A\n    ```\n", shown: "    ```mermaid\n    A\n    ```\n" },
      // In block quotes and list items, as in Markdown documents.
      {
        markdown: "> Flow:\n> ```mermaid\n> A\n>   B\n> ```\n> End",
        source: "A\n  B",
        shown: "> Flow:\n> End",
      },
      {
        markdown: "1. Flow:\n   ```mermaid\n   A\n   ```\n2. End",
        source: "A",
        shown: "1. Flow:\n2. End",
      },
      // The end of a block quote ends a block in it.
      { markdown: "> ```mermaid\n> A\nEnd", source: "A", shown: "End" },
      // A line that ends a code block by leaving its block quote or list item may open a diagram.
      {
        markdown: "> ```js\n> x\n```mermaid\nA\n```\nEnd",
        source: "A",
        shown: "> ```js\n> x\nEnd",
      },
      {
        markdown: "- ```js\n  x\n\n  y\n```mermaid\nA\n```\n",
        source: "A",
        shown: "- ```js\n  x\n\n  y\n",
      },
      // Indentation is spaces and tabs only.
      { markdown: "\u00a0```mermaid\nA\n```\n", shown: "\u00a0```mermaid\nA\n```\n" },
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
