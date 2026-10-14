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
  {
    broken: "Alice->>Bob: Hi\n  Bob-->>Alice: Hello",
    error: 'The diagram has no type: start it with a line "sequenceDiagram".',
    fixed: "sequenceDiagram\n  Alice->>Bob: Hi\n  Bob-->>Alice: Hello",
  },
  // Sequence diagrams.
  {
    broken: "sequenceDiagram\n  Alice->>Bob: Hello; how are you?\n  Bob-->>Alice: Fine",
    error:
      'Parse error on line 2, column 35: unexpected end of line. A ";" ends a statement: write it as #59; in text: Alice->>Bob: Hello#59; how are you?.',
    fixed: "sequenceDiagram\n  Alice->>Bob: Hello#59; how are you?\n  Bob-->>Alice: Fine",
  },
  {
    broken: "sequenceDiagram\n  Alice->>Bob: Fish &amp; chips\n  Bob-->>Alice: Sure",
    error:
      'Parse error on line 2, column 32: unexpected end of line. A ";" ends a statement: write entities as #name;, such as #amp; for &: Alice->>Bob: Fish #amp; chips.',
    fixed: "sequenceDiagram\n  Alice->>Bob: Fish #amp; chips\n  Bob-->>Alice: Sure",
  },
  {
    broken: "sequenceDiagram\n  Alice->>Bob\n  Bob-->>Alice: Hi",
    error:
      "Parse error on line 2, column 14: unexpected end of line. A message takes a colon before its text: Alice->>Bob: text.",
    fixed: "sequenceDiagram\n  Alice->>Bob: text\n  Bob-->>Alice: Hi",
  },
  {
    broken: "sequenceDiagram\n  Alice->>Bob: Hi\n  Note right of Bob thinks it over",
    error:
      "Parse error on line 3, column 35: unexpected end of the diagram. Put a colon before the note's text: Note right of Bob: thinks it over.",
    fixed: "sequenceDiagram\n  Alice->>Bob: Hi\n  Note right of Bob: thinks it over",
  },
  {
    broken: "sequenceDiagram\n  Alice=>>Bob: Hi",
    error:
      'Parse error on line 2, column 9: unexpected ">". Sequence arrows are ->>, -->>, ->, -->, -x, --x, -) and --): Alice->>Bob: Hi.',
    fixed: "sequenceDiagram\n  Alice->>Bob: Hi",
  },
  {
    broken: "sequenceDiagram\n  Alice<-Bob: Hi",
    error:
      'Parse error on line 2, column 8: unexpected "<". Sequence arrows are ->>, -->>, ->, -->, -x, --x, -) and --), from the sender: Bob->>Alice: Hi.',
    fixed: "sequenceDiagram\n  Bob->>Alice: Hi",
  },
  {
    broken: "sequenceDiagram\n  Alice->>loop: Hi",
    error:
      'Parse error on line 2, column 11: unexpected "loop". "loop" on line 2 is a keyword, so it cannot be a participant\'s name: declare the participant as "participant P as loop" and use P.',
    fixed: "sequenceDiagram\n  participant P as loop\n  Alice->>P: Hi",
  },
  {
    broken: "sequenceDiagram\n  participant end\n  end->>Bob: Hi",
    error:
      'Parse error on line 3, column 3: unexpected "end". "end" on line 3 is a keyword, so it cannot be a participant\'s name: declare the participant as "participant P as end" and use P.',
    fixed: "sequenceDiagram\n  participant P as end\n  P->>Bob: Hi",
  },
  {
    broken:
      "sequenceDiagram\n  alt Valid\n    Alice->>Bob: Token\n  else Invalid\n    Bob-->>Alice: Error",
    error:
      'Parse error on line 5, column 24: unexpected end of the diagram. The "alt" block on line 2 is not closed: add a line "end" after its contents.',
    fixed:
      "sequenceDiagram\n  alt Valid\n    Alice->>Bob: Token\n  else Invalid\n    Bob-->>Alice: Error\n  end",
  },
  {
    broken: "sequenceDiagram\n  Alice->>Bob: Hi\n  else Later\n  Bob-->>Alice: Bye",
    error:
      'Parse error on line 3, column 3: unexpected "else". "else" goes inside an "alt" block, between "alt" and "end".',
    fixed:
      "sequenceDiagram\n  alt Now\n    Alice->>Bob: Hi\n  else Later\n    Bob-->>Alice: Bye\n  end",
  },
  {
    broken: "sequenceDiagram\n  Alice->>Bob: Hi\n  end",
    error:
      'Parse error on line 3, column 3: unexpected "end". This "end" closes no block: remove it, or open the block before it, with alt, opt, loop, par, critical, break, rect or box.',
    fixed: "sequenceDiagram\n  Alice->>Bob: Hi",
  },
  // Class diagrams.
  {
    broken: "classDiagram\n  class List<T> {\n    +add(T item)\n  }",
    error:
      'Parse error on line 2, column 13: unexpected "<". Write generic types with tildes: class List~T~.',
    fixed: "classDiagram\n  class List~T~ {\n    +add(T item)\n  }",
  },
  {
    broken: "classDiagram\n  class Cache<String, List<Item>>",
    error:
      'Parse error on line 2, column 14: unexpected "<". Write generic types with tildes; class names cannot nest them: class Cache~String, List~.',
    fixed: "classDiagram\n  class Cache~String, List~",
  },
  {
    broken: "classDiagram\n  Repository<User> --> User",
    error:
      'Parse error on line 2, column 14: unexpected "User". Write generic types with tildes: Repository~User~ --> User.',
    fixed: "classDiagram\n  Repository~User~ --> User",
  },
  {
    broken: "classDiagram\n  User 1 --> 0..* Order : places",
    error:
      'Parse error on line 2, column 15: unexpected "..". Put cardinalities in double quotes: User "1" --> "0..*" Order : places.',
    fixed: 'classDiagram\n  User "1" --> "0..*" Order : places',
  },
  {
    broken: "classDiagram\n  Order -> Item : contains",
    error:
      'Parse error on line 2, column 12: unexpected "Item". Write relations as <|--, *--, o--, -->, --, ..>, ..|> or ..: Order --> Item : contains.',
    fixed: "classDiagram\n  Order --> Item : contains",
  },
  {
    broken: "classDiagram\n  class Order\n  note for Order: Aggregate root",
    error:
      'Parse error on line 3, column 17: unexpected ": Aggregate root". Put the note\'s text in double quotes: note for Order "Aggregate root".',
    fixed: 'classDiagram\n  class Order\n  note for Order "Aggregate root"',
  },
  {
    broken: "classDiagram\n  class A {\n    +run()\n  class B",
    error:
      'Parse error on line 4, column 10: unexpected end of the diagram. The "{" on line 2 is not closed: add a line "}" after its contents.',
    fixed: "classDiagram\n  class A {\n    +run()\n  }\n  class B",
  },
  {
    broken: "classDiagram\n  class A {\n    +run()\n  }\n  }",
    error: 'Parse error on line 5, column 3: unexpected "}". This "}" closes no "{": remove it.',
    fixed: "classDiagram\n  class A {\n    +run()\n  }",
  },
  {
    broken: "classDiagram\n  <<interface>> Shape\n  Shape <|.. Circle",
    error:
      'Error on line 2: <<interface>> Shape annotates a class that is not declared before it: declare it first, with "class Shape".',
    fixed: "classDiagram\n  class Shape\n  <<interface>> Shape\n  Shape <|.. Circle",
  },
  // State diagrams.
  {
    broken: "stateDiagram-v2\n  [*] --> Idle\n  note over Idle: Waits for input",
    error:
      'Parse error on line 3, column 8: unexpected "o". A note goes left of or right of a state: note right of Idle: Waits for input.',
    fixed: "stateDiagram-v2\n  [*] --> Idle\n  note right of Idle: Waits for input",
  },
  {
    broken: "stateDiagram-v2\n  [*] --> in-progress\n  in-progress --> [*]",
    error:
      'Parse error on line 2, column 13: unexpected "-". State ids have no "-": use in_progress, and show the name with state "in-progress" as in_progress.',
    fixed:
      'stateDiagram-v2\n  state "in-progress" as in_progress\n  [*] --> in_progress\n  in_progress --> [*]',
  },
  {
    broken: "stateDiagram-v2\n  Idle -> Running",
    error:
      'Parse error on line 2, column 8: unexpected "-". Write transitions as -->: Idle --> Running.',
    fixed: "stateDiagram-v2\n  Idle --> Running",
  },
  {
    broken: "stateDiagram-v2\n  state Running {\n    Loading --> Ready",
    error:
      'Parse error on line 3, column 22: unexpected end of the diagram. The "{" on line 2 is not closed: add a line "}" after its contents.',
    fixed: "stateDiagram-v2\n  state Running {\n    Loading --> Ready\n  }",
  },
  // ER diagrams.
  {
    broken: "erDiagram\n  USER {\n    id: int PK\n  }",
    error:
      'Parse error on line 3, column 7: unexpected ":". Write an attribute as its type, then its name: int id PK.',
    fixed: "erDiagram\n  USER {\n    int id PK\n  }",
  },
  {
    broken: "erDiagram\n  USER {\n    int id PK FK 'the id'\n  }",
    error:
      "Parse error on line 3, column 15: unexpected \"FK\". Separate an attribute's keys with commas: int id PK, FK 'the id'.",
    fixed: 'erDiagram\n  USER {\n    int id PK, FK "the id"\n  }',
  },
  {
    broken: "erDiagram\n  USER {\n    int id 'the id'\n  }",
    error:
      'Parse error on line 3, column 12: unexpected "\'". Write an attribute\'s comment in double quotes: int id "the id".',
    fixed: 'erDiagram\n  USER {\n    int id "the id"\n  }',
  },
  {
    broken: "erDiagram\n  CUSTOMER 1--* ORDER : places",
    error:
      'Parse error on line 2, column 15: unexpected "*". Write cardinalities as ||, |o, }| or }o left of -- or .., and ||, o|, |{ or o{ right of it: CUSTOMER ||--o{ ORDER : places.',
    fixed: "erDiagram\n  CUSTOMER ||--o{ ORDER : places",
  },
  {
    broken: "erDiagram\n  CUSTOMER ||--o{ ORDER\n  ORDER ||--|{ ITEM : contains",
    error:
      'Parse error on line 2, column 24: unexpected end of line. A relationship takes a label after a colon, "" for none: CUSTOMER ||--o{ ORDER : "".',
    fixed: 'erDiagram\n  CUSTOMER ||--o{ ORDER : ""\n  ORDER ||--|{ ITEM : contains',
  },
  {
    broken: "erDiagram\n  CUSTOMER ||--o{ ORDER : places (online)",
    error:
      'Parse error on line 2, column 34: unexpected "(". Put the label in double quotes: CUSTOMER ||--o{ ORDER : "places (online)".',
    fixed: 'erDiagram\n  CUSTOMER ||--o{ ORDER : "places (online)"',
  },
  {
    broken: "erDiagram\n  A ||--o{ B : key: value\n  B ||--|| C : #1",
    error:
      'Parse error on line 2, column 19: unexpected ":". Put the label in double quotes: A ||--o{ B : "key: value".',
    fixed: 'erDiagram\n  A ||--o{ B : "key: value"\n  B ||--|| C : "#1"',
  },
  {
    broken: 'erDiagram\n  OI["Order Item"] ||--o{ P["Product"] : lists',
    error:
      'Parse error on line 2, column 20: unexpected "||". Declare an entity\'s label on a line of its own, as OI["Order Item"] and P["Product"], and use its id in relationships: OI ||--o{ P : lists.',
    fixed: 'erDiagram\n  OI["Order Item"]\n  P["Product"]\n  OI ||--o{ P : lists',
  },
  // Gantt charts.
  {
    broken:
      "gantt\n  title: Release plan\n  dateFormat YYYY-MM-DD\n  section Build\n  Design :a1, 2026-01-01, 7d",
    error: 'Error on line 2: "title" takes no colon: write "title Release plan".',
    fixed:
      "gantt\n  title Release plan\n  dateFormat YYYY-MM-DD\n  section Build\n  Design :a1, 2026-01-01, 7d",
  },
  {
    broken: "gantt\n  dateFormat: YYYY-MM-DD\n  Design :a1, 2026-01-01, 7d",
    error: 'Error on line 2: "dateFormat" takes no colon: write "dateFormat YYYY-MM-DD".',
    fixed: "gantt\n  dateFormat YYYY-MM-DD\n  Design :a1, 2026-01-01, 7d",
  },
  // Pie charts.
  {
    broken: 'pie title: Pets\n  Dogs : 386\n  "Cats" : 85%',
    error:
      'Parse error on line 1, column 5: unexpected "title". Write the title without a colon: pie title Pets.\nParse error on line 2, column 3: unexpected "Dogs". Put the label in double quotes: "Dogs" : 386.\nParse error on line 3, column 14: unexpected "%". Give the value as a number alone: "Cats" : 85.',
    fixed: 'pie title Pets\n  "Dogs" : 386\n  "Cats" : 85',
  },
  // Mind maps.
  {
    broken: "mindmap\n  root((Plan))\n    Research[Users (interviews)]",
    error:
      'Parse error on line 3, column 21: unexpected "interviews". Put the label in double quotes: Research["Users (interviews)"].',
    fixed: 'mindmap\n  root((Plan))\n    Research["Users (interviews)"]',
  },
  // Architecture diagrams.
  {
    broken:
      "architecture-beta\n  service db(database)[Database]\n  service api(server)[API]\n  api --> db",
    error:
      'Parse error on line 4, column 7: unexpected "--". Architecture edges join sides of services, L, R, T or B: api:R --> L:db.',
    fixed:
      "architecture-beta\n  service db(database)[Database]\n  service api(server)[API]\n  api:R --> L:db",
  },
  {
    broken:
      "architecture-beta\n  service db(database)[Database]\n  service api(server)[API]\n  api:r -- l:db",
    error:
      'Parse error on line 4, column 7: unexpected "r". Architecture edges join sides of services, L, R, T or B, in capitals: api:R -- L:db.',
    fixed:
      "architecture-beta\n  service db(database)[Database]\n  service api(server)[API]\n  api:R -- L:db",
  },
  {
    broken:
      'architecture-beta\n  service db(database)[Database]\n  service api(server)[API]\n  api:R --> L:db : "queries"',
    error:
      'Parse error on line 4, column 18: unexpected ":". Put an edge\'s label in the edge: api:R -[queries]-> L:db.',
    fixed:
      "architecture-beta\n  service db(database)[Database]\n  service api(server)[API]\n  api:R -[queries]-> L:db",
  },
  {
    broken:
      "architecture-beta\n  group cloud(cloud)[Cloud] {\n    service db(database)[Database]\n  }",
    error:
      'Parse error on line 2, column 29: unexpected "{". A group takes no braces: end the lines of the services in it with "in cloud", as in service db(database)[Database] in cloud.\nParse error on line 4, column 3: unexpected "}".',
    fixed:
      "architecture-beta\n  group cloud(cloud)[Cloud]\n  service db(database)[Database] in cloud",
  },
  // Block diagrams.
  {
    broken: 'block-beta\n  columns: 2\n  a["Start"] b["End"]',
    error: 'Parse error on line 2, column 10: unexpected ":". Write "columns 2", without a colon.',
    fixed: 'block-beta\n  columns 2\n  a["Start"] b["End"]',
  },
  {
    broken: "block-beta\n  columns 2\n  a[Start] b(End)",
    error:
      'Parse error on line 3, column 5: unexpected "S". Put the label in double quotes: a["Start"].',
    fixed: 'block-beta\n  columns 2\n  a["Start"] b("End")',
  },
  {
    broken: 'block-beta\n  subgraph front\n    ui["UI"] api["API"]\n  end',
    error:
      'Parse error on line 4, column 3: unexpected "e". Block diagrams group blocks with "block:front" and "end", not with the subgraph on line 2.',
    fixed: 'block-beta\n  block:front\n    ui["UI"] api["API"]\n  end',
  },
  // Sankey diagrams.
  {
    broken: "sankey\n  source,target,value\n  Coal,Power,30",
    error:
      "Error on line 2: A sankey diagram has no header row: remove this line, and start with the first flow.",
    fixed: "sankey\n  Coal,Power,30",
  },
  {
    broken: 'sankey\n  "Source","Target","Value"\n  Coal,Power,30',
    error:
      'Parse error on line 2, column 3: unexpected "\\"". A sankey diagram has no header row: remove this line, and start with the first flow.',
    fixed: "sankey\n  Coal,Power,30",
  },
  {
    broken: 'sankey\n  "Coal, raw",Power,30\n  Power,Homes,20',
    error:
      'Parse error on line 2, column 3: unexpected "\\"". Leave out the indentation of a line that starts with a quoted field: "Coal, raw",Power,30',
    fixed: 'sankey\n"Coal, raw",Power,30\n  Power,Homes,20',
  },
  // Git graphs.
  {
    broken: "gitGraph\n  commit\n  checkout -b feature\n  commit",
    error:
      'Parse error on line 3, column 12: unexpected "-". Create a branch with "branch feature", which also checks it out.',
    fixed: "gitGraph\n  commit\n  branch feature\n  commit",
  },
  {
    broken: "gitGraph\n  git commit\n  commit id: first\n  branch dev\n  merge dev --no-ff",
    error:
      'Parse error on line 2, column 3: unexpected "git". Leave out "git": commit.\nParse error on line 3, column 14: unexpected "first". Put it in double quotes: commit id: "first".\nParse error on line 5, column 13: unexpected "--". Leave out git\'s options: merge dev.',
    fixed:
      'gitGraph\n  commit\n  commit id: "first"\n  branch dev\n  commit\n  checkout main\n  merge dev',
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
