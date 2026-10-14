import * as assert from "node:assert";
import { editDistance, quote } from "../text";

suite("text", () => {
  test("quotes text, shortened without splitting a character", () => {
    for (const [text, quoted] of [
      ["Parser", '"Parser"'],
      ['say "hi"', '"say \\"hi\\""'],
      [`${"a".repeat(40)}b`, `"${"a".repeat(40)}…"`],
      [`${"a".repeat(39)}📊 sales`, `"${"a".repeat(39)}…"`],
      [`${"a".repeat(38)}📊 sales`, `"${"a".repeat(38)}📊…"`],
    ] as const) {
      assert.strictEqual(quote(text), quoted);
    }
  });

  test("counts the letters to add, remove or replace, or pairs of them to swap, between words", () => {
    for (const [a, b, edits] of [
      ["title", "title", 0],
      ["", "pie", 3],
      ["flowchrt", "flowchart", 1],
      ["serie", "series", 1],
      ["titel", "title", 1],
      ["pei", "pie", 1],
      ["kitten", "sitting", 3],
      ["ca", "abc", 3],
    ] as const) {
      assert.strictEqual(editDistance(a, b), edits, `${a} → ${b}`);
      assert.strictEqual(editDistance(b, a), edits, `${b} → ${a}`);
    }
  });
});
