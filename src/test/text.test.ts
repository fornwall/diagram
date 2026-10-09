import * as assert from "node:assert";
import { quote } from "../text";

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
});
