import * as assert from "node:assert";
import { parseTable } from "../data";
import { Datasets, datasets } from "../datasets";

suite("datasets", () => {
  const spec = { type: "bar" as const, data: "name,bytes\na,2 KiB" };

  test("keeps parsed units and isolates snapshots from callers", () => {
    const cache = new Datasets();
    const table = parseTable(spec.data);
    const snapshot = cache.save(table, spec);
    assert.ok(snapshot);
    assert.ok(table.rows[0]);
    table.rows[0][1] = 99;
    assert.strictEqual(cache.get(snapshot.id).table.rows[0]?.[1], 2048);
    assert.strictEqual(cache.get(snapshot.id).table.columns[1]?.unit, "bytes");
    assert.strictEqual(cache.get(snapshot.id).source.data, spec.data);
  });

  test("evicts oldest snapshots and keeps sessions separate", () => {
    const owner = {};
    const cache = datasets(owner);
    const first = cache.save(parseTable(spec.data), spec);
    assert.ok(first);
    assert.strictEqual(datasets(owner), cache);
    assert.throws(() => datasets({}).get(first.id), /expired datasetId/);
    for (let i = 0; i < 8; i++) cache.save(parseTable(spec.data), spec);
    assert.throws(() => cache.get(first.id), /expired datasetId/);
    assert.throws(() => cache.get(""), /nonempty snapshot id/);
  });

  test("bounds total bytes and leaves existing snapshots intact for oversized data", () => {
    const cache = new Datasets();
    const large = {
      columns: [{ name: "text", numeric: false }],
      rows: [["a".repeat(9 * 1024 * 1024)]],
      header: true,
    };
    const source = { type: "bar" as const, file: "data.csv" };
    const first = cache.save(large, source);
    const second = cache.save(large, source);
    assert.ok(first && second);
    assert.throws(() => cache.get(first.id), /expired datasetId/);
    assert.strictEqual(cache.get(second.id), second);
    assert.strictEqual(
      cache.save({ ...large, rows: [...large.rows, ...large.rows] }, source),
      undefined,
    );
    assert.strictEqual(cache.get(second.id), second);
  });
});
