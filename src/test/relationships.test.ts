import * as assert from "node:assert";
import * as vscode from "vscode";
import type { Diagram, DiagramPanel, RenderOutcome } from "../panel";
import type { DiagramNode } from "../protocol";
import { newPanel } from "./newPanel";
import { instrumentWebview, type WebviewHarness } from "./webviewHarness";

suite("relationships", function () {
  // The first render loads the webview and the libraries, which can take a while.
  this.timeout(20_000);

  let panel: DiagramPanel;
  let evaluate: WebviewHarness["evaluate"];
  /** The selection, and the relationships drawn, that the webview last reported. */
  let selection: DiagramNode[] = [];
  let drawnRelationships: DiagramNode[] = [];
  suiteSetup(() => {
    panel = newPanel();
    const harness = instrumentWebview(panel);
    evaluate = harness.evaluate;
    harness.webview.onDidReceiveMessage((message) => {
      if (message.type === "selectionChanged") selection = message.nodes;
      if (message.type === "rendered") drawnRelationships = message.relationships ?? [];
    });
  });
  suiteTeardown(() => panel.dispose());

  const render = (diagram: Partial<Diagram>): Promise<RenderOutcome> =>
    panel.render({ language: "mermaid", source: "", title: "Test", ...diagram }, "tool");

  const selected = () => selection;
  const click = (selector: string, modifier = false) =>
    evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error("Missing selector: " + ${JSON.stringify(selector)});
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: ${modifier} }));
  })()`);
  const node = (id: string) => `[data-diagram-id="${id}"][tabindex="0"]`;

  test("selects labeled and parallel edges with authoritative underscore endpoints and stable IDs", async () => {
    const source =
      "flowchart LR\n A_B[Origin] first@-->|First| B_C[Target]\n A_B second@--> B_C\n B_C back@--> A_B";
    assert.ok((await render({ source })).ok);
    assert.deepStrictEqual(
      await evaluate(
        `Array.from(document.querySelectorAll('.diagram-relationship[tabindex="0"]'), e => e.dataset.diagramId)`,
      ),
      ["edge:first", "edge:second", "edge:back"],
    );
    await click('.edgeLabel .label[data-id="first"]');
    assert.deepStrictEqual(selected()[0]?.relationship, {
      kind: "edge",
      source: "A_B",
      target: "B_C",
      direction: "forward",
    });
    assert.match(selected()[0]?.label ?? "", /First/);
    await click(node("edge:second"), true);
    assert.deepStrictEqual(
      selected().map((n) => n.id),
      ["edge:first", "edge:second"],
    );
    assert.match(panel.describeForModel() ?? "", /edge:first; edge; from: A_B; to: B_C/);
    assert.ok(
      panel.annotate({
        marks: [{ id: "edge:second", kind: "problem", note: "Timeout" }],
        dim: true,
      }).ok,
    );
    assert.ok(
      await evaluate(
        `new Promise(resolve => setTimeout(() => resolve(document.querySelector('[data-diagram-id="edge:second"][tabindex="0"]').classList.contains('diagram-mark-problem')), 50))`,
      ),
    );
    assert.strictEqual(
      await evaluate(
        `getComputedStyle(document.querySelector('.diagram-relationship-hit[data-diagram-id="edge:second"]')).stroke`,
      ),
      "rgba(0, 0, 0, 0)",
    );
    assert.ok((await render({ source })).ok);
    assert.deepStrictEqual(
      await evaluate(
        `Array.from(document.querySelectorAll('.diagram-relationship[tabindex="0"]'), e => e.dataset.diagramId)`,
      ),
      ["edge:first", "edge:second", "edge:back"],
    );
  });

  test("selects unlabeled edges by their wide hit target and keyboard without changing node selection", async () => {
    assert.ok((await render({ source: "flowchart LR\n A --> B\n A --> B" })).ok);
    const ids = (await evaluate(
      `Array.from(document.querySelectorAll('.diagram-relationship[tabindex="0"]'), e => e.dataset.diagramId)`,
    )) as string[];
    assert.strictEqual(ids.length, 2);
    assert.notStrictEqual(ids[0], ids[1]);
    await click(".diagram-relationship-hit");
    assert.deepStrictEqual(
      selected().map((n) => n.id),
      [ids[0]],
    );
    await evaluate(
      `document.querySelector(${JSON.stringify(node(ids[1] ?? ""))}).dispatchEvent(new KeyboardEvent('keydown', {key:' ',ctrlKey:true,bubbles:true}))`,
    );
    assert.deepStrictEqual(
      selected().map((n) => n.id),
      ids,
    );
    await click(node("A"), true);
    assert.deepStrictEqual(
      selected().map((n) => n.id),
      [...ids, "A"],
    );
    await click(node("B"));
    assert.deepStrictEqual(selected(), [{ id: "B", label: "B" }]);
  });

  test("selects repeated and self sequence messages with multiline labels and supports picking and marks", async () => {
    assert.ok(
      (
        await render({
          source:
            "sequenceDiagram\n autonumber 7\n participant A as Client\n A->>A: Repeat\n A->>B: Repeat\n B-->>A: Reply<br/>again\n Note over A: waiting\n A->>B: Repeat",
        })
      ).ok,
    );
    const ids = (await evaluate(
      `Array.from(document.querySelectorAll('[data-et="message"]'), e => e.dataset.diagramId)`,
    )) as string[];
    assert.strictEqual(ids.length, 4);
    assert.strictEqual(new Set(ids).size, 4);
    assert.ok(ids.every((id) => id.startsWith("message:i")));
    await click(node(ids[0] ?? ""));
    assert.deepStrictEqual(selected()[0]?.relationship, {
      kind: "message",
      source: "A",
      target: "A",
      direction: "forward",
    });
    await evaluate(
      `document.querySelector(${JSON.stringify(node(ids[1] ?? ""))}).dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',shiftKey:true,bubbles:true}))`,
    );
    assert.deepStrictEqual(
      selected().map((n) => n.id),
      ids.slice(0, 2),
    );
    await click(`text.messageText[data-diagram-id="${ids[2]}"]`);
    assert.strictEqual(selected()[0]?.id, ids[2]);
    assert.match(selected()[0]?.label ?? "", /Reply again/);
    assert.ok(panel.annotate({ marks: [{ id: ids[2] ?? "", kind: "current" }], dim: false }).ok);
    assert.match(panel.describeForModel() ?? "", /message; from: B; to: A/);
    const token = new vscode.CancellationTokenSource();
    const picking = panel.pickNodes("Which message?", false, token.token);
    await evaluate("new Promise(resolve => setTimeout(resolve, 50))");
    await click(node(ids[3] ?? ""));
    const result = await picking;
    assert.ok(result.picked);
    if (result.picked) assert.strictEqual(result.nodes[0]?.id, ids[3]);
    token.dispose();
  });

  test("sends relationship IDs, endpoints and aliases with a chat request", async () => {
    assert.ok(
      (
        await render({
          source:
            "sequenceDiagram\n participant A as Client\n participant B as Server\n A->>B: Retry",
        })
      ).ok,
    );
    await click('[data-et="message"]');
    const execute = vscode.commands.executeCommand;
    const asked = Promise.withResolvers<string>();
    vscode.commands.executeCommand = (async (command: string, args: { query: string }) => {
      assert.strictEqual(command, "workbench.action.chat.open");
      asked.resolve(args.query);
    }) as typeof execute;
    try {
      await evaluate(`(() => {
        document.querySelector('#ask-input').value = 'Add a timeout here';
        document.querySelector('#ask-form').dispatchEvent(new Event('submit', {bubbles:true,cancelable:true}));
      })()`);
      const query = await asked.promise;
      assert.match(query, /Client → Server: Retry/);
      assert.match(query, /id: message:i\d+; message; from: A; to: B; direction: forward/);
      assert.match(query, /Add a timeout here/);
    } finally {
      vscode.commands.executeCommand = execute;
    }
  });

  test("selects the relationships of class, state, ER and requirement diagrams", async () => {
    const relationships = async (source: string) => {
      assert.ok((await render({ source })).ok);
      return drawnRelationships.map(({ label, relationship }) => [
        label,
        relationship?.source,
        relationship?.target,
        relationship?.direction,
      ]);
    };
    // An inheritance arrow points to the parent; a composition diamond is no arrowhead.
    assert.deepStrictEqual(
      await relationships("classDiagram\n  Animal <|-- Duck : is a\n  Pond *-- Duck"),
      [
        ["Duck → Animal: is a", "Duck", "Animal", "forward"],
        ["Pond — Duck", "Pond", "Duck", "undirected"],
      ],
    );
    // The transition from the start state has no node to describe.
    assert.deepStrictEqual(
      await relationships("stateDiagram-v2\n  [*] --> Still\n  Still --> Moving : push"),
      [["Still → Moving: push", "Still", "Moving", "forward"]],
    );
    // Entities go by their names, not the ids Mermaid draws them with; cardinalities are no arrows.
    assert.deepStrictEqual(await relationships("erDiagram\n  CUSTOMER ||--o{ ORDER : places"), [
      ["CUSTOMER — ORDER: places", "CUSTOMER", "ORDER", "undirected"],
    ]);
    assert.deepStrictEqual(
      await relationships(
        "requirementDiagram\n  requirement req {\n    id: 1\n  }\n  element sim {\n    type: simulation\n  }\n  sim - satisfies -> req",
      ),
      [["sim → req: <<satisfies>>", "sim", "req", "forward"]],
    );
    const id = drawnRelationships[0]?.id;
    await click(`[data-diagram-id="${id}"][tabindex="0"]`);
    assert.deepStrictEqual(
      selected().map((n) => n.id),
      [id],
    );
  });

  test("highlights a deterministic shortest path through cycles in selected direction and reports no path", async () => {
    assert.ok(
      (
        await render({
          source:
            "flowchart LR\n A first@--> B\n A second@--> C\n B third@--> D\n C fourth@--> D\n B cycle@--> A\n E[Isolated]",
        })
      ).ok,
    );
    await click(node("A"));
    await click(node("D"), true);
    assert.strictEqual(await evaluate('document.querySelector("#highlight-path").disabled'), false);
    await click("#highlight-path");
    assert.deepStrictEqual(
      selected().map((n) => n.id),
      ["A", "edge:first", "B", "edge:third", "D"],
    );
    assert.match(
      (await evaluate('document.querySelector("#selection-label").textContent')) as string,
      /shortest path.*2 edges/,
    );
    await click(node("D"));
    await click(node("A"), true);
    await click("#highlight-path");
    assert.deepStrictEqual(
      selected().map((n) => n.id),
      ["D", "A"],
    );
    assert.match(
      (await evaluate('document.querySelector("#selection-label").textContent')) as string,
      /No path from D to A/,
    );
    await click(node("A"));
    await click(node("E"), true);
    await click("#highlight-path");
    assert.match(
      (await evaluate('document.querySelector("#selection-label").textContent')) as string,
      /No path/,
    );
  });

  test("respects bidirectional, undirected and invisible flowchart edges", async () => {
    assert.ok(
      (await render({ source: "flowchart LR\n A both@<--> B\n B plain@--- C\n C ~~~ D" })).ok,
    );
    await click(node("C"));
    await click(node("A"), true);
    await click("#highlight-path");
    assert.deepStrictEqual(
      selected().map((n) => n.id),
      ["C", "edge:plain", "B", "edge:both", "A"],
    );
    assert.strictEqual(
      await evaluate('document.querySelectorAll(".diagram-relationship[tabindex]").length'),
      2,
    );
    await click(node("C"));
    await click(node("D"), true);
    await click("#highlight-path");
    assert.match(
      (await evaluate('document.querySelector("#selection-label").textContent')) as string,
      /No path/,
    );
  });

  test("keeps interaction hit targets and metadata out of SVG exports", async () => {
    assert.ok((await render({ source: "flowchart LR\n A edge@-->|Exported| B" })).ok);
    const svg = (await evaluate(`(async () => {
      const handle = document.querySelector('#drag-out');
      handle.dispatchEvent(new PointerEvent('pointerenter'));
      for (let i = 0; i < 100; i++) {
        await new Promise(resolve => setTimeout(resolve, 20));
        const dataTransfer = new DataTransfer();
        handle.dispatchEvent(new DragEvent('dragstart', {dataTransfer}));
        const svg = dataTransfer.getData('image/svg+xml');
        if (svg) return svg;
      }
      throw new Error('No exported SVG');
    })()`)) as string;
    assert.match(svg, /Exported/);
    assert.doesNotMatch(svg, /diagram-relationship-hit|data-diagram-id|aria-pressed/);
  });
});
