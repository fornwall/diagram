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
  return new StateStore(memento(async () => {}, saved)).load()?.state;
}

suite("panelState", () => {
  test("unchanged saves share pending writes, retry failures and persist rollbacks", async () => {
    const warnings = recordMessages("showWarningMessage");
    const pending = Promise.withResolvers<void>();
    let writes = 0;
    const store = new StateStore(
      memento(() => (++writes === 1 ? pending.promise : Promise.resolve())),
    );
    const saving = store.save(state, 1);
    assert.strictEqual(store.save(state, 1), saving);
    assert.strictEqual(writes, 1);
    pending.reject(new Error("Storage is unavailable"));
    await saving;
    assert.match(warnings[0] ?? "", /Storage is unavailable/);
    await store.save(state, 1);
    assert.strictEqual(writes, 2, "retry unchanged state after failed persistence");
    await store.save(state, 1);
    assert.strictEqual(writes, 2);
    await store.save({ ...state, title: "Replacement" }, 1);
    await store.save(state, 1);
    assert.strictEqual(writes, 4, "rolling back a previously saved state must write it again");
    assert.strictEqual(warnings.length, 1);
  });

  test("saves the source once, without the user's edit that it is, and no edit that it is not", async () => {
    const saved: unknown[] = [];
    const store = new StateStore(memento(async (value) => void saved.push(value)));
    const from = "flowchart LR\n  A";
    await store.save({ ...state, userEdit: { from, to: state.source ?? "" } }, 1);
    await store.save({ ...state, userEdit: { from, to: "flowchart TD" } }, 2);
    assert.deepStrictEqual(saved, [
      { ...state, userEdit: { from }, revision: 1 },
      { ...state, revision: 2 },
    ]);
  });

  test("restored state needs no save until changed, also in its revision", async () => {
    const saved: unknown[] = [];
    const store = new StateStore(memento(async (value) => void saved.push(value), state));
    // Older versions saved no revision.
    const loaded = store.load();
    assert.deepStrictEqual(loaded, { state, revision: 0 });
    if (loaded) await store.save(loaded.state, 0);
    assert.strictEqual(saved.length, 0);
    if (loaded) await store.save(loaded.state, 3);
    assert.deepStrictEqual(saved, [{ ...state, revision: 3 }]);
    assert.deepStrictEqual(new StateStore(memento(async () => {}, saved[0])).load(), {
      state,
      revision: 3,
    });
    for (const revision of [-1, 1.5, "3", null]) {
      const restored = new StateStore(memento(async () => {}, { ...state, revision })).load();
      assert.deepStrictEqual(restored, { state, revision: 0 }, String(revision));
    }
  });

  test("restores the states that older versions saved, leaving out what is no longer used", () => {
    // The first versions drew only Mermaid, and saved no language.
    const { language: _, ...first } = state;
    assert.deepStrictEqual(load(first), state);
    assert.deepStrictEqual(load({ ...state, origin: "participant" }), state);
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
    // The user's edit is the source, which is saved once, without it.
    assert.deepStrictEqual(load({ ...state, userEdit: { from: userEdit.from } }), {
      ...state,
      userEdit,
    });
    // An edit that the source no longer is, which older versions saved, tells nothing.
    assert.deepStrictEqual(
      load({ ...state, userEdit: { ...userEdit, to: "flowchart TD" } }),
      state,
    );
    // Charts were saved with what they were generated from, which is no longer used.
    const chartState = { ...state, language: "echarts", source: '{"series": []}' };
    const chart = { type: "pie", file: "sizes.tsv" };
    const chartPresentation = { baseline: {}, dataHash: "x", edits: [] };
    assert.deepStrictEqual(load({ ...chartState, chart, chartPresentation }), chartState);
  });

  test("drops malformed saved document URIs without losing the diagram", () => {
    const fence = {
      language: "mermaid",
      source: state.source,
      openingLine: 0,
      lastLine: 2,
      prefix: "",
    };
    for (const uri of ["", "notes.md", "invalid scheme:/notes.md", 1]) {
      assert.deepStrictEqual(
        load({ ...state, document: { uri, fence }, openedFrom: uri }),
        state,
        String(uri),
      );
    }
    const uri = "vscode-remote://ssh-remote+host/workspace/notes.md";
    assert.deepStrictEqual(load({ ...state, document: { uri, fence }, openedFrom: uri }), {
      ...state,
      document: { uri, fence },
      openedFrom: uri,
    });
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
});
