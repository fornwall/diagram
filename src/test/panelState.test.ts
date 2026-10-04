import * as assert from "node:assert";
import * as vscode from "vscode";
import type { DiagramState } from "../panel";
import { StateStore } from "../panelState";

const state: DiagramState = {
  language: "mermaid",
  source: "flowchart LR\n  A --> B",
  title: "Flow",
  origin: "tool",
  editedByUser: false,
};

function memento(update: (value: unknown) => Thenable<void>, saved?: DiagramState) {
  return {
    keys: () => [],
    get: () => saved,
    update: (_key: string, value: unknown) => update(value),
  } as unknown as vscode.Memento;
}

suite("panelState", () => {
  test("unchanged saves share pending writes, retry failures and persist rollbacks", async () => {
    const warning = vscode.window.showWarningMessage;
    const warnings: string[] = [];
    vscode.window.showWarningMessage = async (message: string) => void warnings.push(message);
    const pending = Promise.withResolvers<void>();
    let writes = 0;
    const store = new StateStore(
      memento(() => (++writes === 1 ? pending.promise : Promise.resolve())),
    );
    try {
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
    } finally {
      vscode.window.showWarningMessage = warning;
    }
  });

  test("restored state needs no save until changed", async () => {
    let writes = 0;
    const store = new StateStore(memento(async () => void writes++, state));
    const loaded = store.load();
    assert.deepStrictEqual(loaded, state);
    if (loaded) await store.save(loaded);
    assert.strictEqual(writes, 0);
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
});
