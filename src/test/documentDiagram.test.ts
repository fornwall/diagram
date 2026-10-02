import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { type DocumentBinding, writeFence } from "../documentDiagram";
import { findDiagramFences } from "../fences";
import type { DiagramState, RenderOutcome } from "../panel";
import { newPanel } from "./newPanel";

suite("documentDiagram", function () {
  // A panel that an agent renders in loads the webview, which can take a while.
  this.timeout(10_000);

  let dir: string;
  let files = 0;

  suiteSetup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "diagram-test-"));
  });

  suiteTeardown(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

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
  function openedState(read: DocumentBinding): DiagramState {
    return {
      language: read.fence.language,
      source: read.fence.source,
      title: "Flow",
      origin: "document",
      editedByUser: false,
      document: read,
    };
  }

  function applyEdit(panel: ReturnType<typeof newPanel>, source: string): Promise<void> {
    return (panel as unknown as { applyEdit(source: string): Promise<void> }).applyEdit(source);
  }

  /** What the panel's Write button posts, for a diagram the user has not edited. */
  function writeShown(panel: ReturnType<typeof newPanel>): Promise<void> {
    return (panel as unknown as { writeShownToDocument(): Promise<void> }).writeShownToDocument();
  }

  test("writeFence keeps the fence markers and their indentation", async () => {
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

  test("writeFence keeps CRLF line endings and a missing final newline", async () => {
    const crlf = await markdown("# Notes\r\n\r\n```mermaid\r\nflowchart TD\r\n```");
    assert.ok((await writeFence(binding(crlf), "flowchart LR")).written);
    assert.strictEqual(crlf.getText(), "# Notes\r\n\r\n```mermaid\r\nflowchart LR\r\n```");

    // A block that is never closed ends at the end of the document, which has no newline to keep.
    const unclosed = await markdown("```mermaid\nflowchart TD");
    assert.ok((await writeFence(binding(unclosed), "flowchart LR\n  A --> B")).written);
    assert.strictEqual(unclosed.getText(), "```mermaid\nflowchart LR\n  A --> B");
  });

  test("writeFence writes an ECharts option back", async () => {
    const document = await markdown('Sales:\n\n```echarts\n{"series": []}\n```\n');
    assert.ok((await writeFence(binding(document), '{"series": [{"type": "pie"}]}')).written);
    assert.strictEqual(
      document.getText(),
      'Sales:\n\n```echarts\n{"series": [{"type": "pie"}]}\n```\n',
    );
  });

  test("writeFence finds a block that moved in the document", async () => {
    const document = await markdown("```mermaid\nflowchart TD\n```\n");
    const read = binding(document);
    await edit(document, new vscode.Range(0, 0, 0, 0), "# Notes\n\n");
    const outcome = await writeFence(read, "flowchart LR");
    assert.ok(outcome.written);
    assert.strictEqual(outcome.fence.openingLine, 2);
    assert.strictEqual(document.getText(), "# Notes\n\n```mermaid\nflowchart LR\n```\n");
  });

  test("writeFence follows the block's current indentation", async () => {
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
    assert.strictEqual(outcome.fence.indent, "  ");
    assert.strictEqual(outcome.fence.source, "flowchart LR\n  A --> B");
  });

  test("writeFence refuses source that would close the Markdown block", async () => {
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
  });

  test("writeFence reports rejected workspace edits", async () => {
    const document = await markdown("```mermaid\nflowchart TD\n```\n");
    const original = vscode.workspace.applyEdit;
    vscode.workspace.applyEdit = async () => {
      throw new Error("The document is read-only");
    };
    try {
      const outcome = await writeFence(binding(document), "flowchart LR");
      assert.ok(!outcome.written);
      assert.match(outcome.reason, /Could not write the diagram.*The document is read-only/);
      assert.strictEqual(document.getText(), "```mermaid\nflowchart TD\n```\n");
    } finally {
      vscode.workspace.applyEdit = original;
    }
  });

  test("writeFence leaves a block that changed or is gone alone", async () => {
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

  test("writeFence reports a document it cannot open and a source without a diagram", async () => {
    const document = await markdown("```mermaid\nflowchart TD\n```\n");
    const read = binding(document);
    const blank = await writeFence(read, "  \n\n");
    assert.ok(!blank.written);
    assert.match(blank.reason, /no diagram to write/);
    assert.strictEqual(document.getText(), "```mermaid\nflowchart TD\n```\n");

    const missing = vscode.Uri.file(path.join(dir, "gone.md")).toString();
    const outcome = await writeFence({ ...read, uri: missing }, "flowchart LR");
    assert.ok(!outcome.written);
    assert.match(outcome.reason, /Could not open gone\.md/);
  });

  test("writeFence does not overwrite a duplicate when the original block changes", async () => {
    const document = await markdown(
      "```mermaid\nflowchart TD\n```\n\n```mermaid\nflowchart TD\n```\n",
    );
    const read = binding(document);
    await edit(document, new vscode.Range(1, 0, 1, 12), "flowchart LR");
    const before = document.getText();
    const outcome = await writeFence(read, "flowchart RL");
    assert.ok(!outcome.written);
    assert.match(outcome.reason, /Reopen it with Open in Diagram/);
    assert.strictEqual(document.getText(), before);
  });

  test("applying an edit in the panel writes it back to the document", async () => {
    const document = await markdown("# Notes\n\n```mermaid\nflowchart TD\n```\n");
    const read = binding(document);
    const panel = newPanel(new Map<string, unknown>([["diagram.state", openedState(read)]]));
    try {
      panel.show();
      await applyEdit(panel, "flowchart LR\n  A --> B");
      assert.strictEqual(
        document.getText(),
        "# Notes\n\n```mermaid\nflowchart LR\n  A --> B\n```\n",
      );
      // The binding follows the block it wrote, so that the next Apply recognizes it.
      assert.strictEqual(panel.current?.document?.fence.lastLine, 4);
      await applyEdit(panel, "flowchart TD");
      assert.strictEqual(document.getText(), "# Notes\n\n```mermaid\nflowchart TD\n```\n");
    } finally {
      panel.dispose();
    }
  });

  test("writing the diagram as shown needs no edit of the user's own", async () => {
    const document = await markdown("# Notes\n\n```mermaid\nflowchart TD\n```\n");
    const read = binding(document);
    const panel = newPanel(new Map<string, unknown>([["diagram.state", openedState(read)]]));
    try {
      // What an agent drew into the block's diagram, which the user has not touched: Apply has
      // nothing to apply, so the Write button is the way it reaches the document.
      const drawn = { ...openedState(read), source: "flowchart LR\n  A --> B" };
      (panel as unknown as { state: DiagramState }).state = drawn;
      await writeShown(panel);
      assert.strictEqual(
        document.getText(),
        "# Notes\n\n```mermaid\nflowchart LR\n  A --> B\n```\n",
      );
      // The binding follows the block, as it does after an applied edit.
      assert.strictEqual(panel.current?.document?.fence.lastLine, 4);
    } finally {
      panel.dispose();
    }
  });

  test("an invalid Apply keeps the edits in the panel without overwriting the document", async () => {
    const document = await markdown("```mermaid\nflowchart TD\n```\n");
    const before = document.getText();
    const read = binding(document);
    const panel = newPanel(new Map<string, unknown>([["diagram.state", openedState(read)]]));
    const warn = vscode.window.showWarningMessage;
    let warning = "";
    vscode.window.showWarningMessage = async (message: string) => {
      warning = message;
      return undefined;
    };
    try {
      panel.show();
      await applyEdit(panel, "flowchart ??");
      assert.strictEqual(document.getText(), before);
      assert.strictEqual(panel.current?.source, "flowchart ??");
      assert.strictEqual(panel.current?.editedByUser, true);
      assert.ok(panel.current?.error);
      assert.strictEqual(panel.current?.document?.fence.source, "flowchart TD");
      assert.match(warning, /not written.*Your edits are kept in the panel/s);

      await applyEdit(panel, "flowchart LR\n  A --> B");
      assert.strictEqual(document.getText(), "```mermaid\nflowchart LR\n  A --> B\n```\n");
      assert.strictEqual(panel.current?.error, undefined);
    } finally {
      vscode.window.showWarningMessage = warn;
      panel.dispose();
    }
  });

  test("an unfinished render cannot be written to the document", async () => {
    const document = await markdown("```mermaid\nflowchart TD\n```\n");
    const before = document.getText();
    const read = binding(document);
    const panel = newPanel(new Map<string, unknown>([["diagram.state", openedState(read)]]));
    const internals = panel as unknown as { post(): void };
    internals.post = () => {};
    const warn = vscode.window.showWarningMessage;
    let warning = "";
    vscode.window.showWarningMessage = async (message: string) => {
      warning = message;
      return undefined;
    };
    try {
      const rendering = panel.render(
        {
          language: "mermaid",
          source: "flowchart ??",
          title: "Flow",
          document: read,
        },
        "document",
      );
      await writeShown(panel);
      assert.strictEqual(document.getText(), before);
      assert.match(warning, /Wait.*rendering/);
      panel.dispose();
      await rendering;
    } finally {
      vscode.window.showWarningMessage = warn;
      panel.dispose();
    }
  });

  test("writing the diagram as shown writes nothing when it does not render", async () => {
    const document = await markdown("```mermaid\nflowchart TD\n```\n");
    const before = document.getText();
    const read = binding(document);
    const panel = newPanel(new Map<string, unknown>([["diagram.state", openedState(read)]]));
    try {
      const failing = { ...openedState(read), source: "flowchart ??", error: "Parse error" };
      (panel as unknown as { state: DiagramState }).state = failing;
      await writeShown(panel);
      assert.strictEqual(document.getText(), before);
    } finally {
      panel.dispose();
    }
  });

  test("an unavailable render cannot be written to the document", async () => {
    const document = await markdown("```mermaid\nflowchart TD\n```\n");
    const before = document.getText();
    const read = binding(document);
    const panel = newPanel();
    const internals = panel as unknown as {
      post(): void;
      pendingRender: { message: { requestId: number } };
      finishRender(id: number, outcome: RenderOutcome): void;
    };
    internals.post = () => {};
    const warn = vscode.window.showWarningMessage;
    let warning = "";
    vscode.window.showWarningMessage = async (message: string) => {
      warning = message;
      return undefined;
    };
    try {
      const rendering = panel.render(
        { language: "mermaid", source: "flowchart ??", title: "Flow", document: read },
        "document",
      );
      internals.finishRender(internals.pendingRender.message.requestId, {
        ok: false,
        kind: "unavailable",
        error: "The diagram panel did not respond.",
      });
      await rendering;
      await writeShown(panel);
      assert.strictEqual(document.getText(), before);
      assert.match(warning, /not written.*did not respond.*Reopen/);
    } finally {
      vscode.window.showWarningMessage = warn;
      panel.dispose();
    }
  });

  test("applying an edit leaves a document that changed to the user", async () => {
    const document = await markdown("```mermaid\nflowchart TD\n```\n");
    const read = binding(document);
    const panel = newPanel(new Map<string, unknown>([["diagram.state", openedState(read)]]));
    try {
      await edit(document, new vscode.Range(1, 0, 1, 12), "flowchart LR");
      panel.show();
      await applyEdit(panel, "flowchart RL");
      assert.strictEqual(document.getText(), "```mermaid\nflowchart LR\n```\n");
      // The diagram is still the document's, with the block as it was read.
      assert.strictEqual(panel.current?.document?.fence.source, "flowchart TD");
      assert.strictEqual(panel.current?.source, "flowchart RL");
    } finally {
      panel.dispose();
    }
  });

  test("an Apply cannot write to a document opened while the edit renders", async () => {
    const first = await markdown("```mermaid\nflowchart TD\n```\n");
    const second = await markdown("```mermaid\nflowchart LR\n```\n");
    const panel = newPanel(
      new Map<string, unknown>([["diagram.state", openedState(binding(first))]]),
    );
    const internals = panel as unknown as {
      state: DiagramState;
      renderCurrent(): Promise<RenderOutcome>;
      writeToDocument(): Promise<void>;
    };
    let written = false;
    internals.renderCurrent = async () => {
      internals.state = openedState(binding(second));
      return { ok: true, diagramType: "flowchart" };
    };
    internals.writeToDocument = async () => {
      written = true;
    };
    try {
      await applyEdit(panel, "flowchart LR");
      assert.strictEqual(written, false);
    } finally {
      panel.dispose();
    }
  });

  test("changing diagram language drops the previous document binding", async () => {
    const document = await markdown("```mermaid\nflowchart TD\n```\n");
    const read = binding(document);
    const panel = newPanel(new Map<string, unknown>([["diagram.state", openedState(read)]]));
    try {
      const rendering = panel.render(
        { language: "echarts", source: '{"series": []}', title: "Chart" },
        "tool",
      );
      assert.strictEqual(panel.current?.document, undefined);
      panel.dispose();
      await rendering;
      assert.strictEqual(document.getText(), "```mermaid\nflowchart TD\n```\n");
    } finally {
      panel.dispose();
    }
  });

  for (const change of ["replacement", "edit and revert"] as const) {
    test(`a confirmed write does not overwrite the document after ${change}`, async () => {
      const document = await markdown("```mermaid\nflowchart TD\n```\n");
      const before = document.getText();
      const read = { ...binding(document), replaced: true };
      const state = { ...openedState(read), source: "flowchart LR" };
      const panel = newPanel(new Map<string, unknown>([["diagram.state", state]]));
      const warn = vscode.window.showWarningMessage;
      const confirmation = Promise.withResolvers<string | undefined>();
      const warnings: string[] = [];
      vscode.window.showWarningMessage = ((message: string) => {
        warnings.push(message);
        return warnings.length === 1 ? confirmation.promise : Promise.resolve(undefined);
      }) as typeof warn;
      try {
        assert.ok((await panel.render(state, "document")).ok);
        const writing = writeShown(panel);
        assert.strictEqual(warnings.length, 1);
        if (change === "replacement") {
          // Even identical source belongs to a different document binding after replacement.
          assert.ok((await panel.render({ ...state, document: { ...read } }, "document")).ok);
        } else {
          // Editing and restoring the same text still invalidates the original confirmation.
          await applyEdit(panel, "flowchart RL");
          await applyEdit(panel, state.source);
        }
        confirmation.resolve("Write");
        await writing;
        assert.strictEqual(document.getText(), before);
        assert.match(warnings.at(-1) ?? "", /changed while you were confirming/);
      } finally {
        confirmation.resolve(undefined);
        vscode.window.showWarningMessage = warn;
        panel.dispose();
      }
    });
  }

  test("an agent that replaces the diagram keeps the binding without writing", async () => {
    const document = await markdown("```mermaid\nflowchart TD\n```\n");
    const read = binding(document);
    const panel = newPanel(new Map<string, unknown>([["diagram.state", openedState(read)]]));
    try {
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
    } finally {
      panel.dispose();
    }
  });
});
