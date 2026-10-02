import * as assert from "node:assert";
import { safeFileName } from "../protocol";

suite("file names", () => {
  test("names a file after a title, without what file names cannot hold", () => {
    assert.strictEqual(safeFileName("Login flow", "diagram"), "Login flow");
    assert.strictEqual(safeFileName(' OAuth: "step 1/2"? ', "diagram"), "OAuth step 1 2");
    // Windows keeps neither trailing dots nor trailing spaces.
    assert.strictEqual(safeFileName("Release 2026.", "diagram"), "Release 2026");
    // Format characters are not kept either, invisible as they are.
    assert.strictEqual(safeFileName("a b\u200e", "diagram"), "a b");
    // A title of nothing usable falls back to what the caller names its files.
    assert.strictEqual(safeFileName("   ", "diagram"), "diagram");
    assert.strictEqual(safeFileName("...", "chart"), "chart");
    assert.ok(safeFileName("Long ".repeat(100), "diagram").length <= 80);
  });
});
