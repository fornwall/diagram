import * as assert from "node:assert";
import { suitePage } from "./webviewHarness";

/**
 * Mistakes that models make in Mermaid, the error that the model is told for each, and the source
 * with the fix that the error suggests, which must draw.
 */
const MISTAKES: { broken: string; error: string; fixed: string }[] = [
  // Flowchart labels with brackets, parentheses, braces, pipes or quotes.
  {
    broken: "flowchart TD\n  A[Start (init)] --> B[Done]",
    error:
      'Parse error on line 2, column 11: unexpected "(". Put the label in double quotes: A["Start (init)"].',
    fixed: 'flowchart TD\n  A["Start (init)"] --> B[Done]',
  },
  {
    broken: "flowchart TD\n  A{Is it (really) ok?} -->|yes| B",
    error:
      'Parse error on line 2, column 11: unexpected "(". Put the label in double quotes: A{"Is it (really) ok?"}.',
    fixed: 'flowchart TD\n  A{"Is it (really) ok?"} -->|yes| B',
  },
  {
    broken: "flowchart LR\n  A --> B(Call foo(x))",
    error:
      'Parse error on line 2, column 19: unexpected "(". Put the label in double quotes: B("Call foo(x)").',
    fixed: 'flowchart LR\n  A --> B("Call foo(x)")',
  },
  {
    broken: "flowchart TD\n  A[items[0]] & B[Map{k: v}] --> C",
    error:
      'Parse error on line 2, column 10: unexpected "[". Put the label in double quotes: A["items[0]"].',
    fixed: 'flowchart TD\n  A["items[0]"] & B["Map{k: v}"] --> C',
  },
  {
    broken: "flowchart TD\n  A[a|b] --> B",
    error:
      'Parse error on line 2, column 6: unexpected "|". Put the label in double quotes: A["a|b"].',
    fixed: 'flowchart TD\n  A["a|b"] --> B',
  },
  {
    broken: 'flowchart TD\n  A[He said "hi"] --> B',
    error:
      'Parse error on line 2, column 14: unexpected "hi". Put the label in double quotes, writing its quotes as #quot;: A["He said #quot;hi#quot;"].',
    fixed: 'flowchart TD\n  A["He said #quot;hi#quot;"] --> B',
  },
  {
    broken: "flowchart TD\n  A((x (y))) --> B[(Store (main))]",
    error:
      'Parse error on line 2, column 8: unexpected "(". Put the label in double quotes: A(("x (y)")).',
    fixed: 'flowchart TD\n  A(("x (y)")) --> B[("Store (main)")]',
  },
  {
    broken: "flowchart TD\n  A{{x (y)}} --> B>x (y)]",
    error:
      'Parse error on line 2, column 8: unexpected "(". Put the label in double quotes: A{{"x (y)"}}.',
    fixed: 'flowchart TD\n  A{{"x (y)"}} --> B>"x (y)"]',
  },
  {
    broken: "flowchart TD\n  A[/x (y)/] --> B[[x (y)]] --> C([x (y)])",
    error:
      'Parse error on line 2, column 8: unexpected "(". Put the label in double quotes: A[/"x (y)"/].',
    fixed: 'flowchart TD\n  A[/"x (y)"/] --> B[["x (y)"]] --> C(["x (y)"])',
  },
  {
    broken: "flowchart TD\n  A -->|call (x)| B",
    error:
      'Parse error on line 2, column 14: unexpected "(". Put the label in double quotes: -->|"call (x)"|.',
    fixed: 'flowchart TD\n  A -->|"call (x)"| B',
  },
  // Keywords as node ids.
  {
    broken: "flowchart TD\n  start --> end",
    error:
      'Parse error on line 2, column 13: unexpected "e". "end" is a keyword, so it cannot be a node id: use another id, such as endNode[end].',
    fixed: "flowchart TD\n  start --> endNode[end]",
  },
  {
    broken: "flowchart TD\n  end --> A",
    error:
      'Parse error on line 2, column 3: unexpected "end". "end" is a keyword, so it cannot be a node id: use another id, such as endNode[end].',
    fixed: "flowchart TD\n  endNode[end] --> A",
  },
  {
    broken: "flowchart TD\n  A --> class",
    error:
      'Parse error on line 2, column 9: unexpected "class". "class" is a keyword, so it cannot be a node id: use another id, such as classNode[class].',
    fixed: "flowchart TD\n  A --> classNode[class]",
  },
  {
    broken: "flowchart TD\n  A --> click",
    error:
      'Parse error on line 2, column 9: unexpected end of line. "click" is a keyword, so it cannot be a node id: use another id, such as clickNode[click].',
    fixed: "flowchart TD\n  A --> clickNode[click]",
  },
  // Links.
  {
    broken: "flowchart TD\n  A -->|yes|> B",
    error:
      'Parse error on line 2, column 13: unexpected ">". Nothing goes between an edge\'s label and the node it leads to: A -->|yes| B.',
    fixed: "flowchart TD\n  A -->|yes| B",
  },
  {
    broken: "flowchart LR\n  A -> B",
    error:
      'Parse error on line 2, column 5: unexpected "-". Write links as -->, ---, -.->, ==> or ~~~: A --> B.',
    fixed: "flowchart LR\n  A --> B",
  },
  {
    broken: "flowchart LR\n  A => B",
    error:
      'Parse error on line 2, column 5: unexpected "=". Write links as -->, ---, -.->, ==> or ~~~: A ==> B.',
    fixed: "flowchart LR\n  A ==> B",
  },
  // Ids with spaces.
  {
    broken: "flowchart TD\n  my node --> B",
    error:
      'Parse error on line 2, column 6: unexpected "node". Ids have no spaces: write the node as my_node["my node"], and link to my_node.',
    fixed: 'flowchart TD\n  my_node["my node"] --> B',
  },
  {
    broken: "flowchart TD\n  subgraph My Group\n    A --> B\n  end\n  C --> My Group",
    error:
      'Parse error on line 5, column 12: unexpected "Group". Give the subgraph an id to link to it: "subgraph My_Group [My Group]", and link to My_Group.',
    fixed: "flowchart TD\n  subgraph My_Group [My Group]\n    A --> B\n  end\n  C --> My_Group",
  },
  // Subgraphs.
  {
    broken: "flowchart TD\n  subgraph S\n    A --> B\n  subgraph T\n    C\n  end",
    error:
      'Parse error on line 6, column 6: unexpected end of the diagram. The subgraph on line 2 is not closed: add a line "end" after its contents.',
    fixed: "flowchart TD\n  subgraph S\n    A --> B\n  subgraph T\n    C\n  end\n  end",
  },
  {
    broken: "flowchart TD\n  subgraph S\n    A\n  end\n  end",
    error:
      'Parse error on line 5, column 3: unexpected "e". This "end" closes no subgraph: remove it.',
    fixed: "flowchart TD\n  subgraph S\n    A\n  end",
  },
  // Directions, comments and the diagram type.
  {
    broken: "flowchart lr\n  A --> B",
    error:
      'Parse error on line 1, column 10: unexpected space. The direction is TB, TD, BT, RL or LR, in capitals: "flowchart LR".',
    fixed: "flowchart LR\n  A --> B",
  },
  {
    broken: "graph TOP\n  A --> B",
    error:
      'Parse error on line 1, column 6: unexpected space. The direction is TB, TD, BT, RL or LR, in capitals: "graph TD".',
    fixed: "graph TD\n  A --> B",
  },
  {
    broken: "flowchart TD\n  A --> B %% the happy path",
    error:
      'Parse error on line 2, column 11: unexpected "%%". Comments go on lines of their own: move "%% the happy path" to a line of its own.',
    fixed: "flowchart TD\n  %% the happy path\n  A --> B",
  },
  {
    broken: "flowchart TD\n  // the happy path\n  A --> B",
    error:
      'Parse error on line 2, column 6: unexpected "the". Comments start with %%, on a line of their own: "%% the happy path".',
    fixed: "flowchart TD\n  %% the happy path\n  A --> B",
  },
  {
    broken: "A[Start] --> B[Done]",
    error: 'The diagram has no type: start it with a line "flowchart TD".',
    fixed: "flowchart TD\nA[Start] --> B[Done]",
  },
];

suite("Mermaid errors in the webview", function () {
  this.timeout(60_000);

  const page = suitePage();

  test("tells how to fix the mistakes that models make in Mermaid", async () => {
    const outcomes: { error: string; fixed: string }[] = [];
    for (const { broken, fixed } of MISTAKES) {
      const error = await page.render({ source: broken });
      const drawn = await page.render({ source: fixed });
      outcomes.push({
        error: error.ok ? "drawn" : error.error,
        fixed: drawn.ok ? "drawn" : `${fixed}: ${drawn.error}`,
      });
    }
    assert.deepStrictEqual(
      outcomes,
      MISTAKES.map(({ error }) => ({ error, fixed: "drawn" })),
    );
  });
});
