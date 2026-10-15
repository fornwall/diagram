import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { hexColor, parseColor, readableTextColor, sourceColor } from "../cssColors";
import { EditDiagramTool } from "../editTool";
import { findDiagramFences } from "../fences";
import {
  applyStyles,
  compositeStateIds,
  diagramKind,
  isStyleableId,
  sourceIds,
  subgraphIds,
} from "../mermaidStyle";
import { type StyleInput, validateStyleInput } from "../styleInput";
import { StyleDiagramTool } from "../styleTool";
import { quoteAll } from "../text";
import { afterTest, tempDir } from "./afterTest";
import { newFakePanel, newPanel, within } from "./newPanel";
import { invokeTool } from "./toolText";
import { suitePage, UNTIL } from "./webviewHarness";

/** Why the input is invalid, which it must be. */
function problems(input: unknown): string {
  try {
    validateStyleInput(input);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return assert.fail(`${JSON.stringify(input)} was accepted`);
}

suite("CSS colors", () => {
  test("reads names, hex and functions, and writes them without commas", () => {
    assert.deepStrictEqual(parseColor("Green"), { r: 0, g: 128, b: 0, a: 1 });
    assert.deepStrictEqual(parseColor("#0f08"), { r: 0, g: 255, b: 0, a: 136 / 255 });
    assert.deepStrictEqual(parseColor("rgb(255, 0, 0)"), { r: 255, g: 0, b: 0, a: 1 });
    assert.deepStrictEqual(parseColor("rgba(0 0 255 / 50%)"), { r: 0, g: 0, b: 255, a: 0.5 });
    assert.deepStrictEqual(parseColor("rgb(100%, 0%, 0%)"), { r: 255, g: 0, b: 0, a: 1 });
    assert.strictEqual(sourceColor(" RebeccaPurple "), "rebeccapurple");
    assert.strictEqual(sourceColor("transparent"), "transparent");
    assert.strictEqual(sourceColor("#ABC"), "#aabbcc");
    assert.strictEqual(sourceColor("hsl(120deg 100% 25%)"), "#008000");
    assert.strictEqual(sourceColor("hsla(0, 100%, 50%, 0.5)"), "#ff000080");
    assert.strictEqual(sourceColor("hsl(0.5turn 100% 50%)"), "#00ffff");
    assert.strictEqual(sourceColor("rgb(46 125 50)"), "#2e7d32");
    assert.strictEqual(hexColor({ r: 1, g: 2, b: 3, a: 1 }), "#010203");
    for (const invalid of [
      "",
      "greenish",
      "#12",
      "#12345",
      "#12345g",
      "rgb(1, 2)",
      "rgb(1 2 3 4)",
      "rgb(1px 2 3)",
      "hsl(1%, 2%, 3%)",
      "var(--x)",
      "url(#x)",
      "currentColor",
      "red;fill:blue",
      "red,stroke:blue",
      "red\nstyle A fill:blue",
      "constructor",
    ]) {
      assert.strictEqual(parseColor(invalid), undefined, invalid);
      assert.strictEqual(sourceColor(invalid), undefined, invalid);
    }
  });

  test("chooses black or white text, whichever has the better WCAG contrast", () => {
    const text = (fill: string) => readableTextColor(parseColor(fill) ?? assert.fail(fill));
    assert.strictEqual(text("green"), "white");
    assert.strictEqual(text("navy"), "white");
    assert.strictEqual(text("lime"), "black");
    assert.strictEqual(text("yellow"), "black");
    assert.strictEqual(text("#777"), "black");
    assert.strictEqual(text("#666"), "white");
  });
});

suite("diagram_style input", () => {
  test("gives colors as written to the source, with text chosen for a fill", () => {
    assert.deepStrictEqual(
      validateStyleInput({
        styles: [
          { id: " pay ", fill: "Green", stroke: "rgb(0, 102, 0)" },
          { id: "grp", stroke: "#060" },
          { id: "old", fill: null },
          { id: "label", text: "AUTO" },
          { id: "gone", clear: true, fill: null },
          { id: "own", fill: "red", text: "blue" },
        ],
        revision: 7,
      }),
      {
        styles: [
          { id: "pay", fill: "green", stroke: "#006600", text: "auto" },
          { id: "grp", stroke: "#006600" },
          { id: "old", fill: null, text: null },
          { id: "label", text: "auto" },
          { id: "gone", clear: true },
          { id: "own", fill: "red", text: "blue" },
        ],
        revision: 7,
      },
    );
    // Some models send null for what they leave out.
    assert.deepStrictEqual(
      validateStyleInput({ styles: [{ id: "a", clear: true }], revision: null }),
      {
        styles: [{ id: "a", clear: true }],
      },
    );
  });

  test("refuses malformed input, and colors that would write Mermaid syntax", () => {
    assert.match(problems(undefined), /must be given as an object/);
    assert.match(problems({ styles: [] }), /non-empty array/);
    assert.match(problems({ styles: "pay" }), /non-empty array/);
    // One style without an array, as a model may send it.
    assert.deepStrictEqual(validateStyleInput({ styles: { id: "a", stroke: "red" } }).styles, [
      { id: "a", stroke: "red" },
    ]);
    const many = Array.from({ length: 51 }, (_, i) => ({ id: `n${i}`, fill: "red" }));
    assert.match(problems({ styles: many }), /51 items, more than 50/);
    assert.match(problems({ styles: [{ id: "a", fill: "red" }], colour: 1 }), /"colour"/);
    assert.match(problems({ styles: [{ id: "a" }] }), /Give "fill", "stroke" or "text"/);
    assert.match(problems({ styles: [{ id: " ", fill: "red" }] }), /"id" must be/);
    assert.match(problems({ styles: [{ id: "a", fill: "red", revision: 1 }] }), /"revision"/);
    assert.match(
      problems({
        styles: [
          { id: "a", fill: "red" },
          { id: "a", stroke: "red" },
        ],
      }),
      /styled twice/,
    );
    assert.match(problems({ styles: [{ id: "a", fill: "red", clear: true }] }), /leave out "fill"/);
    assert.match(problems({ styles: [{ id: "a", clear: "yes" }] }), /"clear" must be/);
    assert.match(problems({ styles: [{ id: "a", stroke: "auto" }] }), /"stroke" must be a CSS/);
    assert.match(problems({ styles: [{ id: "a", fill: 255 }] }), /"fill" must be a CSS color/);
    assert.match(problems({ styles: [{ id: "a", fill: "red" }], revision: -1 }), /"revision"/);
    for (const injection of [
      "red;fill:blue",
      "red,stroke:blue",
      "red\n  style B fill:blue",
      "rgb(1,2,3);x",
      "red %% comment",
      `#${"f".repeat(80)}`,
    ]) {
      assert.match(problems({ styles: [{ id: "a", fill: injection }] }), /must be a CSS color/);
      assert.match(problems({ styles: [{ id: "a", text: injection }] }), /must be a CSS color/);
    }
  });
});

suite("Mermaid style lines", () => {
  const style = (source: string, styles: unknown) =>
    applyStyles(source, validateStyleInput({ styles }).styles);

  test("finds the diagram type after front matter, comments and directives", () => {
    assert.deepStrictEqual(diagramKind("---\ntitle: x\n---\n%% hi\ngraph TD\n A"), {
      keyword: "graph",
      kind: "flowchart",
    });
    assert.strictEqual(
      diagramKind('%%{\n  init: {"theme": "dark"}\n}%%\nclassDiagram').kind,
      "class",
    );
    assert.strictEqual(diagramKind("stateDiagram-v2\n [*] --> A").kind, "state");
    assert.strictEqual(diagramKind("erDiagram\n A ||--o{ B : has").kind, "er");
    assert.deepStrictEqual(diagramKind("sequenceDiagram\n A->>B: hi"), {
      keyword: "sequenceDiagram",
      kind: undefined,
    });
    assert.strictEqual(diagramKind("constructor\n A").kind, undefined);
    assert.deepStrictEqual(
      subgraphIds("flowchart LR\n subgraph pay [Payment]\n A\n end\n subgraph Plain Title\n end"),
      ["pay"],
    );
    assert.deepStrictEqual(
      compositeStateIds('stateDiagram-v2\n state Comp {\n A\n }\n state "Long" as L {\n }'),
      ["Comp", "L"],
    );
  });

  test("tells ids from the labels that the panel names notes and interfaces by", () => {
    const states = sourceIds(
      'stateDiagram-v2\n  %%{init: {"themeVariables": {"x": "Ghost"}}}%%\n  A --> B : Go\n  note right of A : Important\n  note left of B\n    Multi\n  end note\n  %% Comment',
      "state",
    );
    for (const id of ["A", "B"]) assert.ok(states.has(id), id);
    for (const label of ["Go", "Important", "Multi", "Ghost", "Comment"]) {
      assert.ok(!states.has(label), label);
    }
    const classes = sourceIds(
      'classDiagram\n  Bird --() Flyable\n  Singing ()-- Bird\n  class Bird {\n    +fly() Wing\n  }\n  note for Bird "Tweets"',
      "class",
    );
    assert.ok(classes.has("Bird"));
    for (const label of ["Flyable", "Singing", "fly", "Wing", "Tweets"]) {
      assert.ok(!classes.has(label), label);
    }
    assert.ok(isStyleableId("CUSTOMER-ACCOUNT", "er"));
    assert.ok(!isStyleableId("a.b", "er"));
    assert.ok(isStyleableId("a.b", "flowchart"));
    // Mermaid's class parser takes no other ids in a style line, though it declares them.
    for (const id of ["A-B", "a.b", "Ä"]) assert.ok(!isStyleableId(id, "class"), id);
    assert.ok(isStyleableId("Parser_2", "class"));
    // Classes declared in a namespace, and the statements of a one-line flowchart.
    const spaced = sourceIds(
      "classDiagram\n  namespace Shapes {\n    class Square {\n      +side int\n    }\n    class Circle\n  }",
      "class",
    );
    for (const id of ["Square", "Circle"]) assert.ok(spaced.has(id), id);
    assert.ok(!spaced.has("side"));
    assert.deepStrictEqual([...sourceIds("graph TD;A-->B;", "flowchart")], ["A", "B"]);
    assert.ok(!isStyleableId("Payment Flow", "flowchart"));
    assert.ok(!isStyleableId("B (2)", "state"));
  });

  test("appends a line for a node and a subgraph at the indentation of the diagram's body", () => {
    const source =
      "flowchart LR\n  subgraph grp [Group]\n    pay[Pay]\n    style pay stroke:red\n  end\n  pay --> done\n\n";
    const { source: edited, applied } = style(source, [
      { id: "done", fill: "green" },
      { id: "grp", stroke: "#060" },
    ]);
    assert.strictEqual(
      edited,
      "flowchart LR\n  subgraph grp [Group]\n    pay[Pay]\n    style pay stroke:red\n  end\n  pay --> done\n  style done fill:green,color:white\n  style grp stroke:#006600\n\n",
    );
    assert.deepStrictEqual(applied, [
      { id: "done", fill: "green", stroke: undefined, text: "white", autoText: "contrast" },
      { id: "grp", fill: undefined, stroke: "#006600", text: undefined },
    ]);
  });

  test("replaces a node's lines in place, keeping its other properties and the line breaks", () => {
    const source =
      "flowchart LR\r\n  A --> B\r\n  style A fill:#f9f,stroke:#333,stroke-width:4px;\r\n  style A color:red\r\n  style A,B stroke-dasharray:5\r\n";
    assert.strictEqual(
      style(source, [{ id: "A", fill: "blue" }]).source,
      "flowchart LR\r\n  A --> B\r\n  style A fill:blue,stroke:#333,color:white,stroke-width:4px\r\n  style A,B stroke-dasharray:5\r\n",
    );
    assert.strictEqual(
      style(source, [{ id: "A", fill: null }]).source,
      "flowchart LR\r\n  A --> B\r\n  style A stroke:#333,stroke-width:4px\r\n  style A,B stroke-dasharray:5\r\n",
    );
    const cleared = style(source, [{ id: "A", clear: true }]);
    assert.strictEqual(
      cleared.source,
      "flowchart LR\r\n  A --> B\r\n  style A,B stroke-dasharray:5\r\n",
    );
    assert.deepStrictEqual(cleared.applied, [{ id: "A", removed: true }]);
    assert.deepStrictEqual(style(source, [{ id: "B", clear: true }]).applied, [
      { id: "B", unstyled: true },
    ]);
  });

  test("leaves the text color of a translucent fill to the panel", () => {
    const source = "flowchart LR\n  A\n  style A fill:white,color:black";
    const { source: edited, applied } = style(source, [{ id: "A", fill: "#ff000080" }]);
    assert.strictEqual(edited, "flowchart LR\n  A\n  style A fill:#ff000080");
    assert.strictEqual(applied[0]?.autoText, "theme");
    assert.strictEqual(
      style(source, [{ id: "A", fill: "transparent" }]).source,
      "flowchart LR\n  A\n  style A fill:transparent",
    );
  });

  test("appends rather than replace a style statement that others follow on its line", () => {
    const edge = "flowchart TD\n  style A fill:red; A-->C";
    assert.strictEqual(
      style(edge, [{ id: "A", fill: "green" }]).source,
      `${edge}\n  style A fill:green,color:white`,
    );
    const both = "flowchart TD\n  A-->B\n  style A fill:red; style B fill:blue";
    assert.strictEqual(
      style(both, [{ id: "A", stroke: "green" }]).source,
      `${both}\n  style A stroke:green`,
    );
    assert.strictEqual(
      style("graph TD;A-->B;", [{ id: "B", fill: "navy" }]).source,
      "graph TD;A-->B;\n  style B fill:navy,color:white",
    );
    // Such a style cannot be removed by a line after it.
    const removed = style(both, [{ id: "B", clear: true }]);
    assert.strictEqual(removed.source, both);
    assert.match(removed.applied[0]?.problem ?? "", /in a line with other statements/);
  });

  test("keeps commas in parentheses, and the lines of a label that goes on for several", () => {
    assert.strictEqual(
      style("flowchart TD\n  A-->B\n  style A fill:rgb(255,0,0),stroke-width:2px", [
        { id: "A", stroke: "blue" },
      ]).source,
      "flowchart TD\n  A-->B\n  style A fill:rgb(255,0,0),stroke:blue,stroke-width:2px",
    );
    const markdown = 'flowchart TD\n  A["`line1\nstyle A fill:red\n`"]-->B';
    assert.strictEqual(
      style(markdown, [{ id: "B", fill: "navy" }]).source,
      `${markdown}\n  style B fill:navy,color:white`,
    );
    assert.strictEqual(
      style(markdown, [{ id: "A", fill: "navy" }]).source,
      `${markdown}\n  style A fill:navy,color:white`,
    );
    assert.deepStrictEqual([...sourceIds(markdown, "flowchart")], ["A", "B"]);
  });

  test("chooses text for the fill a node has, and says when it has none", () => {
    const source = "flowchart LR\n  A --> B\n  style A fill:navy";
    const { source: edited, applied } = style(source, [
      { id: "A", text: "auto" },
      { id: "B", text: "auto" },
    ]);
    assert.strictEqual(edited, "flowchart LR\n  A --> B\n  style A fill:navy,color:white");
    assert.match(applied[1]?.problem ?? "", /no fill to choose a text color for/);
  });

  test("styles classes, states and entities, after front matter and multi-line directives", () => {
    assert.strictEqual(
      style("classDiagram\n  class Parser\n  Parser <|-- Json", [{ id: "Parser", fill: "lime" }])
        .source,
      "classDiagram\n  class Parser\n  Parser <|-- Json\n  style Parser fill:lime,color:black",
    );
    assert.strictEqual(
      style("---\ntitle: States\n---\nstateDiagram-v2\n[*] --> A\n", [{ id: "A", stroke: "red" }])
        .source,
      "---\ntitle: States\n---\nstateDiagram-v2\n[*] --> A\nstyle A stroke:red\n",
    );
    const directive =
      '%%{\n  init: {"theme": "base"}\n}%%\nerDiagram\n    CUSTOMER ||--o{ ORDER : places';
    assert.strictEqual(
      style(directive, [{ id: "CUSTOMER", fill: "#123" }]).source,
      `${directive}\n    style CUSTOMER fill:#112233,color:white`,
    );
  });

  /** Styles the links of edges, by their numbers in linkStyle lines, naming each by its number. */
  const styleLinks = (source: string, styles: { link: number; [key: string]: unknown }[]) => {
    const validated = validateStyleInput({
      styles: styles.map(({ link, ...style }, index) => ({ id: `${index}: ${link}`, ...style })),
    }).styles;
    return applyStyles(
      source,
      styles.map(({ link }, index) => ({ ...validated[index], id: `edge ${link}`, link })),
    );
  };

  test("gives an edge's link a linkStyle line of its own, keeping its other properties", () => {
    const edges = "flowchart LR\n  A --> B --> C\n  linkStyle default stroke:gray\n";
    const added = styleLinks(edges, [
      { link: 1, stroke: "red", text: "blue" },
      { link: 0, stroke: null },
    ]);
    assert.strictEqual(added.source, `${edges.trimEnd()}\n  linkStyle 1 stroke:red,color:blue\n`);
    assert.deepStrictEqual(added.applied, [
      { id: "edge 1", stroke: "red", text: "blue" },
      { id: "edge 0", unstyled: true },
    ]);
    // In place, merged from the last line that names the link, which Mermaid takes it from.
    const lines =
      "flowchart LR\n  A --> B --> C --> D\n  linkStyle 1 stroke:blue;\n  linkStyle 0,1,2 stroke-width:4px,color:green\n  linkStyle 1 interpolate basis";
    assert.strictEqual(
      styleLinks(lines, [{ link: 1, stroke: "red" }]).source,
      "flowchart LR\n  A --> B --> C --> D\n  linkStyle 1 stroke:red,color:green,stroke-width:4px\n  linkStyle 0,2 stroke-width:4px,color:green\n  linkStyle 1 interpolate basis",
    );
    assert.strictEqual(
      styleLinks(lines, [{ link: 2, text: "red" }]).source,
      "flowchart LR\n  A --> B --> C --> D\n  linkStyle 1 stroke:blue;\n  linkStyle 0,1 stroke-width:4px,color:green\n  linkStyle 1 interpolate basis\n  linkStyle 2 color:red,stroke-width:4px",
    );
    const cleared = styleLinks(lines, [
      { link: 1, clear: true },
      { link: 0, clear: true },
      { link: 2, clear: true },
      { link: 3, clear: true },
    ]);
    assert.strictEqual(
      cleared.source,
      "flowchart LR\n  A --> B --> C --> D\n  linkStyle 1 interpolate basis",
    );
    assert.deepStrictEqual(
      cleared.applied.map((applied) => applied.removed ?? applied.unstyled),
      [true, true, true, true],
    );
  });

  test("leaves the links of lines with other statements, and refuses an edge's fill", () => {
    const source =
      "flowchart LR\n  A --> B --> C\n  linkStyle 0 interpolate basis stroke:red\n  B --> D; linkStyle 1 stroke:red";
    const { source: edited, applied } = styleLinks(source, [
      { link: 0, stroke: "blue" },
      { link: 1, stroke: "blue" },
      { link: 2, fill: "blue" },
      { link: 2, text: "auto" },
    ]);
    assert.strictEqual(edited, source);
    assert.deepStrictEqual(
      applied.map(({ problem }) => problem),
      [
        "Its linkStyle is in a line with other statements, or one that sets its curve, which is left as it is: give it a line of its own first.",
        "Its linkStyle is in a line with other statements, or one that sets its curve, which is left as it is: give it a line of its own first.",
        'An edge has no fill: give "stroke" for its line and "text" for its label.',
        'An edge has no fill to choose a text color for: give a "text" color.',
      ],
    );
  });
});

suite("diagram_style", () => {
  test("says what it colors, and that there is nothing to color without a diagram", async () => {
    const panel = newPanel();
    afterTest(() => panel.dispose());
    const tool = new StyleDiagramTool(panel);
    const message = (input: unknown) =>
      tool.prepareInvocation({ input: input as StyleInput }).invocationMessage;
    assert.strictEqual(
      message({ styles: [{ id: "pay", fill: "green" }] }),
      'Coloring "pay" in the diagram',
    );
    assert.strictEqual(
      message({
        styles: [
          { id: "a", clear: true },
          { id: "b", fill: null, stroke: null, text: null },
        ],
      }),
      'Removing the colors of "a", "b" in the diagram',
    );
    const many = ["a", "b", "c", "d"].map((id) => ({ id, fill: "red" }));
    assert.strictEqual(message({ styles: many }), "Coloring 4 items in the diagram");
    assert.strictEqual(message({ styles: [] }), "Coloring the diagram");
    assert.strictEqual(
      await invokeTool(tool, { styles: [{ id: "pay", fill: "green" }] }),
      "Nothing was styled: There is no diagram to color. Render one with diagram_render first. Revision: 0.",
    );
    assert.match(
      await invokeTool(tool, { styles: [{ id: "pay", fill: "red;stroke:blue" }] }),
      /^Nothing was styled, as the input is invalid\. Fix it and call diagram_style again\. Revision: 0\.\n\nInvalid styles:\n- Style 1: "fill" must be a CSS color/,
    );
  });
});

suite("diagram_style in the panel", () => {
  test("keeps the selection, the marks and the user's edits of the diagram it colors", async () => {
    const source = "flowchart TD\n  A --> B";
    const { panel, webview } = await newFakePanel(
      new Map<string, unknown>([
        [
          "diagram.state",
          { language: "mermaid", source, title: "Flow", origin: "document", editedByUser: true },
        ],
      ]),
    );
    webview.answer = (message) =>
      message.type === "render"
        ? {
            type: "rendered",
            requestId: message.requestId,
            diagramType: "flowchart-v2",
            nodeIds: ["A", "B"],
          }
        : undefined;
    await webview.receive({ type: "ready" });
    await within(() => panel.drawnIds !== undefined);
    await webview.select([{ id: "A", label: "A" }]);
    assert.ok(panel.annotate({ marks: [{ id: "B", kind: "info", note: "watch" }], dim: false }).ok);
    const result = await invokeTool(new StyleDiagramTool(panel), {
      styles: [{ id: "A", fill: "red" }],
    });
    assert.match(result, /^Styled "A"/);
    assert.deepStrictEqual(webview.render.selection, ["A"]);
    assert.strictEqual(panel.current?.editedByUser, true);
    assert.match(
      panel.describeForModel() ?? "",
      /The user has selected these nodes in the panel: "A"/,
    );
    assert.match(panel.describeForModel() ?? "", /watch/);
  });

  test("keeps a coloring that fails to render shown with its error and marks, for diagram_edit to fix", async () => {
    const source = "flowchart TD\n  A --> B";
    const { panel, webview } = await newFakePanel(
      new Map<string, unknown>([
        ["diagram.state", { language: "mermaid", source, title: "Flow", origin: "tool" }],
      ]),
    );
    webview.answer = (message) =>
      message.type === "render"
        ? {
            type: "rendered",
            requestId: message.requestId,
            diagramType: "flowchart-v2",
            nodeIds: ["A", "B"],
          }
        : undefined;
    await webview.receive({ type: "ready" });
    await within(() => panel.drawnIds !== undefined);
    assert.ok(panel.annotate({ marks: [{ id: "B", kind: "info", note: "watch" }], dim: false }).ok);
    const error = 'Parse error on line 3, column 9: unexpected "fill".';
    webview.failNextRender(error);
    const colored = `${source}\n  style A fill:red,color:black`;
    assert.strictEqual(
      await invokeTool(new StyleDiagramTool(panel), { styles: [{ id: "A", fill: "red" }] }),
      `The colored diagram failed to render with this error:\n\n${error}\n\nLines 1-3 of the source:\n1: flowchart TD\n2:   A --> B\n3:   style A fill:red,color:black\n\nThe panel shows it with this error. Fix it with diagram_edit.\n\nRevision: ${panel.revision}.`,
    );
    // As the panel shows the colored source, the quoted line is in it, for the fix to replace.
    assert.strictEqual(panel.current?.source, colored);
    assert.strictEqual(panel.current?.error, error);
    assert.match(panel.describeForModel() ?? "", /watch/);
    assert.match(
      await invokeTool(new EditDiagramTool(panel), {
        edits: [{ oldText: "\n  style A fill:red,color:black", newText: "" }],
      }),
      /^Edited the flowchart-v2 diagram with 1 edit/,
    );
    assert.strictEqual(panel.current?.source, source);
    assert.strictEqual(panel.current?.error, undefined);
    assert.match(panel.describeForModel() ?? "", /watch/);
  });

  test("leaves an edge whose number in linkStyle lines the page does not tell, saying how to color it", async () => {
    const source = "flowchart TD\n  A --> B";
    const { panel, webview } = await newFakePanel(
      new Map<string, unknown>([
        ["diagram.state", { language: "mermaid", source, title: "Flow", origin: "tool" }],
      ]),
    );
    webview.answer = (message) =>
      message.type === "render"
        ? {
            type: "rendered",
            requestId: message.requestId,
            diagramType: "flowchart-v2",
            nodeIds: ["A", "B"],
            relationships: [
              {
                id: "edge:L_A_B_0",
                label: "A → B",
                relationship: { kind: "edge", source: "A", target: "B", direction: "forward" },
              },
            ],
          }
        : undefined;
    await webview.receive({ type: "ready" });
    await within(() => panel.drawnIds !== undefined);
    const result = await invokeTool(new StyleDiagramTool(panel), {
      styles: [{ id: "A --> B", stroke: "red" }],
    });
    assert.strictEqual(
      result,
      'Nothing was styled. Revision: 0.\n\n"A --> B" was not styled, as its number in linkStyle lines is not known. Color it with a linkStyle line through diagram_edit, which numbers the links in the order the source writes them, from 0, e.g. `linkStyle 0 stroke:red`.',
    );
    assert.strictEqual(panel.current?.source, source);
  });
});

suite("diagram_style in the webview", function () {
  // The first render loads the webview and the libraries, which can take a while.
  this.timeout(20_000);

  const page = suitePage();
  const { evaluate, draw } = page;
  const style = (input: unknown) => invokeTool(new StyleDiagramTool(page.panel), input);
  const source = () => page.panel.current?.source ?? "";
  /** Whether a shape of the item is drawn filled in the color, as CSS computes it. */
  const filled = (id: string, color: string) =>
    evaluate(`[...document.querySelectorAll('#diagram [data-diagram-id=${JSON.stringify(id)}] :is(rect, path, polygon, circle)')]
      .some((shape) => getComputedStyle(shape).fill === ${JSON.stringify(color)})`);
  const flowchart =
    "flowchart LR\n  subgraph grp [Group]\n    A[Parser] --> B[Checker]\n  end\n  B --> C[Done]";

  test("colors flowchart nodes and subgraphs, and clears their styles again", async () => {
    await draw({ source: flowchart });
    const revision = page.panel.revision;
    const styled = await style({
      styles: [
        { id: "A", fill: "green" },
        { id: "grp", stroke: "rgb(0, 102, 0)" },
      ],
      revision,
    });
    assert.strictEqual(
      styled,
      `Styled "A" (fill green, text white for contrast), "grp" (stroke #006600).\n\nRevision: ${page.panel.revision}.`,
    );
    assert.ok(page.panel.revision > revision);
    assert.strictEqual(
      source(),
      `${flowchart}\n  style A fill:green,color:white\n  style grp stroke:#006600`,
    );
    assert.strictEqual(await filled("A", "rgb(0, 128, 0)"), true);

    const cleared = await style({
      styles: [
        { id: "A", clear: true },
        { id: "C", clear: true },
      ],
    });
    assert.match(
      cleared,
      /^Removed the style of "A"\. "C" had no style to remove\.\n\nRevision: \d+\.$/,
    );
    assert.strictEqual(source(), `${flowchart}\n  style grp stroke:#006600`);
    assert.strictEqual(await filled("A", "rgb(0, 128, 0)"), false);
  });

  test("colors flowchart edges named by their ends or ids with linkStyle lines, and clears them again", async () => {
    const edges =
      "flowchart LR\n  A[Parser] -->|parses| B[Checker]\n  B ~~~ D[Log]\n  B --> C[Done]\n  B --> C\n  linkStyle 0,2 stroke-width:3px";
    await draw({ source: edges });
    const result = await style({
      styles: [
        { id: "A --> B", stroke: "#f00", text: "blue" },
        { id: "edge:L_B_C_2", stroke: "hsl(120 100% 25%)" },
        { id: "B --> C", stroke: "red" },
        { id: "A -> B", stroke: "red" },
        { id: "C --> A", stroke: "red" },
      ],
    });
    const [styled, unknown, several, twice, revision] = result.split("\n\n");
    assert.strictEqual(
      styled,
      'Styled "A --> B" (stroke #ff0000, text blue), "edge:L_B_C_2" (stroke #008000).',
    );
    assert.strictEqual(
      unknown,
      `These ids are not nodes, subgraphs or edges of the diagram, so they were not styled: "C --> A" (nothing goes from "C" to "A"). Its ids are ${quoteAll(page.panel.drawnIds ?? [])}. Name an edge by its ends' ids, as in "A --> B".`,
    );
    assert.strictEqual(
      several,
      '"B --> C" (ids: "edge:L_B_C_0" for "Checker → Done", "edge:L_B_C_2" for "Checker → Done") names several edges, so none was styled: give the id of the one to color.',
    );
    assert.strictEqual(
      twice,
      '"A -> B" names the same edge as "A --> B"; give each edge one entry.',
    );
    assert.strictEqual(revision, `Revision: ${page.panel.revision}.`);
    // The invisible link counts too, as Mermaid numbers the links.
    assert.strictEqual(
      source(),
      "flowchart LR\n  A[Parser] -->|parses| B[Checker]\n  B ~~~ D[Log]\n  B --> C[Done]\n  B --> C\n  linkStyle 2 stroke-width:3px\n  linkStyle 0 stroke:#ff0000,color:blue,stroke-width:3px\n  linkStyle 3 stroke:#008000",
    );
    const line = (id: string, property: string) =>
      evaluate(
        `getComputedStyle(document.querySelector('#diagram .diagram-relationship:not(.diagram-relationship-hit)[data-diagram-id=${JSON.stringify(id)}]')).${property}`,
      );
    assert.deepStrictEqual(
      [
        await line("edge:L_A_B_0", "stroke"),
        await line("edge:L_A_B_0", "strokeWidth"),
        await line("edge:L_B_C_0", "strokeWidth"),
        await line("edge:L_B_C_2", "stroke"),
      ],
      ["rgb(255, 0, 0)", "3px", "3px", "rgb(0, 128, 0)"],
    );
    // The label's text takes the color.
    assert.strictEqual(
      await evaluate(
        `[...document.querySelectorAll('#diagram .edgeLabel [data-diagram-id="edge:L_A_B_0"], #diagram .edgeLabel [data-diagram-id="edge:L_A_B_0"] *')].some((e) => e.textContent.includes("parses") && getComputedStyle(e).color === "rgb(0, 0, 255)")`,
      ),
      true,
    );

    const cleared = await style({ styles: [{ id: "A --> B", clear: true }] });
    assert.match(cleared, /^Removed the style of "A --> B"\.\n\nRevision: \d+\.$/);
    assert.strictEqual(
      source(),
      "flowchart LR\n  A[Parser] -->|parses| B[Checker]\n  B ~~~ D[Log]\n  B --> C[Done]\n  B --> C\n  linkStyle 2 stroke-width:3px\n  linkStyle 3 stroke:#008000",
    );
  });

  test("names the ids it does not know, refuses note labels, and styles the others", async () => {
    await draw({
      source: "stateDiagram-v2\n  [*] --> A\n  A --> B\n  note right of A : Important",
    });
    assert.ok(page.panel.drawnIds?.includes("Important"));
    const result = await style({
      styles: [
        { id: "Important", fill: "red" },
        { id: "Nope", fill: "red" },
        { id: "A\nstyle B fill:red", fill: "red" },
        { id: "B", fill: "yellow" },
      ],
    });
    const [styled, unknown, label, revision] = result.split("\n\n");
    assert.strictEqual(styled, 'Styled "B" (fill yellow, text black for contrast).');
    assert.strictEqual(
      unknown,
      'These ids are not states of the diagram, so they were not styled: "Nope", "A\\nstyle B fill:red". Its ids are "A", "B".',
    );
    assert.match(
      label ?? "",
      /^"Important" is a label, not an id in the source.*Notes cannot be colored\.$/,
    );
    assert.strictEqual(revision, `Revision: ${page.panel.revision}.`);
    assert.doesNotMatch(source(), /style (?:Important|Nope|A)\b/);
    assert.match(source(), /\n {2}style B fill:yellow,color:black$/);
  });

  test("refuses a stale revision, all items and composite states, saying the revision", async () => {
    await draw({ source: "stateDiagram-v2\n  state S {\n    A --> B\n  }\n  [*] --> S" });
    const before = source();
    const revision = page.panel.revision;
    assert.strictEqual(
      await style({ styles: [{ id: "A", fill: "red" }], revision: revision - 1 }),
      `Nothing was styled: The diagram changed since revision ${revision - 1}. Read diagram_getState and retry with its current revision. Revision: ${revision}.`,
    );
    const refused = await style({
      styles: [
        { id: "S", fill: "red" },
        { id: "all", fill: "red" },
      ],
    });
    assert.match(refused, new RegExp(`^Nothing was styled\\. Revision: ${revision}\\.\\n\\n`));
    assert.match(refused, /"S" is a composite state, which Mermaid draws without colors/);
    assert.match(refused, /"all" is not an item: give the ids of the states to color/);
    assert.strictEqual(source(), before);
    assert.strictEqual(page.panel.revision, revision);
  });

  test("says that the background follows the theme, still styling the items given", async () => {
    await draw({ source: flowchart });
    const result = await style({
      styles: [
        { id: "background", fill: "black" },
        { id: "B", fill: "#ff000080" },
        { id: "C", fill: "transparent" },
      ],
    });
    assert.match(
      result,
      /^Styled "B" \(fill #ff000080, text from the theme\), "C" \(fill transparent, text from the theme\)\.\n\n"background" was not styled: The panel background follows the VS Code theme and can't be changed\. Color the diagram's nodes, subgraphs or edges instead\.\n\nThe fill of "B", "C" is translucent, so no text color was written: the panel picks one that reads on the theme\.\n\nRevision: \d+\.$/,
    );
    assert.strictEqual(
      source(),
      `${flowchart}\n  style B fill:#ff000080\n  style C fill:transparent`,
    );
  });

  test("colors classes and entities, and refuses other diagrams and charts", async () => {
    await draw({ source: "classDiagram\n  class Parser\n  Parser <|-- Json" });
    assert.match(await style({ styles: [{ id: "Parser", fill: "navy" }] }), /^Styled "Parser"/);
    assert.strictEqual(page.panel.current?.error, undefined);
    assert.strictEqual(await filled("Parser", "rgb(0, 0, 128)"), true);

    await draw({ source: "erDiagram\n  CUSTOMER ||--o{ ORDER : places" });
    assert.match(await style({ styles: [{ id: "ORDER", fill: "gold" }] }), /^Styled "ORDER"/);
    assert.strictEqual(page.panel.current?.error, undefined);
    assert.strictEqual(await filled("ORDER", "rgb(255, 215, 0)"), true);

    const sequence = "sequenceDiagram\n  Alice->>Bob: Hello";
    await draw({ source: sequence });
    assert.strictEqual(
      await style({ styles: [{ id: "Alice", fill: "red" }] }),
      `Nothing was styled: Coloring isn't supported for sequenceDiagram diagrams. diagram_style colors flowchart nodes, subgraphs and edges, classes, states and ER entities. Revision: ${page.panel.revision}.`,
    );
    assert.strictEqual(source(), sequence);

    await draw({ language: "echarts", source: '{"series": [{"type": "pie", "data": [1]}]}' });
    const chart = await style({ styles: [{ id: "background", fill: "red" }] });
    assert.match(
      chart,
      /^Nothing was styled: Coloring isn't supported for charts\. Change the colors in the ECharts option with diagram_edit, after diagram_getState for its source\./,
    );
    assert.match(chart, /background follows the VS Code theme/);
    assert.doesNotMatch(chart, /nodes/);
  });

  test("keeps the items selected in the page, also of a one-line flowchart", async () => {
    await draw({ source: "graph TD;A-->B;" });
    await evaluate(`document.querySelector('#diagram [data-diagram-id="A"][tabindex]')
      .dispatchEvent(new MouseEvent("click", { bubbles: true }))`);
    const selected = () =>
      /selected these nodes in the panel: "A"/.test(page.panel.describeForModel() ?? "");
    assert.ok(await within(selected), "A is selected");
    assert.match(await style({ styles: [{ id: "B", fill: "navy" }] }), /^Styled "B"/);
    assert.strictEqual(source(), "graph TD;A-->B;\n  style B fill:navy,color:white");
    // The page clears the selection of the new drawing, and then selects A again.
    await evaluate(`(async () => {
      ${UNTIL}
      await until(() => document.querySelector('#diagram [data-diagram-id="A"].diagram-selected'),
        "A selected again");
    })()`);
    assert.ok(await within(selected), "A stays selected");
  });

  test("leaves a diagram opened from Markdown to Apply or Write to, as other agents' changes", async () => {
    const file = path.join(tempDir("diagram-style-"), "notes.md");
    const markdown = `# Notes\n\n\`\`\`mermaid\n${flowchart}\n\`\`\`\n`;
    fs.writeFileSync(file, markdown);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const [fence] = findDiagramFences(document.getText());
    assert.ok(fence);
    const opened = await page.panel.render(
      {
        language: "mermaid",
        source: fence.source,
        title: "Notes",
        document: { uri: document.uri.toString(), fence },
      },
      "document",
    );
    assert.ok(opened.ok);
    try {
      const result = await style({ styles: [{ id: "C", fill: "green" }] });
      assert.match(
        result,
        /^Styled "C".*\n\nThe diagram was opened from a code block in notes\.md\. The change is in the panel only, until the user writes it to that file with Apply or Write to\.\n\nRevision: \d+\.$/,
      );
      assert.strictEqual(document.getText(), markdown);
      assert.strictEqual(page.panel.current?.document?.replaced, true);
    } finally {
      // The next Mermaid diagram of the suites would keep the binding.
      await draw({ language: "echarts", source: '{"series": [{"type": "pie", "data": [1]}]}' });
    }
  });
});
