import * as assert from "node:assert";
import { isFromWebview, safeFileName } from "../protocol";

suite("protocol", () => {
  test("takes only well-formed messages as messages from the page", () => {
    assert.ok(isFromWebview({ type: "ready" }));
    assert.ok(isFromWebview({ type: "warningsChanged", requestId: 2, warnings: ["Too wide"] }));
    const rendered = { type: "rendered", requestId: 2, diagramType: "flowchart-v2" };
    assert.ok(
      isFromWebview({
        ...rendered,
        repair: { source: 'graph LR; A["foo(x)"]', description: "Quoted A" },
      }),
    );
    const malformed = [
      null,
      "ready",
      [{ type: "ready" }],
      { type: "toString" },
      { type: "selectionChanged", nodes: [{ id: "A" }] },
      { type: "ask", nodes: [] },
      { type: "warningsChanged", requestId: 2 },
      { type: "warningsChanged", requestId: 2, warnings: [1] },
      { ...rendered, repair: {} },
      { ...rendered, repair: { source: 1, description: "Quoted A" } },
      { ...rendered, repair: { source: "graph LR", description: false } },
    ];
    for (const message of malformed) {
      assert.ok(!isFromWebview(message), JSON.stringify(message));
    }
  });

  test("names a file after a title, without what file names cannot hold", () => {
    assert.strictEqual(safeFileName("Login flow", "diagram"), "Login flow");
    assert.strictEqual(safeFileName(' OAuth: "step 1/2"? ', "diagram"), "OAuth step 1 2");
    assert.strictEqual(safeFileName("Disk usage of /tmp/*", "chart"), "Disk usage of tmp");
    // Windows keeps neither trailing dots nor trailing spaces.
    assert.strictEqual(safeFileName("Release 2026.", "diagram"), "Release 2026");
    // Format characters are not kept either, invisible as they are.
    assert.strictEqual(safeFileName("a b\u200e", "diagram"), "a b");
    // A title of nothing usable falls back to what the caller names its files.
    assert.strictEqual(safeFileName("   ", "diagram"), "diagram");
    assert.strictEqual(safeFileName("...", "chart"), "chart");
    assert.ok(safeFileName("Long ".repeat(100), "diagram").length <= 80);
  });

  test("cuts a long title short without splitting a character", () => {
    const prefix = "a".repeat(79);
    const name = safeFileName(`${prefix}📊 Results`, "chart");
    assert.strictEqual(name, prefix);
    assert.doesNotThrow(() => encodeURIComponent(name));
    assert.strictEqual(safeFileName("📊".repeat(50), "chart"), "📊".repeat(40));
  });

  test("avoids Windows device names, including names with extensions", () => {
    for (const name of ["CON", "prn", "AUX", "NUL", "COM1", "LPT9", "COM¹", "LPT²", "COM³"]) {
      assert.strictEqual(safeFileName(name, "diagram"), `_${name}`);
      assert.strictEqual(safeFileName(`${name}.notes`, "diagram"), `_${name}.notes`);
    }
    assert.strictEqual(safeFileName("CON .notes", "diagram"), "_CON .notes");
    for (const name of ["Console", "COM10", "LPT0", "AUX chart"]) {
      assert.strictEqual(safeFileName(name, "diagram"), name);
    }
    assert.ok(safeFileName(`CON.${"a".repeat(100)}`, "diagram").length <= 80);
    for (const trailing of [".", " "]) {
      assert.strictEqual(
        safeFileName(`CON.${"a".repeat(74)}${trailing}x`, "diagram"),
        `_CON.${"a".repeat(74)}`,
      );
    }
  });
});
