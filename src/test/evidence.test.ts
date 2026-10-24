import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  evidenceHash,
  evidenceIdentity,
  evidenceInput,
  reconcileEvidence,
  restoredEvidence,
} from "../evidence";
import { EvidenceTool } from "../evidenceTool";
import type { DiagramPanel } from "../panel";
import { cancellationSource, folders, replace, tempDir } from "./afterTest";
import { type FakeWebview, memento, newFakePanel, newPanel } from "./newPanel";
import { invokeTool } from "./toolText";

suite("evidence", () => {
  let panel: DiagramPanel;
  let webview: FakeWebview;
  let tool: EvidenceTool;
  let directory: string;
  let saved: Map<string, unknown>;
  const ids = Array.from({ length: 12 }, (_, index) => `N${index}`);
  const attachment = {
    id: "A",
    locations: [{ file: "code.ts", startLine: 2, endLine: 3 }],
    assumptions: ["The request is authenticated before this call."],
  };

  setup(async () => {
    directory = tempDir("diagram-evidence-");
    replace(vscode.workspace, "workspaceFolders", folders(directory));
    fs.writeFileSync(path.join(directory, "code.ts"), "first\ncall();\nreturn result;\nlast\n");
    saved = new Map();
    ({ panel, webview } = await newFakePanel(saved));
    webview.answer = (message) =>
      message.type === "render"
        ? {
            type: "rendered",
            requestId: message.requestId,
            diagramType: "flowchart-v2",
            nodeIds: ["A", "B", ...ids],
            nodes: ["A", "B", ...ids].map((id) => ({ id, label: id })),
            relationships: [
              {
                id: "edge:1",
                label: "A to B",
                relationship: { kind: "edge", source: "A", target: "B", direction: "forward" },
              },
            ],
          }
        : undefined;
    await panel.render(
      { language: "mermaid", source: "flowchart LR\n A --> B", title: "Evidence" },
      "tool",
    );
    tool = new EvidenceTool(panel);
  });

  const attach = (items: unknown[] = [attachment]) =>
    invokeTool(tool, { action: "set", revision: panel.revision, items });

  test("attaches exact node and edge evidence without redrawing and persists it", async () => {
    const revision = panel.revision;
    const renders = webview.sent.filter(({ type }) => type === "render").length;
    const result = JSON.parse(
      await attach([
        attachment,
        {
          id: "edge:1",
          assumptions: ["Calls are synchronous."],
        },
      ]),
    );
    assert.strictEqual(result.revision, revision + 1);
    assert.match(result.note, /not verified/);
    assert.strictEqual(result.items, 2);
    assert.strictEqual(webview.sent.filter(({ type }) => type === "render").length, renders);
    const report = JSON.parse(await invokeTool(tool, { action: "read" }));
    assert.strictEqual(report.items[0].itemStatus, "unchanged");
    assert.strictEqual(report.items[0].locations[0].status, "unchanged");
    assert.strictEqual(report.items[0].locations[0].rangeStatus, "unchanged");
    assert.deepStrictEqual(report.items[0].locations[0].snippet, [
      { line: 2, text: "call();" },
      { line: 3, text: "return result;" },
    ]);
    assert.deepStrictEqual(report.items[1].assumptions, ["Calls are synchronous."]);
    const restored = newPanel(saved);
    try {
      assert.deepStrictEqual(restored.current?.evidence, panel.current?.evidence);
    } finally {
      restored.dispose();
    }
    assert.deepStrictEqual(restoredEvidence(panel.current?.evidence), panel.current?.evidence);
    assert.strictEqual(
      restoredEvidence([
        { ...panel.current?.evidence?.[0], locations: [{ file: "code.ts", hash: "bad" }] },
      ]),
      undefined,
    );
  });

  test("distinguishes range changes from unrelated file edits and missing ranges", async () => {
    await attach();
    const file = path.join(directory, "code.ts");
    fs.writeFileSync(file, "changed elsewhere\ncall();\nreturn result;\nlast\n");
    let report = JSON.parse(await invokeTool(tool, {}));
    assert.strictEqual(report.items[0].locations[0].status, "changed");
    assert.strictEqual(report.items[0].locations[0].rangeStatus, "unchanged");
    fs.writeFileSync(file, "changed elsewhere\nchangedCall();\nreturn result;\nlast\n");
    report = JSON.parse(await invokeTool(tool, {}));
    assert.strictEqual(report.items[0].locations[0].rangeStatus, "changed");
    fs.writeFileSync(file, "short");
    report = JSON.parse(await invokeTool(tool, {}));
    assert.strictEqual(report.items[0].locations[0].status, "changed");
    assert.strictEqual(report.items[0].locations[0].rangeStatus, "unavailable");
    assert.match(report.items[0].locations[0].reason, /file has 1 lines/);
    fs.unlinkSync(file);
    report = JSON.parse(await invokeTool(tool, {}));
    assert.strictEqual(report.items[0].locations[0].status, "missing");
    assert.strictEqual(report.items[0].locations[0].rangeStatus, "unavailable");
  });

  test("retains missing and renamed item evidence until it is explicitly reviewed", async () => {
    await attach();
    const respond = (label?: string) => {
      webview.answer = (message) =>
        message.type === "render"
          ? {
              type: "rendered",
              requestId: message.requestId,
              diagramType: "flowchart-v2",
              nodeIds: label === undefined ? [] : ["A"],
              nodes: label === undefined ? [] : [{ id: "A", label }],
            }
          : undefined;
    };
    respond();
    await panel.editByAgent({ source: "flowchart LR\n B" }, panel.revision);
    assert.strictEqual(panel.current?.evidence?.[0]?.itemStatus, "missing");
    let report = JSON.parse(await invokeTool(tool, {}));
    assert.strictEqual(report.items[0].itemStatus, "missing");
    respond("A");
    await panel.editByAgent({ source: "flowchart LR\n A" }, panel.revision);
    report = JSON.parse(await invokeTool(tool, {}));
    assert.strictEqual(report.items[0].itemStatus, "changed");
    assert.strictEqual(panel.current?.evidence?.[0]?.itemStatus, "changed");
    await attach();
    assert.strictEqual(JSON.parse(await invokeTool(tool, {})).items[0].itemStatus, "unchanged");
    respond("Other meaning");
    await panel.editByAgent({ source: "flowchart LR\n A[Other meaning]" }, panel.revision);
    assert.strictEqual(JSON.parse(await invokeTool(tool, {})).items[0].itemStatus, "changed");
    assert.strictEqual(panel.current?.evidence?.[0]?.locations.length, 1);
    const restored = newPanel(saved);
    try {
      assert.strictEqual(restored.current?.evidence?.[0]?.itemStatus, "changed");
    } finally {
      restored.dispose();
    }
  });

  test("reports unknown identity and range baselines for legacy evidence", async () => {
    await attach();
    const legacy = panel.current?.evidence?.map(({ identity: _, ...item }) => ({
      ...item,
      locations: item.locations.map(({ rangeHash: _, ...location }) => location),
    }));
    await panel.setEvidence(legacy, panel.revision);
    const report = JSON.parse(await invokeTool(tool, {}));
    assert.strictEqual(report.items[0].itemStatus, "unverified");
    assert.strictEqual(report.items[0].locations[0].rangeStatus, "unverified");
  });

  test("does not infer missing items from unavailable or incomplete labels", async () => {
    await attach();
    webview.answer = (message) =>
      message.type === "render"
        ? {
            type: "rendered",
            requestId: message.requestId,
            diagramType: "flowchart-v2",
            nodeIds: ["A"],
          }
        : undefined;
    await panel.editByAgent({ source: "flowchart LR\n A" }, panel.revision);
    assert.strictEqual(panel.current?.evidence?.[0]?.itemStatus, undefined);
    assert.strictEqual(JSON.parse(await invokeTool(tool, {})).items[0].itemStatus, "unavailable");
    webview.failNextRender("invalid");
    await panel.editByAgent({ source: "invalid" }, panel.revision);
    assert.strictEqual(JSON.parse(await invokeTool(tool, {})).items[0].itemStatus, "unavailable");
  });

  test("invalidates changed edge identities and chart sources without silently rebinding", () => {
    const edge = {
      id: "edge:1",
      label: "A to B",
      relationship: {
        kind: "edge" as const,
        source: "A",
        target: "B",
        direction: "forward" as const,
      },
    };
    const entries = [
      { id: edge.id, locations: [], assumptions: ["Calls B"], identity: evidenceIdentity(edge) },
    ];
    assert.strictEqual(
      reconcileEvidence(entries, [
        { ...edge, relationship: { ...edge.relationship, linkStyle: 2 } },
      ]),
      entries,
    );
    const rebound = { ...edge, relationship: { ...edge.relationship, target: "C" } };
    assert.strictEqual(reconcileEvidence(entries, [rebound])?.[0]?.itemStatus, "changed");
    const chart = [
      {
        id: "A",
        locations: [],
        assumptions: ["Value is stable"],
        sourceHash: evidenceHash("original"),
      },
    ];
    assert.strictEqual(reconcileEvidence(chart, undefined, "original"), chart);
    const changed = reconcileEvidence(chart, undefined, "updated");
    assert.strictEqual(changed?.[0]?.itemStatus, "changed");
    assert.strictEqual(
      reconcileEvidence(changed, undefined, "original")?.[0]?.itemStatus,
      "changed",
    );
    const missing = reconcileEvidence(entries, []);
    assert.strictEqual(reconcileEvidence(missing, undefined)?.[0]?.itemStatus, "missing");
  });

  test("hashes and reads unsaved editor contents", async () => {
    const documents = vscode.workspace.textDocuments;
    let content = "unsaved first\nchanged();\nreturn draft;\n";
    replace(vscode.workspace, "textDocuments", [
      ...documents,
      {
        uri: vscode.Uri.file(path.join(directory, "code.ts")),
        isDirty: true,
        isClosed: false,
        getText: () => content,
      } as vscode.TextDocument,
    ]);
    await attach();
    let report = JSON.parse(await invokeTool(tool, {}));
    assert.strictEqual(report.items[0].locations[0].unsaved, true);
    assert.strictEqual(report.items[0].locations[0].status, "unchanged");
    assert.strictEqual(report.items[0].locations[0].snippet[0].text, "changed();");
    content += "another edit";
    report = JSON.parse(await invokeTool(tool, {}));
    assert.strictEqual(report.items[0].locations[0].status, "changed");
    assert.strictEqual(report.items[0].locations[0].rangeStatus, "unchanged");
    replace(vscode.workspace, "textDocuments", documents);
    report = JSON.parse(await invokeTool(tool, {}));
    assert.strictEqual(report.items[0].locations[0].unsaved, false);
    assert.strictEqual(report.items[0].locations[0].status, "changed");
    assert.strictEqual(report.items[0].locations[0].rangeStatus, "changed");
  });

  test("rejects invalid identities, locations and stale revisions atomically", async () => {
    await attach();
    const before = panel.current?.evidence;
    const revision = panel.revision;
    for (const items of [
      [attachment, { id: "missing", assumptions: ["Unknown"] }],
      [{ ...attachment, locations: [{ file: "missing.ts" }] }],
      [{ ...attachment, locations: [{ file: "code.ts", startLine: 90 }] }],
      [{ ...attachment, locations: [{ file: "../external.ts" }] }],
      [{ id: "A --> B", assumptions: ["Use exact id"] }],
    ]) {
      assert.match(await attach(items), /Evidence was not read or changed/);
      assert.strictEqual(panel.current?.evidence, before);
      assert.strictEqual(panel.revision, revision);
    }
    assert.match(
      await invokeTool(tool, { action: "clear", revision: revision - 1 }),
      /diagram changed/,
    );
    assert.strictEqual(panel.current?.evidence, before);
  });

  test("refuses links outside the workspace and bounds file sizes and counts", async () => {
    const outside = tempDir("diagram-evidence-outside-");
    fs.writeFileSync(path.join(outside, "secret.ts"), "secret");
    fs.symlinkSync(path.join(outside, "secret.ts"), path.join(directory, "link.ts"));
    assert.match(
      await attach([{ id: "A", locations: [{ file: "link.ts" }] }]),
      /outside the workspace/,
    );
    fs.writeFileSync(path.join(directory, "large.ts"), "x".repeat(1024 * 1024 + 1));
    assert.match(await attach([{ id: "A", locations: [{ file: "large.ts" }] }]), /1 MiB/);
    const items = ids.slice(0, 9).map((id) => {
      fs.writeFileSync(path.join(directory, `${id}.ts`), id);
      return { id, locations: [{ file: `${id}.ts` }] };
    });
    assert.match(await attach(items), /at most 8 distinct files/);
    assert.strictEqual(panel.current?.evidence, undefined);
  });

  test("requests workspace confirmation for file reads but not clearing or assumptions", () => {
    replace(vscode.workspace, "isTrusted", false);
    assert.ok(tool.prepareInvocation({ input: { action: "read" } }).confirmationMessages);
    assert.ok(
      tool.prepareInvocation({
        input: { action: "set", revision: panel.revision, items: [attachment] },
      }).confirmationMessages,
    );
    assert.strictEqual(
      tool.prepareInvocation({ input: { action: "clear", revision: panel.revision } })
        .confirmationMessages,
      undefined,
    );
    assert.strictEqual(
      tool.prepareInvocation({
        input: {
          action: "set",
          revision: panel.revision,
          items: [{ id: "A", assumptions: ["Unknown implementation"] }],
        },
      }).confirmationMessages,
      undefined,
    );
  });

  test("pages whole evidence items within token budgets and clears only requested ids", async () => {
    await attach(ids.map((id) => ({ id, assumptions: ["x".repeat(300)] })));
    const report = JSON.parse(
      await invokeTool(tool, { maxItems: 10 }, undefined, {
        tokenBudget: 1200,
        countTokens: async (text) => text.length,
      }),
    );
    assert.ok(report.items.length > 0 && report.items.length < 10);
    assert.strictEqual(report.nextItem, report.items.length + 1);
    const next = JSON.parse(await invokeTool(tool, { startItem: report.nextItem, maxItems: 1 }));
    assert.strictEqual(next.items[0].id, ids[report.items.length]);
    await invokeTool(tool, { action: "clear", ids: ["N0"], revision: panel.revision });
    assert.strictEqual(panel.current?.evidence?.length, 11);
    assert.strictEqual(panel.current?.evidence?.[0]?.id, "N1");
    await invokeTool(tool, { action: "clear", revision: panel.revision });
    assert.strictEqual(panel.current?.evidence, undefined);
    assert.strictEqual(
      await invokeTool(tool, {}, undefined, {
        tokenBudget: 1,
        countTokens: async (text) => text.length,
      }),
      "",
    );
  });

  test("does not attach after cancellation or a concurrent diagram change", async () => {
    const evidence = () => panel.current?.evidence;
    const original = vscode.workspace.fs;
    const source = cancellationSource();
    replace(vscode.workspace, "fs", {
      ...original,
      readFile: async (uri) => {
        source.cancel();
        return original.readFile(uri);
      },
    });
    await assert.rejects(
      invokeTool(
        tool,
        { action: "set", revision: panel.revision, items: [attachment] },
        source.token,
      ),
      vscode.CancellationError,
    );
    assert.strictEqual(evidence(), undefined);
    replace(vscode.workspace, "fs", {
      ...original,
      readFile: async (uri) => {
        await panel.setEvidence(
          [{ id: "B", locations: [], assumptions: ["New evidence"] }],
          panel.revision,
        );
        return original.readFile(uri);
      },
    });
    assert.match(await attach(), /diagram changed while reading evidence/);
    assert.deepStrictEqual(
      evidence()?.map(({ id }) => id),
      ["B"],
    );
  });

  test("rejects malformed input and restored metadata", () => {
    for (const input of [
      { action: "other" },
      { action: "set" },
      { action: "clear", revision: -1 },
      { action: "read", items: [] },
      { action: "read", ids: [] },
      { action: "set", revision: 1, items: [{ id: "A" }] },
      {
        action: "set",
        revision: 1,
        items: [{ id: "A", locations: [{ file: "code.ts", startLine: 1, endLine: 101 }] }],
      },
      {
        action: "set",
        revision: 1,
        items: [{ id: "A", locations: [{ file: "code.ts", hash: "forged" }] }],
      },
    ])
      assert.throws(() => evidenceInput(input));
    for (const input of [null, {}, [], [null], [{ id: "A", locations: [], assumptions: [] }]]) {
      assert.strictEqual(restoredEvidence(input), undefined);
    }
  });

  test("reports the applied revision when a newer diagram replaces evidence during persistence", async () => {
    for (const action of ["set", "clear"] as const) {
      let delay = false;
      let release = () => {};
      let began = () => {};
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        began = resolve;
      });
      const state = memento(new Map());
      const own = await newFakePanel({
        ...state,
        update: async (key, value) => {
          if (delay && key === "diagram.state") {
            delay = false;
            began();
            await pending;
          }
          return state.update(key, value);
        },
      });
      own.webview.answer = webview.answer;
      await own.panel.render(
        { language: "mermaid", source: "flowchart LR\n A --> B", title: "Before" },
        "tool",
      );
      const ownTool = new EvidenceTool(own.panel);
      if (action === "clear") {
        await invokeTool(ownTool, {
          action: "set",
          revision: own.panel.revision,
          items: [attachment],
        });
      }
      const before = own.panel.revision;
      delay = true;
      const changed = invokeTool(ownTool, {
        action,
        revision: before,
        ...(action === "set" && { items: [attachment] }),
      });
      try {
        await started;
        await own.panel.render(
          { language: "mermaid", source: "flowchart LR\n New", title: "After" },
          "tool",
        );
      } finally {
        release();
      }
      const answer = JSON.parse(await changed);
      assert.strictEqual(answer.revision, before + 1);
      assert.strictEqual(own.panel.revision, before + 2);
      assert.strictEqual(own.panel.current?.evidence, undefined);
    }
  });
});
