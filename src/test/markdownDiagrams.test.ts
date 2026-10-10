import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { isDiagramFence } from "../fences";
import { registerMarkdownDiagrams } from "../markdownDiagrams";
import { afterTest, recordMessages, replace, suiteTempDir } from "./afterTest";
import { newFakePanel, newPanel, webviewTabs, within } from "./newPanel";

suite("markdownDiagrams", function () {
  // Opening a diagram loads the panel's webview, which can take a while.
  this.timeout(30_000);

  const dir = suiteTempDir("diagram-test-");

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension("fornwall.diagram");
    assert.ok(extension);
    await extension.activate();
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  function codeLenses(document: vscode.TextDocument): Thenable<vscode.CodeLens[]> {
    return vscode.commands.executeCommand<vscode.CodeLens[]>(
      "vscode.executeCodeLensProvider",
      document.uri,
    );
  }

  /** An untitled Markdown document holding the text. */
  const untitled = (content: string) =>
    vscode.workspace.openTextDocument({ language: "markdown", content });

  /** The command of the first lens in the document, which opens its first diagram. */
  async function firstLens(document: vscode.TextDocument): Promise<vscode.Command> {
    const command = (await codeLenses(document))[0]?.command;
    assert.ok(command);
    return command;
  }

  test("offers a lens for every diagram in a Markdown document", async () => {
    const document = await untitled(
      [
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
    );
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

  test("offers lenses in block quotes and list items, but not in indented code", async () => {
    const document = await untitled(
      [
        "    ```mermaid",
        "    flowchart TD",
        "    ```",
        "",
        "> [!TIP]",
        "> ```mermaid",
        "> flowchart TD",
        "> ```",
        "",
        "1. ```echarts",
        "   {}",
        "   ```",
      ].join("\n"),
    );
    const lenses = await codeLenses(document);
    assert.deepStrictEqual(
      lenses.map((lens) => lens.range.start.line),
      [5, 9],
    );
    assert.strictEqual(lenses[0]?.command?.arguments?.[1]?.source, "flowchart TD");
  });

  test("offers no lenses while the setting turns them off", async () => {
    const document = await untitled("```mermaid\nflowchart TD\n```\n");
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

  test("offers lenses where VS Code's preview draws Mermaid, following its setting", async () => {
    const document = await untitled("```mermaid\nA\n```\n```mmd\nB\n```\n");
    const lines = async () => (await codeLenses(document)).map((lens) => lens.range.start.line);
    assert.deepStrictEqual(await lines(), [0]);
    const settings = vscode.workspace.getConfiguration("markdown-mermaid");
    await settings.update("languages", ["mmd"], vscode.ConfigurationTarget.Global);
    try {
      assert.deepStrictEqual(await lines(), [3]);
    } finally {
      await settings.update("languages", undefined, vscode.ConfigurationTarget.Global);
    }
    assert.deepStrictEqual(await lines(), [0]);
  });

  test("Open Diagram at Cursor shows the diagram, in a panel named after the file", async () => {
    const file = path.join(dir, "flow.md");
    fs.writeFileSync(file, "# Notes\n\n```mermaid\nflowchart TD\n  A --> B\n```\n");
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(4, 0, 4, 0);
    await vscode.commands.executeCommand("diagram.openAtCursor");
    await webviewTabs((labels) => labels.includes("flowchart — flow.md"));
    assert.ok(
      vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputWebview,
      "Opening a document diagram should focus its panel",
    );
  });

  test("offers Open Diagram at Cursor in the context menu of an editor that holds a diagram", async () => {
    const execute = vscode.commands.executeCommand;
    let holds: unknown;
    replace(vscode.commands, "executeCommand", (async (command: string, ...args: unknown[]) => {
      if (command === "setContext" && args[0] === "diagram.editorHasDiagram") holds = args[1];
      return execute(command, ...args);
    }) as typeof execute);
    const show = async (language: string, content: string) => {
      const document = await vscode.workspace.openTextDocument({ language, content });
      await vscode.window.showTextDocument(document);
      return document;
    };
    await show("markdown", "```mermaid\nflowchart TD\n```\n");
    assert.ok(await within(() => holds === true));
    const notes = await show("markdown", "# Notes\n");
    assert.ok(await within(() => holds === false));
    const edit = new vscode.WorkspaceEdit();
    edit.insert(notes.uri, new vscode.Position(1, 0), "\n```echarts\n{}\n```\n");
    assert.ok(await vscode.workspace.applyEdit(edit));
    assert.ok(await within(() => holds === true));
    await show("plaintext", "```mermaid\nflowchart TD\n```\n");
    assert.ok(await within(() => holds === false));
    const extension = vscode.extensions.getExtension("fornwall.diagram");
    assert.ok(extension);
    const menu: { command: string; when: string }[] =
      extension.packageJSON.contributes.menus["editor/context"];
    assert.strictEqual(
      menu.find(({ command }) => command === "diagram.openAtCursor")?.when,
      "editorLangId == markdown && diagram.editorHasDiagram",
    );
  });

  test("Open Diagram at Cursor says why there is nothing to open", async () => {
    const messages = recordMessages("showInformationMessage");
    for (const [language, content] of [
      ["plaintext", "```mermaid\nflowchart TD\n```\n"],
      ["markdown", "# Notes\n\n```ts\nconst x = 1;\n```\n"],
      // At the cursor, rather than the diagram below.
      ["markdown", "```echarts\n\n```\n```mermaid\nA\n```\n"],
    ] as const) {
      const document = await vscode.workspace.openTextDocument({ language, content });
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand("diagram.openAtCursor");
    }
    assert.strictEqual(messages.length, 3);
    assert.strictEqual(
      messages[2],
      "The echarts block at line 1 is empty. Write a chart in it to open it.",
    );
    assert.strictEqual(
      messages[0],
      "Open a Markdown file to open a diagram or chart that is written in it.",
    );
    assert.match(
      messages[1] ?? "",
      /^Untitled-\d+ holds no mermaid or echarts code block to open\.$/,
    );
  });

  test("a stale CodeLens does not open a different diagram", async () => {
    const warnings = recordMessages("showWarningMessage");
    // Below the deleted block, or moved onto its line, which an edit of it cannot do.
    for (const [second, inserted] of [
      ["```mermaid\nsequenceDiagram\n```\n", "\n\n\n"],
      ["```echarts\n{}\n```\n", ""],
    ] as const) {
      const document = await untitled(`\`\`\`mermaid\nflowchart TD\n\`\`\`\n\n${second}`);
      const command = await firstLens(document);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, new vscode.Range(0, 0, 4, 0), inserted);
      assert.ok(await vscode.workspace.applyEdit(edit));
      await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
      assert.strictEqual(warnings.length, 1);
      assert.match(
        warnings.pop() ?? "",
        /^The mermaid block that was at line 1 of Untitled-\d+ moved or was removed\. If it is still there, use the Open in Diagram action above it\.$/,
      );
    }
  });

  test("a CodeLens of a file that no longer exists says why it cannot open it", async () => {
    const document = await untitled("```mermaid\nflowchart TD\n```\n");
    const command = await firstLens(document);
    const file = path.join(dir, "deleted.md");
    const errors = recordMessages("showErrorMessage");
    await vscode.commands.executeCommand(
      command.command,
      vscode.Uri.file(file),
      command.arguments?.[1],
    );
    assert.strictEqual(errors.length, 1);
    assert.match(
      errors[0] ?? "",
      /^Could not open the diagram: \/\S+\/deleted\.md does not exist\.$/,
    );
  });

  test("opening a diagram reports when the panel cannot display it", async () => {
    const document = await untitled("```mermaid\nflowchart TD\n```\n");
    const command = await firstLens(document);
    const panel = newPanel();
    afterTest(() => panel.dispose());
    const reason = "The diagram panel did not respond within 15 seconds.";
    panel.render = async () => ({ ok: false, kind: "unavailable", error: reason, revision: 1 });
    // Registered under other names than the extension's own.
    const register = vscode.commands.registerCommand;
    replace(vscode.commands, "registerCommand", (name, callback, thisArg) =>
      register(`test.${name}`, callback, thisArg),
    );
    const registrations = registerMarkdownDiagrams(panel);
    afterTest(() => vscode.Disposable.from(...registrations).dispose());
    const warnings = recordMessages("showWarningMessage");
    await vscode.commands.executeCommand(`test.${command.command}`, ...(command.arguments ?? []));
    assert.deepStrictEqual(warnings, [reason]);
  });

  test("opens a diagram of a read-only document to view, not to write to", async () => {
    const content = new TextEncoder().encode("```mermaid\nflowchart TD\n```\n");
    const provider: vscode.FileSystemProvider = {
      onDidChangeFile: new vscode.EventEmitter<vscode.FileChangeEvent[]>().event,
      watch: () => new vscode.Disposable(() => {}),
      stat: async () => ({ type: vscode.FileType.File, ctime: 0, mtime: 0, size: content.length }),
      readDirectory: async () => [],
      createDirectory: () => {},
      readFile: async () => content,
      writeFile: () => {},
      delete: () => {},
      rename: () => {},
    };
    const registration = vscode.workspace.registerFileSystemProvider(
      "diagram-test-readonly",
      provider,
      { isReadonly: true },
    );
    afterTest(() => registration.dispose());
    const included = path.join(dir, "included.md");
    fs.writeFileSync(included, "```echarts\n{}\n```\n");
    const files = vscode.workspace.getConfiguration("files");
    await files.update(
      "readonlyInclude",
      { "**/included.md": true },
      vscode.ConfigurationTarget.Global,
    );
    afterTest(() => files.update("readonlyInclude", undefined, vscode.ConfigurationTarget.Global));
    const { panel } = await newFakePanel();
    const register = vscode.commands.registerCommand;
    replace(vscode.commands, "registerCommand", (name, callback, thisArg) =>
      register(`test.${name}`, callback, thisArg),
    );
    const registrations = registerMarkdownDiagrams(panel);
    afterTest(() => vscode.Disposable.from(...registrations).dispose());
    const messages = recordMessages("showInformationMessage");
    const open = async (document: vscode.TextDocument) => {
      const { command, arguments: args = [] } = await firstLens(document);
      await vscode.commands.executeCommand(`test.${command}`, ...args);
    };
    // A diagram of a writable document first, whose binding a read-only one must not take over.
    await open(await untitled("```mermaid\nflowchart LR\n```\n"));
    assert.ok(panel.current?.document);
    await open(
      await vscode.workspace.openTextDocument(vscode.Uri.parse("diagram-test-readonly:/git.md")),
    );
    assert.strictEqual(panel.current?.source, "flowchart TD");
    assert.strictEqual(panel.current?.document, undefined);
    await open(await vscode.workspace.openTextDocument(vscode.Uri.file(included)));
    assert.strictEqual(panel.current?.language, "echarts");
    assert.strictEqual(panel.current?.document, undefined);
    // Which it is exported beside.
    assert.strictEqual(panel.current?.openedFrom, vscode.Uri.file(included).toString());
    assert.deepStrictEqual(messages, [
      "/git.md is read-only, so edits of the diagram in the panel are not written to it.",
      `${vscode.workspace.asRelativePath(included)} is read-only, so edits of the chart in the panel are not written to it.`,
    ]);
  });
});
