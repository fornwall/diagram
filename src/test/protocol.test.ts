import * as assert from "node:assert";
import { isFromWebview, safeFileName } from "../protocol";
import { testColors } from "./themeColors";

suite("protocol", () => {
  test("takes only well-formed messages as messages from the page", () => {
    assert.ok(isFromWebview({ type: "ready" }));
    assert.ok(isFromWebview({ type: "picked", pickId: 3, nodes: [{ id: "A", label: "Parser" }] }));
    assert.ok(isFromWebview({ type: "exportTheme", requestId: 1, colors: testColors }));
    assert.ok(isFromWebview({ type: "warningsChanged", requestId: 2, warnings: ["Too wide"] }));
    const options = { type: "applyChartOptions", revision: 1, controls: { type: "bar" } };
    assert.ok(isFromWebview({ ...options, replaceSource: false }));
    // Without controls, a reset of the chart's styling.
    assert.ok(isFromWebview({ type: "applyChartOptions", revision: 1, replaceSource: true }));
    const malformed = [
      null,
      "ready",
      [{ type: "ready" }],
      { type: "toString" },
      { type: "picked", pickId: "3", nodes: [] },
      { type: "selectionChanged", nodes: [{ id: "A" }] },
      { type: "ask", nodes: [] },
      { type: "exportTheme", requestId: 1 },
      { type: "warningsChanged", requestId: 2 },
      { type: "warningsChanged", requestId: 2, warnings: [1] },
      // A saved chart needs every color to draw in.
      { type: "exportTheme", requestId: 1, colors: { ...testColors, palette: [] } },
      { type: "exportTheme", requestId: 1, colors: { ...testColors, focus: { r: 0, g: 0, b: 0 } } },
      { type: "exportTheme", requestId: 1, colors: { ...testColors, fontSize: Number.NaN } },
      // Replacing a chart's source takes an explicit choice, for the revision it was made for.
      options,
      { ...options, replaceSource: "true" },
      { ...options, replaceSource: false, revision: "1" },
      { ...options, replaceSource: false, controls: [] },
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
