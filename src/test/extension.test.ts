import * as assert from "node:assert";
import * as vscode from "vscode";

suite("Extension", () => {
  test("activates", async () => {
    const extension = vscode.extensions.getExtension("fornwall.diagram");
    assert.ok(extension);
    await extension.activate();
    assert.ok(extension.isActive);
  });
});
