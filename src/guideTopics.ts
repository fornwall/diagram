// What diagram_guide tells a model about each kind of diagram: an example that renders in the
// panel, the syntax rules that models get wrong, layout tips, and what the panel does already, so
// that the model does not fight it. The tests render every example in the panel, which must draw
// it without an error or a warning, and keep each topic short.

import type { DiagramLanguage } from "./protocol";

export interface GuideTopic {
  /** The name that diagram_guide takes. */
  name: string;
  /** Other names that a model may ask for, such as the keyword that starts the diagram. */
  aliases: readonly string[];
  /** One line for the index. */
  summary: string;
  language: DiagramLanguage;
  /** A complete diagram or option that the panel draws without an error or a warning. */
  example: string;
  /** Rules and tips, after the example. */
  notes: string;
}

const MERMAID: GuideTopic[] = [
  {
    name: "mermaid",
    aliases: ["mermaid-basics", "front-matter", "config"],
    summary:
      "Front matter, ids and labels, styling, and what the panel does for every Mermaid diagram",
    language: "mermaid",
    example: `---
config:
  layout: dagre
---
flowchart LR
  %% A comment: front matter above sets options, the first line names the type
  client[Client] -->|"GET /items"| server[Server]`,
    notes: `- The first line, after optional front matter, names the type: each type has a topic here.
- Ids are short ASCII words (letters, digits, _) that stay the same across edits: selection, marks, code links and the user's edits refer to them. Labels carry the text.
- Quote labels with punctuation: A["parse(input)"]. Write a quote inside one as #quot;. Lowercase end as an id breaks flowcharts and sequence diagrams, where it closes blocks.
- %% starts a comment line. $$x^2$$ in a label draws math.
- Mermaid 12 lays out flowcharts, class, state, ER and requirement diagrams with ELK by default, with right-angled edges; front matter config: layout: dagre gives the curved edges of Mermaid 11.
- Leave out theme, themeVariables, classDef, style and fonts unless the user asks for colors (diagram_style sets them); never click directives or HTML. themeVariables without a theme, such as primaryColor and lineColor, recolor the panel's theme, which keeps text legible; any theme but base replaces it.
Panel: follows the VS Code theme (light, dark, high contrast; the background can't be changed), fits the diagram to its width with zoom and pan, and makes nodes and edges selectable. Instead of click directives, give diagram_render "links" (node id → code location) or a "clickPrompt". Sources over 50,000 characters are refused: split them.`,
  },
  {
    name: "flowchart",
    aliases: ["graph", "flowchart-elk", "flow", "process", "dependency"],
    summary: "Steps, decisions, dependencies and data flow; shapes, subgraphs, edge labels",
    language: "mermaid",
    example: `flowchart TD
  user([Customer]) -->|submits order| api[API gateway]
  subgraph backend [Backend]
    api -->|checks token| auth{Token valid?}
    auth -->|yes| orders[Order service]
    auth -->|no| reject[Reply 401]
    orders -->|writes| db[(Orders DB)]
  end
  orders -.->|publishes| events@{ shape: das, label: "Order events" }
  events --> mail[Email worker]`,
    notes: `- Declare a node once as id[Label], then use the id alone. Shapes: [rect], (rounded), ([stadium]), [(database)], {decision}, {{hexagon}}, ((circle)); more as id@{ shape: doc, label: "Spec" } with shapes such as doc, docs, cyl, das, hex, cloud, person, browser, console, folder.
- Edges: --> arrow, --- line, -.-> dotted, ==> thick, --o, --x. Label them with a verb: A -->|reads| B. Chain A --> B --> C; fan out A --> B & C.
- Put spaces around links: A---ops and A--xray end in a circle or a cross at nodes "ps" and "ray"; A --- ops links node ops.
- Quote labels with ( ) [ ] { } | ; or :, e.g. A["parse(input)"]; unquoted parentheses fail. Long text: a Markdown label A["\`**Bold** text that wraps\`"].
- Ids have no spaces; lowercase end fails as an id (use done).
- subgraph id [Title] … end groups nodes; edges can start or end at a subgraph id. direction LR inside a subgraph applies only when no edge crosses its border.
Layout:
- TD for hierarchies, decisions and long chains (the panel is often narrow); LR for short pipelines of up to ~6 steps.
- 15–25 nodes read well. Beyond that, group related nodes in subgraphs, or split into an overview and detail diagrams. Keep one main direction of flow.
- Node labels of a few words; edge labels of 1–3 words.
Panel: nodes and edges are selectable; edges have edge: ids in diagram_getState. Link nodes to code with diagram_render's "links".`,
  },
  {
    name: "sequence",
    aliases: ["sequencediagram", "interaction", "messages"],
    summary: "Messages between participants over time: calls, replies, alt/loop blocks, notes",
    language: "mermaid",
    example: `sequenceDiagram
  autonumber
  actor U as User
  participant W as Web app
  participant A as Auth API
  participant D@{ "type": "database" } as Users DB
  U->>W: Sign in
  W->>+A: POST /token
  A->>D: Look up user
  D-->>A: User row
  alt valid password
    A-->>W: 200 + token
  else wrong password
    A-->>W: 401
  end
  deactivate A
  Note over W,A: Token cached for 5 min`,
    notes: `- Declare participants first, in display order: participant W as Web app (id W, label after "as"); actor for people; @{ "type": "database" } (also queue, boundary, control, entity, collections) for other shapes.
- Arrows: ->> call, -->> reply (dashed), -) async, -x failed. A + or - after the arrow activates the target or deactivates the source: W->>+A: call … A-->>-W: done. They must balance: deactivating a participant that is not active fails.
- Text after ":" must not contain ";" (it ends the statement); write #59; for one.
- alt/else, opt, loop, par/and, critical/option and break blocks each close with end. box Name … end around participant lines groups them.
- Note right of A: text, or Note over A,B: text.
Layout:
- Up to 6–8 participants and ~30 messages read well; split long flows by phase into several diagrams.
- Short message labels: a verb, an HTTP method and path, or a function name. autonumber lets you refer to steps by number.
Panel: participants and messages are selectable; messages have message: ids in diagram_getState, for diagram_annotate.`,
  },
  {
    name: "class",
    aliases: ["classdiagram", "uml", "types"],
    summary: "Classes, interfaces and their members, inheritance, composition and dependencies",
    language: "mermaid",
    example: `classDiagram
  direction LR
  class Shape {
    <<abstract>>
    +String name
    +area() double*
  }
  class Circle {
    -double radius
    +area() double
  }
  class Repository~T~ {
    +find(id) T
  }
  class Canvas
  Shape <|-- Circle
  Canvas "1" *-- "*" Shape : contains
  Canvas ..> Repository~T~ : loads with`,
    notes: `- Relations: <|-- inherits, ..|> implements, *-- composition, o-- aggregation, --> association, ..> dependency, -- link. Label after " : "; cardinality in quotes beside the class: A "1" *-- "*" B.
- Generics with tildes: List~T~. List<T> fails; generics do not nest (List~List~int~~ fails): name the inner type, e.g. List~Row~.
- Members: + public, - private, # protected, ~ package; a method's return type after the parentheses; * or $ at the end marks it abstract or static. <<interface>> or <<abstract>> as the first line of the body.
- class A["Order service"] gives a class a label with spaces; refer to it by A.
- namespace Name { class A … } groups classes.
Layout:
- 5–12 classes with their key members read well; leave out members that don't matter for the question, and private helpers.
- direction LR or TB; put base classes and interfaces on the side the direction starts from.
Panel: classes and relations are selectable; diagram_style colors classes.`,
  },
  {
    name: "state",
    aliases: ["statediagram", "statediagram-v2", "state-machine", "states", "lifecycle"],
    summary: "States and transitions, composite states, choices, start and end",
    language: "mermaid",
    example: `stateDiagram-v2
  direction LR
  [*] --> Idle
  Idle --> Loading : fetch
  Loading --> Ready : ok
  Loading --> Failed : error
  Failed --> Loading : retry
  state Ready {
    [*] --> Viewing
    Viewing --> Editing : edit
    Editing --> Viewing : save
  }
  state check <<choice>>
  Ready --> check : close
  check --> [*] : saved
  check --> Ready : unsaved`,
    notes: `- Use stateDiagram-v2. [*] is the start or the end, inside a composite state its own.
- State ids are words without spaces or hyphens (in-progress fails); give a label with state "Waiting for input" as Waiting.
- Transition label after " : ", e.g. an event or a guard.
- Composite: state Name { … }, which must not be empty. <<choice>>, <<fork>> and <<join>> pseudo-states; -- separates concurrent regions inside a composite.
- note right of Idle : text
Layout:
- direction LR for lifecycles, TB (default) for deep nesting. Up to ~15 states read well; nest the details of a phase in a composite state.
Panel: states and transitions are selectable; diagram_style colors states.`,
  },
  {
    name: "er",
    aliases: ["erdiagram", "entity-relationship", "schema", "database"],
    summary: "Entities, attributes and keys, and the cardinality of their relationships",
    language: "mermaid",
    example: `erDiagram
  CUSTOMER ||--o{ ORDER : places
  ORDER ||--|{ LINE_ITEM : contains
  PRODUCT ||--o{ LINE_ITEM : "appears in"
  CUSTOMER {
    string id PK
    string email UK "login name"
  }
  ORDER {
    string id PK
    string customer_id FK
    date placed_at
  }`,
    notes: `- Every relationship needs a label after ":"; quote one of several words.
- Cardinality, read from each side: || exactly one, |o zero or one, }| one or more, }o zero or more (mirrored on the right: o{, |{). -- identifying (solid), .. non-identifying (dashed).
- Attributes: type name, then PK, FK or UK (several as PK, FK), then an optional "comment". Types are one word, which may hold parentheses: varchar(255).
- Entity names are words (letters, digits, _, -). An entity on a line of its own may get a label: c["Customer"], then use c in relationships.
Layout:
- Up to ~10 entities with attributes read well; for larger schemas show only keys, or one diagram per area.
Panel: entities and relationships are selectable; diagram_style colors entities.`,
  },
  {
    name: "gantt",
    aliases: ["schedule", "plan", "roadmap"],
    summary: "Tasks on a calendar: durations, dependencies, milestones, sections",
    language: "mermaid",
    example: `gantt
  title Release plan
  dateFormat YYYY-MM-DD
  axisFormat %b %d
  excludes weekends
  section Build
    Design       :done, design, 2026-01-05, 5d
    Implement    :active, impl, after design, 10d
  section Ship
    Test         :test, after impl, 5d
    Release      :milestone, after test, 0d`,
    notes: `- Task: Name :tags, id, start, duration. Tags (optional): done, active, crit, milestone. Start is a date in dateFormat or "after id"; duration such as 3d, 2w, or an end date.
- A colon in a task name cuts the name there: "Phase 1: design" draws as "Phase 1".
- Ids are unique words; a task without an id can't be referred to.
- axisFormat takes strftime codes (%Y-%m-%d, %b %d); excludes weekends skips them in durations.
Layout:
- Up to ~25 tasks in a few sections read well. Keep names short; put details in the chat.
- Title in title, not as a task.
Panel: draws the chart at the panel's width; tasks are selectable.`,
  },
  {
    name: "pie",
    aliases: ["pie-chart", "share"],
    summary: "Shares of a whole as a Mermaid pie (an ECharts pie: echarts-pie)",
    language: "mermaid",
    example: `pie showData
  title Bugs by component
  "Parser" : 42
  "Renderer" : 31
  "CLI" : 9`,
    notes: `- Labels in double quotes; values positive numbers. showData prints the values in the legend.
- At most ~6 slices: merge the small ones into "Other". Order them largest first.
- For tooltips, a doughnut or more data, use an ECharts pie (topic echarts-pie); to compare values, a bar chart.`,
  },
  {
    name: "quadrant",
    aliases: ["quadrantchart", "matrix-2x2", "prioritization"],
    summary: "Items placed on two axes in four labeled quadrants (effort vs impact)",
    language: "mermaid",
    example: `quadrantChart
  title Effort vs impact
  x-axis Low effort --> High effort
  y-axis Low impact --> High impact
  quadrant-1 Major projects
  quadrant-2 Quick wins
  quadrant-3 Fill-ins
  quadrant-4 Avoid
  Cache layer: [0.2, 0.8]
  Rewrite UI: [0.85, 0.7]
  Fix typos: [0.1, 0.2]
  Migrate DB: [0.75, 0.3]`,
    notes: `- Coordinates are from 0 to 1: [x, y]. Values such as [20, 80] fail.
- quadrant-1 is top right, quadrant-2 top left, quadrant-3 bottom left, quadrant-4 bottom right.
- Axis: x-axis Low --> High (both ends optional).
- Up to ~15 points with short names read well.`,
  },
  {
    name: "requirement",
    aliases: ["requirementdiagram", "requirements", "sysml"],
    summary: "Requirements, the elements that satisfy or verify them, and their relations",
    language: "mermaid",
    example: `requirementDiagram
  requirement login {
    id: 1
    text: "Users sign in with SSO"
    risk: high
    verifymethod: test
  }
  performanceRequirement fast_login {
    id: 1.1
    text: "Sign-in takes under 2 s"
    risk: medium
    verifymethod: analysis
  }
  element auth_service {
    type: service
  }
  login - contains -> fast_login
  auth_service - satisfies -> login`,
    notes: `- Kinds: requirement, functionalRequirement, interfaceRequirement, performanceRequirement, physicalRequirement, designConstraint, and element.
- risk: low, medium or high; verifymethod: analysis, inspection, test or demonstration.
- Quote text with punctuation: a "-" in unquoted text fails.
- Relations: a - satisfies -> b, with contains, copies, derives, satisfies, verifies, refines or traces.
Layout: up to ~10 boxes read well; the boxes are large, so split by feature.`,
  },
  {
    name: "gitgraph",
    aliases: ["git", "branches"],
    summary: "Commits, branches, merges and tags of a Git history",
    language: "mermaid",
    example: `gitGraph
  commit id: "init"
  branch feature
  commit id: "add api"
  commit id: "add tests"
  checkout main
  commit id: "fix typo"
  merge feature tag: "v1.0"
  commit id: "hotfix"`,
    notes: `- branch name creates a branch and checks it out; checkout (or switch) needs an existing branch. The first branch is main.
- Commit ids are quoted and unique: a repeated id silently replaces the earlier commit.
- merge needs a branch with commits of its own; cherry-pick id: "x" copies a commit.
- commit type: HIGHLIGHT or REVERSE marks a commit; tag: "v1" labels it.
Layout: up to ~25 commits on a few branches read well; summarize long histories.`,
  },
  {
    name: "c4",
    aliases: ["c4context", "c4container", "c4component", "c4dynamic", "c4deployment", "c4-model"],
    summary: "C4 model views: people, systems, containers and their relations",
    language: "mermaid",
    example: `C4Context
  title Payments system
  Person(customer, "Customer", "Pays online")
  System(pay, "Payments", "Handles card payments")
  System_Ext(bank, "Bank", "Card network")
  System_Ext(mail, "Mail service", "Sends receipts")
  Rel(customer, pay, "Pays with")
  Rel(pay, bank, "Authorizes via", "HTTPS")
  Rel(pay, mail, "Sends receipts via")`,
    notes: `- Header C4Context, C4Container, C4Component, C4Dynamic or C4Deployment.
- Elements: Person, System, System_Ext, Container, ContainerDb, Component, … (alias, "Label", "Description"); a container also takes a technology: Container(api, "API", "Go", "Serves JSON").
- Boundaries: System_Boundary(b1, "Payments") { … } or Enterprise_Boundary.
- Rel(from, to, "label", "technology"); BiRel for both ways.
- Elements are placed in rows in the order they are declared, not by their relations: declare them in reading order. UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1") sets the row lengths.
- C4 colors are fixed. For larger architectures, a flowchart with subgraphs or architecture-beta lays out better.`,
  },
  {
    name: "mindmap",
    aliases: ["brainstorm", "outline"],
    summary: "A topic and its subtopics, by indentation",
    language: "mermaid",
    example: `mindmap
  root((Release 2.0))
    Scope
      New editor
      Faster sync
    Risks
      Schedule
      Staffing
    Owners
      Ana
      Raj`,
    notes: `- Indentation sets the level: indent children more than their parent, consistently. One root.
- Node shapes as in flowcharts: id[square], id(rounded), id((circle)), id{{hexagon}}, id))bang((, id)cloud(.
- Text with brackets or parentheses needs an id and quotes: fix["Fix bug (urgent)"]. Unquoted, "Fix bug (urgent)" draws as a node "urgent".
- ::icon() needs icon fonts, which the panel does not load.
Layout: up to ~30 nodes in 3 levels read well; keep labels to a few words.`,
  },
  {
    name: "timeline",
    aliases: ["history", "milestones", "chronology"],
    summary: "Events by period, grouped in sections",
    language: "mermaid",
    example: `timeline
  title Project history
  section 2025
    Q1 : Prototype
    Q3 : Beta : First customers
  section 2026
    Q1 : 1.0 release`,
    notes: `- period : event : event; each ":" starts another event of the period, so event text can't contain ":".
- section Name groups the periods that follow, until the next section.
- Up to ~8 periods with 1–3 short events each read well; for dated tasks with durations use gantt.`,
  },
  {
    name: "journey",
    aliases: ["user-journey", "customer-journey"],
    summary: "Steps of a user's journey with a 1–5 satisfaction score and actors",
    language: "mermaid",
    example: `journey
  title Checkout
  section Browse
    Find product: 4: Shopper
    Read reviews: 3: Shopper
  section Buy
    Enter card: 2: Shopper, Bank
    Confirm: 5: Shopper`,
    notes: `- Step: Task name: score: actor, actor. Score is 1 (bad) to 5 (good); task names can't contain ":".
- section Name groups steps. Up to ~15 steps read well.`,
  },
  {
    name: "sankey",
    aliases: ["sankey-beta", "mermaid-sankey"],
    summary: "Flows between nodes as Mermaid CSV (an interactive one: echarts-sankey)",
    language: "mermaid",
    example: `sankey

Salary,Budget,3000
Freelance,Budget,800
Budget,Rent,1200
Budget,Food,600
Budget,Savings,1000
Budget,"Fun, travel",1000`,
    notes: `- One flow per line: source,target,value, as CSV without a header. Quote names with commas: "Fun, travel".
- Flows must not form a cycle. Values are positive.
- For tooltips, highlighting of paths and node selection, prefer an ECharts sankey (topic echarts-sankey).`,
  },
  {
    name: "xychart",
    aliases: ["xychart-beta", "mermaid-bar", "mermaid-line"],
    summary: "Simple bar and line charts in Mermaid (most charts read better in ECharts)",
    language: "mermaid",
    example: `xychart
  title "Monthly revenue"
  x-axis [Jan, Feb, Mar, Apr, May]
  y-axis "Revenue (k$)" 0 --> 60
  bar [32, 41, 38, 52, 47]
  line [30, 38, 40, 50, 49]`,
    notes: `- Titles with spaces in quotes. x-axis [a, b, c] for categories, or x-axis "Name" min --> max for numbers; y-axis "Name (unit)" min --> max.
- bar […] and line […] take one value per category. xychart horizontal turns it sideways.
- No tooltips, legend or series names: for anything beyond one or two series use ECharts (topic echarts-bar).`,
  },
  {
    name: "block",
    aliases: ["block-beta", "blocks", "grid-layout"],
    summary: "Boxes placed on a grid you control, with arrows between them",
    language: "mermaid",
    example: `block
  columns 3
  web["Web app"] space api["API"]
  space:3
  cache[("Cache")] space db[("Database")]
  web --> api
  api --> cache
  api --> db`,
    notes: `- columns N, then blocks fill rows left to right in order. space (or space:3) leaves gaps; id:2 makes a block 2 columns wide.
- Shapes as in flowcharts: id["Label"], id(("circle")), id[("database")], id{"decision"}.
- Nested: block:group … end, with its own columns.
- Edges: a --> b, or a -- "label" --> b.
- Nothing is placed automatically: use block when the user wants a fixed arrangement, else a flowchart.`,
  },
  {
    name: "packet",
    aliases: ["packet-beta", "bits", "protocol-header"],
    summary: "Bit fields of a packet or binary format",
    language: "mermaid",
    example: `packet
  title UDP header
  0-15: "Source port"
  16-31: "Destination port"
  +16: "Length"
  +16: "Checksum"
  +32: "Data (variable)"`,
    notes: `- start-end: "Field" with inclusive bit numbers, n: "Flag" for one bit, +16: "Field" for the next 16 bits. Fields are contiguous from bit 0: a gap fails.
- Labels in quotes: 0-7: Type fails. A field longer than a row continues on the next.
- A row has 32 bits, which the panel narrows to fit; front matter config: packet: bitsPerRow: 16 halves the rows. bitOrder: descending puts the most significant bit on the left.
- The title is drawn below the fields.`,
  },
  {
    name: "kanban",
    aliases: ["board", "tasks"],
    summary: "Columns of cards with assignees and priorities",
    language: "mermaid",
    example: `kanban
  todo[To do]
    spec[Write spec]
    review[Review API]@{ priority: 'High' }
  doing[In progress]
    parser[Build parser]@{ assigned: 'ana' }
  done[Done]
    ci[Set up CI]`,
    notes: `- Columns at the first indentation, cards indented below them; ids unique.
- Card metadata: @{ assigned: 'name', ticket: 'ABC-1', priority: 'Very High' } with priority Very High, High, Low or Very Low.
- Up to ~5 columns of ~6 cards read well.`,
  },
  {
    name: "architecture",
    aliases: ["architecture-beta", "cloud", "infrastructure", "deployment"],
    summary: "Services with icons in groups, connected at chosen sides",
    language: "mermaid",
    example: `architecture-beta
  group cloud(cloud)[Cloud]
  service api(server)[API] in cloud
  service db(database)[Database] in cloud
  service queue(disk)[Queue] in cloud
  service web(internet)[Browser]
  junction fork in cloud
  web:R --> L:api
  api:R -- L:fork
  fork:R --> L:db
  fork:B --> T:queue`,
    notes: `- The header is architecture-beta (architecture alone fails). service id(icon)[Label] in group; group id(icon)[Label] in parent. Built-in icons: cloud, database, disk, internet, server; others need icon packs, which the panel does not load.
- Edges name the sides they leave and enter, in capitals: a:R --> L:b (L, R, T, B); -- without arrow, <--> both ways, a:R -[HTTPS]-> L:b with a label. An edge between groups: a{group}:R --> L:b{group}.
- One edge per side of a service: a second edge from the same side is drawn astray. Fan out through a junction, which has no label, as above.
- Labels sit under the icons, so an edge into the bottom of a service crosses its label: enter services from the left, right or top.
- align row a b or align column a c hints at placement. title is not drawn.
- Up to ~8 services read well; for more, a flowchart with subgraphs lays out better.`,
  },
  {
    name: "radar",
    aliases: ["radar-beta", "spider", "mermaid-radar"],
    summary: "Several items scored on the same axes (an ECharts radar: echarts-radar)",
    language: "mermaid",
    example: `radar-beta
  title Team skills
  axis design["Design"], code["Code"], test["Testing"], ops["Ops"], docs["Docs"]
  curve ana["Ana"]{4, 3, 5, 2, 4}
  curve raj["Raj"]{design: 2, code: 5, test: 3, ops: 4, docs: 3}
  max 5
  min 0
  graticule polygon`,
    notes: `- The header is radar-beta. axis id["Label"], … with quoted labels: a[Alpha] fails.
- curve id["Label"]{v1, v2, …} with a value per axis in axis order, or {axisId: value, …} naming every axis. Fewer values than axes silently draws no curve; negative values fail.
- Options without a colon: max 5, min 0, ticks 5, showLegend true, graticule circle or polygon.
- 4–8 axes and up to 3 curves read well; to compare exact values, use a bar chart.`,
  },
  {
    name: "treemap",
    aliases: ["treemap-beta", "mermaid-treemap"],
    summary: "Nested rectangles sized by value (an interactive one: echarts-hierarchy)",
    language: "mermaid",
    example: `treemap
  "Frontend"
    "Components": 120
    "Styles": 40
  "Backend"
    "API": 90
    "Jobs": 30`,
    notes: `- Indentation nests; names in quotes; leaves have "Name": value, sections no value and sum their children. A section given a value becomes a leaf, and its children move up.
- Values are non-negative: 1,000 reads as 1000, but 1_000 as 1.
- Keep every leaf inside a section. Front matter config: treemap: valueFormat: "$0,0" formats values (d3 format).
- Up to ~30 leaves read well. For drilling down and tooltips, prefer an ECharts treemap (topic echarts-hierarchy).`,
  },
  {
    name: "agentflow",
    aliases: ["agentflow-beta", "agent", "llm-pipeline", "ai-workflow"],
    summary: "Agent and LLM pipelines: tasks, tools, decisions, inputs, documents, connectors",
    language: "mermaid",
    example: `agentflow-beta TB
  connector jira["Jira"]
  flow triage["Triage ticket"]
    ticket@{ shape: input, label: "Ticket text" }
    classify["Classify severity"]
    search@{ shape: tool, label: "Search runbooks" }
    urgent@{ shape: decision, label: "Urgent?" }
    ticket --> classify --> search --> urgent
  end
  page@{ shape: action, label: "Page on-call" }
  reply["Draft reply"]
  runbook@{ shape: refdoc, label: "Runbook" }
  urgent -->|yes| page
  urgent -->|no| reply
  search -.- runbook
  page --x reply
  reply --> jira`,
    notes: `- The header is agentflow-beta, with the direction on the same line (TB by default).
- Shapes: id["Task"], id{"Decision"}, id[["Tool"]], id{{"Action"}}, or id@{ shape: task|tool|input|decision|refdoc|action, label: "…" } in lowercase. Flowchart shapes such as [(db)] or [/x/] draw as plain tasks.
- Edges: --> sequence, --x failure, -.- reference, with |label| as in flowcharts; ==>, -.-> and <--> fail.
- flow id["Title"] … end groups steps (subgraph fails). An edge written inside a flow pulls the nodes it names into that flow: write edges across flows after their end, or declare shared nodes in global … end.
- connector id["Name"] is an external system. Quote labels with parentheses; end, flow, global and connector can't be ids.
Layout: TB fits the panel; labels of 2–4 words, about 4 nodes side by side. Leave the theme alone.`,
  },
  {
    name: "swimlane",
    aliases: ["swimlane-beta", "swimlanes", "lanes", "cross-functional"],
    summary: "A process in lanes by who does each step, in flowchart syntax",
    language: "mermaid",
    example: `swimlane-beta TB
  subgraph customer["Customer"]
    order["Place order"]
    pay["Pay invoice"]
  end
  subgraph shop["Shop"]
    check{"In stock?"}
    ship["Ship goods"]
    cancel["Cancel order"]
  end
  subgraph bank["Bank"]
    charge["Charge card"]
  end
  order --> check
  check -->|yes| pay
  check -->|no| cancel
  pay --> charge
  charge --> ship`,
    notes: `- The header is swimlane-beta with the direction on the same line: a direction line of its own is ignored. TB draws lanes as columns, LR as rows.
- Each top-level subgraph id["Title"] … end is a lane; nested subgraphs are not lanes. Everything else is flowchart syntax.
- Declare each node inside its lane and write all edges after the lanes: an edge inside a lane pulls the nodes it names into that lane. Nodes outside every lane go into an untitled lane.
Layout: TB with up to 4 lanes and ~10 steps reads well; LR grows wide quickly, so keep it to 3–4 steps per lane.`,
  },
  {
    name: "treeview",
    aliases: ["treeview-beta", "file-tree", "directory", "folders"],
    summary: "File and directory trees, or any indented listing",
    language: "mermaid",
    example: `treeView-beta
  src/
    main.ts ## entry point
    components/
      Button.tsx
      Modal.tsx :::highlight ## changed
    utils/
      format.ts
  tests/
    format.test.ts
  "my notes.md"
  package.json`,
    notes: `- The header is treeView-beta, with a capital V. One entry per line, nested by indentation with spaces (a tab counts as one column).
- A trailing / makes a folder. ## text after a name adds a description; :::highlight marks the entry.
- Quote names that start with a keyword, such as "title.md". Output of the tree command, with ├── lines, is accepted too.
- title is not drawn; icon(…) needs icon packs, which the panel does not load.
Layout: up to ~25 rows read well; summarize the rest, e.g. "… 12 more files".`,
  },
  {
    name: "eventmodeling",
    aliases: ["event-sourcing", "cqrs"],
    summary: "Event Modeling timelines: screens, commands, events, read models, processors",
    language: "mermaid",
    example: `eventmodeling
  tf 01 ui CartScreen
  tf 02 cmd AddItem ->> 01 { "sku": "A1", "qty": 2 }
  tf 03 evt ItemAdded ->> 02
  tf 04 rmo CartItems ->> 03
  tf 05 pcr PriceWatcher ->> 04
  tf 06 cmd ApplyDiscount ->> 05
  tf 07 evt DiscountApplied ->> 06`,
    notes: `- The header is eventmodeling, lowercase, without -beta. Frames: tf NN type Name, left to right in order, with unique numbers NN of 1–3 digits.
- Types: ui, cmd (command), evt (event), rmo (readmodel), pcr (processor); each has its lane.
- ->> NN draws the arrow from an earlier frame, by its exact number (->> 1 does not find 01); without it, the arrow comes from the previous frame in another lane.
- Names are single words ([A-Za-z_] then letters, digits, _): no spaces, quotes or hyphens; title lines fail.
- Inline data: { "key": "value" } with a space before }. data Name { … } blocks close with } at the start of a line; refer to them with [[Name]].
Layout: up to 6–7 frames with names up to ~15 characters read well; split longer stories.`,
  },
  {
    name: "ishikawa",
    aliases: ["ishikawa-beta", "fishbone", "root-cause", "cause-effect"],
    summary: "Fishbone diagram of an effect and its grouped causes",
    language: "mermaid",
    example: `ishikawa-beta
  Defective welds
  Machine
    Worn tips
    Wrong current
  Method
    No work instruction
    Rushed changeover
  Material
    Rust on plates
  People
    New operator
    Night-shift fatigue`,
    notes: `- The first line after the header is the effect; every later line is a cause, nested by indentation. Indent with spaces: a tab counts as one column and mis-nests.
- No ids, arrows or keywords: text is drawn as written, quotes included; <br> breaks a line. A line that starts with the word "ishikawa" fails.
- Give every cause at least one sub-cause: a bare cause's box crowds the head.
- 4–6 causes with 1–3 sub-causes each read well; labels wrap at ~15 characters.`,
  },
  {
    name: "venn",
    aliases: ["venn-beta", "sets", "overlap"],
    summary: "Overlaps of 2–4 sets, with items in the regions",
    language: "mermaid",
    example: `venn-beta
  title Team skills
  set FE["Frontend"]: 12
    text alice["Alice"]
  set BE["Backend"]: 10
    text bob["Bob"]
  set OPS["DevOps"]: 6
  union FE,BE["Full-stack"]: 4
    text dave["Dave"]
  union BE,OPS: 3
  union FE,OPS: 2
  union FE,BE,OPS: 1`,
    notes: `- The header is exactly venn-beta. set ID["Label"]: size, then union ID,ID["Label"]: size of sets declared before it; labels in brackets, sizes optional.
- Sizes are relative areas: a union smaller than each of its sets; size 0 removes a region.
- An indented text id["Label"] puts an item in the set or union above it; at the start of a line, text FE,BE id["Label"] names the region.
- Ids are words (letters, digits, _, -) or "quoted".
- Up to 4 sets, labels up to ~15 characters and ~3 short items per region: labels never wrap and overlap when long.`,
  },
  {
    name: "usecase",
    aliases: ["usecase-beta", "actors"],
    summary: "UML use cases: actors, a system boundary, include and extend",
    language: "mermaid",
    example: `usecase-beta
  direction LR
  actor Customer, Admin
  systemBoundary shop["Online shop"]
    browse("Browse catalog")
    checkout("Check out")
    pay("Pay by card")
    coupon("Apply coupon")
    stock("Manage stock")
  end
  Customer --> browse
  Customer --> checkout
  checkout ..>:include pay
  coupon ..>:extend checkout
  Admin --> stock`,
    notes: `- The header is usecase-beta. id("Label") is a use case, id["Label"] a rectangle; ids are case-sensitive, and an undeclared id in a relation silently becomes a use case. Keywords such as class can't be ids.
- actor A, B declares actors; actor A@{ type: hollow } draws another figure.
- systemBoundary id["Title"] … end holds only declarations: write the relations after its end.
- Relations: --> association, -- line, --|> generalization, a -- label --> b. ..>:include and ..>:extend connect use cases only, not actors.
- note for pay "text" adds a note. PlantUML forms such as (Browse), usecase X as "…" and rectangle X { fail.
Layout: direction LR with actors on the left reads best; up to ~10 use cases.`,
  },
  {
    name: "wardley",
    aliases: ["wardley-beta", "wardley-map", "value-chain", "evolution"],
    summary: "Wardley map: components by visibility in the value chain and evolution",
    language: "mermaid",
    example: `wardley-beta
title Tea shop
size [640, 440]
anchor Customer [0.95, 0.63]
component Cup of Tea [0.79, 0.61] label [12, -6]
component Tea [0.63, 0.81]
component Hot Water [0.52, 0.80]
component Kettle [0.43, 0.35] label [-45, 4]
component Power [0.10, 0.70] (outsource)
Customer -> Cup of Tea
Cup of Tea -> Tea
Cup of Tea -> Hot Water
Hot Water -> Kettle; boils
Kettle -.-> Power
evolve Kettle 0.62
note "Kettles are commoditising" [0.12, 0.25]`,
    notes: `- The header is lowercase wardley-beta. Coordinates are [visibility, evolution], y before x, as decimals with a dot from 0 to 1: [1, 0] fails, and 1.5 means 1.5%.
- Names of several words need no quotes, but each word starts with a letter; names with . or / are quoted, also in links: "Node.js" -> "CI/CD".
- Links: -> solid, -.-> dashed, A -> B; label. A link to an undeclared name is dropped silently.
- After a component's coordinates: label [dx, dy] to move its label, then (build), (buy), (outsource) or (market), then inertia. evolve Name 0.62 draws its movement.
- size [640, 440] makes it fit the panel at full size; front matter config has no effect on it. Up to ~12 components with short names read well.`,
  },
  {
    name: "cynefin",
    aliases: ["cynefin-beta", "sense-making", "domains"],
    summary: "Situations sorted into the Cynefin domains, with transitions",
    language: "mermaid",
    example: `---
config:
  cynefin:
    showDomainDescriptions: false
---
cynefin-beta
  title Incident response
  complex
    "New failure mode"
    "Flaky canary"
  complicated
    "Slow queries"
  clear
    "Disk full"
    "Expired cert"
  chaotic
    "Region outage"
  confusion
    "Unclear ownership"
  chaotic --> complex : "stabilise"
  complicated --> clear : "write runbook"`,
    notes: `- Domains, lowercase only: complex, complicated, clear, chaotic, confusion. Each lists its items in double quotes; unquoted items fail. A domain listed twice keeps only its last items.
- Transitions: from --> to : "label", with the label quoted (unquoted fails with a misleading error); -> fails.
- Up to 4 items per domain (more spill into the next) with labels up to ~20 characters; at most 2 transitions, as their arrows cross the items.
- showDomainDescriptions: false in the front matter above leaves out the "Probe → Sense → Respond" lines.`,
  },
  {
    name: "railroad",
    aliases: [
      "railroad-beta",
      "railroad-ebnf-beta",
      "railroad-abnf-beta",
      "railroad-peg-beta",
      "syntax-diagram",
      "grammar",
      "ebnf",
    ],
    summary: "Syntax (railroad) diagrams of a grammar in EBNF, ABNF, PEG or function calls",
    language: "mermaid",
    example: `railroad-ebnf-beta
(* key = value config file; every rule ends with ; *)
file    = { line } ;
line    = [ entry ] , [ comment ] , newline ;
entry   = key , "=" , value ;
key     = letter , { letter | digit | "_" } ;
value   = string | number | "true" | "false" ;
comment = "#" , { ? any char except newline ? } ;`,
    notes: `- Headers, lowercase: railroad-ebnf-beta (the default choice, for config and CLI syntax), railroad-abnf-beta (RFC grammars), railroad-peg-beta, and railroad-beta, which writes sequence(…), choice(…), optional(…), zeroOrMore(…), oneOrMore(…), terminal("…") and nonterminal("…") calls.
- Every rule ends with ";" in all four; a missing one fails on the next line.
- EBNF: = or ::=, | choice, [x] optional, {x} zero or more, (x) group, ? text ? special, (* comments *). Not [a-z] ranges, which draw as a rule named a-z, nor two postfix ? in a rule.
- ABNF: / choice, *x and 1*x repeats, [x] optional, %x41 values; "; comment" ends a line, so end each rule exactly at its ";". PEG: <- defines, / choice, ? * + suffixes, # comments; no [0-9] classes.
- Avoid < in terminals: it is drawn escaped or not at all. title is not drawn.
Layout: a rule is one row that never wraps, and the widest scales the whole diagram: up to ~8 items per sequence and ~5 alternatives, then pull parts out into rules; 6–8 rules per diagram.`,
  },
];

const ECHARTS: GuideTopic[] = [
  {
    name: "echarts",
    aliases: ["echarts-basics", "option", "chart", "charts"],
    summary: "Option skeleton, the series types there are, and what the panel does for every chart",
    language: "echarts",
    example: `{
  "title": {"text": "Build time by package", "subtext": "Median of the last 20 CI runs"},
  "xAxis": {"type": "category", "name": "Package", "data": ["web", "core", "cli", "docs"]},
  "yAxis": {"type": "value", "name": "Seconds"},
  "series": [{"type": "bar", "data": [77, 42, 18, 9]}]
}`,
    notes: `- The source is JSON, which renders anywhere, or a JavaScript object literal when it needs functions (formatter, renderItem). JavaScript needs a trusted workspace and runs with nothing in scope: no echarts global, so write gradients as {"type": "linear", "x": 0, "y": 0, "x2": 0, "y2": 1, "colorStops": […]}.
- Series types: bar, line, scatter, effectScatter, pie, radar, funnel, gauge, heatmap, tree, treemap, sunburst, sankey, graph, chord, boxplot, candlestick, parallel, themeRiver, pictorialBar, lines, custom. Components: grid, polar, singleAxis, calendar, matrix, dataset with transforms, dataZoom, visualMap, timeline, markLine/markPoint/markArea, graphic. No geo or maps, brush or 3D.
- Every axis that matters gets a name with its unit: "name": "Latency (ms)". A short title; units or the source in subtext.
- Choose: bar to compare categories, line for trends over time, scatter for correlation, pie only for few shares of a whole, heatmap for two categories, treemap for sizes in a hierarchy, sankey for flows.
Panel, unless the option sets them: VS Code theme colors, font and a transparent background (leave out color, backgroundColor, textStyle); a tooltip (axis for bar and line, item otherwise); a scrolling legend for several named series or a small pie; the grid fitted to the panel with room for axis labels (setting grid left/right/top/bottom turns that off); long category labels rotated or cut; compact value labels (1.5M); thousands separators in "{c}" templates; selection highlighting. A title equal to the panel's title is hidden. Toolbox magicType, dataZoom and brush are left out (use a dataZoom component); media queries turn off the panel's layout.`,
  },
  {
    name: "echarts-bar",
    aliases: [
      "bar",
      "line",
      "area",
      "stacked",
      "horizontal-bar",
      "column",
      "echarts-line",
      "echarts-area",
    ],
    summary: "Bar, line and area charts: categories, several series, stacking, horizontal bars",
    language: "echarts",
    example: `{
  "title": {"text": "Open issues by team"},
  "xAxis": {"type": "value", "name": "Issues"},
  "yAxis": {"type": "category", "inverse": true, "data": ["Platform", "Payments", "Mobile", "Web", "Data"]},
  "series": [
    {"name": "Bugs", "type": "bar", "stack": "total", "data": [34, 21, 18, 12, 7]},
    {"name": "Features", "type": "bar", "stack": "total", "data": [12, 15, 9, 10, 4]}
  ]
}`,
    notes: `- Vertical bars: xAxis category with "data", yAxis value. Horizontal bars, for long labels or many categories: swap them, and "inverse": true on the category axis keeps the first category on top.
- Sort bars by value unless the categories have an order of their own (time, ranks). Value axes of bars start at 0: don't set min.
- Each series' "data" lines up with the categories; null for a missing value, not 0. Series with the same "stack" stack.
- Line: "type": "line"; "areaStyle": {} for an area, with "stack" for a stacked area; "showSymbol": false for many points; "smooth" only for dense data.
- Value labels: "label": {"show": true, "position": "top"} (or "right" for horizontal bars) for up to ~12 bars of one series; on stacked bars a label shows the segment, not the total.
- markLine: {"data": [{"type": "average", "name": "Average"}]} adds a reference line.
- Up to ~5 series per chart; more: a heatmap or small multiples (diagram_chart's facetColumn). No 3D, no dual axes unless the units differ (echarts-dual-axis).
Panel: adds the legend for named series, the axis tooltip and room for labels.`,
  },
  {
    name: "echarts-scatter",
    aliases: ["scatter", "bubble", "correlation", "echarts-bubble"],
    summary: "Scatter and bubble charts: two measures, size by a third, named points",
    language: "echarts",
    example: `{
  "title": {"text": "Response time vs payload"},
  "dataset": {
    "dimensions": ["payload", "time", "calls", "endpoint"],
    "source": [
      [12, 80, 30, "list"], [48, 140, 12, "search"], [5, 40, 50, "item"],
      [30, 95, 22, "cart"], [64, 210, 6, "export"], [20, 70, 41, "user"]
    ]
  },
  "xAxis": {"type": "value", "name": "Payload (KB)", "scale": true},
  "yAxis": {"type": "value", "name": "Response time (ms)", "scale": true},
  "visualMap": {"show": false, "dimension": 2, "min": 6, "max": 50, "inRange": {"symbolSize": [8, 30]}},
  "series": [{"type": "scatter", "encode": {"x": "payload", "y": "time", "itemName": "endpoint", "tooltip": ["payload", "time", "calls"]}}]
}`,
    notes: `- Points as [x, y] pairs in "data", or rows of a dataset with "encode" naming the x, y, itemName and tooltip dimensions, which also gives the tooltip readable names.
- "scale": true lets a value axis start near the data instead of 0 (fine for scatter, not for bars).
- Size by a third measure in JSON: a hidden visualMap with "dimension" and inRange.symbolSize; or "symbolSize" as a function in JavaScript.
- A series per group, each named, for a legend; up to ~4 groups.
- Overlapping points: "itemStyle": {"opacity": 0.6}; thousands of points: see echarts-large.
- On a category axis, "jitter": 20 on the axis spreads points that would overlap.`,
  },
  {
    name: "echarts-pie",
    aliases: ["doughnut", "donut", "echarts-doughnut"],
    summary: "Pie and doughnut charts: few shares of a whole, percentages",
    language: "echarts",
    example: `{
  "title": {"text": "Disk usage", "subtext": "GB"},
  "series": [{
    "type": "pie",
    "radius": ["45%", "70%"],
    "padAngle": 1,
    "itemStyle": {"borderRadius": 4},
    "label": {"formatter": "{b}: {d}%"},
    "data": [
      {"name": "Videos", "value": 182}, {"name": "Photos", "value": 96},
      {"name": "Apps", "value": 64}, {"name": "Other", "value": 31}
    ]
  }]
}`,
    notes: `- "data" holds {"name", "value"} items; "radius": ["45%", "70%"] makes a doughnut.
- Templates: {b} name, {c} value, {d} percent.
- At most ~6 slices, largest first, the rest merged into "Other". To compare values or show change over time, use bars.
- Avoid roseType and several pies side by side: angles and areas are hard to compare.
Panel: adds a legend when the panel is too small for labels, and the item tooltip.`,
  },
  {
    name: "echarts-time",
    aliases: ["time-series", "time", "dates", "datazoom"],
    summary: "Time axes, dates, zooming with dataZoom, marking periods",
    language: "echarts",
    example: `{
  "title": {"text": "Requests per minute"},
  "xAxis": {"type": "time"},
  "yAxis": {"type": "value", "name": "Requests/min"},
  "dataZoom": [{"type": "inside"}, {"type": "slider"}],
  "series": [{
    "name": "API",
    "type": "line",
    "showSymbol": false,
    "data": [
      ["2026-03-01T10:00:00Z", 120], ["2026-03-01T10:01:00Z", 132], ["2026-03-01T10:02:00Z", 128],
      ["2026-03-01T10:03:00Z", 95], ["2026-03-01T10:04:00Z", 60], ["2026-03-01T10:05:00Z", 140],
      ["2026-03-01T10:06:00Z", 151], ["2026-03-01T10:07:00Z", 149]
    ],
    "markArea": {"data": [[{"name": "Deploy", "xAxis": "2026-03-01T10:03:00Z"}, {"xAxis": "2026-03-01T10:05:00Z"}]]}
  }]
}`,
    notes: `- "type": "time" axes take [time, value] pairs; times as ISO 8601 strings or epoch milliseconds (not seconds). Dates without a time zone are local time.
- Don't put dates on a category axis: gaps and uneven intervals would look even.
- Labels: "axisLabel": {"formatter": "{HH}:{mm}"} or {"formatter": "{yyyy}-{MM}-{dd}"}; the default adapts to the zoom.
- null in the data breaks the line at a gap; "connectNulls": true bridges it.
- dataZoom "inside" zooms with the wheel and pans by dragging; "slider" adds a range bar. markArea marks periods, markLine events: {"data": [{"xAxis": "2026-03-01T10:03:00Z", "name": "Deploy"}]}.
- Several series: each with its own [time, value] pairs; times need not line up.
Panel: places the slider below the plot; long series are sampled (see echarts-large).`,
  },
  {
    name: "echarts-dual-axis",
    aliases: ["dual-axis", "two-axes", "secondary-axis", "combo"],
    summary: "Two measures with different units on one category axis",
    language: "echarts",
    example: `{
  "title": {"text": "Revenue and margin"},
  "xAxis": {"type": "category", "data": ["Q1", "Q2", "Q3", "Q4"]},
  "yAxis": [
    {"type": "value", "name": "Revenue (k$)"},
    {"type": "value", "name": "Margin (%)", "alignTicks": true}
  ],
  "series": [
    {"name": "Revenue", "type": "bar", "data": [320, 410, 380, 520]},
    {"name": "Margin", "type": "line", "yAxisIndex": 1, "data": [22, 28, 25, 31]}
  ]
}`,
    notes: `- Only for two measures in different units over the same categories or times; with the same unit, use one axis.
- yAxis is an array; the second goes on the right. A series on it sets "yAxisIndex": 1.
- Name both axes with their units, and the series, so that the legend says which is which. Bars for the main measure, a line for the other.
- "alignTicks": true on the second axis lines its grid up with the first.`,
  },
  {
    name: "echarts-heatmap",
    aliases: ["heatmap", "calendar", "matrix", "echarts-calendar"],
    summary: "Values over two categories, or per day on a calendar, colored by a visualMap",
    language: "echarts",
    example: `{
  "title": {"text": "Deploys by weekday and hour"},
  "xAxis": {"type": "category", "name": "Hour", "data": ["0-4", "4-8", "8-12", "12-16", "16-20", "20-24"]},
  "yAxis": {"type": "category", "inverse": true, "data": ["Mon", "Tue", "Wed", "Thu", "Fri"]},
  "visualMap": {"min": 0, "max": 12, "calculable": true},
  "series": [{
    "type": "heatmap",
    "label": {"show": true},
    "data": [
      [0, 0, 0], [1, 0, 1], [2, 0, 8], [3, 0, 11], [4, 0, 5], [5, 0, 1],
      [0, 1, 0], [1, 1, 2], [2, 1, 9], [3, 1, 12], [4, 1, 6], [5, 1, 0],
      [0, 2, 1], [1, 2, 1], [2, 2, 7], [3, 2, 10], [4, 2, 4], [5, 2, 2],
      [0, 3, 0], [1, 3, 3], [2, 3, 6], [3, 3, 9], [4, 3, 7], [5, 3, 1],
      [0, 4, 0], [1, 4, 0], [2, 4, 4], [3, 4, 5], [4, 4, 2], [5, 4, 0]
    ]
  }]
}`,
    notes: `- Cells are [x index, y index, value] (or [x name, y name, value]) on two category axes. A visualMap with the data's min and max is required for colors.
- Labels in cells for up to ~100 cells; else rely on the tooltip.
- Per day: "calendar": {"range": ["2026-01-01", "2026-03-31"]} and a heatmap series with "coordinateSystem": "calendar" and ["2026-01-05", 3] items.
- ECharts 6's "matrix" component draws a table of labeled rows and columns: a heatmap with "coordinateSystem": "matrix" takes [column name, row name, value].
Panel: places the visualMap below the plot.`,
  },
  {
    name: "echarts-hierarchy",
    aliases: [
      "echarts-treemap",
      "echarts-sunburst",
      "echarts-tree",
      "tree",
      "sunburst",
      "hierarchy",
    ],
    summary: "Treemap, sunburst and tree series of nested {name, value, children} data",
    language: "echarts",
    example: `{
  "title": {"text": "Bundle size by module", "subtext": "KB"},
  "series": [{
    "type": "treemap",
    "name": "Bundle",
    "upperLabel": {"show": true},
    "data": [
      {"name": "src", "children": [
        {"name": "webview", "value": 340}, {"name": "charts", "value": 120},
        {"name": "data", "children": [{"name": "csv", "value": 40}, {"name": "json", "value": 55}]}
      ]},
      {"name": "node_modules", "children": [
        {"name": "mermaid", "value": 1400}, {"name": "echarts", "value": 900}
      ]}
    ]
  }]
}`,
    notes: `- Nodes are {"name", "value", "children"}; a parent without a value sums its children. Names identify items for selection and marks: keep them unique among siblings.
- treemap: "upperLabel": {"show": true} names the parents; "leafDepth": 2 shows two levels at a time and drills down on click.
- sunburst: "radius": ["15%", "90%"]; up to ~3 levels read well.
- tree: "data" holds one root (only the first root is drawn); "orient": "LR" or "TB", "layout": "radial"; "initialTreeDepth" for large trees.
- For structure without sizes, a Mermaid mindmap or flowchart reads better.
Panel: names an unnamed treemap's root "All" in its breadcrumb.`,
  },
  {
    name: "echarts-graph",
    aliases: ["network", "force", "nodes-links", "echarts-network"],
    summary: "Networks of nodes and links with force or circular layout and categories",
    language: "echarts",
    example: `{
  "title": {"text": "Service dependencies"},
  "legend": {},
  "series": [{
    "type": "graph",
    "layout": "force",
    "roam": true,
    "draggable": true,
    "edgeSymbol": ["none", "arrow"],
    "label": {"show": true, "position": "right"},
    "categories": [{"name": "Frontend"}, {"name": "Backend"}, {"name": "Data"}],
    "data": [
      {"name": "web", "category": 0, "symbolSize": 24}, {"name": "mobile", "category": 0, "symbolSize": 18},
      {"name": "api", "category": 1, "symbolSize": 30}, {"name": "auth", "category": 1, "symbolSize": 18},
      {"name": "postgres", "category": 2, "symbolSize": 24}, {"name": "redis", "category": 2, "symbolSize": 16}
    ],
    "links": [
      {"source": "web", "target": "api"}, {"source": "mobile", "target": "api"},
      {"source": "api", "target": "auth"}, {"source": "api", "target": "postgres"},
      {"source": "auth", "target": "redis"}
    ]
  }]
}`,
    notes: `- Nodes need unique names (or ids); links name their source and target. "categories" color the nodes, and "legend": {} lists them.
- "layout": "force" for networks, "circular" for cycles, "none" with x and y on every node.
- symbolSize by importance; "edgeSymbol": ["none", "arrow"] for direction; link labels with "label": {"show": true, "formatter": "calls"} on a link.
- Up to ~50 labeled nodes read well; for more, hide labels and let emphasis show them.
- For a few nodes with directed dependencies, a Mermaid flowchart reads better.
Panel: spreads a force layout over the panel unless "force" sets repulsion or edgeLength.`,
  },
  {
    name: "echarts-sankey",
    aliases: ["echarts-flow", "flows", "chord", "echarts-chord"],
    summary: "Sankey diagrams of flows between stages, and chord diagrams of flows among peers",
    language: "echarts",
    example: `{
  "title": {"text": "Visitors from source to outcome"},
  "series": [{
    "type": "sankey",
    "emphasis": {"focus": "adjacency"},
    "data": [
      {"name": "Search"}, {"name": "Ads"}, {"name": "Social"},
      {"name": "Landing page"}, {"name": "Pricing"},
      {"name": "Signup"}, {"name": "Left"}
    ],
    "links": [
      {"source": "Search", "target": "Landing page", "value": 620},
      {"source": "Ads", "target": "Landing page", "value": 310},
      {"source": "Social", "target": "Pricing", "value": 140},
      {"source": "Landing page", "target": "Pricing", "value": 480},
      {"source": "Landing page", "target": "Left", "value": 450},
      {"source": "Pricing", "target": "Signup", "value": 260},
      {"source": "Pricing", "target": "Left", "value": 360}
    ]
  }]
}`,
    notes: `- Node names are unique across all stages: name a repeated stage "Signup (web)". Links reference names and have positive values.
- No cycles: "Sankey is a DAG" means a link goes back to an earlier node. For flows among peers in both directions use "type": "chord" with the same data and links.
- "orient": "vertical" for top-down; "nodeAlign": "justify" puts the last nodes at the end; "lineStyle": {"color": "gradient"} colors links by their ends.
- Up to ~25 nodes read well; merge small flows into "Other".
Panel: links and nodes are selectable; marks and selection highlight them.`,
  },
  {
    name: "echarts-gauge",
    aliases: ["gauge", "kpi", "meter", "progress"],
    summary: "One value against a range, such as a utilization or a score",
    language: "echarts",
    example: `{
  "series": [{
    "type": "gauge",
    "min": 0,
    "max": 100,
    "progress": {"show": true, "width": 14},
    "axisLine": {"lineStyle": {"width": 14}},
    "detail": {"formatter": "{value}%"},
    "data": [{"value": 72, "name": "CPU"}]
  }]
}`,
    notes: `- One value per gauge; min and max should be a meaningful range, such as 0–100%.
- "detail": {"formatter": "{value} ms"} shows the unit. Thresholds: "axisLine": {"lineStyle": {"color": [[0.7, "#3ba272"], [0.9, "#fac858"], [1, "#ee6666"]]}}, only when the user wants them.
- To compare several values, use bars; several gauges need "center" and "radius" each.`,
  },
  {
    name: "echarts-custom",
    aliases: ["custom", "renderitem", "custom-series", "echarts-gantt"],
    summary: "Custom series: draw each item with renderItem, e.g. Gantt bars or error bars",
    language: "echarts",
    example: `{
  title: { text: "Deploy pipeline" },
  tooltip: { formatter: (p) => p.name + ": " + (p.value[2] - p.value[1]) + " s" },
  xAxis: { type: "value", name: "Seconds" },
  yAxis: { type: "category", inverse: true, data: ["build", "test", "deploy"] },
  series: [{
    type: "custom",
    encode: { x: [1, 2], y: 0 },
    data: [
      { name: "build", value: [0, 0, 95] },
      { name: "test", value: [1, 95, 240] },
      { name: "deploy", value: [2, 240, 300] },
    ],
    renderItem: (params, api) => {
      const start = api.coord([api.value(1), api.value(0)]);
      const end = api.coord([api.value(2), api.value(0)]);
      const height = api.size([0, 1])[1] * 0.6;
      return {
        type: "rect",
        shape: { x: start[0], y: start[1] - height / 2, width: end[0] - start[0], height },
        style: api.style(),
      };
    },
  }],
}`,
    notes: `- JavaScript, so it needs a trusted workspace. renderItem(params, api) runs per item: api.value(dimension) reads it, api.coord([x, y]) gives pixels, api.size([dx, dy]) the pixel size of a data step, api.style() the series' style (keep it, for theme colors and selection).
- Return a shape: {type: "rect" | "circle" | "line" | "polygon" | "text" | "group", shape, style}.
- "encode" tells the axes which dimensions to fit: without it they don't cover the data.
- No echarts global: no echarts.graphic helpers; clip by hand with params.coordSys if needed.
- A built-in series (bar with "stack", boxplot, candlestick) is simpler when it fits.`,
  },
  {
    name: "echarts-large",
    aliases: ["large", "large-data", "big-data", "performance", "sampling"],
    summary: "Many points: sampling, datasets, aggregation and zooming",
    language: "echarts",
    example: `{
  title: { text: "Latency of 20,000 requests" },
  dataset: {
    source: Array.from({ length: 20000 }, (_, i) => [i, 80 + 30 * Math.sin(i / 900) + 8 * Math.sin(i / 23)]),
  },
  xAxis: { type: "value", name: "Request" },
  yAxis: { type: "value", name: "Latency (ms)", scale: true },
  dataZoom: [{ type: "inside" }, { type: "slider" }],
  series: [{ type: "line", showSymbol: false, encode: { x: 0, y: 1 } }],
}`,
    notes: `- The panel draws with SVG (sharp, exportable) and has no progressive rendering. It samples long unstacked lines with LTTB and draws large scatter series as one shape, unless the option sets "sampling" or "large".
- Still aggregate first: bins, averages per time unit or top N. More than ~10,000 points rarely shows more, and the source travels in the tool call.
- For data in files or command output, diagram_chart reads, aggregates and bins it itself, without sending it through the model.
- Use a dataset with "encode" rather than copies of the data per series; "showSymbol": false and no labels per point; dataZoom to explore.
- Dense two-dimensional data reads better as a heatmap.`,
  },
  {
    name: "echarts-formatters",
    aliases: [
      "formatter",
      "formatters",
      "tooltip",
      "labels",
      "callbacks",
      "valueformatter",
      "units",
    ],
    summary: "Label, tooltip and axis label formatting: templates, valueFormatter, callbacks",
    language: "echarts",
    example: `{
  title: { text: "Build duration" },
  tooltip: {
    trigger: "axis",
    valueFormatter: (s) => (s == null ? "-" : Math.floor(s / 60) + " min " + (s % 60) + " s"),
  },
  xAxis: { type: "category", data: ["core", "cli", "web"] },
  yAxis: {
    type: "value",
    name: "Duration (min:s)",
    interval: 60,
    axisLabel: { formatter: (s) => Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0") },
  },
  series: [
    { name: "Median", type: "bar", data: [95, 140, 230], label: { show: true, position: "top", formatter: "{c} s" } },
    { name: "Slowest", type: "bar", data: [150, 210, 395] },
  ],
}`,
    notes: `- Templates work in JSON: {a} series name, {b} item or category name, {c} value, {d} percent (pie, funnel), {@dimension} a dataset dimension; axisLabel "{value} ms"; time axes {yyyy}-{MM}-{dd} {HH}:{mm}.
- tooltip.valueFormatter (a function) formats each value and keeps the default layout: the simplest way to add units.
- tooltip.formatter(params) gets an array of items for "trigger": "axis", one item for "item"; it returns HTML text.
- Rich text: "formatter": "{name|{b}}\\n{c}" with "rich": {"name": {"fontWeight": "bold"}}.
- Functions need a trusted workspace, and nothing is in scope (no echarts global): use toFixed, toLocaleString or Intl.NumberFormat.
Panel: "{c}" templates of labels and item tooltips get thousands separators; value axes get compact labels (1.5M) unless axisLabel sets a formatter.`,
  },
  {
    name: "echarts-radar",
    aliases: ["echarts-spider"],
    summary: "Radar charts: a few items scored on several indicators",
    language: "echarts",
    example: `{
  "title": {"text": "Plans compared"},
  "legend": {},
  "radar": {"indicator": [
    {"name": "Speed", "max": 10}, {"name": "Cost", "max": 10}, {"name": "Safety", "max": 10},
    {"name": "Effort", "max": 10}, {"name": "Reach", "max": 10}
  ]},
  "series": [{"type": "radar", "data": [
    {"name": "Plan A", "value": [8, 6, 7, 4, 9]},
    {"name": "Plan B", "value": [5, 9, 8, 7, 5]}
  ]}]
}`,
    notes: `- One "indicator" per axis with its max (the same scale for all reads best); each item's "value" lists one number per indicator, in order.
- "legend": {} names the items, which are the data of one series.
- 4–8 indicators and up to 3 items read well; areas exaggerate differences, so for exact comparisons use grouped bars.`,
  },
  {
    name: "echarts-boxplot",
    aliases: ["boxplot", "candlestick", "distribution", "echarts-candlestick"],
    summary: "Boxplots of distributions per group, and candlesticks",
    language: "echarts",
    example: `{
  "title": {"text": "Build time by runner"},
  "xAxis": {"type": "category", "data": ["linux", "macos", "windows"]},
  "yAxis": {"type": "value", "name": "Seconds"},
  "series": [
    {"name": "Build time", "type": "boxplot", "data": [[295, 305, 320, 336, 382], [190, 202, 210, 217, 238], [430, 455, 465, 475, 510]]},
    {"name": "Outliers", "type": "scatter", "data": [["linux", 515], ["windows", 610]]}
  ]
}`,
    notes: `- Boxplot items are [min, Q1, median, Q3, max] per category. From raw samples: a dataset whose rows are each group's samples, then {"transform": {"type": "boxplot"}} computes them (and outliers as its second result).
- diagram_chart's boxplot type computes them from a data file or command output.
- Candlestick items are [open, close, low, high] on a category or time axis.
- Name the value axis with its unit; a scatter series for outliers or raw points.`,
  },
];

/** Every topic, the Mermaid ones first, in the order of the index. */
export const GUIDE_TOPICS: readonly GuideTopic[] = [...MERMAID, ...ECHARTS];
