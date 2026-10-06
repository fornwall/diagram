import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  boundary,
  FindWorkspaceFilesTool,
  ReadWorkspaceFileTool,
  resolveWorkspaceFile,
  SearchWorkspaceTextTool,
} from "../workspaceTools";
import { toolText } from "./toolText";

suite("workspace tools", function () {
  // Each file search starts ripgrep processes, which can take seconds on a busy machine.
  this.timeout(10_000);
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
    return toolText(result);
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
    assert.strictEqual(
      await invoke(finder, { glob: `${relative}/**/*.ts` }),
      `${relative}/code.ts`,
    );
    const bounded = (await invoke(finder, { glob: `${relative}/*`, maxResults: 1 })).split("\n");
    assert.strictEqual(bounded.length, 2);
    assert.strictEqual(bounded[1], "Showing the first 1 file; narrow the glob to see more.");
    assert.strictEqual(
      await invoke(finder, { glob: `${relative}/*.missing` }),
      `No files match "${relative}/*.missing".`,
    );
  });

  test("reads inclusive line ranges from relative paths and absolute URIs", async () => {
    assert.strictEqual(
      await invoke(reader, { file: `${relative}/code.ts`, startLine: 2, endLine: 3 }),
      `${relative}/code.ts, lines 2-3 of 5:\n2: const value = 'Needle';\n3: needle needle\nContinue with startLine 4.`,
    );
    assert.strictEqual(
      await invoke(reader, {
        file: vscode.Uri.file(path.join(dir, "code.ts")).toString(),
        startLine: 4,
        endLine: 500,
      }),
      `${relative}/code.ts, lines 4-5 of 5:\n4: last\n5: `,
    );
  });

  test("reads at most 500 lines and says where to continue", async () => {
    const file = path.join(dir, "pages.txt");
    await fs.writeFile(file, "line\n".repeat(600));
    const page = (await invoke(reader, { file, startLine: 2, endLine: 1000 })).split("\n");
    assert.strictEqual(page[0], `${relative}/pages.txt, lines 2-501 of 601:`);
    assert.strictEqual(page.length, 502);
    assert.strictEqual(page.at(-1), "Continue with startLine 502.");
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
      // Paths outside the first root are absolute, so that reading them is unambiguous.
      assert.strictEqual(
        await invoke(finder, { maxResults: 3 }),
        ["a.ts", "b.ts", files[2]?.fsPath].join("\n"),
      );
      assert.strictEqual(
        await invoke(finder, { maxResults: 2 }),
        "a.ts\nb.ts\nShowing the first 2 files; narrow the glob to see more.",
      );
    } finally {
      vscode.workspace.findFiles = findFiles;
      Object.defineProperty(vscode.workspace, "workspaceFolders", descriptor);
    }
  });

  test("searches literal text with accurate lines and case control", async () => {
    assert.strictEqual(
      await invoke(searcher, { query: "needle", glob: `${relative}/code.ts` }),
      `2 matches in 1 file (searched 1 file).\n${relative}/code.ts\n  2: const value = 'Needle';\n  3: needle needle`,
    );
    const exact = await invoke(searcher, {
      query: "Needle",
      glob: `${relative}/code.ts`,
      caseSensitive: true,
    });
    assert.match(exact, /^1 match in 1 file/);
    const literal = await invoke(searcher, { query: "a.*[x]", glob: `${relative}/literal.txt` });
    assert.match(literal, /^1 match in 1 file.*\n.*\n {2}1: special a\.\*\[x\] here$/);
    const unicode = await invoke(searcher, { query: "Needle", glob: `${relative}/literal.txt` });
    assert.match(unicode, /\n {2}2: İ first Needle then needle$/);
  });

  test("keeps line and preview boundaries across mixed line endings and repeated matches", async () => {
    const file = path.join(dir, "mixed-lines.txt");
    await fs.writeFile(file, "first\r\nNeedle Needle\rskip\n\nNeedle end\r\nNeedle");
    const result = await invoke(searcher, { query: "Needle", glob: `${relative}/mixed-lines.txt` });
    assert.deepStrictEqual(result.split("\n").slice(2), [
      "  2: Needle Needle",
      "  5: Needle end",
      "  6: Needle",
    ]);
    assert.strictEqual(
      await invoke(reader, { file, startLine: 3, endLine: 5 }),
      `${relative}/mixed-lines.txt, lines 3-5 of 6:\n3: skip\n4: \n5: Needle end\nContinue with startLine 6.`,
    );
  });

  test("bounds results in files with many short lines and preserves trailing empty lines", async () => {
    const file = path.join(dir, "many-lines.txt");
    await fs.writeFile(file, `${"x\n".repeat(100_000)}Needle\n`);
    const search = await invoke(searcher, { query: "Needle", glob: `${relative}/many-lines.txt` });
    assert.match(search, /\n {2}100001: Needle$/);
    assert.strictEqual(
      await invoke(reader, { file, startLine: 100_001, endLine: 100_002 }),
      `${relative}/many-lines.txt, lines 100001-100002 of 100002:\n100001: Needle\n100002: `,
    );
    const bounded = await invoke(searcher, {
      query: "x",
      glob: `${relative}/many-lines.txt`,
      maxResults: 1,
    });
    assert.strictEqual(
      bounded,
      `1 match in 1 file (searched 1 file). Incomplete: the search stopped because it reached 1 match. Narrow the glob or use a more specific query.\n${relative}/many-lines.txt\n  1: x`,
    );
  });

  test("reports result limits and skipped binary or oversized files", async () => {
    const limited = await invoke(searcher, {
      query: "needle",
      glob: `${relative}/code.ts`,
      maxResults: 1,
    });
    assert.match(limited, /^1 match in 1 file .* Incomplete: .*\n.*\n {2}2: [^\n]+$/);
    const full = await invoke(searcher, { query: "missing", glob: `${relative}/*` });
    assert.match(full, /^No matches \(searched \d+ files; skipped [2-9] files: binary/);
    assert.match(await invoke(reader, { file: path.join(dir, "binary.bin") }), /^Error: Binary/);
    assert.match(await invoke(reader, { file: path.join(dir, "large.txt") }), /^Error: .*1 MiB/);
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
      assert.strictEqual(
        await invoke(searcher, { query: "missing", glob: `${relative}/budget/*` }),
        "No matches (searched 0 files; skipped 16 files: binary, not UTF-8 or UTF-16, over 1 MiB or linked outside the workspace). Incomplete: the search stopped because it reached the 16 MiB scan limit. Narrow the glob or use a more specific query.",
      );
    } finally {
      await fs.rm(budgetDir, { recursive: true, force: true });
    }
  });

  test("bounds long line output while keeping search matches visible", async () => {
    const read = (await invoke(reader, { file: path.join(dir, "long.txt") })).split("\n");
    assert.strictEqual(read[1], `1: ${"a".repeat(1000)}… (2006 characters)`);
    assert.strictEqual(read.at(-1), "Lines longer than 1000 characters are cut.");
    const search = await invoke(searcher, { query: "Needle", glob: `${relative}/long.txt` });
    assert.strictEqual(search.split("\n")[2], `  1: …${"a".repeat(200)}Needle`);
  });

  test("reads and searches unsaved editor changes", async () => {
    // Plain text, as opening a TypeScript file would start TypeScript's language features.
    const file = path.join(dir, "dirty.txt");
    await fs.writeFile(file, "saved text");
    const document = await vscode.workspace.openTextDocument(file);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, new vscode.Position(0, 0), "unsaved Needle\n");
    assert.ok(await vscode.workspace.applyEdit(edit));
    try {
      assert.strictEqual(
        await invoke(reader, { file }),
        `${relative}/dirty.txt, lines 1-2 of 2, with unsaved changes:\n1: unsaved Needle\n2: saved text`,
      );
      const search = await invoke(searcher, { query: "Needle", glob: `${relative}/dirty.txt` });
      assert.match(search, /\n.*dirty\.txt \(unsaved changes\)\n {2}1: unsaved Needle$/);
    } finally {
      await document.save();
    }
  });

  test("rejects outside paths and symlinks escaping the workspace", async function () {
    assert.match(
      await invoke(reader, { file: path.join(outside, "secret.txt") }),
      /inside an open workspace/,
    );
    assert.match(await invoke(reader, { file: "../../../etc/passwd" }), /inside an open workspace/);
    if (process.platform === "win32") this.skip();
    const link = path.join(dir, "external.txt");
    await fs.symlink(path.join(outside, "secret.txt"), link);
    assert.match(await invoke(reader, { file: link }), /symbolic link outside/);
    const search = await invoke(searcher, {
      query: "external secret",
      glob: `${relative}/external.txt`,
    });
    assert.match(search, /^No matches \(searched 0 files; skipped 1 file: /);
    assert.strictEqual(
      await invoke(finder, { glob: `${relative}/external.txt` }),
      "Left out 1 file linked outside the workspace.",
    );
    const parentLink = path.join(dir, "external-dir");
    await fs.symlink(outside, parentLink);
    assert.match(
      await invoke(reader, { file: path.join(parentLink, "secret.txt") }),
      /symbolic link outside/,
    );
    // Links within the workspace can be read.
    const inside = path.join(dir, "inside-link.ts");
    await fs.symlink(path.join(dir, "code.ts"), inside);
    assert.match(await invoke(reader, { file: inside }), /\n1: first\n/);
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

  test("refuses symbolic links that a filesystem provider reports, also of parent directories", async () => {
    const types = new Map<string, vscode.FileType>([
      ["/root/plain.txt", vscode.FileType.File],
      ["/root/sub", vscode.FileType.Directory],
      ["/root/sub/plain.txt", vscode.FileType.File],
      ["/root/link.txt", vscode.FileType.File | vscode.FileType.SymbolicLink],
      ["/root/linked", vscode.FileType.Directory | vscode.FileType.SymbolicLink],
      ["/root/linked/plain.txt", vscode.FileType.File],
    ]);
    const stats: string[] = [];
    const unsupported = () => {
      throw vscode.FileSystemError.NoPermissions();
    };
    const provider = vscode.workspace.registerFileSystemProvider("diagram-links", {
      onDidChangeFile: new vscode.EventEmitter<vscode.FileChangeEvent[]>().event,
      stat: (uri) => {
        stats.push(uri.path);
        const type = types.get(uri.path);
        if (type === undefined) throw vscode.FileSystemError.FileNotFound(uri);
        return { type, ctime: 0, mtime: 0, size: 0 };
      },
      watch: () => new vscode.Disposable(() => {}),
      readDirectory: unsupported,
      createDirectory: unsupported,
      readFile: unsupported,
      writeFile: unsupported,
      delete: unsupported,
      rename: unsupported,
    });
    try {
      const root = vscode.Uri.parse("diagram-links:/root");
      const check = boundary([{ uri: root, name: "links", index: 0 }], source.token);
      const at = (file: string) => check(vscode.Uri.joinPath(root, file));
      await at("plain.txt");
      await at("sub/plain.txt");
      // Each directory is checked once per call.
      assert.deepStrictEqual(stats, ["/root/plain.txt", "/root/sub/plain.txt", "/root/sub"]);
      await at("sub/plain.txt");
      assert.strictEqual(stats.length, 3);
      for (const file of ["link.txt", "linked/plain.txt"]) {
        await assert.rejects(at(file), /^Error: Symbolic links cannot be read safely/, file);
      }
      await assert.rejects(at("missing.txt"), vscode.FileSystemError);
      await assert.rejects(
        check(vscode.Uri.parse("diagram-links:/elsewhere/plain.txt")),
        /outside the workspace folders/,
      );
    } finally {
      provider.dispose();
    }
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
      assert.match(await invoke(finder, input as never), /^Error: /);
    }
    for (const input of [
      { query: "" },
      { query: "a\nb" },
      { query: "x", caseSensitive: "yes" },
      { query: "x", maxResults: 101 },
    ]) {
      assert.match(await invoke(searcher, input as never), /^Error: /);
    }
    assert.match(
      await invoke(finder, { glob: `${relative}/code.ts`, maxResults: null } as never),
      /code\.ts$/,
    );
    assert.strictEqual(
      await invoke(finder, { pattern: "*.ts" } as never),
      'Error: Unknown property "pattern"; the properties are "glob", "maxResults".',
    );
    assert.strictEqual(
      await invoke(reader, { file: relative }),
      `Error: ${relative} is a folder, not a file. List its files with diagram_findFiles and the glob "${relative}/**".`,
    );
    assert.strictEqual(
      await invoke(reader, { file: `${relative}/missing.ts` }),
      `Error: ${relative}/missing.ts does not exist.`,
    );
    for (const range of [
      { startLine: 0 },
      { startLine: 4, endLine: 3 },
      { startLine: 99 },
      { startLine: 1.5 },
    ]) {
      assert.match(await invoke(reader, { file: `${relative}/code.ts`, ...range }), /^Error: /);
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
