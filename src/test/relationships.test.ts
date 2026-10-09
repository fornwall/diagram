import * as assert from "node:assert";
import * as vscode from "vscode";
import type { DiagramNode } from "../protocol";
import { replace } from "./afterTest";
import { DRAG_IMAGE, suitePage, UNTIL } from "./webviewHarness";

suite("relationships", function () {
  // The first render loads the webview and the libraries, which can take a while.
  this.timeout(20_000);

  const page = suitePage();
  const { evaluate, draw } = page;
  /** The selection, and the relationships drawn, that the webview last reported. */
  let selection: DiagramNode[] = [];
  let drawnRelationships: DiagramNode[] = [];
  let listener: vscode.Disposable | undefined;
  suiteSetup(() => {
    listener = page.webview.onDidReceiveMessage((message) => {
      if (message.type === "selectionChanged") selection = message.nodes;
      if (message.type === "rendered") drawnRelationships = message.relationships ?? [];
    });
  });
  suiteTeardown(() => listener?.dispose());

  const click = (selector: string, modifier = false) =>
    evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error("Missing selector: " + ${JSON.stringify(selector)});
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: ${modifier} }));
  })()`);
  const node = (id: string) => `[data-diagram-id="${id}"][tabindex]`;
  /** Waits until the expression holds in the page, which handles some messages asynchronously. */
  const until = (expression: string) =>
    evaluate(`(async () => {
      ${UNTIL}
      await until(() => ${expression}, ${JSON.stringify(expression)});
    })()`);

  test("selects labeled and parallel flowchart edges by their ids, with endpoints whose ids hold underscores", async () => {
    const source =
      "flowchart LR\n A_B[Origin] first@-->|First| B_C[Target]\n A_B second@--> B_C\n B_C back@--> A_B";
    await draw({ source });
    assert.deepStrictEqual(
      await evaluate(
        `Array.from(document.querySelectorAll('.diagram-relationship[tabindex]'), e => e.dataset.diagramId)`,
      ),
      ["edge:first", "edge:second", "edge:back"],
    );
    await click('.edgeLabel .label[data-id="first"]');
    assert.deepStrictEqual(selection[0]?.relationship, {
      kind: "edge",
      source: "A_B",
      target: "B_C",
      direction: "forward",
    });
    assert.match(selection[0]?.label ?? "", /First/);
    await click(node("edge:second"), true);
    assert.deepStrictEqual(
      selection.map((n) => n.id),
      ["edge:first", "edge:second"],
    );
    assert.match(page.panel.describeForModel() ?? "", /"edge:first"; edge; from: "A_B"; to: "B_C"/);
    assert.ok(
      page.panel.annotate({
        marks: [{ id: "edge:second", kind: "problem", note: "Timeout" }],
        dim: true,
      }).ok,
    );
    // The page draws marks in turn with renders.
    await until(
      `document.querySelector('[data-diagram-id="edge:second"][tabindex]').classList.contains('diagram-mark-problem')`,
    );
    assert.strictEqual(
      await evaluate(
        `getComputedStyle(document.querySelector('.diagram-relationship-hit[data-diagram-id="edge:second"]')).stroke`,
      ),
      "rgba(0, 0, 0, 0)",
    );
    await draw({ source });
    assert.deepStrictEqual(
      await evaluate(
        `Array.from(document.querySelectorAll('.diagram-relationship[tabindex]'), e => e.dataset.diagramId)`,
      ),
      ["edge:first", "edge:second", "edge:back"],
    );
  });

  test("selects unlabeled edges by a wide hit target and with the keyboard, together with nodes", async () => {
    await draw({ source: "flowchart LR\n A --> B\n A --> B" });
    const ids = (await evaluate(
      `Array.from(document.querySelectorAll('.diagram-relationship[tabindex]'), e => e.dataset.diagramId)`,
    )) as string[];
    assert.strictEqual(ids.length, 2);
    assert.notStrictEqual(ids[0], ids[1]);
    await click(".diagram-relationship-hit");
    assert.deepStrictEqual(
      selection.map((n) => n.id),
      [ids[0]],
    );
    await evaluate(
      `document.querySelector(${JSON.stringify(node(ids[1] ?? ""))}).dispatchEvent(new KeyboardEvent('keydown', {key:' ',ctrlKey:true,bubbles:true}))`,
    );
    assert.deepStrictEqual(
      selection.map((n) => n.id),
      ids,
    );
    await click(node("A"), true);
    assert.deepStrictEqual(
      selection.map((n) => n.id),
      [...ids, "A"],
    );
    await click(node("B"));
    assert.deepStrictEqual(selection, [{ id: "B", label: "B" }]);
  });

  test("selects, picks and marks each sequence message, also repeated ones, ones to oneself and multiline ones", async () => {
    await draw({
      source:
        "sequenceDiagram\n autonumber 7\n participant A as Client\n A->>A: Repeat\n A->>B: Repeat\n B-->>A: Reply<br/>again\n Note over A: waiting\n A->>B: Repeat",
    });
    const ids = (await evaluate(
      `Array.from(document.querySelectorAll('[data-et="message"]'), e => e.dataset.diagramId)`,
    )) as string[];
    assert.strictEqual(ids.length, 4);
    assert.strictEqual(new Set(ids).size, 4);
    assert.ok(ids.every((id) => id.startsWith("message:i")));
    await click(node(ids[0] ?? ""));
    assert.deepStrictEqual(selection[0]?.relationship, {
      kind: "message",
      source: "A",
      target: "A",
      direction: "forward",
    });
    await evaluate(
      `document.querySelector(${JSON.stringify(node(ids[1] ?? ""))}).dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',shiftKey:true,bubbles:true}))`,
    );
    assert.deepStrictEqual(
      selection.map((n) => n.id),
      ids.slice(0, 2),
    );
    await click(`text.messageText[data-diagram-id="${ids[2]}"]`);
    assert.strictEqual(selection[0]?.id, ids[2]);
    assert.match(selection[0]?.label ?? "", /Reply again/);
    assert.ok(
      page.panel.annotate({ marks: [{ id: ids[2] ?? "", kind: "current" }], dim: false }).ok,
    );
    assert.match(page.panel.describeForModel() ?? "", /message; from: "B"; to: "A"/);
    const token = new vscode.CancellationTokenSource();
    const picking = page.panel.pickNodes("Which message?", false, token.token);
    await until("document.querySelector('.picking')");
    await click(node(ids[3] ?? ""));
    const result = await picking;
    assert.ok(result.picked);
    if (result.picked) assert.strictEqual(result.nodes[0]?.id, ids[3]);
    token.dispose();
  });

  test("sends relationship IDs, endpoints and aliases with a chat request", async () => {
    await draw({
      source: "sequenceDiagram\n participant A as Client\n participant B as Server\n A->>B: Retry",
    });
    await click('[data-et="message"]');
    const asked = Promise.withResolvers<string>();
    replace(vscode.commands, "executeCommand", (async (
      command: string,
      args: { query: string },
    ) => {
      assert.strictEqual(command, "workbench.action.chat.open");
      asked.resolve(args.query);
    }) as typeof vscode.commands.executeCommand);
    await evaluate(`(() => {
      // As a user does: a synthetic submit event would not show if the form could not submit.
      const input = document.querySelector('#ask-input');
      input.value = 'Add a timeout here';
      input.dispatchEvent(new Event('input'));
      document.querySelector('#ask-submit').click();
    })()`);
    const query = await asked.promise;
    assert.match(query, /Client → Server: Retry/);
    assert.match(query, /id: "message:i\d+"; message; from: "A"; to: "B"; direction: forward/);
    assert.match(query, /Add a timeout here/);
  });

  test("selects the relationships of class, state, ER and requirement diagrams", async () => {
    const relationships = async (source: string) => {
      await draw({ source });
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
    await click(`[data-diagram-id="${id}"][tabindex]`);
    assert.deepStrictEqual(
      selection.map((n) => n.id),
      [id],
    );
  });

  test("highlights the shortest path from the first selected node to the second, or says there is none", async () => {
    await draw({
      source:
        "flowchart LR\n A first@--> B\n A second@--> C\n B third@--> D\n C fourth@--> D\n B cycle@--> A\n E[Isolated]",
    });
    await click(node("A"));
    await click(node("D"), true);
    assert.strictEqual(await evaluate('document.querySelector("#highlight-path").disabled'), false);
    await click("#highlight-path");
    assert.deepStrictEqual(
      selection.map((n) => n.id),
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
      selection.map((n) => n.id),
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

  test("highlights paths in swimlane, agent flow and state diagrams, but not in class diagrams", async () => {
    const path = async (source: string, from: string, to: string) => {
      await draw({ source });
      await click(node(from));
      await click(node(to), true);
      if (await evaluate('document.querySelector("#highlight-path").hidden')) return undefined;
      await click("#highlight-path");
      return selection.map((n) => n.id);
    };
    assert.deepStrictEqual(
      await path(
        "swimlane-beta LR\n  subgraph A\n    a1[Start]\n  end\n  subgraph B\n    b1[Work] --> b2[End]\n  end\n  a1 --> b1",
        "a1",
        "b2",
      ),
      ["a1", "edge:L_a1_b1_0", "b1", "edge:L_b1_b2_0", "b2"],
    );
    assert.deepStrictEqual(
      await path("agentflow-beta\n  start --> plan\n  plan --> done", "start", "done"),
      ["start", "edge:L_start_plan_0", "plan", "edge:L_plan_done_0", "done"],
    );
    // Through a choice, which shows no name, by its id.
    assert.deepStrictEqual(
      await path(
        "stateDiagram-v2\n  [*] --> Still\n  Still --> Moving\n  state hit <<choice>>\n  Moving --> hit\n  hit --> Crash",
        "Still",
        "Crash",
      ),
      ["Still", "edge:edge1", "Moving", "edge:edge2", "hit", "edge:edge3", "Crash"],
    );
    assert.strictEqual(await path("classDiagram\n  Animal <|-- Duck", "Duck", "Animal"), undefined);
  });

  test("respects bidirectional, undirected and invisible flowchart edges", async () => {
    await draw({ source: "flowchart LR\n A both@<--> B\n B plain@--- C\n C ~~~ D" });
    await click(node("C"));
    await click(node("A"), true);
    await click("#highlight-path");
    assert.deepStrictEqual(
      selection.map((n) => n.id),
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
    await draw({ source: "flowchart LR\n A edge@-->|Exported| B" });
    const svg = (await evaluate(`(async () => {
      ${DRAG_IMAGE}
      return (await dragImage()).getData("image/svg+xml");
    })()`)) as string;
    assert.match(svg, /Exported/);
    assert.doesNotMatch(svg, /diagram-relationship-hit|data-diagram-id|aria-pressed/);
  });
});
