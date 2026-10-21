import * as assert from "node:assert";
import { codeFence, guessTitle } from "../blocks";

suite("blocks", () => {
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
    for (const [source, title] of [
      ['---\ntitle: "Login flow"\n---\nsequenceDiagram', "Login flow"],
      ["---\ntitle: 'Login flow'\n---\nsequenceDiagram", "Login flow"],
      ["---\ntitle: Users' requests\n---\nflowchart LR", "Users' requests"],
      ["---\ntitle: James'\n---\nflowchart LR", "James'"],
    ] as const) {
      assert.strictEqual(mermaidTitle(source), title, source);
    }
  });

  test("titles a diagram by its title statement", () => {
    for (const [source, title] of [
      ['pie title Pets\n  "Dogs" : 386', "Pets"],
      ["pie showData title Key elements", "Key elements"],
      ["gantt\n  dateFormat YYYY-MM-DD\n  title A Gantt Diagram %% comment", "A Gantt Diagram"],
      ['xychart-beta\n  title "Sales Revenue"', "Sales Revenue"],
      ["sequenceDiagram\n  title: Login\n  A->>B: hi", "Login"],
      ["eventmodeling\n  title Checkout\n  tf 01 evt Start", "Checkout"],
      ["railroad-abnf-beta\n  title Syntax\n  a = b", "Syntax"],
      ['---\ntitle: "Front"\n---\njourney\n  title Statement', "Front"],
    ] as const) {
      assert.strictEqual(mermaidTitle(source), title, source);
    }
  });

  test("ignores title lines in diagrams that have no title statement", () => {
    assert.strictEqual(mermaidTitle("flowchart LR\n  title Here --> B"), "flowchart");
    assert.strictEqual(mermaidTitle("mindmap\n  root\n    title Here"), "mindmap");
    assert.strictEqual(mermaidTitle("gantt\n  section title\n  title"), "gantt");
    // An Ishikawa diagram's first line is its effect, and the rest are causes.
    assert.strictEqual(mermaidTitle("ishikawa-beta\n  title Here"), "ishikawa-beta");
    assert.strictEqual(mermaidTitle("swimlane-beta LR\n  title Here --> B"), "swimlane-beta");
    assert.strictEqual(mermaidTitle("usecase-beta\n  title Here"), "usecase-beta");
    assert.strictEqual(mermaidTitle("agentflow-beta\n  title Here"), "agentflow-beta");
  });

  test("titles an untitled diagram by its type", () => {
    assert.strictEqual(mermaidTitle("%% comment\n\nflowchart LR\n  A --> B"), "flowchart");
    assert.strictEqual(mermaidTitle("---\nconfig:\n  theme: dark\n---\nerDiagram"), "erDiagram");
    assert.strictEqual(mermaidTitle(""), "Diagram");
  });

  test("reads past directives that span lines", () => {
    const init = "%%{\n  init: {\n    'theme': 'dark'\n  }\n}%%";
    assert.strictEqual(mermaidTitle(`${init}\nflowchart LR\n  A --> B`), "flowchart");
    assert.strictEqual(mermaidTitle(`${init}\npie title Pets\n  "Dogs" : 386`), "Pets");
    assert.strictEqual(mermaidTitle(`gantt\n  ${init}\n  title Plan`), "Plan");
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

  test("titles a chart written as a JavaScript object literal, without running code", () => {
    const chartTitle = (source: string) => guessTitle({ language: "echarts", source });
    const literal = "{\n  // Monthly\n  title: {text: 'Sales'},\n  series: [{type: 'bar'}],\n}";
    assert.strictEqual(chartTitle(literal), "Sales");
    const code = "{title: {text: (globalThis.diagramTitleRan = 'Ran')}, series: []}";
    assert.strictEqual(chartTitle(code), "Chart");
    assert.strictEqual((globalThis as Record<string, unknown>).diagramTitleRan, undefined);
  });

  function mermaidTitle(source: string): string {
    return guessTitle({ language: "mermaid", source });
  }
});
