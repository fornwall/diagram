import * as assert from "node:assert";
import { ItemNames } from "../itemNames";
import type { DiagramNode } from "../protocol";

type Direction = NonNullable<DiagramNode["relationship"]>["direction"];

const relation = (
  id: string,
  source: string,
  target: string,
  direction: Direction = "forward",
): DiagramNode => ({
  id,
  label: `${source} → ${target}`,
  relationship: { kind: id.startsWith("message:") ? "message" : "edge", source, target, direction },
});

suite("itemNames", () => {
  const names = new ItemNames({
    nodeIds: ["A", "B", "C", "my-node", "Solar power", "Grid", "B --> C"],
    relationships: [
      relation("edge:L_A_B_0", "A", "B"),
      relation("edge:L_A_B_1", "A", "B"),
      relation("edge:L_B_A_0", "B", "A"),
      relation("edge:both", "B", "C", "both"),
      relation("edge:plain", "C", "my-node", "undirected"),
      relation("edge:L_A_A_0", "A", "A"),
      relation("edge:Solar power → Grid", "Solar power", "Grid"),
    ],
  });
  const ids = (name: string) => names.resolve(name).ids;

  test("names an edge by its ends' ids, with any of the arrows that models write", () => {
    for (const arrow of ["-->", "->", "→", "->>", "-->>", "==>", "-.->", "---", "<-->", "↔"]) {
      assert.deepStrictEqual(ids(`B ${arrow} A`), ["edge:L_B_A_0"], arrow);
    }
    assert.deepStrictEqual(ids("B-->A"), ["edge:L_B_A_0"]);
    assert.deepStrictEqual(ids("  B  ->  A "), ["edge:L_B_A_0"]);
    // A self-loop, and ends of an id with a dash or a space.
    assert.deepStrictEqual(ids("A --> A"), ["edge:L_A_A_0"]);
    assert.deepStrictEqual(ids("my-node-->C"), ["edge:plain"]);
    assert.deepStrictEqual(ids("Solar power -> Grid"), ["edge:Solar power → Grid"]);
    // As the id of an edge, which a model may copy the prefix of.
    assert.deepStrictEqual(ids("edge:B -> A"), ["edge:L_B_A_0"]);
  });

  test("names all edges between the ends in that direction, and those both or no way either way", () => {
    assert.deepStrictEqual(ids("A --> B"), ["edge:L_A_B_0", "edge:L_A_B_1"]);
    assert.deepStrictEqual(ids("B -> C"), ["edge:both"]);
    assert.deepStrictEqual(ids("C --> B"), ["edge:both"]);
    assert.deepStrictEqual(ids("my-node --> C"), ["edge:plain"]);
  });

  test("takes an item's id as it is before reading ends from it", () => {
    assert.deepStrictEqual(ids("edge:L_A_B_1"), ["edge:L_A_B_1"]);
    assert.deepStrictEqual(ids("B --> C"), ["B --> C"]);
    assert.deepStrictEqual(ids("A"), ["A"]);
  });

  test("says why ends name nothing", () => {
    assert.deepStrictEqual(names.resolve("X"), { ids: [] });
    assert.deepStrictEqual(names.resolve("edge:L_X"), { ids: [] });
    assert.deepStrictEqual(names.resolve("A --> X"), { ids: [], why: '"X" is not a node id' });
    assert.deepStrictEqual(names.resolve("Client -> Server"), {
      ids: [],
      why: '"Client", "Server" are not node ids',
    });
    assert.deepStrictEqual(names.resolve("X -> X"), { ids: [], why: '"X" is not a node id' });
    assert.deepStrictEqual(names.resolve("A --> C"), {
      ids: [],
      why: 'nothing goes from "A" to "C"',
    });
    assert.deepStrictEqual(names.resolve("Grid --> Solar power"), {
      ids: [],
      why: 'nothing goes from "Grid" to "Solar power", only from "Solar power" to "Grid"',
    });
    assert.deepStrictEqual(names.resolve("--> A"), { ids: [] });
  });

  test("names each item by its id, or an edge by its ends unless others go between them too, or its label", () => {
    assert.deepStrictEqual(names.names(), [
      "A",
      "B",
      "C",
      "my-node",
      "Solar power",
      "Grid",
      "B --> C",
      "edge:L_A_B_0",
      "edge:L_A_B_1",
      "B --> A",
      // A node has this name as its id.
      "edge:both",
      "C --> my-node",
      "A --> A",
      "Solar power --> Grid",
    ]);
  });

  /** A message as the page reports it, labeled by its ends' labels and its own. */
  const message = (
    id: string,
    source: string,
    target: string,
    ends: string,
    text: string,
  ): DiagramNode => ({
    id,
    label: `${ends}: ${text}`,
    relationship: { kind: "message", source, target, direction: "forward", text },
  });
  const messages = new ItemNames({
    nodeIds: ["C", "S", "S:1"],
    relationships: [
      message("message:i0", "C", "S", "Client → Server", "Login"),
      message("message:i1", "C", "S", "Client → Server", "Fetch"),
      message("message:i2", "C", "S", "Client → Server", "Fetch"),
      message("message:i3", "C", "S", "Client → Server", "Log out"),
      message("message:i4", "S", "C", "Server → Client", "Token: abc"),
      message("message:i5", "C", "S:1", "Client → Shard", "Hi"),
    ],
  });

  test("names one of several between the same ends by its label, as the source writes it", () => {
    const named = (name: string) => messages.resolve(name);
    assert.deepStrictEqual(named("C->>S: Login"), { ids: ["message:i0"] });
    assert.deepStrictEqual(named("C -->|Login| S"), { ids: ["message:i0"] });
    assert.deepStrictEqual(named('C -->|"login"| S'), { ids: ["message:i0"] });
    // A line break in the source is a space in the label.
    assert.deepStrictEqual(named("C->>S: Log<br/>out"), { ids: ["message:i3"] });
    assert.deepStrictEqual(named("S --> C: Token: abc"), { ids: ["message:i4"] });
    assert.deepStrictEqual(named("C --> S:1: Hi"), { ids: ["message:i5"] });
    assert.deepStrictEqual(named("C --> S:1"), { ids: ["message:i5"] });
    // All with the label, which does not tell them apart.
    assert.deepStrictEqual(named("C --> S: Fetch"), { ids: ["message:i1", "message:i2"] });
    assert.deepStrictEqual(named("C --> S: Logon"), {
      ids: [],
      why: 'nothing labeled "Logon" goes from "C" to "S"',
    });
    assert.deepStrictEqual(named("S --> C: Login"), {
      ids: [],
      why: 'nothing labeled "Login" goes from "S" to "C"',
    });
    assert.deepStrictEqual(named("Client -> Server: Login"), {
      ids: [],
      why: '"Client", "Server" are not node ids',
    });
    assert.deepStrictEqual(messages.names().slice(3), [
      "C --> S: Login",
      "message:i1",
      "message:i2",
      "C --> S: Log out",
      "S --> C",
      "C --> S:1",
    ]);
  });
});
