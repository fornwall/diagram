import * as assert from "node:assert";
import { RepairableMermaidError, renderWithRecovery } from "../webview/mermaidRecovery";

suite("Mermaid recovery", () => {
  const repair = { source: 'flowchart LR\nA["Call foo(x)"]', description: "Quoted A's label." };
  const original = new RepairableMermaidError("Parse error on line 2", repair);

  test("retries once and keeps the original diagnostic if the correction also fails", async () => {
    const sources: string[] = [];
    await assert.rejects(
      renderWithRecovery(
        "original",
        async (source) => {
          sources.push(source);
          throw original;
        },
        true,
      ),
      /Parse error on line 2\n\nAutomatic repair failed; kept the original source/,
    );
    assert.deepStrictEqual(sources, ["original", repair.source]);
  });

  test("does not retry other failures or repairs that were not requested", async () => {
    for (const [error, enabled] of [
      [new Error("Renderer unavailable"), true],
      [original, false],
    ] as const) {
      let attempts = 0;
      await assert.rejects(
        renderWithRecovery(
          "original",
          async () => {
            attempts++;
            throw error;
          },
          enabled,
        ),
        (caught) => caught === error,
      );
      assert.strictEqual(attempts, 1);
    }
  });
});
