import * as assert from "node:assert";
import * as vscode from "vscode";
import { checkedRevision, fitsToolResult, fitWholeRecords } from "../toolContracts";
import { cancellationSource } from "./afterTest";

suite("tool contracts", () => {
  test("keeps continuation positions on whole records under a small budget", async () => {
    const items = Array.from({ length: 20 }, (_, index) => ({ id: `item-${index + 1}` }));
    const token = cancellationSource().token;
    const result = await fitWholeRecords(
      1,
      items.length,
      (count) => JSON.stringify({ items: items.slice(0, count), nextItem: count + 1 }),
      (text) =>
        fitsToolResult(text, { tokenBudget: 100, countTokens: async (text) => text.length }, token),
    );
    assert.ok(result);
    const page = JSON.parse(result);
    assert.ok(page.items.length > 0 && page.items.length < items.length);
    assert.strictEqual(page.nextItem, page.items.length + 1);
    assert.ok(result.length <= 100);
  });

  test("rejects stale or malformed revisions and cancellation during token counting", async () => {
    assert.strictEqual(checkedRevision(undefined, 3), 3);
    assert.throws(() => checkedRevision(2, 3), /changed since revision 2/);
    assert.throws(() => checkedRevision("3", 3), /nonnegative integer/);
    const cancellation = cancellationSource();
    await assert.rejects(
      fitsToolResult(
        "result",
        {
          tokenBudget: 100,
          countTokens: async () => {
            cancellation.cancel();
            return 1;
          },
        },
        cancellation.token,
      ),
      vscode.CancellationError,
    );
  });
});
