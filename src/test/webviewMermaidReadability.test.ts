import * as assert from "node:assert";
import * as vscode from "vscode";
import { RenderDiagramTool } from "../tools";
import { afterTest } from "./afterTest";
import { webviewTabs } from "./newPanel";
import { invokeTool } from "./toolText";
import { suitePage, UNTIL } from "./webviewHarness";

/** Diagrams of the common types, as a model draws them, that read well in a narrow panel. */
const READABLE = [
  `flowchart TD
  A[User opens app] --> B{Logged in?}
  B -->|Yes| C[Show dashboard]
  B -->|No| D[Show login form]
  D --> E[Submit credentials]
  E --> F{Valid?}
  F -->|Yes| C
  F -->|No| G[Show error]
  G --> D`,
  `flowchart LR
  Client --> API[API Gateway]
  API --> Auth[Auth Service]
  API --> Orders[Order Service]
  Orders --> DB[(Postgres)]
  Orders --> Queue[[Kafka]]
  Queue --> Mailer[Email Worker]`,
  `flowchart TB
  subgraph Frontend
    UI[React UI] --> Store[Redux store]
  end
  subgraph Backend
    API[REST API] --> Svc[Service layer]
  end
  subgraph Legend
    L1[Service]
    L2[(Store)]
  end
  Store --> API
  Svc --> DB[(PostgreSQL)]`,
  `sequenceDiagram
  actor User
  participant Web as Web App
  participant API
  participant DB as Database
  User->>Web: Click "Save"
  Web->>API: PUT /documents/42
  API->>DB: UPDATE documents
  DB-->>API: 1 row
  API-->>Web: 200 OK
  Web-->>User: Show "Saved"
  Note over Web,API: Retries on 5xx`,
  `classDiagram
  class Animal {
    +String name
    +makeSound() void
  }
  class Dog
  class Owner {
    +adopt(Animal a) void
  }
  Animal <|-- Dog
  Owner "1" --> "*" Animal : owns`,
  `erDiagram
  CUSTOMER ||--o{ ORDER : places
  ORDER ||--|{ LINE_ITEM : contains
  CUSTOMER {
    int id PK
    string name
  }
  ORDER {
    int id PK
    int customer_id FK
  }`,
  `stateDiagram-v2
  [*] --> Draft
  Draft --> Review : submit
  Review --> Draft : request changes
  Review --> Published : approve
  Published --> [*]`,
  `gantt
  dateFormat YYYY-MM-DD
  section Design
  Wireframes :a1, 2026-01-05, 7d
  section Build
  Frontend :b1, after a1, 14d
  Backend :b2, after a1, 10d`,
  `mindmap
  root((Launch))
    Marketing
      Blog post
      Newsletter
    Engineering
      Load testing
    Support
      FAQ`,
  `pie title Browsers
  "Chrome" : 64
  "Safari" : 19
  "Other" : 17`,
  `gitGraph
  commit id: "init"
  branch feature
  commit id: "add api"
  checkout main
  merge feature`,
  `timeline
  2024 : Beta : First customers
  2025 : 1.0 release
  2026 : Enterprise edition`,
  `architecture-beta
  group api(cloud)[API]
  service db(database)[Database] in api
  service server(server)[Server] in api
  db:L -- R:server`,
  `quadrantChart
  x-axis Low Reach --> High Reach
  y-axis Low Engagement --> High Engagement
  Campaign A: [0.3, 0.6]
  Campaign B: [0.45, 0.23]`,
  `xychart
  x-axis [jan, feb, mar, apr, may, jun]
  bar [5000, 6000, 7500, 8200, 9500, 10000]`,
  // Slanted labels, whose boxes overlap where the labels do not.
  `gitGraph
  commit id: "a very long commit message one"
  commit id: "a very long commit message two"`,
];

/** A chain of steps, laid out in the direction. */
const chain = (header: string, steps: number) =>
  `${header}\n${Array.from({ length: steps }, (_, i) => `  S${i}[Step ${i} of the pipeline] --> S${i + 1}[Step ${i + 1} of the pipeline]`).join("\n")}`;

/** A timeline 1,190 px wide, which reads in a panel about 430 px wide. */
const TIMELINE = "timeline\n  2023 : Prototype\n  2024 : Beta\n  2025 : 1.0\n  2026 : 2.0";

const PACKET = `packet
  0-15: "Source Port"
  16-31: "Destination Port"
  32-63: "Sequence Number"`;

suite("Mermaid readability in the webview", function () {
  this.timeout(60_000);

  const page = suitePage();
  const { evaluate, draw } = page;

  /** The warnings that the panel has for the Mermaid source drawn at the panel width. */
  const warnings = async (source: string, panelWidth = 450): Promise<readonly string[]> => {
    await evaluate(`document.body.style.maxWidth = "${panelWidth}px"`);
    await draw({ source });
    return page.panel.warnings;
  };
  setup(() => afterTest(() => evaluate(`document.body.style.maxWidth = ""`)));

  test("says nothing of diagrams that read well in a narrow panel", async () => {
    for (const source of READABLE) {
      assert.deepStrictEqual(await warnings(source), [], source);
    }
  });

  test("says when fitting a drawing to the panel makes its text too small, and what helps", async () => {
    const tooSmall = (remedy: string) =>
      new RegExp(
        `^Too small to read: the [\\d,]+ px wide drawing fits the panel's 4\\d\\d px width at \\d+%, which shows its 16 px text at [\\d.]+ px\\. ${remedy}\\.$`,
      );
    assert.match(
      (await warnings(chain("flowchart LR", 15)))[0] ?? "",
      tooSmall('Change "flowchart LR" to "flowchart TB" or split it into several diagrams'),
    );
    // The remedies help.
    assert.deepStrictEqual(await warnings(chain("flowchart TB", 15)), []);
    const fan = `flowchart TD\n  Root[Central service]\n${Array.from({ length: 14 }, (_, i) => `  Root --> C${i}[Consumer service ${i}]`).join("\n")}`;
    assert.match(
      (await warnings(fan))[0] ?? "",
      tooSmall('Change "flowchart TD" to "flowchart LR" or split it into several diagrams'),
    );
    assert.deepStrictEqual(await warnings(fan.replace("flowchart TD", "flowchart LR")), []);
    assert.match(
      (await warnings(chain("stateDiagram-v2\n  direction LR", 25).replace(/\[.*?\]/g, "")))[0] ??
        "",
      /\. Lay it out with "direction TB" or split it into several diagrams\.$/,
    );
    const messages = Array.from(
      { length: 12 },
      (_, i) => `  P${i}->>P${i + 1}: request number ${i}`,
    );
    assert.match(
      (await warnings(`sequenceDiagram\n${messages.join("\n")}`))[0] ?? "",
      /\. Shorten its messages and show fewer participants or split it into several diagrams\.$/,
    );
    // The panel draws a packet's bits narrower in a narrow panel, unless the packet sizes them.
    assert.deepStrictEqual(await warnings(PACKET), []);
    assert.match(
      (await warnings(`---\nconfig:\n  packet: {bitWidth: 32}\n---\n${PACKET}`))[0] ?? "",
      /\. Show fewer bits per row, with "packet: \{bitsPerRow: 16\}" under "config" in the front matter or widen the panel to at least \d+ px\.$/,
    );
    assert.deepStrictEqual(
      await warnings(`---\nconfig:\n  packet: {bitWidth: 32, bitsPerRow: 16}\n---\n${PACKET}`),
      [],
    );
  });

  test("says how wide a panel shows a drawing that is a little too wide for it", async () => {
    const [narrow] = await warnings(TIMELINE, 350);
    const wider =
      /^Too small to read: the [\d,]+ px wide drawing fits the panel's (\d+) px width at \d+%, which shows its 16 px text at [\d.]+ px\. Widen the panel to at least (\d+) px or split it into several diagrams\.$/.exec(
        narrow ?? "",
      );
    assert.ok(wider, narrow);
    const [room, width] = [Number(wider[1]), Number(wider[2])];
    assert.ok(room < 350 && width > 350 && width <= 525, narrow);
    assert.deepStrictEqual(await warnings(TIMELINE, width), []);
  });

  test("measures for a narrow panel while the page has the size of an empty frame", async () => {
    const [tab] = await webviewTabs((labels) => labels.length === 1);
    const column = tab?.group.viewColumn;
    assert.ok(column);
    // Too wide for a panel 300 px wide but not for one 500 px wide, and too wide for both.
    const sources = [TIMELINE, chain("flowchart LR", 15)];
    const answers = new Map<number, unknown>();
    const listener = page.webview.onDidReceiveMessage((message) => {
      if (message.type === "rendered") answers.set(message.requestId, message.warnings);
    });
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(), column);
    try {
      // As when the page hears that the tab is shown before it has the tab's size, under load.
      await evaluate(`(async () => {
        ${UNTIL}
        await until(() => innerWidth === 300, "the size of a hidden tab");
        receive({type: "tabVisibility", hidden: false});
        for (const [index, source] of ${JSON.stringify(sources)}.entries()) {
          const requestId = 2000000 + index;
          receive({type: "render", requestId, language: "mermaid", source, title: "Hidden"});
          await until(() => testRenderResults.includes(requestId), "the diagram drawn");
        }
      })()`);
    } finally {
      listener.dispose();
      page.panel.show(true);
    }
    assert.deepStrictEqual(answers.get(2_000_000), []);
    assert.match(
      String((answers.get(2_000_001) as string[] | undefined)?.[0]),
      /^Too small to read: the [\d,]+ px wide drawing fits a narrow panel's 500 px width at /,
    );
  });

  test("says when a graph has more nodes than read well", async () => {
    const edges = Array.from(
      { length: 70 },
      (_, i) => `  N${i} --> N${(i * 7 + 3) % 70}\n  N${i} --> N${(i * 3 + 1) % 70}`,
    );
    const found = await warnings(`flowchart TD\n${edges.join("\n")}`, 2000);
    assert.deepStrictEqual(
      found.filter((warning) => !warning.startsWith("Too small")),
      [
        "Hard to follow: 70 nodes and 140 edges, where about 50 nodes or 80 edges read well in one diagram. Split it into several diagrams.",
      ],
    );
  });

  test("names the flowchart nodes that are linked to nothing, as a misspelt id leaves them", async () => {
    assert.deepStrictEqual(
      await warnings("flowchart TD\n  A[API] --> B[DB]\n  A --> C[Cache]\n  D[Queue]\n  C --> B"),
      [
        'Node "D" ("Queue") is linked to no other node: link it, or check that its id is the one its edges use.',
      ],
    );
    // A style for a node that is not there draws one.
    assert.deepStrictEqual(
      await warnings("flowchart TD\n  A --> B\n  A --> C\n  style X fill:#f00\n  E\n  F\n  G"),
      [
        'Nodes "X", "E", "F" and 1 more are linked to no other node: link them, or check that their ids are the ones their edges use.',
      ],
    );
    // Nodes in subgraphs, and in flowcharts of hardly any edges, may well stand alone.
    assert.deepStrictEqual(await warnings("flowchart TD\n  A --> B\n  C\n  D"), []);
  });

  test("says when a link takes the o or x of the node it was meant for as its end", async () => {
    const cases = [
      [
        "api---orderService",
        "circle",
        "rderService",
        "---o",
        "o",
        "orderService",
        "api --- orderService",
      ],
      ["A--xray", "cross", "ray", "--x", "x", "xray", "A --- xray"],
      ["A==oB", "circle", "B", "==o", "o", "oB", "A === oB"],
      ["A-.-oB", "circle", "B", "-.-o", "o", "oB", "A -.- oB"],
    ];
    for (const [link, end, node, arrow, mark, meant, fixed] of cases) {
      const source = (statement: string) => `flowchart LR\n  ${statement}\n  ${meant} --> db`;
      assert.deepStrictEqual(await warnings(source(link as string)), [
        `The link on line 2 ends in a ${end} at node "${node}", as "${arrow}" takes the "${mark}" of "${meant}": put spaces around the link, as in ${fixed}.`,
      ]);
      // The fix links the node meant, as the only node besides db.
      assert.deepStrictEqual(await warnings(source(fixed as string)), []);
      assert.strictEqual(page.panel.drawnIds?.length, 3, fixed);
    }
    // Links meant to end in a circle or cross, also without spaces.
    assert.deepStrictEqual(
      await warnings("flowchart LR\n  A --o B\n  A --x C\n  A o--o D\n  E--oF\n  E--xG"),
      [],
    );
  });

  test("names Gantt tasks placed after or until a task that the chart does not have", async () => {
    const gantt = (build: string, test: string) =>
      `gantt\n  dateFormat YYYY-MM-DD\n  Design :a1, 2026-01-05, 7d\n  Build :a2, ${build}, 7d\n  Test :${test}`;
    assert.deepStrictEqual(await warnings(gantt("after a0", "after a2, until a9")), [
      'Task "Build" starts with "after a0", but no task has the id "a0" (and 1 more), so Mermaid draws it from today: give the id of a task, such as "a1", or a date.',
    ]);
    assert.deepStrictEqual(await warnings(gantt("after a1 design", "after a2, 3d")), [
      'Task "Build" starts with "after a1 design", but no task has the id "design", and Mermaid leaves it out: give the id of a task, such as "a1", or a date.',
    ]);
    assert.deepStrictEqual(await warnings(gantt("2026-01-12", "after a2, until a9")), [
      'Task "Test" ends with "until a9", but no task has the id "a9", so Mermaid draws it to today: give the id of a task, such as "a1", or a date.',
    ]);
    // Tasks may name tasks that come after them.
    assert.deepStrictEqual(await warnings(gantt("after a3", "a3, 2026-01-05, 3d")), []);
  });

  test("says when labels overlap, and what they say", async () => {
    const [close] = await warnings(`quadrantChart
  x-axis Low --> High
  y-axis Low --> High
  Alpha campaign: [0.30, 0.60]
  Beta campaign: [0.32, 0.61]
  Delta: [0.7, 0.2]`);
    assert.match(
      close ?? "",
      /^Labels overlap, such as "(Alpha|Beta) campaign" and "(Alpha|Beta) campaign": shorten them, or draw fewer or more widely spaced items\.$/,
    );
    const months = Array.from({ length: 40 }, (_, i) => `month-${i}`);
    assert.match(
      (
        await warnings(
          `xychart\n  x-axis [${months.join(", ")}]\n  bar [${months.map((_, i) => i).join(", ")}]`,
        )
      )[0] ?? "",
      /^Labels overlap, such as "month-\d+" and "month-\d+" \(\d+ pairs\)/,
    );
  });

  test("tells the model that rendered the diagram", async () => {
    await evaluate(`document.body.style.maxWidth = "450px"`);
    const result = await invokeTool(new RenderDiagramTool(page.panel), {
      source: chain("flowchart LR", 15),
    });
    assert.match(
      result,
      /^Rendered the flowchart-v2 diagram in the diagram panel next to the chat\.\n\nToo small to read: the [\d,]+ px wide drawing fits the panel's 4\d\d px width .* Change "flowchart LR" to "flowchart TB" or split it into several diagrams\.\n\nRevision: \d+\.$/,
    );
  });
});
