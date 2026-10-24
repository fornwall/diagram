import * as assert from "node:assert";
import * as vscode from "vscode";
import { CheckpointTool } from "../checkpointTool";
import { parseTable } from "../data";
import { compareSnapshots, DiagramHistory, type DiagramSnapshot } from "../diagramHistory";
import type { DiagramState } from "../panel";
import type { DiagramNode } from "../protocol";
import { parseStateInput } from "../stateSource";
import { GetDiagramStateTool } from "../tools";
import { cancellationSource } from "./afterTest";
import { drawChart, memento, newFakePanel } from "./newPanel";
import { invokeTool } from "./toolText";

const state = (source = "flowchart LR\n A --> B"): DiagramState => ({
  language: "mermaid",
  source,
  title: "Diagram",
  origin: "tool",
  editedByUser: false,
});
const snapshot = (revision: number, changes: Partial<DiagramState> = {}): DiagramSnapshot => ({
  revision,
  state: { ...state(), ...changes },
});
const comparison = (before: DiagramSnapshot, after: DiagramSnapshot) =>
  JSON.parse(JSON.stringify(compareSnapshots(before, after)));
const connection = (
  id: string,
  from: string,
  to: string,
  index: number,
  label = "",
): DiagramNode => ({
  id,
  label,
  relationship: {
    kind: "edge",
    source: from,
    target: to,
    direction: "forward",
    text: label,
    linkStyle: index,
  },
});

suite("diagram history", () => {
  test("evicts oldest revisions by count and the complete stored byte size", () => {
    const history = new DiagramHistory();
    for (let revision = 0; revision < 40; revision++) history.record(snapshot(revision));
    assert.strictEqual(history.at(7), undefined);
    assert.strictEqual(history.at(8)?.revision, 8);
    assert.strictEqual(history.at(39)?.revision, 39);
    history.record(snapshot(40, { title: "大".repeat(750_000) }));
    history.record(snapshot(41, { title: "大".repeat(750_000) }));
    assert.strictEqual(history.at(40), undefined);
    assert.strictEqual(history.at(41)?.revision, 41);
    history.record(snapshot(42, { title: "x".repeat(4_000_001) }));
    assert.strictEqual(history.at(41), undefined);
    assert.strictEqual(history.at(42), undefined);
  });

  test("replaces a revision snapshot without counting it twice", () => {
    const history = new DiagramHistory();
    for (let revision = 0; revision < 10; revision++)
      history.record(snapshot(revision, { title: "x".repeat(150_000) }));
    for (let repeat = 0; repeat < 10; repeat++) history.record(snapshot(9, { title: "Final" }));
    assert.ok(history.at(0));
    assert.strictEqual(history.at(9)?.state.title, "Final");
  });

  test("keeps checkpoints separate from eviction and copies their data", () => {
    const history = new DiagramHistory();
    const original = snapshot(1);
    const table = parseTable("name,value\nA,1\nB,2");
    const saved = history.save(original, "  Original  ", table);
    original.state.title = "Changed later";
    if (table.rows[0]) table.rows[0][1] = 99;
    for (let revision = 2; revision < 100; revision++) history.record(snapshot(revision));
    assert.strictEqual(history.get(saved.id).name, "Original");
    assert.strictEqual(history.get(saved.id).state.title, "Diagram");
    assert.strictEqual(history.get(saved.id).table?.rows[0]?.[1], 1);
    assert.throws(() => history.save(snapshot(100), " "), /name/);
  });

  test("enforces checkpoint count and byte limits without losing existing saves", () => {
    const history = new DiagramHistory();
    const first = history.save(snapshot(0), "First");
    assert.throws(
      () => history.save(snapshot(1, { title: "大".repeat(2_700_000) }), "Too large"),
      /8 MB/,
    );
    assert.strictEqual(history.list().length, 1);
    for (let revision = 1; revision < 20; revision++)
      history.save(snapshot(revision), `Checkpoint ${revision}`);
    assert.throws(() => history.save(snapshot(20), "Full"), /already 20/);
    history.delete(first.id);
    history.save(snapshot(20), "Room again");
    assert.strictEqual(history.list().length, 20);
    assert.throws(() => history.get(first.id), /Unknown checkpoint/);
  });

  test("restores checkpoint items and rejects malformed stored tables", () => {
    const history = new DiagramHistory();
    const saved = history.save(
      {
        ...snapshot(4),
        labelsKnown: true,
        items: [{ id: "A", label: "API" }, connection("edge:first", "A", "B", 0)],
      },
      "Baseline",
      parseTable("name,value\nA,4"),
    );
    const restored = new DiagramHistory(JSON.parse(JSON.stringify(history.saved())));
    assert.deepStrictEqual(restored.get(saved.id), saved);
    const brokenItems = new DiagramHistory([{ ...saved, items: [{ id: 1, label: "bad" }] }]);
    assert.strictEqual(brokenItems.get(saved.id).items, undefined);
    assert.strictEqual(
      new DiagramHistory([{ ...saved, table: { ...saved.table, rows: [[true, 1]] } }]).list()
        .length,
      0,
    );
    assert.strictEqual(
      new DiagramHistory([{ ...saved, table: { ...saved.table, rows: [["A"]] } }]).list().length,
      0,
    );
    assert.strictEqual(new DiagramHistory([{ ...saved, name: "" }]).list().length, 0);
    assert.strictEqual(new DiagramHistory([{ ...saved, revision: -1 }]).list().length, 0);
  });

  test("does not report legacy synthetic labels as renamed nodes", () => {
    const history = new DiagramHistory();
    const saved = history.save({ ...snapshot(1), items: [{ id: "A", label: "A" }] }, "Legacy");
    const restored = new DiagramHistory(JSON.parse(JSON.stringify(history.saved())));
    const before = restored.get(saved.id);
    assert.strictEqual(before.labelsKnown, false);
    assert.deepStrictEqual(
      comparison(before, {
        ...snapshot(2),
        labelsKnown: true,
        items: [{ id: "A", label: "API" }],
      }).structure,
      { added: [], removed: [], modified: [] },
    );
  });

  test("compares edge meaning independently of render ids, direction order and linkStyle positions", () => {
    const before = {
      ...snapshot(1),
      items: [connection("edge:old", "A", "B", 1), connection("parallel", "A", "B", 2)],
    };
    const after = {
      ...snapshot(2),
      items: [connection("edge:new", "A", "B", 4), connection("parallel2", "A", "B", 5)],
    };
    assert.deepStrictEqual(comparison(before, after).structure, {
      added: [],
      removed: [],
      modified: [],
    });
    after.items.push(connection("third", "A", "B", 6));
    assert.deepStrictEqual(
      comparison(before, after).structure.added.map((item: DiagramNode) => item.id),
      ["third"],
    );
    const oldBoth = connection("oldBoth", "A", "B", 0);
    const newBoth = connection("newBoth", "B", "A", 1);
    if (oldBoth.relationship) oldBoth.relationship.direction = "both";
    if (newBoth.relationship) newBoth.relationship.direction = "both";
    assert.deepStrictEqual(
      comparison({ ...snapshot(1), items: [oldBoth] }, { ...snapshot(2), items: [newBoth] })
        .structure,
      { added: [], removed: [], modified: [] },
    );
  });

  test("reports node label changes without inventing additions or removals", () => {
    const before = {
      ...snapshot(1),
      items: [
        { id: "A", label: "Before" },
        { id: "B", label: "Same" },
      ],
    };
    const after = {
      ...snapshot(2),
      items: [
        { id: "A", label: "After" },
        { id: "B", label: "Same" },
      ],
    };
    assert.deepStrictEqual(comparison(before, after).structure, {
      added: [],
      removed: [],
      modified: [{ id: "A", before: before.items[0], after: after.items[0] }],
    });
    assert.deepStrictEqual(
      comparison({ ...before, labelsKnown: false }, after).structure.modified,
      [],
    );
  });

  test("reports changed edges, evidence and unavailable source without inventing deletions", () => {
    const before = { ...snapshot(1), items: [connection("first", "A", "B", 0, "old")] };
    const evidence = [{ id: "A", locations: [], assumptions: ["Requests are authenticated"] }];
    const after = {
      ...snapshot(2, { evidence, source: "flowchart LR\n A --> C" }),
      items: [connection("second", "A", "C", 0, "new")],
    };
    const report = comparison(before, after);
    assert.strictEqual(report.sourceChanged, true);
    assert.match(report.diff, /- A --> B\n\+ A --> C/);
    assert.deepStrictEqual(report.metadata.evidence, { before: null, after: evidence });
    assert.strictEqual(report.structure.added[0].relationship.target, "C");
    assert.strictEqual(report.structure.removed[0].relationship.target, "B");
    const unavailable = comparison(snapshot(1, { source: undefined }), snapshot(2));
    assert.strictEqual(unavailable.diff, undefined);
    assert.match(unavailable.sourceNotice, /unavailable/);
  });
});

suite("checkpoint tools", () => {
  test("compares actual rendered node labels from saved checkpoints", async () => {
    const { panel, webview } = await newFakePanel();
    let label = "Before";
    webview.answer = (message) =>
      message.type === "render"
        ? {
            type: "rendered",
            requestId: message.requestId,
            diagramType: "flowchart-v2",
            nodeIds: ["A"],
            nodes: [{ id: "A", label }],
          }
        : undefined;
    await panel.render(
      { language: "mermaid", title: "Labels", source: "flowchart LR\n A[Before]" },
      "tool",
    );
    const tool = new CheckpointTool(panel);
    const checkpoint = JSON.parse(await invokeTool(tool, { action: "save", name: "Before" }));
    label = "After";
    await panel.editByAgent({ source: "flowchart LR\n A[After]" }, panel.revision);
    const result = JSON.parse(await invokeTool(tool, { action: "compare", id: checkpoint.id }));
    assert.strictEqual(result.structure.modified[0].before.label, "Before");
    assert.strictEqual(result.structure.modified[0].after.label, "After");
  });
  test("bounds comparison output even with a generous token budget and cancels token counting", async () => {
    const { panel } = await newFakePanel();
    await panel.render(
      { language: "mermaid", title: "Original", source: "flowchart LR\n A" },
      "tool",
    );
    const tool = new CheckpointTool(panel);
    const saved = JSON.parse(await invokeTool(tool, { action: "save", name: "Original" }));
    await panel.render(
      { language: "mermaid", title: "Large", source: `flowchart LR\n A[${"x".repeat(30_000)}]` },
      "tool",
    );
    const report = await invokeTool(tool, { action: "compare", id: saved.id }, undefined, {
      tokenBudget: 100_000,
      countTokens: async () => 0,
    });
    assert.match(report, /exceeds the tool budget/);
    assert.ok(report.length < 200);
    const cancellation = cancellationSource();
    await assert.rejects(
      () =>
        invokeTool(tool, { action: "list" }, cancellation.token, {
          tokenBudget: 1000,
          countTokens: () => {
            cancellation.cancel();
            return new Promise<number>(() => {});
          },
        }),
      vscode.CancellationError,
    );
    const tiny = await invokeTool(
      tool,
      { action: "save", name: "Saved with tiny budget" },
      undefined,
      { tokenBudget: 1, countTokens: async () => 1000 },
    );
    assert.match(tiny, /^Saved checkpoint [\w-]+ at revision/);
  });

  test("serializes saves and deletes while retaining the revision requested before waiting", async () => {
    const values = new Map<string, unknown>();
    const store = memento(values);
    let block = false;
    let writes = 0;
    let release = () => {};
    let entered = () => {};
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { panel } = await newFakePanel({
      ...store,
      update: async (key, value) => {
        if (block && key === "diagram.checkpoints") {
          writes++;
          entered();
          await blocked;
        }
        await store.update(key, value);
      },
    });
    await panel.render(
      { language: "mermaid", source: "flowchart LR\n A", title: "Original" },
      "tool",
    );
    const original = await panel.saveCheckpoint("Original");
    block = true;
    const deleting = panel.deleteCheckpoint(original.id);
    await waiting;
    const revision = panel.revision;
    const saving = panel.saveCheckpoint("While deleting");
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(writes, 1, "A second checkpoint write started before the first finished");
    await panel.render({ language: "mermaid", source: "flowchart LR\n B", title: "Later" }, "tool");
    block = false;
    release();
    await deleting;
    const saved = await saving;
    assert.strictEqual(saved.revision, revision);
    assert.strictEqual(panel.history.get(saved.id).state.title, "Original");
    const persisted = new DiagramHistory(values.get("diagram.checkpoints"));
    assert.deepStrictEqual(persisted.list(), panel.history.list());
    assert.strictEqual(persisted.list().length, 1);
  });

  test("persists loaded file data and restores it after restart without rereading the file", async () => {
    const values = new Map<string, unknown>();
    const first = await newFakePanel(values);
    await drawChart(
      first.panel,
      { type: "bar", file: "missing-checkpoint-data.csv" },
      "name,size\nA,1 KiB\nB,2 KiB",
    );
    const table = first.panel.loadedChartData;
    const saved = JSON.parse(
      await invokeTool(new CheckpointTool(first.panel), {
        action: "save",
        name: "Sizes",
        revision: first.panel.revision,
      }),
    );
    first.panel.dispose();
    const { panel } = await newFakePanel(values);
    assert.strictEqual(panel.loadedChartData, undefined);
    const restored = await invokeTool(new CheckpointTool(panel), {
      action: "restore",
      id: saved.id,
      revision: panel.revision,
    });
    assert.match(restored, /Restored checkpoint/);
    assert.deepStrictEqual(panel.loadedChartData, table);
    assert.strictEqual(panel.current?.chart?.file, "missing-checkpoint-data.csv");
    const update = await panel.updateChart({ title: "Reconfigured" }, cancellationSource().token);
    assert.ok(update.ok);
    assert.strictEqual(panel.current?.title, "Reconfigured");
  });

  test("restores a document checkpoint detached from Markdown and keeps evidence", async () => {
    const { panel, webview } = await newFakePanel();
    const source = "flowchart LR\n A --> B";
    const evidence = [{ id: "A", locations: [], assumptions: ["One request at a time"] }];
    await panel.render(
      {
        language: "mermaid",
        source,
        title: "Bound",
        evidence,
        document: {
          uri: "file:///missing/checkpoint.md",
          fence: { language: "mermaid", source, openingLine: 0, lastLine: 3, prefix: "" },
        },
      },
      "document",
    );
    const tool = new CheckpointTool(panel);
    const saved = JSON.parse(await invokeTool(tool, { action: "save", name: "Original" }));
    await panel.render(
      { language: "mermaid", source: "flowchart LR\n C --> D", title: "Replacement" },
      "tool",
    );
    const revision = panel.revision;
    assert.match(
      await invokeTool(tool, { action: "restore", id: saved.id, revision: revision - 1 }),
      /changed since revision/,
    );
    assert.strictEqual(panel.current?.title, "Replacement");
    assert.match(
      await invokeTool(tool, { action: "restore", id: saved.id, revision }),
      /detached from Markdown/,
    );
    assert.strictEqual(panel.current?.document, undefined);
    assert.strictEqual(webview.render.writeTo, undefined);
    assert.deepStrictEqual(panel.current?.evidence, evidence);
  });

  test("reports user edits and metadata changes since a captured revision", async () => {
    const { panel, webview } = await newFakePanel();
    await panel.render(
      { language: "mermaid", source: "flowchart LR\n A --> B", title: "Original" },
      "tool",
    );
    const revision = panel.revision;
    await webview.edit("flowchart LR\n A --> C");
    const report = JSON.parse(
      await invokeTool(new GetDiagramStateTool(panel), { sinceRevision: revision }),
    );
    assert.strictEqual(report.fromRevision, revision);
    assert.strictEqual(report.revision, panel.revision);
    assert.match(report.diff, /- A --> B\n\+ A --> C/);
    assert.deepStrictEqual(report.metadata.editedByUser, { before: false, after: true });
    assert.strictEqual(
      JSON.parse(
        await invokeTool(new GetDiagramStateTool(panel), {
          detail: "changes",
          sinceRevision: panel.revision,
        }),
      ).diff,
      "",
    );
    assert.match(
      await invokeTool(new GetDiagramStateTool(panel), { sinceRevision: 0 }),
      /no longer in session history/,
    );
    assert.throws(
      () => parseStateInput({ detail: "source", sinceRevision: revision }),
      /alone or with/,
    );
    assert.throws(() => parseStateInput({ detail: "changes" }), /sinceRevision/);
  });

  test("compares named alternatives and keeps checkpoints intact when persistence fails", async () => {
    const values = new Map<string, unknown>();
    const store = memento(values);
    let fail = false;
    const { panel } = await newFakePanel({
      ...store,
      update: async (key, value) => {
        if (fail && key === "diagram.checkpoints") throw new Error("No storage");
        await store.update(key, value);
      },
    });
    await panel.render(
      { language: "mermaid", source: "flowchart LR\n A --> B", title: "First" },
      "tool",
    );
    const tool = new CheckpointTool(panel);
    const first = JSON.parse(await invokeTool(tool, { action: "save", name: "First" }));
    await panel.render(
      { language: "mermaid", source: "flowchart LR\n A --> C", title: "Second" },
      "tool",
    );
    const second = JSON.parse(await invokeTool(tool, { action: "save", name: "Second" }));
    const compared = JSON.parse(
      await invokeTool(tool, { action: "compare", id: first.id, otherId: second.id }),
    );
    assert.deepStrictEqual(compared.metadata.title, { before: "First", after: "Second" });
    fail = true;
    assert.match(await invokeTool(tool, { action: "delete", id: first.id }), /No storage/);
    assert.match(await invokeTool(tool, { action: "save", name: "Failed save" }), /No storage/);
    assert.strictEqual(panel.history.list().length, 2);
    fail = false;
    assert.strictEqual(
      JSON.parse(await invokeTool(tool, { action: "delete", id: first.id })).deleted,
      first.id,
    );
    assert.strictEqual(panel.history.list().length, 1);
  });
});
