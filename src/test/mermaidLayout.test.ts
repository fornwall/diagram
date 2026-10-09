import * as assert from "node:assert";
import { laidOutWithElk } from "../webview/mermaidLayout";

suite("mermaidLayout", () => {
  test("guesses the diagrams that Mermaid lays out with elk by their type", () => {
    for (const source of [
      "flowchart TD\n  A --> B",
      "graph LR\n  A --> B",
      "flowchart-elk TD\n  A --> B",
      "classDiagram\n  class A",
      "stateDiagram-v2\n  [*] --> A",
      "erDiagram\n  A ||--o{ B : has",
      "requirementDiagram\n  requirement r {\n  }",
      "usecase-beta\n  actor A",
    ]) {
      assert.ok(laidOutWithElk(source), source);
    }
    for (const source of [
      "sequenceDiagram\n  A->>B: Hi",
      "gantt\n  title T",
      "mindmap\n  root",
      'pie\n  "A": 1',
      "",
      "%% only a comment",
    ]) {
      assert.ok(!laidOutWithElk(source), source);
    }
  });

  test("looks past front matter, directives, comments and blank lines, minding the layout they set", () => {
    assert.ok(laidOutWithElk("\n---\ntitle: Flow\n---\n\n%% A comment\nflowchart TD\n  A --> B"));
    assert.ok(laidOutWithElk('%%{init: {"theme": "dark"}}%%\r\nstateDiagram\r\n  [*] --> A'));
    assert.ok(!laidOutWithElk("---\nconfig:\n  layout: dagre\n---\nflowchart TD\n  A --> B"));
    assert.ok(!laidOutWithElk('%%{init: {"layout": "dagre"}}%%\nclassDiagram\n  class A'));
    assert.ok(laidOutWithElk("---\nconfig:\n  layout: elk.stress\n---\nflowchart TD\n  A --> B"));
    // Front matter names no diagram type, nor does a mention of the layout in the diagram.
    assert.ok(!laidOutWithElk("---\ntitle: flowchart\n---\nsequenceDiagram\n  A->>B: layout: elk"));
  });
});
