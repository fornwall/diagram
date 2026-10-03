import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  FindWorkspaceFilesTool,
  ReadWorkspaceFileTool,
  resolveWorkspaceFile,
  SearchWorkspaceTextTool,
} from "../workspaceTools";

suite("workspace tools", () => {
  let dir: string;
  let outside: string;
  let relative: string;
  const source = new vscode.CancellationTokenSource();
  const reader = new ReadWorkspaceFileTool();
  const finder = new FindWorkspaceFilesTool();
  const searcher = new SearchWorkspaceTextTool();

  async function invoke<T>(tool: vscode.LanguageModelTool<T>, input: T, token = source.token) {
    const result = await tool.invoke({ input, toolInvocationToken: undefined }, token);
    assert.ok(result);
    const part = result.content[0];
    assert.ok(part instanceof vscode.LanguageModelTextPart);
    return JSON.parse(part.value);
  }

  suiteSetup(async () => {
    const root = vscode.workspace.workspaceFolders?.[0];
    assert.ok(root);
    dir = await fs.mkdtemp(path.join(root.uri.fsPath, "workspace-tools-"));
    relative = path.basename(dir);
    outside = await fs.mkdtemp(path.join(os.tmpdir(), "diagram-outside-"));
    await fs.writeFile(
      path.join(dir, "code.ts"),
      "first\nconst value = 'Needle';\nneedle needle\nlast\n",
    );
    await fs.writeFile(
      path.join(dir, "literal.txt"),
      "special a.*[x] here\nİ first Needle then needle\n",
    );
    await fs.writeFile(path.join(dir, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    await fs.writeFile(path.join(dir, "large.txt"), "X".repeat(1024 * 1024 + 1));
    await fs.writeFile(
      path.join(dir, "long.txt"),
      `${"a".repeat(2000)}Needle\n${"b".repeat(2000)}\n`,
    );
    await fs.writeFile(path.join(outside, "secret.txt"), "Needle external secret");
    await fs.mkdir(path.join(dir, "node_modules"));
    await fs.writeFile(path.join(dir, "node_modules", "ignored.ts"), "Needle ignored");
    await fs.mkdir(path.join(dir, ".git"));
    await fs.writeFile(path.join(dir, ".git", "ignored.ts"), "Needle ignored");
  });

  suiteTeardown(async () => {
    source.dispose();
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  test("finds bounded workspace paths and respects default exclusions", async () => {
    const result = await invoke(finder, { glob: `${relative}/**/*.ts` });
    assert.deepStrictEqual(
      result.files.map((entry: { file: string }) => path.basename(entry.file)),
      ["code.ts"],
    );
    assert.strictEqual(result.truncated, false);
    assert.strictEqual(result.files[0].uri, vscode.Uri.file(path.join(dir, "code.ts")).toString());
    const bounded = await invoke(finder, { glob: `${relative}/*`, maxResults: 1 });
    assert.strictEqual(bounded.files.length, 1);
    assert.strictEqual(bounded.truncated, true);
  });

  test("reads inclusive line ranges from relative paths and absolute URIs", async () => {
    const result = await invoke(reader, { file: `${relative}/code.ts`, startLine: 2, endLine: 3 });
    assert.deepStrictEqual(result.lines, [
      { line: 2, text: "const value = 'Needle';" },
      { line: 3, text: "needle needle" },
    ]);
    assert.strictEqual(result.nextStartLine, 4);
    assert.strictEqual(result.truncated, false);
    const uri = await invoke(reader, {
      file: vscode.Uri.file(path.join(dir, "code.ts")).toString(),
      startLine: 4,
      endLine: 500,
    });
    assert.strictEqual(uri.endLine, 5);
    assert.strictEqual(uri.nextStartLine, undefined);
  });

  test("fills result limits across overlapping workspace roots", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(vscode.workspace, "workspaceFolders");
    assert.ok(descriptor);
    const findFiles = vscode.workspace.findFiles;
    const nested = path.join(dir, "nested");
    await fs.mkdir(nested);
    const files = ["nested/a.ts", "nested/b.ts", "c.ts"].map((name) =>
      vscode.Uri.file(path.join(dir, name)),
    );
    for (const uri of files) await fs.writeFile(uri.fsPath, "text");
    const roots = [nested, dir].map((file, index) => ({
      uri: vscode.Uri.file(file),
      name: path.basename(file),
      index,
    }));
    Object.defineProperty(vscode.workspace, "workspaceFolders", { get: () => roots });
    vscode.workspace.findFiles = async (include, _exclude, maxResults) => {
      assert.ok(include instanceof vscode.RelativePattern);
      const matches = include.baseUri.fsPath === nested ? files.slice(0, 2) : files;
      return matches.slice(0, maxResults);
    };
    try {
      const complete = await invoke(finder, { maxResults: 3 });
      assert.deepStrictEqual(
        complete.files.map((entry: { uri: string }) => entry.uri),
        files.map((uri) => uri.toString()),
      );
      assert.strictEqual(complete.truncated, false);
      const limited = await invoke(finder, { maxResults: 2 });
      assert.strictEqual(limited.files.length, 2);
      assert.strictEqual(limited.truncated, true);
    } finally {
      vscode.workspace.findFiles = findFiles;
      Object.defineProperty(vscode.workspace, "workspaceFolders", descriptor);
    }
  });

  test("searches literal text with accurate lines, columns and case control", async () => {
    const result = await invoke(searcher, { query: "needle", glob: `${relative}/code.ts` });
    assert.deepStrictEqual(
      result.matches.map((match: { line: number; column: number }) => [match.line, match.column]),
      [
        [2, 16],
        [3, 1],
      ],
    );
    const exact = await invoke(searcher, {
      query: "Needle",
      glob: `${relative}/code.ts`,
      caseSensitive: true,
    });
    assert.strictEqual(exact.matches.length, 1);
    const literal = await invoke(searcher, { query: "a.*[x]", glob: `${relative}/literal.txt` });
    assert.strictEqual(literal.matches.length, 1);
    const unicode = await invoke(searcher, { query: "Needle", glob: `${relative}/literal.txt` });
    assert.strictEqual(unicode.matches[0].column, 9);
  });

  test("reports result limits and skipped binary or oversized files", async () => {
    const limited = await invoke(searcher, {
      query: "needle",
      glob: `${relative}/code.ts`,
      maxResults: 1,
    });
    assert.strictEqual(limited.matches.length, 1);
    assert.strictEqual(limited.truncated, true);
    const full = await invoke(searcher, { query: "missing", glob: `${relative}/*` });
    assert.ok(full.skipped >= 2);
    assert.strictEqual(full.matches.length, 0);
    assert.match((await invoke(reader, { file: path.join(dir, "binary.bin") })).error, /Binary/);
    assert.match((await invoke(reader, { file: path.join(dir, "large.txt") })).error, /1 MiB/);
  });

  test("charges binary and invalid text against the total scan byte limit", async () => {
    const budgetDir = path.join(dir, "budget");
    await fs.mkdir(budgetDir);
    try {
      for (let i = 0; i < 17; i++) {
        await fs.writeFile(
          path.join(budgetDir, `${i}.bin`),
          Buffer.alloc(1024 * 1024, i % 2 ? 0xff : 0),
        );
      }
      const result = await invoke(searcher, { query: "missing", glob: `${relative}/budget/*` });
      assert.strictEqual(result.truncated, true);
      assert.strictEqual(result.skipped, 16);
      assert.strictEqual(result.scannedBytes, 16 * 1024 * 1024);
      assert.deepStrictEqual(result.matches, []);
    } finally {
      await fs.rm(budgetDir, { recursive: true, force: true });
    }
  });

  test("bounds long line output while keeping search matches visible", async () => {
    const read = await invoke(reader, { file: path.join(dir, "long.txt") });
    assert.strictEqual(read.lines[0].text.length, 1000);
    assert.strictEqual(read.lines[0].truncated, true);
    assert.strictEqual(read.truncated, true);
    const search = await invoke(searcher, { query: "Needle", glob: `${relative}/long.txt` });
    assert.strictEqual(search.matches[0].column, 2001);
    assert.ok(search.matches[0].text.includes("Needle"));
    assert.strictEqual(search.matches[0].previewTruncated, true);
  });

  test("reads and searches unsaved editor changes", async () => {
    const file = path.join(dir, "dirty.ts");
    await fs.writeFile(file, "saved text");
    const document = await vscode.workspace.openTextDocument(file);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, new vscode.Position(0, 0), "unsaved Needle\n");
    assert.ok(await vscode.workspace.applyEdit(edit));
    try {
      const read = await invoke(reader, { file });
      assert.strictEqual(read.unsaved, true);
      assert.strictEqual(read.lines[0].text, "unsaved Needle");
      const search = await invoke(searcher, { query: "Needle", glob: `${relative}/dirty.ts` });
      assert.strictEqual(search.matches[0].unsaved, true);
      assert.strictEqual(search.matches[0].line, 1);
    } finally {
      await document.save();
    }
  });

  test("rejects outside paths and symlinks escaping the workspace", async function () {
    assert.match(
      (await invoke(reader, { file: path.join(outside, "secret.txt") })).error,
      /inside an open workspace/,
    );
    assert.match(
      (await invoke(reader, { file: "../../../etc/passwd" })).error,
      /inside an open workspace/,
    );
    if (process.platform === "win32") this.skip();
    const link = path.join(dir, "external.txt");
    await fs.symlink(path.join(outside, "secret.txt"), link);
    const read = await invoke(reader, { file: link });
    assert.match(read.error, /symbolic link outside/);
    const search = await invoke(searcher, {
      query: "external secret",
      glob: `${relative}/external.txt`,
    });
    assert.deepStrictEqual(search.matches, []);
    const find = await invoke(finder, { glob: `${relative}/external.txt` });
    assert.deepStrictEqual(find.files, []);
    const parentLink = path.join(dir, "external-dir");
    await fs.symlink(outside, parentLink);
    assert.match(
      (await invoke(reader, { file: path.join(parentLink, "secret.txt") })).error,
      /symbolic link outside/,
    );
  });

  test("resolves multiple workspace roots and rejects URI decorations and sibling prefixes", () => {
    const roots = ["/one", "/two"].map((file, index) => ({
      uri: vscode.Uri.file(file),
      name: file,
      index,
    }));
    assert.strictEqual(
      resolveWorkspaceFile("src/a.ts", roots).fsPath,
      path.resolve("/one/src/a.ts"),
    );
    assert.strictEqual(
      resolveWorkspaceFile(path.resolve("/two/b.ts"), roots).fsPath,
      path.resolve("/two/b.ts"),
    );
    assert.throws(() => resolveWorkspaceFile(path.resolve("/two-else/b.ts"), roots), /inside/);
    assert.throws(
      () => resolveWorkspaceFile("file:///one/a.ts#L4", roots),
      /without a query or fragment/,
    );
  });

  test("rejects traversal in virtual URIs, including encoded dot segments", () => {
    const roots = [{ uri: vscode.Uri.parse("memory:/root/"), name: "virtual", index: 0 }];
    assert.strictEqual(resolveWorkspaceFile("memory:/root/code.ts", roots).path, "/root/code.ts");
    for (const file of [
      "memory:/root/../outside",
      "memory:/root/%2e%2e/outside",
      "memory:/root/sub/../../outside",
      "memory:/root/..%5coutside",
      "memory:/root/sub%5c..%5c..%5coutside",
    ]) {
      assert.throws(() => resolveWorkspaceFile(file, roots), /inside/);
    }
    const root = [{ uri: vscode.Uri.parse("memory:/"), name: "virtual", index: 0 }];
    assert.strictEqual(resolveWorkspaceFile("src/code.ts", root).path, "/src/code.ts");
  });

  test("validates malformed input and invalid line ranges", async () => {
    for (const input of [
      null,
      [],
      { glob: "../*" },
      { glob: "" },
      { maxResults: 201 },
      { maxResults: 0 },
    ]) {
      const result = await invoke(finder, input as never);
      assert.strictEqual(typeof result.error, "string");
    }
    for (const input of [
      { query: "" },
      { query: "a\nb" },
      { query: "x", caseSensitive: "yes" },
      { query: "x", maxResults: 101 },
    ]) {
      assert.strictEqual(typeof (await invoke(searcher, input as never)).error, "string");
    }
    for (const range of [
      { startLine: 0 },
      { startLine: 4, endLine: 3 },
      { endLine: 501 },
      { startLine: 99 },
      { startLine: 1.5 },
    ]) {
      assert.strictEqual(
        typeof (await invoke(reader, { file: `${relative}/code.ts`, ...range })).error,
        "string",
      );
    }
  });

  test("propagates cancellation before inspecting files", async () => {
    const cancelled = new vscode.CancellationTokenSource();
    cancelled.cancel();
    try {
      await assert.rejects(
        invoke(reader, { file: `${relative}/code.ts` }, cancelled.token),
        vscode.CancellationError,
      );
      await assert.rejects(invoke(finder, {}, cancelled.token), vscode.CancellationError);
      await assert.rejects(
        invoke(searcher, { query: "x" }, cancelled.token),
        vscode.CancellationError,
      );
    } finally {
      cancelled.dispose();
    }
  });
});
