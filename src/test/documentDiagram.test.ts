import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { type DocumentBinding, writeFence } from "../documentDiagram";
import { findDiagramFences } from "../fences";
import type { DiagramState } from "../panel";
import { afterTest, recordMessages, replace, suiteTempDir } from "./afterTest";
import { type FakeWebview, newFakePanel } from "./newPanel";

suite("documentDiagram", function () {
  // A panel that an agent renders in loads the webview, which can take a while.
  this.timeout(10_000);

  const dir = suiteTempDir("diagram-test-");
  let files = 0;

  /** A Markdown file holding exactly this text, opened as the panel opens a diagram's document. */
  async function markdown(content: string): Promise<vscode.TextDocument> {
    const file = path.join(dir, `notes-${files++}.md`);
    fs.writeFileSync(file, content);
    return vscode.workspace.openTextDocument(vscode.Uri.file(file));
  }

  /** What the panel remembers about the first diagram in a document, as opening it does. */
  function binding(document: vscode.TextDocument): DocumentBinding {
    const [fence] = findDiagramFences(document.getText());
    assert.ok(fence);
    return { uri: document.uri.toString(), fence };
  }

  /** Changes a document behind the panel's back, as the user may in the editor. */
  async function edit(
    document: vscode.TextDocument,
    range: vscode.Range,
    text: string,
  ): Promise<void> {
    const change = new vscode.WorkspaceEdit();
    change.replace(document.uri, range, text);
    assert.ok(await vscode.workspace.applyEdit(change));
  }

  /** A diagram shown in the panel that was opened from a document. */
  function openedState(read: DocumentBinding): DiagramState & { source: string } {
    return {
      language: read.fence.language,
      source: read.fence.source,
      title: "Flow",
      origin: "document",
      editedByUser: false,
      document: read,
    };
  }

  /** A panel showing the diagram, saved as it was when VS Code closed. */
  function restored(state: DiagramState) {
    return newFakePanel(new Map<string, unknown>([["diagram.state", state]]));
  }

  /** What the panel's Write button posts, for a diagram the user has not edited. */
  function writeShown(webview: FakeWebview): Promise<void> {
    return webview.receive({ type: "writeToDocument", requestId: webview.render.requestId });
  }

  /** Answers renders of "flowchart ??" with a parse error, as Mermaid does. */
  function failingUnknown(webview: FakeWebview): void {
    webview.answer = (message) =>
      message.type !== "render"
        ? undefined
        : message.source === "flowchart ??"
          ? { type: "renderError", requestId: message.requestId, message: "Parse error" }
          : { type: "rendered", requestId: message.requestId, diagramType: "flowchart" };
  }

  test("writes a diagram back keeping the fence markers and their indentation", async () => {
    const document = await markdown(
      "# Notes\n\n- The flow:\n\n  ````mermaid\n  flowchart TD\n    A --> B\n  ````\n\nAfter.\n",
    );
    const read = binding(document);
    const outcome = await writeFence(read, "flowchart LR\n  A --> C\n");
    assert.ok(outcome.written);
    assert.strictEqual(
      document.getText(),
      "# Notes\n\n- The flow:\n\n  ````mermaid\n  flowchart LR\n    A --> C\n  ````\n\nAfter.\n",
    );
    // The block holds the diagram that was written, so that a second write finds it again.
    assert.strictEqual(outcome.fence.source, "flowchart LR\n  A --> C");
    assert.deepStrictEqual([outcome.fence.openingLine, outcome.fence.lastLine], [4, 6]);
    const grown = await writeFence(
      { uri: read.uri, fence: outcome.fence },
      "flowchart LR\n  A --> C\n  C --> D",
    );
    assert.ok(grown.written);
    assert.strictEqual(
      document.getText(),
      "# Notes\n\n- The flow:\n\n  ````mermaid\n  flowchart LR\n    A --> C\n    C --> D\n  ````\n\nAfter.\n",
    );
    assert.strictEqual(grown.fence.lastLine, 7);
  });

  test("keeps CRLF line endings and a missing final newline", async () => {
    const crlf = await markdown("# Notes\r\n\r\n```mermaid\r\nflowchart TD\r\n```");
    assert.ok((await writeFence(binding(crlf), "flowchart LR")).written);
    assert.strictEqual(crlf.getText(), "# Notes\r\n\r\n```mermaid\r\nflowchart LR\r\n```");

    // A block that is never closed ends at the end of the document, which has no newline to keep.
    const unclosed = await markdown("```mermaid\nflowchart TD");
    assert.ok((await writeFence(binding(unclosed), "flowchart LR\n  A --> B")).written);
    assert.strictEqual(unclosed.getText(), "```mermaid\nflowchart LR\n  A --> B");
  });

  test("writes a block in a block quote behind its markers", async () => {
    const before = "> [!NOTE]\r\n> ```mermaid\r\n> flowchart TD\r\n> ```\r\nAfter.\r\n";
    const document = await markdown(before);
    const read = binding(document);
    assert.strictEqual(read.fence.source, "flowchart TD");
    const outcome = await writeFence(read, "flowchart LR\n\n  A --> B");
    assert.ok(outcome.written);
    assert.strictEqual(
      document.getText(),
      "> [!NOTE]\r\n> ```mermaid\r\n> flowchart LR\r\n>\r\n>   A --> B\r\n> ```\r\nAfter.\r\n",
    );
    assert.deepStrictEqual(outcome.fence, binding(document).fence);

    const rejected = await writeFence({ ...read, fence: outcome.fence }, "flowchart TD\n```");
    assert.ok(!rejected.written);
    assert.match(rejected.reason, /closing Markdown fence on line 2, "```"/);
  });

  test("reads lone carriage returns as line breaks before checking for a closing fence", async () => {
    const before = "```echarts\n{}\n```\nAfter.\n";
    const document = await markdown(before);
    const read = binding(document);
    const rejected = await writeFence(read, "{ title: { text: `\r```\r` } }");
    assert.ok(!rejected.written);
    assert.match(rejected.reason, /closing Markdown fence/);
    assert.strictEqual(document.getText(), before);

    const source = '{\r  "series": []\r}';
    const written = await writeFence(read, source);
    assert.ok(written.written);
    assert.strictEqual(document.getText(), '```echarts\n{\n  "series": []\n}\n```\nAfter.\n');
    assert.strictEqual(written.fence.source, '{\n  "series": []\n}');
    assert.strictEqual(written.fence.lastLine, 3);
  });

  test("keeps lines of only whitespace as written", async () => {
    // Editors leave indentation on otherwise empty lines, which must not become changes.
    const document = await markdown("- Sales:\n\n  ```echarts\n  {\n    \n  }\n  ```\n");
    const read = binding(document);
    assert.strictEqual(read.fence.source, "{\n  \n}");
    assert.ok((await writeFence(read, '{\n  "series": [],\n  \n}')).written);
    assert.strictEqual(
      document.getText(),
      '- Sales:\n\n  ```echarts\n  {\n    "series": [],\n    \n  }\n  ```\n',
    );
  });

  test("writes to a block that moved in the document", async () => {
    const document = await markdown("```mermaid\nflowchart TD\n```\n");
    const read = binding(document);
    await edit(document, new vscode.Range(0, 0, 0, 0), "# Notes\n\n");
    const outcome = await writeFence(read, "flowchart LR");
    assert.ok(outcome.written);
    assert.strictEqual(outcome.fence.openingLine, 2);
    assert.strictEqual(document.getText(), "# Notes\n\n```mermaid\nflowchart LR\n```\n");
  });

  test("follows the block's current indentation", async () => {
    const document = await markdown("```mermaid\nflowchart TD\n```\n");
    const read = binding(document);
    await edit(
      document,
      new vscode.Range(0, 0, 3, 0),
      "- Flow:\n\n  ```mermaid\n  flowchart TD\n  ```\n",
    );
    const outcome = await writeFence(read, "flowchart LR\n  A --> B");
    assert.ok(outcome.written);
    assert.strictEqual(
      document.getText(),
      "- Flow:\n\n  ```mermaid\n  flowchart LR\n    A --> B\n  ```\n",
    );
    assert.strictEqual(outcome.fence.prefix, "  ");
    assert.strictEqual(outcome.fence.source, "flowchart LR\n  A --> B");
  });

  test("refuses a source that would close the Markdown block", async () => {
    for (const marker of ["```", "~~~"]) {
      const before = `${marker}echarts\n{}\n${marker}\nAfter.\n`;
      const document = await markdown(before);
      const outcome = await writeFence(binding(document), `{ title: { text: \`\n${marker}\n\` } }`);
      assert.ok(!outcome.written);
      assert.match(outcome.reason, /closing Markdown fence/);
      assert.strictEqual(document.getText(), before);
    }

    const document = await markdown("````echarts\n{}\n````\n");
    const source = "{ title: { text: `\n```\n` } }";
    assert.ok((await writeFence(binding(document), source)).written);
    assert.strictEqual(document.getText(), `\`\`\`\`echarts\n${source}\n\`\`\`\`\n`);

    // A fence indented by 4 columns more than the block's own is content.
    const indented = await markdown("```echarts\n{}\n```\n");
    const nested = "{ title: { text: `\n    ```\n` } }";
    const written = await writeFence(binding(indented), nested);
    assert.ok(written.written);
    assert.strictEqual(written.fence.source, nested);
    assert.strictEqual(binding(indented).fence.source, nested);
  });

  test("says when the workspace refuses the edit", async () => {
    const document = await markdown("```mermaid\nflowchart TD\n```\n");
    replace(vscode.workspace, "applyEdit", async () => {
      throw new Error("The document is read-only");
    });
    const outcome = await writeFence(binding(document), "flowchart LR");
    assert.ok(!outcome.written);
    assert.match(outcome.reason, /Could not write the diagram.*The document is read-only/);
    assert.strictEqual(document.getText(), "```mermaid\nflowchart TD\n```\n");
    replace(vscode.workspace, "applyEdit", async () => false);
    const refused = await writeFence(binding(document), "flowchart LR");
    assert.ok(!refused.written);
    assert.match(refused.reason, /refused the edit\. Check that the file is not read-only\./);
  });

  test("writes again when the user types while the edit is applied", async () => {
    const document = await markdown("```mermaid\nflowchart TD\n```\n");
    const read = binding(document);
    const original = vscode.workspace.applyEdit;
    let attempts = 0;
    /** Types into the document before the first edit arrives, which VS Code then refuses. */
    function typeFirst(line: number, text: string): void {
      attempts = 0;
      replace(vscode.workspace, "applyEdit", async (edit) => {
        if (attempts++ > 0) {
          return original(edit);
        }
        const typing = new vscode.WorkspaceEdit();
        typing.insert(document.uri, new vscode.Position(line, 0), text);
        assert.ok(await original(typing));
        return false;
      });
    }
    typeFirst(0, "# Notes\n\n");
    const outcome = await writeFence(read, "flowchart LR");
    assert.ok(outcome.written);
    assert.strictEqual(attempts, 2);
    assert.strictEqual(document.getText(), "# Notes\n\n```mermaid\nflowchart LR\n```\n");
    assert.strictEqual(outcome.fence.openingLine, 2);

    // Typing in the block itself leaves the block to the user.
    typeFirst(4, "  A --> B\n");
    const typedInBlock = await writeFence({ ...read, fence: outcome.fence }, "flowchart RL");
    assert.ok(!typedInBlock.written);
    assert.match(typedInBlock.reason, /has changed/);
    assert.strictEqual(document.getText(), "# Notes\n\n```mermaid\nflowchart LR\n  A --> B\n```\n");
  });

  test("leaves a block that changed or is gone alone", async () => {
    const changed = await markdown("```mermaid\nflowchart TD\n```\n");
    const edited = binding(changed);
    await edit(changed, new vscode.Range(1, 0, 1, 12), "flowchart LR");
    const stale = await writeFence(edited, "flowchart RL");
    assert.ok(!stale.written);
    assert.match(stale.reason, /mermaid block in notes-\d+\.md has changed/);
    assert.strictEqual(changed.getText(), "```mermaid\nflowchart LR\n```\n");

    const emptied = await markdown("```mermaid\nflowchart TD\n```\n");
    const removed = binding(emptied);
    await edit(emptied, new vscode.Range(0, 0, 3, 0), "");
    assert.ok(!(await writeFence(removed, "flowchart RL")).written);
    assert.strictEqual(emptied.getText(), "");
  });

  test("says when it cannot open the document, or the source holds no diagram", async () => {
    const document = await markdown("```mermaid\nflowchart TD\n```\n");
    const read = binding(document);
    const blank = await writeFence(read, "  \n\n");
    assert.ok(!blank.written);
    assert.match(blank.reason, /no diagram to write/);
    assert.strictEqual(document.getText(), "```mermaid\nflowchart TD\n```\n");

    const missing = vscode.Uri.file(path.join(dir, "gone.md")).toString();
    const outcome = await writeFence({ ...read, uri: missing }, "flowchart LR");
    assert.ok(!outcome.written);
    assert.match(outcome.reason, /^Could not write the diagram: \/\S+\/gone\.md does not exist\.$/);
  });

  test("does not write to a document that VS Code keeps read-only", async () => {
    const document = await markdown("```mermaid\nflowchart TD\n```\n");
    const name = path.basename(document.uri.fsPath);
    const files = vscode.workspace.getConfiguration("files");
    await files.update(
      "readonlyInclude",
      { [`**/${name}`]: true },
      vscode.ConfigurationTarget.Global,
    );
    afterTest(() => files.update("readonlyInclude", undefined, vscode.ConfigurationTarget.Global));
    assert.deepStrictEqual(await writeFence(binding(document), "flowchart LR"), {
      written: false,
      reason: `${name} is read-only, so the diagram was not written to it.`,
    });
    assert.strictEqual(document.getText(), "```mermaid\nflowchart TD\n```\n");
    await files.update(
      "readonlyExclude",
      { [`**/${name}`]: true },
      vscode.ConfigurationTarget.Global,
    );
    afterTest(() => files.update("readonlyExclude", undefined, vscode.ConfigurationTarget.Global));
    assert.ok((await writeFence(binding(document), "flowchart LR")).written);
    // Root may write to any file.
    if (process.getuid?.() === 0) return;
    const locked = await markdown("```mermaid\nflowchart TD\n```\n");
    fs.chmodSync(locked.uri.fsPath, 0o444);
    assert.ok((await writeFence(binding(locked), "flowchart LR")).written, "VS Code's default");
    await files.update("readonlyFromPermissions", true, vscode.ConfigurationTarget.Global);
    afterTest(() =>
      files.update("readonlyFromPermissions", undefined, vscode.ConfigurationTarget.Global),
    );
    const outcome = await writeFence(binding(locked), "flowchart RL");
    assert.ok(!outcome.written && / is read-only, /.test(outcome.reason), JSON.stringify(outcome));
  });

  test("does not overwrite a copy of the block when the block itself changed", async () => {
    const document = await markdown(
      "```mermaid\nflowchart TD\n```\n\n```mermaid\nflowchart TD\n```\n",
    );
    const read = binding(document);
    await edit(document, new vscode.Range(1, 0, 1, 12), "flowchart LR");
    const before = document.getText();
    const outcome = await writeFence(read, "flowchart RL");
    assert.ok(!outcome.written);
    assert.match(outcome.reason, /reopen the block with Open in Diagram/);
    assert.strictEqual(document.getText(), before);
  });

  test("applying an edit in the panel writes it back to the document", async () => {
    const document = await markdown("# Notes\n\n```mermaid\nflowchart TD\n```\n");
    const read = binding(document);
    const { panel, webview } = await restored(openedState(read));
    await webview.edit("flowchart LR\n  A --> B");
    assert.strictEqual(document.getText(), "# Notes\n\n```mermaid\nflowchart LR\n  A --> B\n```\n");
    // The binding follows the block it wrote, so that the next Apply recognizes it.
    assert.strictEqual(panel.current?.document?.fence.lastLine, 4);
    await webview.edit("flowchart TD");
    assert.strictEqual(document.getText(), "# Notes\n\n```mermaid\nflowchart TD\n```\n");
  });

  test("writes the diagram as shown, which needs no edit, twice to the block it left", async () => {
    const document = await markdown("# Notes\n\n```mermaid\nflowchart TD\n```\n");
    const read = binding(document);
    // What an agent drew into the block's diagram, which the user has not touched: Apply has
    // nothing to apply, so the Write button is the way it reaches the document.
    const { panel, webview } = await restored({
      ...openedState(read),
      source: "flowchart LR\n  A --> B",
    });
    const warnings = recordMessages("showWarningMessage");
    await Promise.all([writeShown(webview), writeShown(webview)]);
    assert.deepStrictEqual(warnings, []);
    assert.strictEqual(document.getText(), "# Notes\n\n```mermaid\nflowchart LR\n  A --> B\n```\n");
    // The binding follows the block, as it does after an applied edit.
    assert.strictEqual(panel.current?.document?.fence.source, "flowchart LR\n  A --> B");
    assert.strictEqual(panel.current?.document?.fence.lastLine, 4);
  });

  test("an invalid Apply keeps the edits in the panel without overwriting the document", async () => {
    const document = await markdown("```mermaid\nflowchart TD\n```\n");
    const before = document.getText();
    const read = binding(document);
    const { panel, webview } = await restored(openedState(read));
    failingUnknown(webview);
    const warnings = recordMessages("showWarningMessage");
    await webview.edit("flowchart ??");
    assert.strictEqual(document.getText(), before);
    assert.strictEqual(panel.current?.source, "flowchart ??");
    assert.strictEqual(panel.current?.editedByUser, true);
    assert.ok(panel.current?.error);
    assert.strictEqual(panel.current?.document?.fence.source, "flowchart TD");
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0] ?? "", /not written.*Your edits are kept in the panel/s);

    await webview.edit("flowchart LR\n  A --> B");
    assert.strictEqual(document.getText(), "```mermaid\nflowchart LR\n  A --> B\n```\n");
    assert.strictEqual(panel.current?.error, undefined);
  });

  const notWritten = {
    unfinished: "Wait for the diagram to finish rendering before writing it.",
    invalid: "The diagram was not written, as it fails to render: Parse error",
    unavailable:
      "The diagram was not written: The diagram panel is unavailable. Reopen the panel and try again.",
  };
  for (const [failure, warning] of Object.entries(notWritten)) {
    test(`a render that is ${failure} cannot be written to the document`, async () => {
      const document = await markdown("```mermaid\nflowchart TD\n```\n");
      const { panel, webview } = await newFakePanel();
      if (failure === "unfinished") webview.answer = undefined;
      if (failure === "invalid") failingUnknown(webview);
      if (failure === "unavailable") webview.deliver = (message) => message.type !== "render";
      const warnings = recordMessages("showWarningMessage");
      const rendering = panel.render(
        { language: "mermaid", source: "flowchart ??", title: "Flow", document: binding(document) },
        "document",
      );
      if (failure !== "unfinished") assert.ok(!(await rendering).ok);
      await writeShown(webview);
      assert.strictEqual(document.getText(), "```mermaid\nflowchart TD\n```\n");
      assert.deepStrictEqual(warnings, [warning]);
      panel.dispose();
      await rendering;
    });
  }

  test("a diagram that no document holds ignores a Write from the page", async () => {
    const { panel, webview } = await newFakePanel();
    const warnings = recordMessages("showWarningMessage");
    assert.ok(
      (await panel.render({ language: "mermaid", source: "flowchart TD", title: "Flow" }, "tool"))
        .ok,
    );
    await writeShown(webview);
    assert.deepStrictEqual(warnings, []);
  });

  test("applying an edit leaves a document that changed to the user, and offers to open it", async () => {
    const document = await markdown("# Notes\n\n```mermaid\nflowchart TD\n```\n");
    const read = binding(document);
    const { panel, webview } = await restored(openedState(read));
    let actions: unknown[] = [];
    const warnings = recordMessages("showWarningMessage", (_, ...rest) => {
      actions = rest;
      return rest[0];
    });
    const opened = Promise.withResolvers<[vscode.TextDocument, vscode.TextDocumentShowOptions]>();
    replace(vscode.window, "showTextDocument", (async (
      shown: vscode.TextDocument,
      options: vscode.TextDocumentShowOptions,
    ) => opened.resolve([shown, options])) as unknown as typeof vscode.window.showTextDocument);
    await edit(document, new vscode.Range(3, 0, 3, 12), "flowchart LR");
    await webview.edit("flowchart RL");
    assert.strictEqual(document.getText(), "# Notes\n\n```mermaid\nflowchart LR\n```\n");
    // The diagram is still the document's, with the block as it was read.
    assert.strictEqual(panel.current?.document?.fence.source, "flowchart TD");
    assert.strictEqual(panel.current?.source, "flowchart RL");
    const [shown, options] = await opened.promise;
    const name = path.basename(document.uri.fsPath);
    assert.deepStrictEqual(warnings, [
      `The mermaid block in ${name} has changed or cannot be identified safely, so it was not overwritten. Copy the diagram to paste it into the block, or reopen the block with Open in Diagram, which replaces the diagram in the panel.`,
    ]);
    assert.deepStrictEqual(actions, [`Open ${name}`, "Copy Diagram"]);
    assert.strictEqual(shown, document);
    assert.deepStrictEqual(options.selection, new vscode.Range(2, 0, 2, 0));
  });

  test("offers to copy the edit that it could not write to a document that changed", async () => {
    const document = await markdown("```echarts\n{}\n```\n");
    const { webview } = await restored(openedState(binding(document)));
    await vscode.env.clipboard.writeText("");
    const warnings = recordMessages("showWarningMessage", (_, ...actions) => actions[1]);
    await edit(document, new vscode.Range(1, 0, 1, 2), '{"series": []}');
    await webview.edit('{"title": {}}');
    // The write does not wait for the warning to be answered.
    let copied = "";
    for (let tries = 0; tries < 100 && !copied; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      copied = await vscode.env.clipboard.readText();
    }
    assert.strictEqual(copied, '{"title": {}}');
    assert.match(warnings[0] ?? "", /^The echarts block .* Copy the chart to paste it/);
    assert.strictEqual(document.getText(), '```echarts\n{"series": []}\n```\n');
  });

  test("an Apply cannot write to a document opened while the edit renders", async () => {
    const first = await markdown("```mermaid\nflowchart TD\n```\n");
    const second = await markdown("```mermaid\nflowchart LR\n```\n");
    const { panel, webview } = await restored(openedState(binding(first)));
    webview.answer = undefined;
    const warnings = recordMessages("showWarningMessage");
    const applying = webview.edit("flowchart RL");
    const opening = panel.render(openedState(binding(second)), "document");
    await webview.finishRender();
    await Promise.all([applying, opening]);
    assert.strictEqual(first.getText(), "```mermaid\nflowchart TD\n```\n");
    assert.strictEqual(second.getText(), "```mermaid\nflowchart LR\n```\n");
    assert.deepStrictEqual(warnings, []);
  });

  for (const change of ["replacement", "reload"] as const) {
    test(`a pending document open writes only the diagram shown after ${change}`, async () => {
      const document = await markdown("```mermaid\nflowchart TD\n```\n");
      const state = { ...openedState(binding(document)), source: "flowchart LR" };
      const { panel, webview } = await restored(state);
      const opened = Promise.withResolvers<vscode.TextDocument>();
      replace(vscode.workspace, "openTextDocument", (() => opened.promise) as never);
      const warnings = recordMessages("showWarningMessage");
      const writing = writeShown(webview);
      if (change === "replacement") {
        // Even the same diagram, opened again, is a new one.
        void panel.render({ ...state, document: { ...binding(document) } }, "document");
      } else {
        // A reloaded page draws the same diagram again.
        await webview.receive({ type: "ready" });
      }
      opened.resolve(document);
      await writing;
      if (change === "replacement") {
        assert.strictEqual(document.getText(), "```mermaid\nflowchart TD\n```\n");
        assert.strictEqual(warnings.length, 1);
        assert.match(warnings[0] ?? "", /changed before it could be written/);
      } else {
        assert.strictEqual(document.getText(), "```mermaid\nflowchart LR\n```\n");
        assert.deepStrictEqual(warnings, []);
      }
    });
  }

  test("changing diagram language drops the previous document binding", async () => {
    const document = await markdown("```mermaid\nflowchart TD\n```\n");
    const read = binding(document);
    const { panel } = await restored(openedState(read));
    const rendering = panel.render(
      { language: "echarts", source: '{"series": []}', title: "Chart" },
      "tool",
    );
    assert.strictEqual(panel.current?.document, undefined);
    panel.dispose();
    await rendering;
    assert.strictEqual(document.getText(), "```mermaid\nflowchart TD\n```\n");
  });

  for (const change of ["replacement", "edit and revert"] as const) {
    test(`a confirmed write does not overwrite the document after ${change}`, async () => {
      const document = await markdown("```mermaid\nflowchart TD\n```\n");
      const before = document.getText();
      const read = { ...binding(document), replaced: true };
      const state = { ...openedState(read), source: "flowchart LR" };
      const { panel, webview } = await restored(state);
      const confirmation = Promise.withResolvers<string | undefined>();
      const warnings = recordMessages("showWarningMessage", () =>
        warnings.length === 1 ? confirmation.promise : undefined,
      );
      assert.ok((await panel.render(state, "document")).ok);
      const writing = writeShown(webview);
      assert.strictEqual(warnings.length, 1);
      if (change === "replacement") {
        // Even identical source belongs to a different document binding after replacement.
        assert.ok((await panel.render({ ...state, document: { ...read } }, "document")).ok);
      } else {
        // Editing and restoring the same text still invalidates the original confirmation.
        await webview.edit("flowchart RL");
        await webview.edit(state.source);
      }
      confirmation.resolve("Write");
      await writing;
      assert.strictEqual(document.getText(), before);
      assert.match(warnings.at(-1) ?? "", /changed while you were confirming/);
    });
  }

  test("an agent that replaces the diagram keeps the binding without writing", async () => {
    const document = await markdown("```mermaid\nflowchart TD\n```\n");
    const read = binding(document);
    const { panel } = await restored(openedState(read));
    const outcome = await panel.render(
      { language: "mermaid", source: "flowchart LR\n  C --> D", title: "Other" },
      "tool",
    );
    assert.ok(outcome.ok);
    // Rendering never writes: the file still holds the diagram that was opened from it.
    assert.strictEqual(document.getText(), "```mermaid\nflowchart TD\n```\n");
    assert.strictEqual(panel.current?.document?.uri, read.uri);
    assert.ok(panel.current?.document?.replaced);
    assert.match(panel.describeForModel() ?? "", /Opened from a code block in notes-\d+\.md/);
  });
});
