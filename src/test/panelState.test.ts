import * as assert from "node:assert";
import type * as vscode from "vscode";
import type { DiagramState } from "../panel";
import { StateStore } from "../panelState";
import { recordMessages } from "./afterTest";

const state: DiagramState = {
  language: "mermaid",
  source: "flowchart LR\n  A --> B",
  title: "Flow",
  origin: "tool",
  editedByUser: false,
};

function memento(update: (value: unknown) => Thenable<void>, saved?: unknown) {
  return {
    keys: () => [],
    get: () => saved,
    update: (_key: string, value: unknown) => update(value),
  } as unknown as vscode.Memento;
}

function load(saved: unknown): DiagramState | undefined {
  return new StateStore(memento(async () => {}, saved)).load();
}

suite("panelState", () => {
  test("unchanged saves share pending writes, retry failures and persist rollbacks", async () => {
    const warnings = recordMessages("showWarningMessage");
    const pending = Promise.withResolvers<void>();
    let writes = 0;
    const store = new StateStore(
      memento(() => (++writes === 1 ? pending.promise : Promise.resolve())),
    );
    const saving = store.save(state);
    assert.strictEqual(store.save(state), saving);
    assert.strictEqual(writes, 1);
    pending.reject(new Error("Storage is unavailable"));
    await saving;
    assert.match(warnings[0] ?? "", /Storage is unavailable/);
    await store.save(state);
    assert.strictEqual(writes, 2, "retry unchanged state after failed persistence");
    await store.save(state);
    assert.strictEqual(writes, 2);
    await store.save({ ...state, title: "Replacement" });
    await store.save(state);
    assert.strictEqual(writes, 4, "rolling back a previously saved state must write it again");
    assert.strictEqual(warnings.length, 1);
  });

  test("restored state needs no save until changed", async () => {
    let writes = 0;
    const store = new StateStore(memento(async () => void writes++, state));
    const loaded = store.load();
    assert.deepStrictEqual(loaded, state);
    if (loaded) await store.save(loaded);
    assert.strictEqual(writes, 0);
  });

  test("restores the states that older versions saved, leaving out what is no longer used", () => {
    // The first versions drew only Mermaid, and saved no language.
    const { language: _, ...first } = state;
    assert.deepStrictEqual(load(first), state);
    // Fences were saved with an indentation where they now have a prefix.
    const fence = { language: "mermaid", source: state.source, openingLine: 2, lastLine: 4 };
    assert.deepStrictEqual(
      load({ ...state, document: { uri: "file:///a.md", fence: { ...fence, indent: "" } } }),
      state,
    );
    const document = { uri: "file:///a.md", fence: { ...fence, prefix: "" } };
    assert.deepStrictEqual(load({ ...state, document }), { ...state, document });
    const openedFrom = "file:///read-only.md";
    assert.deepStrictEqual(load({ ...state, openedFrom }), { ...state, openedFrom });
    assert.deepStrictEqual(load({ ...state, openedFrom: 1 }), state);
    const userEdit = { from: "flowchart LR\n  A", to: state.source };
    assert.deepStrictEqual(load({ ...state, userEdit }), { ...state, userEdit });
    assert.deepStrictEqual(load({ ...state, userEdit: { from: 1, to: "" } }), state);
    // Charts were saved without the presentation that tells manual styling apart, which a
    // refresh would discard, so the option is kept without the chart it was generated from.
    const chartState = { ...state, language: "echarts", source: '{"series": []}' };
    const chart = { type: "pie", file: "sizes.tsv" };
    assert.deepStrictEqual(load({ ...chartState, chart }), chartState);
    const chartPresentation = { baseline: {}, dataHash: "x", edits: [] };
    assert.deepStrictEqual(load({ ...chartState, chart, chartPresentation }), {
      ...chartState,
      chart,
      chartPresentation,
    });
  });

  test("restores what is valid of a damaged state, and nothing when there is nothing to show", () => {
    const { source: _, ...withoutSource } = { ...state, language: "echarts" };
    for (const saved of [
      "flowchart LR",
      [state],
      { ...state, title: 1 },
      { ...state, language: "graphviz" },
      { ...state, source: 1 },
      // A chart saved without its option can only be drawn again from its file or command.
      { ...withoutSource, chart: { type: "pie", data: "a,1" } },
      { ...withoutSource, chart: { type: "cake", file: "a" } },
    ]) {
      assert.strictEqual(load(saved), undefined, JSON.stringify(saved));
    }
    assert.deepStrictEqual(
      load({
        ...state,
        origin: "agent",
        editedByUser: "yes",
        error: 1,
        clickPrompt: null,
        links: { A: { file: "a.ts", line: "1" } },
        document: { uri: "file:///a.md", fence: { openingLine: -1 } },
        chart: { type: "pie", file: "sizes.tsv" },
      }),
      state,
    );
    const chart = { type: "pie", file: "sizes.tsv" };
    // Edits of properties that capturing refuses, such as "__proto__", which assigning would
    // set the prototype by rather than styling the chart.
    for (const edits of [[{}], [{ path: [] }], [{ path: [{}] }], [{ path: ["__proto__", "x"] }]]) {
      const chartPresentation = { baseline: {}, dataHash: "x", edits };
      assert.deepStrictEqual(load({ ...withoutSource, chart, chartPresentation }), {
        ...withoutSource,
        chart,
      });
    }
  });

  test("discards saved links with invalid line ranges or empty paths", () => {
    for (const link of [
      { file: " " },
      { file: "a.ts", line: 0 },
      { file: "a.ts", line: -1 },
      { file: "a.ts", line: 10_000_000 },
      { file: "a.ts", line: 2, endLine: 1 },
      { file: "a.ts", endLine: 1 },
    ]) {
      assert.deepStrictEqual(load({ ...state, links: { A: link } }), state);
    }
    const links = { A: { file: "a.ts", line: 1, endLine: 9_999_999 } };
    assert.deepStrictEqual(load({ ...state, links }), { ...state, links });
  });

  test("a large chart of a file is saved without its option, unless edited by hand", async () => {
    const saved: unknown[] = [];
    const store = new StateStore(memento(async (value) => void saved.push(value)));
    const chart: DiagramState = {
      language: "echarts",
      source: `{"series":[]}${" ".repeat(1_000_000)}`,
      title: "Sizes",
      chart: { type: "pie", file: "sizes.tsv" },
      origin: "tool",
      editedByUser: false,
      error: "stale",
    };
    await store.save(chart);
    await store.save({ ...chart, editedByUser: true });
    await store.save({ ...chart, chart: { type: "pie", data: "a,1" } });
    assert.deepStrictEqual(
      saved.map((value) => (value as DiagramState).source === undefined),
      [true, false, false],
    );
    assert.strictEqual((saved[0] as DiagramState).error, undefined);
  });

  test("saves the source of a diagram that its document's block holds once", async () => {
    const saved: unknown[] = [];
    const store = new StateStore(memento(async (value) => void saved.push(value)));
    const source = "flowchart LR\n  A --> B";
    const fence = { language: "mermaid", source, openingLine: 2, lastLine: 4, prefix: "" } as const;
    const document = { uri: "file:///a.md", fence };
    await store.save({ ...state, source, document });
    // An edit that the block does not hold yet.
    const edited: DiagramState = { ...state, source: "flowchart TD", editedByUser: true, document };
    await store.save(edited);
    const [once, twice] = saved as DiagramState[];
    assert.strictEqual(once?.document?.fence.source, undefined);
    assert.strictEqual(twice?.document?.fence.source, state.source);
    assert.deepStrictEqual(load(once), { ...state, document });
    assert.deepStrictEqual(load(twice), edited);
    // Without the diagram's source either, the binding is left out.
    const chart = { type: "pie", file: "a" };
    const restored = load({ ...once, language: "echarts", source: undefined, chart });
    assert.deepStrictEqual(restored?.chart, chart);
    assert.strictEqual(restored?.document, undefined);
  });
});
