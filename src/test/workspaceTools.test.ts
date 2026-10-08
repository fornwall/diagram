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
import { afterTest, cancellationSource, recordFilePaths, replace } from "./afterTest";
import { invokeTool as invoke } from "./toolText";

suite("workspaceTools", function () {
  // Each file search starts ripgrep processes, which can take seconds on a busy machine.
  this.timeout(10_000);
  let dir: string;
  let outside: string;
  let relative: string;
  const source = new vscode.CancellationTokenSource();
  const reader = new ReadWorkspaceFileTool();
  const finder = new FindWorkspaceFilesTool();
  const searcher = new SearchWorkspaceTextTool();

  /** Writes a file into the test folder, to be removed once the test ends. */
  async function writeFile(name: string, contents: string | Buffer): Promise<string> {
    const file = path.join(dir, name);
    await fs.writeFile(file, contents);
    afterTest(() => fs.rm(file, { force: true }));
    return file;
  }

  /** Makes a folder or a symbolic link in the test folder, to be removed once the test ends. */
  async function make(name: string, linkTo?: string): Promise<string> {
    const file = path.join(dir, name);
    await (linkTo === undefined ? fs.mkdir(file) : fs.symlink(linkTo, file));
    afterTest(() => fs.rm(file, { recursive: true, force: true }));
    return file;
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
    // As models write globs.
    assert.strictEqual(await invoke(finder, { glob: `./${relative}/*.ts` }), `${relative}/code.ts`);
    assert.strictEqual(
      await invoke(finder, { glob: `${relative}/` }),
      `No files match "${relative}/". To list the files in a folder, use the glob "${relative}/**".`,
    );
  });

  test("reads inclusive line ranges from relative paths and absolute URIs", async () => {
    assert.strictEqual(
      await invoke(reader, { file: `${relative}/code.ts`, startLine: 2, endLine: 3 }),
      `${relative}/code.ts, lines 2-3 of 5:\n2: const value = 'Needle';\n3: needle needle\nContinue with "startLine" 4.`,
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
    const file = await writeFile("pages.txt", "line\n".repeat(600));
    const page = (await invoke(reader, { file, startLine: 2, endLine: 1000 })).split("\n");
    assert.strictEqual(page[0], `${relative}/pages.txt, lines 2-501 of 601:`);
    assert.strictEqual(page.length, 502);
    assert.strictEqual(page.at(-1), 'Continue with "startLine" 502.');
  });

  test("fits whole lines and matches to the tokens it is given, and says where to continue", async () => {
    const file = await writeFile("budget.txt", "Needle line\n".repeat(100));
    const tokenizationOptions = {
      tokenBudget: 100,
      countTokens: async (text: string) => Math.ceil(text.length / 4),
    };
    const fitted = async (tool: vscode.LanguageModelTool<never>, input: object) => {
      const result = await tool.invoke(
        { input: input as never, toolInvocationToken: undefined, tokenizationOptions },
        source.token,
      );
      const text = (result?.content ?? [])
        .map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : ""))
        .join("");
      assert.ok(text.length <= 400, text);
      return text.split("\n");
    };
    const page = await fitted(reader, { file, endLine: 100 });
    const shown = page.length - 2;
    assert.ok(shown > 10, `${shown}`);
    assert.strictEqual(page[0], `${relative}/budget.txt, lines 1-${shown} of 101:`);
    assert.strictEqual(page.at(-1), `Continue with "startLine" ${shown + 1}.`);
    const found = await fitted(searcher, { query: "Needle", glob: `${relative}/budget.txt` });
    assert.match(
      found[0] ?? "",
      new RegExp(`^${found.length - 2} matches in 1 file .* Incomplete: .* size limit\\.`),
    );
    assert.strictEqual(found.at(-1), `  ${found.length - 2}: Needle line`);
  });

  test("leaves out the files that a conditional exclude hides, as their sibling exists", async () => {
    const files = vscode.workspace.getConfiguration("files");
    afterTest(() => files.update("exclude", undefined, vscode.ConfigurationTarget.Global));
    for (const name of ["compiled.ts", "compiled.js", ".dot.ts", ".dot.js", "plain.js"]) {
      await writeFile(name, "Needle");
    }
    for (const pattern of [
      "**/*.js",
      "**/*{.js,.map}",
      "**/*{.js,.js.map}",
      "**/{.dot,compiled}.js",
    ]) {
      const exclude = { [pattern]: { when: "$(basename).ts" } };
      await files.update("exclude", exclude, vscode.ConfigurationTarget.Global);
      assert.strictEqual(
        await invoke(finder, { glob: `${relative}/*.js` }),
        `${relative}/plain.js`,
        pattern,
      );
    }
  });

  test("fills result limits across overlapping workspace roots", async () => {
    const nested = await make("nested");
    const files = ["nested/a.ts", "nested/b.ts", "c.ts"].map((name) =>
      vscode.Uri.file(path.join(dir, name)),
    );
    for (const name of ["nested/a.ts", "nested/b.ts", "c.ts"]) await writeFile(name, "text");
    const roots = [nested, dir].map((file, index) => ({
      uri: vscode.Uri.file(file),
      name: path.basename(file),
      index,
    }));
    replace(vscode.workspace, "workspaceFolders", roots);
    replace(vscode.workspace, "findFiles", async (include, _exclude, maxResults) => {
      assert.ok(include instanceof vscode.RelativePattern);
      const matches = include.baseUri.fsPath === nested ? files.slice(0, 2) : files;
      return matches.slice(0, maxResults);
    });
    // Paths outside the first root are absolute, so that reading them is unambiguous.
    assert.strictEqual(
      await invoke(finder, { maxResults: 3 }),
      ["a.ts", "b.ts", files[2]?.fsPath].join("\n"),
    );
    assert.strictEqual(
      await invoke(finder, { maxResults: 2 }),
      "a.ts\nb.ts\nShowing the first 2 files; narrow the glob to see more.",
    );
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
    const file = await writeFile(
      "mixed-lines.txt",
      "first\r\nNeedle Needle\rskip\n\nNeedle end\r\nNeedle",
    );
    const result = await invoke(searcher, { query: "Needle", glob: `${relative}/mixed-lines.txt` });
    assert.deepStrictEqual(result.split("\n").slice(2), [
      "  2: Needle Needle",
      "  5: Needle end",
      "  6: Needle",
    ]);
    assert.strictEqual(
      await invoke(reader, { file, startLine: 3, endLine: 5 }),
      `${relative}/mixed-lines.txt, lines 3-5 of 6:\n3: skip\n4: \n5: Needle end\nContinue with "startLine" 6.`,
    );
  });

  test("bounds results in files with many short lines and preserves trailing empty lines", async () => {
    const file = await writeFile("many-lines.txt", `${"x\n".repeat(100_000)}Needle\n`);
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
    assert.match(full, /^No matches \(searched \d+ files; skipped 2 files: binary or over 1 MiB\)/);
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      await fs.chmod(await writeFile("denied.txt", "Needle"), 0);
      assert.match(
        await invoke(searcher, { query: "missing", glob: `${relative}/*` }),
        /; skipped 3 files: 2 binary or over 1 MiB, 1 unreadable\)/,
      );
    }
    assert.match(await invoke(reader, { file: path.join(dir, "binary.bin") }), /^Error: Binary/);
    assert.strictEqual(
      await invoke(reader, { file: path.join(dir, "large.txt"), endLine: 1 }),
      `${relative}/large.txt, lines 1-1 of 1:\n1: ${"X".repeat(1000)}… (1,048,577 characters)\nLines longer than 1,000 characters are cut.`,
    );
    const huge = await writeFile("huge.txt", "X".repeat(16 * 1024 * 1024 + 1));
    assert.strictEqual(
      await invoke(reader, { file: huge }),
      "Error: The file exceeds the 16 MiB text limit.",
    );
  });

  test("charges binary files against the total scan byte limit", async () => {
    const budgetDir = await make("budget");
    for (let i = 0; i < 17; i++) {
      await fs.writeFile(path.join(budgetDir, `${i}.bin`), Buffer.alloc(1024 * 1024));
    }
    assert.strictEqual(
      await invoke(searcher, { query: "missing", glob: `${relative}/budget/*` }),
      "No matches (searched 0 files; skipped 16 files: binary or over 1 MiB). Incomplete: the search stopped because it reached the 16 MiB scan limit. Narrow the glob or use a more specific query.",
    );
  });

  test("reads and searches text that is not UTF-8 in the encoding of files.encoding", async () => {
    const files = vscode.workspace.getConfiguration("files");
    await files.update("encoding", "iso88591", vscode.ConfigurationTarget.Global);
    afterTest(() => files.update("encoding", undefined, vscode.ConfigurationTarget.Global));
    const file = await writeFile("latin1.txt", Buffer.from("café Needle", "latin1"));
    assert.strictEqual(
      await invoke(reader, { file }),
      `${relative}/latin1.txt, lines 1-1 of 1:\n1: café Needle`,
    );
    assert.match(
      await invoke(searcher, { query: "café", glob: `${relative}/latin1.txt` }),
      /^1 match in 1 file/,
    );
  });

  test("reads and searches text with a stray byte as the editor shows it", async () => {
    const bytes = Buffer.concat([Buffer.from("café € 東京 "), Buffer.from([0xff])]);
    const file = await writeFile("stray.txt", bytes);
    assert.strictEqual(
      await invoke(reader, { file }),
      `${relative}/stray.txt, lines 1-1 of 1:\n1: café € 東京 \uFFFD`,
    );
    assert.match(
      await invoke(searcher, { query: "東京", glob: `${relative}/stray.txt` }),
      /^1 match in 1 file/,
    );
  });

  test("bounds long line output while keeping search matches visible", async () => {
    const read = (await invoke(reader, { file: path.join(dir, "long.txt") })).split("\n");
    assert.strictEqual(read[1], `1: ${"a".repeat(1000)}… (2,006 characters)`);
    assert.strictEqual(read.at(-1), "Lines longer than 1,000 characters are cut.");
    const search = await invoke(searcher, { query: "Needle", glob: `${relative}/long.txt` });
    assert.strictEqual(search.split("\n")[2], `  1: …${"a".repeat(200)}Needle`);
  });

  test("reads and searches unsaved editor changes", async () => {
    // Plain text, as opening a TypeScript file would start TypeScript's language features.
    const file = await writeFile("dirty.txt", "saved text");
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
      // Not saved: local history would copy the file after the test removes it.
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    }
  });

  test("rejects outside paths and symlinks escaping the workspace", async function () {
    assert.match(
      await invoke(reader, { file: path.join(outside, "secret.txt") }),
      /inside an open workspace/,
    );
    assert.match(await invoke(reader, { file: "../../../etc/passwd" }), /inside an open workspace/);
    if (process.platform === "win32") this.skip();
    const link = await make("external.txt", path.join(outside, "secret.txt"));
    assert.match(await invoke(reader, { file: link }), /symbolic link outside/);
    const search = await invoke(searcher, {
      query: "external secret",
      glob: `${relative}/external.txt`,
    });
    assert.match(
      search,
      /^No matches \(searched 0 files; skipped 1 file: linked outside the workspace\)/,
    );
    assert.strictEqual(
      await invoke(finder, { glob: `${relative}/external.txt` }),
      "Left out 1 file linked outside the workspace.",
    );
    // Links within the workspace can be read.
    const inside = await make("inside-link.ts", path.join(dir, "code.ts"));
    assert.match(await invoke(reader, { file: inside }), /\n1: first\n/);
  });

  test("follows links one name at a time, touching no target outside the workspace", async function () {
    if (process.platform === "win32") this.skip();
    await make("hop.ts", "next.ts");
    await make("next.ts", "code.ts");
    const links = [await make("out", outside), await make("up", path.relative(dir, outside))];
    const loop = await make("loop.ts", "loop.ts");
    const paths = recordFilePaths();
    assert.match(await invoke(reader, { file: path.join(dir, "hop.ts") }), /\n1: first\n/);
    for (const link of links) {
      const file = path.join(link, "secret.txt");
      assert.match(await invoke(reader, { file }), /symbolic link outside/);
    }
    assert.match(await invoke(reader, { file: loop }), /too many symbolic links/);
    // Nor through the links, as realpath would.
    assert.deepStrictEqual(
      paths.filter((file) => file.startsWith(outside) || file.endsWith("secret.txt")),
      [],
    );
  });

  test('follows ".." in a link target from where the link before it leads', async function () {
    if (process.platform === "win32") this.skip();
    await fs.mkdir(path.join(outside, "inner"), { recursive: true });
    // A decoy for the target read by its text.
    await writeFile("secret.txt", "decoy");
    await make("b", path.join(outside, "inner"));
    const away = await make("a", "b/../secret.txt");
    await make("sub");
    await make("in", "sub");
    const back = await make("back", "in/../code.ts");
    const paths = recordFilePaths();
    assert.match(await invoke(reader, { file: away }), /symbolic link outside/);
    assert.match(await invoke(reader, { file: back }), /\n1: first\n/);
    assert.deepStrictEqual(
      paths.filter((file) => file.startsWith(outside)),
      [],
    );
  });

  test("resolves no path outside the workspace, which could reach a network share", async function () {
    if (process.platform === "win32") this.skip();
    const roots = vscode.workspace.workspaceFolders ?? [];
    const check = boundary(roots, source.token);
    const inward = path.join(outside, "inward.ts");
    await fs.symlink(path.join(dir, "code.ts"), inward);
    afterTest(() => fs.rm(inward));
    const paths = recordFilePaths();
    for (const file of [
      path.join(outside, "secret.txt"),
      path.join(outside, "missing.txt"),
      inward,
      "file://attacker.example/share/code.ts",
    ]) {
      assert.match(await invoke(reader, { file }), /inside an open workspace/);
      await assert.rejects(
        check(file.startsWith("file:") ? vscode.Uri.parse(file) : vscode.Uri.file(file)),
        /^Error: The file is outside/,
      );
    }
    assert.deepStrictEqual(
      paths.filter((file) => file.startsWith(outside) || file.includes("attacker.example")),
      [],
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
    // A colon makes a URI only before "/", as in "file:/", and not after a drive letter.
    for (const file of ["a:b.md", "notes:2024.md"]) {
      assert.strictEqual(resolveWorkspaceFile(file, roots).fsPath, path.resolve("/one", file));
    }
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

  test("resolves absolute paths in virtual workspace roots", () => {
    const roots = ["one", "two"].map((name, index) => ({
      uri: vscode.Uri.parse(`vscode-vfs://github/owner/${name}`),
      name,
      index,
    }));
    assert.strictEqual(
      resolveWorkspaceFile("/owner/two/src/b.ts", roots).toString(),
      "vscode-vfs://github/owner/two/src/b.ts",
    );
    assert.throws(() => resolveWorkspaceFile("/owner/three/c.ts", roots), /inside/);
  });

  test("names files relative to a virtual workspace folder whose path has '.' and '..'", async () => {
    const unsupported = () => {
      throw vscode.FileSystemError.NoPermissions();
    };
    const provider = vscode.workspace.registerFileSystemProvider("diagram-dots", {
      onDidChangeFile: new vscode.EventEmitter<vscode.FileChangeEvent[]>().event,
      stat: (uri) => ({
        type: uri.path.endsWith(".ts") ? vscode.FileType.File : vscode.FileType.Directory,
        ctime: 0,
        mtime: 0,
        size: 4,
      }),
      watch: () => new vscode.Disposable(() => {}),
      readDirectory: unsupported,
      createDirectory: unsupported,
      readFile: () => Buffer.from("text"),
      writeFile: unsupported,
      delete: unsupported,
      rename: unsupported,
    });
    afterTest(() => provider.dispose());
    const root = vscode.Uri.parse("diagram-dots:/owner/x/../one/./");
    replace(vscode.workspace, "workspaceFolders", [{ uri: root, name: "one", index: 0 }]);
    replace(vscode.workspace, "findFiles", async () => [
      vscode.Uri.parse("diagram-dots:/owner/one/src/a.ts"),
    ]);
    assert.strictEqual(await invoke(finder, {}), "src/a.ts");
    assert.strictEqual(
      await invoke(reader, { file: "src/a.ts" }),
      "src/a.ts, lines 1-1 of 1:\n1: text",
    );
    assert.match(await invoke(reader, { file: "src" }), /the glob "src\/\*\*"\.$/);
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

  test("rejects malformed input, and line ranges outside the file", async () => {
    for (const input of [
      null,
      [],
      { glob: "../*" },
      { glob: "" },
      { maxResults: 201 },
      { maxResults: 0 },
    ]) {
      assert.match(await invoke(finder, input), /^Error: /);
    }
    for (const input of [
      { query: "" },
      { query: "a\nb" },
      { query: "x", caseSensitive: "yes" },
      { query: "x", maxResults: 101 },
    ]) {
      assert.match(await invoke(searcher, input), /^Error: /);
    }
    assert.match(
      await invoke(finder, { glob: `${relative}/code.ts`, maxResults: null }),
      /code\.ts$/,
    );
    assert.strictEqual(
      await invoke(finder, { pattern: "*.ts" }),
      'Error: Unknown property "pattern"; the properties are "glob", "maxResults".',
    );
    assert.strictEqual(
      await invoke(reader, { file: relative }),
      `Error: ${relative} is a folder, not a file. List its files with diagram_findFiles and the glob "${relative}/**".`,
    );
    // Folder names such as Next.js's "[id]" are matched literally.
    await make("[id]");
    await writeFile("[id]/page.ts", "");
    await make("i");
    await writeFile("i/other.ts", "");
    const glob = `${relative}/[[]id[]]/**`;
    assert.strictEqual(
      await invoke(reader, { file: `${relative}/[id]` }),
      `Error: ${relative}/[id] is a folder, not a file. List its files with diagram_findFiles and the glob "${glob}".`,
    );
    assert.strictEqual(await invoke(finder, { glob }), `${relative}/[id]/page.ts`);
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

  test("say in chat what they look for, whatever the input", () => {
    const message = <T>(tool: vscode.LanguageModelTool<T>, input: unknown) =>
      tool.prepareInvocation?.({ input: input as T }, source.token);
    assert.deepStrictEqual(
      [
        message(finder, { glob: "src/**" }),
        message(searcher, { query: "parse(", glob: "**/*.ts" }),
        message(searcher, { query: "parse(" }),
        message(reader, { file: "src/a.ts", startLine: 10, endLine: 40 }),
        message(reader, { file: "src/a.ts", startLine: 10 }),
      ].map((prepared) => (prepared as vscode.PreparedToolInvocation).invocationMessage),
      [
        'Finding workspace files matching "src/**"',
        'Searching files matching "**/*.ts" for "parse("',
        'Searching the workspace for "parse("',
        'Reading "src/a.ts", lines 10-40',
        'Reading "src/a.ts" from line 10',
      ],
    );
    for (const input of [null, 42, { glob: 7, query: [], file: {} }]) {
      assert.deepStrictEqual(
        [finder, searcher, reader].map(
          (tool) => (message(tool, input) as vscode.PreparedToolInvocation).invocationMessage,
        ),
        ["Finding workspace files", "Searching workspace text", "Reading a workspace file"],
      );
    }
  });

  test("say what they would read when asking in an untrusted workspace", () => {
    replace(vscode.workspace, "isTrusted", false);
    const query = `${"a".repeat(80)}*b`;
    const prepared = searcher.prepareInvocation({ input: { query, glob: "**/*.ts" } });
    const message = prepared.confirmationMessages?.message;
    assert.ok(message instanceof vscode.MarkdownString);
    assert.ok(
      message.value.includes(
        `\n\`\`\`text\nSearching files matching "**/*.ts" for "${query}"\n\`\`\``,
      ),
      message.value,
    );
    assert.match(String(prepared.invocationMessage), /"a{80}…"$/);
  });

  test("propagates cancellation before inspecting files", async () => {
    const cancelled = cancellationSource();
    cancelled.cancel();
    await assert.rejects(
      invoke(reader, { file: `${relative}/code.ts` }, cancelled.token),
      vscode.CancellationError,
    );
    await assert.rejects(invoke(finder, {}, cancelled.token), vscode.CancellationError);
    await assert.rejects(
      invoke(searcher, { query: "x" }, cancelled.token),
      vscode.CancellationError,
    );
  });
});
