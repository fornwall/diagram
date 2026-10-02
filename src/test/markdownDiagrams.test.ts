import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { isDiagramFence } from "../fences";

/** Waits until a webview tab has this label, as tabs are updated asynchronously. */
async function webviewTab(label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const labels = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.input instanceof vscode.TabInputWebview)
      .map((tab) => tab.label);
    if (labels.includes(label)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`No webview tab is labelled "${label}"`);
}

suite("markdownDiagrams", function () {
  // Opening a diagram loads the panel's webview, which can take a while.
  this.timeout(30_000);

  let dir: string;

  suiteSetup(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "diagram-test-"));
    const extension = vscode.extensions.getExtension("fornwall.diagram");
    assert.ok(extension);
    await extension.activate();
  });

  suiteTeardown(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  function codeLenses(document: vscode.TextDocument): Thenable<vscode.CodeLens[]> {
    return vscode.commands.executeCommand<vscode.CodeLens[]>(
      "vscode.executeCodeLensProvider",
      document.uri,
    );
  }

  test("offers a lens for every diagram in a Markdown document", async () => {
    const document = await vscode.workspace.openTextDocument({
      language: "markdown",
      content: [
        "# Notes",
        "",
        "```mermaid",
        "flowchart TD",
        "  A --> B",
        "```",
        "",
        "```ts",
        "const x = 1;",
        "```",
        "",
        "```echarts",
        '{"series": []}',
        "```",
        "",
      ].join("\n"),
    });
    const lenses = await codeLenses(document);
    assert.deepStrictEqual(
      lenses.map((lens) => [lens.range.start.line, lens.command?.title]),
      [
        [2, "Open in Diagram"],
        [11, "Open in Diagram"],
      ],
    );
    // The command takes the document and the block, which reach it through VS Code.
    const command = lenses[0]?.command;
    assert.strictEqual(command?.command, "diagram.openFence");
    const [uri, fence] = command.arguments ?? [];
    assert.ok(uri instanceof vscode.Uri && uri.toString() === document.uri.toString());
    assert.ok(isDiagramFence(fence), JSON.stringify(fence));
    assert.strictEqual(fence.source, "flowchart TD\n  A --> B");
  });

  test("offers no lenses while the setting turns them off", async () => {
    const document = await vscode.workspace.openTextDocument({
      language: "markdown",
      content: "```mermaid\nflowchart TD\n```\n",
    });
    assert.strictEqual((await codeLenses(document)).length, 1);
    const settings = vscode.workspace.getConfiguration("diagram");
    await settings.update("codeLens.enabled", false, vscode.ConfigurationTarget.Global);
    try {
      assert.deepStrictEqual(await codeLenses(document), []);
    } finally {
      await settings.update("codeLens.enabled", undefined, vscode.ConfigurationTarget.Global);
    }
    assert.strictEqual((await codeLenses(document)).length, 1);
  });

  test("Open Diagram at Cursor shows the diagram, in a panel named after the file", async () => {
    const file = path.join(dir, "flow.md");
    fs.writeFileSync(file, "# Notes\n\n```mermaid\nflowchart TD\n  A --> B\n```\n");
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(4, 0, 4, 0);
    await vscode.commands.executeCommand("diagram.openAtCursor");
    await webviewTab("flowchart — flow.md");
    assert.ok(
      vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputWebview,
      "Opening a document diagram should focus its panel",
    );
  });

  test("a stale CodeLens does not open a different nearby diagram", async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const document = await vscode.workspace.openTextDocument({
      language: "markdown",
      content: "```mermaid\nflowchart TD\n```\n\n```mermaid\nsequenceDiagram\n```\n",
    });
    const command = (await codeLenses(document))[0]?.command;
    assert.ok(command);
    const edit = new vscode.WorkspaceEdit();
    // Leave the second diagram below the deleted block, as it could be in a live editor.
    edit.replace(document.uri, new vscode.Range(0, 0, 3, 0), "\n\n\n");
    assert.ok(await vscode.workspace.applyEdit(edit));
    await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
    const diagrams = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.input instanceof vscode.TabInputWebview);
    assert.deepStrictEqual(diagrams, []);
  });
});
