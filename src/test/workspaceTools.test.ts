import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  boundary,
  cacheIgnoreFiles,
  FindWorkspaceFilesTool,
  IGNORE_FILES_KEPT_MS,
  ReadWorkspaceFileTool,
  resolveWorkspaceFile,
  SearchWorkspaceTextTool,
} from "../workspaceTools";
import {
  afterTest,
  cancellationSource,
  fileSystem,
  folders,
  recordFilePaths,
  replace,
  setting,
  suiteTempDir,
  workspaceRoot,
} from "./afterTest";
import { invokeTool as invoke } from "./toolText";

suite("workspaceTools", function () {
  // Each file search starts ripgrep processes, which can take seconds on a busy machine.
  this.timeout(10_000);
  let dir: string;
  const outside = suiteTempDir("diagram-outside-");
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

  /** Makes the test folder the one workspace folder until the test ends. */
  function onlyTestFolder(): void {
    replace(vscode.workspace, "workspaceFolders", folders(dir));
  }

  suiteSetup(async () => {
    const root = workspaceRoot();
    dir = await fs.mkdtemp(path.join(root.uri.fsPath, "workspace-tools-"));
    relative = path.basename(dir);
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
  });

  test("finds bounded workspace paths and respects default exclusions", async () => {
    assert.strictEqual(
      await invoke(finder, { glob: `${relative}/**/*.ts` }),
      `${relative}/code.ts`,
    );
    assert.strictEqual(
      await invoke(finder, { glob: `${relative}/*.txt` }),
      ["large", "literal", "long"].map((name) => `${relative}/${name}.txt`).join("\n"),
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
    // As models write globs, that match only in the workspace folder itself.
    assert.strictEqual(
      await invoke(searcher, { query: "Needle", glob: relative }),
      `No matches (searched 0 files). No files match "${relative}". To list the files in a folder, use the glob "${relative}/**".`,
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
      const text = await invoke(tool, input, source.token, tokenizationOptions);
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

    // What plainly fits is not counted.
    tokenizationOptions.tokenBudget = 100_000;
    tokenizationOptions.countTokens = async () => assert.fail("counted");
    assert.strictEqual((await fitted(reader, { file, endLine: 3 })).length, 5);
  });

  test("reports when even one result or empty-result metadata exceeds the token budget", async () => {
    const file = await writeFile("budget-long.txt", "Needle ".repeat(100));
    const options = { tokenBudget: 100, countTokens: async (text: string) => text.length };
    for (const [tool, input] of [
      [reader, { file }],
      [searcher, { query: "Needle", glob: `${relative}/budget-long.txt` }],
      [finder, { glob: `${relative}/${"missing".repeat(40)}` }],
    ] as const) {
      const text = await invoke(tool, input, source.token, options);
      assert.strictEqual(text, "Result exceeds the token budget. Retry with a larger budget.");
      assert.ok(text.length <= options.tokenBudget);
      assert.strictEqual(
        await invoke(tool, input, source.token, { ...options, tokenBudget: 1 }),
        "",
      );
    }
  });

  test("cancels while waiting for token counts, including when fitting a smaller page", async () => {
    for (const stalledCall of [1, 2]) {
      const cancelled = cancellationSource();
      let calls = 0;
      const counting = Promise.withResolvers<void>();
      const pending = invoke(reader, { file: `${relative}/code.ts` }, cancelled.token, {
        tokenBudget: 1,
        countTokens: async () => {
          if (++calls < stalledCall) return 2;
          counting.resolve();
          return new Promise<number>(() => {});
        },
      });
      await counting.promise;
      cancelled.cancel();
      await assert.rejects(pending, vscode.CancellationError);
    }
  });

  test("leaves out the files that a conditional exclude hides, as their sibling exists", async () => {
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
      await setting("files.exclude", exclude);
      assert.strictEqual(
        await invoke(finder, { glob: `${relative}/*.js` }),
        `${relative}/plain.js`,
        pattern,
      );
    }
  });

  test("leaves out what .gitignore files ignore, unless search.useIgnoreFiles is off", async () => {
    onlyTestFolder();
    await writeFile(
      ".gitignore",
      "# output\n*.log\n/ignore/out/\ncache\n!keep.log\n\\#odd\n/ignore/build/\n!/ignore/build/keep.ts\n",
    );
    await make("ignore");
    for (const folder of ["out", "cache", "build", "sub", "sub/out", "sub/deep"]) {
      await make(`ignore/${folder}`);
    }
    await writeFile("ignore/sub/.gitignore", "out/\n!*.log\n/top.ts\n");
    const files = ["a.log", "build/keep.ts", "cache/c.ts", "keep.log", "main.ts", "out/x.js"];
    const nested = ["sub/b.log", "sub/cache", "sub/deep/top.ts", "sub/out/y.js", "sub/top.ts"];
    for (const name of [...files, ...nested]) await writeFile(`ignore/${name}`, "");
    assert.strictEqual(
      await invoke(finder, { glob: "ignore/**" }),
      ["keep.log", "main.ts", "sub/.gitignore", "sub/b.log", "sub/deep/top.ts"]
        .map((name) => `ignore/${name}`)
        .join("\n"),
    );
    // Searches leave them out too.
    assert.match(
      await invoke(searcher, { query: "out/", glob: "ignore/**" }),
      /^1 match in 1 file \(searched 5 files\)\.\nignore\/sub\/\.gitignore\n {2}1: out\/$/,
    );
    await setting("search.useIgnoreFiles", false);
    assert.strictEqual(
      await invoke(finder, { glob: "ignore/**" }),
      [...files, ...nested, "sub/.gitignore"]
        .sort()
        .map((name) => `ignore/${name}`)
        .join("\n"),
    );
  });

  test("looks for no ignore files in what the top-level one ignores, nor reads them", async () => {
    onlyTestFolder();
    await writeFile(".gitignore", "vendor/\nout*/\n!outlier\n*.log\n");
    for (const folder of ["vendor", "vendor/lib", "out1"]) await make(folder);
    // Read, either would let "!" include again what "*.log" ignores.
    await writeFile("vendor/lib/.gitignore", "!*.log\n");
    await writeFile("out1/.gitignore", "!*.log\n");
    await writeFile("a.log", "");
    const excludes: string[][] = [];
    const findFiles = vscode.workspace.findFiles;
    replace(vscode.workspace, "findFiles", (include, exclude, ...rest) => {
      excludes.push(String(exclude).split(/[{},]/));
      return findFiles(include, exclude, ...rest);
    });
    assert.strictEqual(
      await invoke(finder, { glob: "*.log" }),
      'No files match "*.log". A glob matches from the workspace folder: "**/*.log" matches at any depth.',
    );
    const [found, searched] = excludes;
    // "out*/" is no exclude, as "!outlier" could include a folder it matches again.
    assert.ok(found?.includes("**/vendor/**") && !found.includes("**/out*/**"), String(found));
    assert.ok(searched?.includes("**/*.log"), String(searched));
  });

  test("reads no ignore file through a link outside the workspace", async function () {
    if (process.platform === "win32") this.skip();
    onlyTestFolder();
    await fs.writeFile(path.join(outside, ".gitignore"), "*.ts\n");
    await make(".gitignore", path.join(outside, ".gitignore"));
    await make("external", outside);
    const findFiles = vscode.workspace.findFiles;
    replace(vscode.workspace, "findFiles", (include, ...rest) =>
      include instanceof vscode.RelativePattern && include.pattern === "**/.gitignore"
        ? Promise.resolve([vscode.Uri.file(path.join(dir, "external", ".gitignore"))])
        : findFiles(include, ...rest),
    );
    const readFile = vscode.workspace.fs.readFile;
    const reads: string[] = [];
    replace(vscode.workspace, "fs", {
      ...vscode.workspace.fs,
      readFile: (uri) => {
        reads.push(uri.fsPath);
        return readFile(uri);
      },
    });
    assert.strictEqual(await invoke(finder, { glob: "*.ts" }), "code.ts");
    assert.deepStrictEqual(reads, []);
  });

  test("reads ignore files linked within the workspace", async function () {
    if (process.platform === "win32") this.skip();
    onlyTestFolder();
    const file = await writeFile("rules.ignore", "*.ts\n");
    await make(".gitignore", file);
    assert.match(await invoke(finder, { glob: "*.ts" }), /^No files match/);
  });

  test("skips oversized ignore files before reading them", async () => {
    onlyTestFolder();
    const file = await writeFile(".gitignore", `*.ts\n${"#".repeat(1024 * 1024)}`);
    const readFile = vscode.workspace.fs.readFile;
    const reads: string[] = [];
    replace(vscode.workspace, "fs", {
      ...vscode.workspace.fs,
      readFile: (uri) => {
        reads.push(uri.fsPath);
        return readFile(uri);
      },
    });
    assert.strictEqual(await invoke(finder, { glob: "*.ts" }), "code.ts");
    assert.ok(!reads.includes(file), "must check the size before reading");
  });

  test("finds files where the ignore files ignore more than a search can exclude", async () => {
    onlyTestFolder();
    // Excluded in full, these would make arguments of ripgrep too long to start it with.
    const names = Array.from({ length: 3000 }, (_, index) => `generated-${index}`);
    await writeFile(
      ".gitignore",
      [...names.map((name) => `${name}.ts`), ...names.map((name) => `${name}/`)].join("\n"),
    );
    await make("many");
    await make("many/generated-2999");
    for (const name of ["kept.ts", "generated-0.ts", "generated-2999.ts", "generated-2999/a.ts"]) {
      await writeFile(`many/${name}`, "");
    }
    assert.strictEqual(await invoke(finder, { glob: "many/**" }), "many/kept.ts");
  });

  test("reads as many nested ignore files when those in ignored folders are found too", async () => {
    onlyTestFolder();
    await writeFile(".gitignore", "vendor/\n");
    await make("real");
    await writeFile("real/.gitignore", "*.tmp\n");
    for (const name of ["a.ts", "b.tmp"]) await writeFile(`real/${name}`, "");
    // As where the exclude cannot say all that the top-level one ignores, and findFiles returns
    // files in no fixed order.
    const vendored = Array.from({ length: 1500 }, (_, index) =>
      vscode.Uri.file(path.join(dir, "vendor", `p${index}`, ".gitignore")),
    );
    const findFiles = vscode.workspace.findFiles;
    replace(vscode.workspace, "findFiles", async (include, exclude, maxResults, token) => {
      const found = await findFiles(include, exclude, maxResults, token);
      if (!(include instanceof vscode.RelativePattern) || include.pattern !== "**/.gitignore") {
        return found;
      }
      return [...vendored, ...found].slice(0, maxResults);
    });
    assert.strictEqual(await invoke(finder, { glob: "real/**" }), "real/.gitignore\nreal/a.ts");
  });

  test("reads nested ignore files that the top-level one ignores, as git does", async () => {
    onlyTestFolder();
    await writeFile(".gitignore", ".*\n");
    await make("dotted");
    await make("dotted/.hidden");
    await writeFile("dotted/.gitignore", "*.tmp\n");
    for (const name of ["a.tmp", "b.ts", ".hidden/c.ts"]) await writeFile(`dotted/${name}`, "");
    assert.strictEqual(await invoke(finder, { glob: "dotted/**" }), "dotted/b.ts");
  });

  test("bounds concurrent ignore-file reads across a wide workspace", async () => {
    const root = vscode.Uri.parse("diagram-wide:/root");
    const ignores = Array.from({ length: 24 }, (_, index) =>
      vscode.Uri.joinPath(root, `p${index}`, ".gitignore"),
    );
    let active = 0;
    let peak = 0;
    let read = 0;
    fileSystem("diagram-wide", {
      stat: (uri) => ({
        type: uri.path.endsWith(".gitignore") ? vscode.FileType.File : vscode.FileType.Directory,
        ctime: 0,
        mtime: 0,
        size: 6,
      }),
      readFile: async (uri) => {
        if (uri.path === "/root/.gitignore") return new Uint8Array();
        peak = Math.max(peak, ++active);
        read++;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        active--;
        return Buffer.from("*.tmp\n");
      },
    });
    replace(vscode.workspace, "workspaceFolders", folders(root));
    replace(vscode.workspace, "findFiles", async (include) =>
      include instanceof vscode.RelativePattern && include.pattern === "**/.gitignore"
        ? ignores
        : [vscode.Uri.joinPath(root, "p0/a.ts"), vscode.Uri.joinPath(root, "p0/b.tmp")],
    );
    assert.strictEqual(await invoke(finder, {}), "p0/a.ts");
    assert.strictEqual(read, ignores.length);
    assert.ok(peak > 1 && peak <= 8, `${peak} concurrent reads`);
  });

  test("keeps the ignore files found until one changes, or for a while, when caching them", async function () {
    // Each call starts ripgrep.
    this.timeout(30_000);
    // The watcher tells of changes as the test says: VS Code's misses some, and tells of those of
    // other tests.
    const watched: string[] = [];
    const created = new vscode.EventEmitter<vscode.Uri>();
    afterTest(() => created.dispose());
    const none = new vscode.EventEmitter<vscode.Uri>().event;
    replace(vscode.workspace, "createFileSystemWatcher", ((glob: string) => {
      watched.push(glob);
      return { onDidCreate: created.event, onDidChange: none, onDidDelete: none, dispose() {} };
    }) as unknown as typeof vscode.workspace.createFileSystemWatcher);
    let now = 0;
    const caching = cacheIgnoreFiles(() => now);
    afterTest(() => caching.dispose());
    assert.deepStrictEqual(watched, ["**/.gitignore"]);
    onlyTestFolder();
    await make("cached");
    await writeFile("cached/a.log", "");
    await writeFile("cached/b.ts", "");
    let searches = 0;
    const findFiles = vscode.workspace.findFiles;
    replace(vscode.workspace, "findFiles", (include, ...rest) => {
      if (include instanceof vscode.RelativePattern && include.pattern === "**/.gitignore") {
        searches++;
      }
      return findFiles(include, ...rest);
    });
    const listed = () => invoke(finder, { glob: "cached/**" });
    assert.strictEqual(await listed(), "cached/a.log\ncached/b.ts");
    // Until the watcher tells of a change, also of one it would not have told of.
    const ignore = await writeFile("cached/.gitignore", "*.log\n");
    now += IGNORE_FILES_KEPT_MS;
    assert.strictEqual(await listed(), "cached/.gitignore\ncached/a.log\ncached/b.ts");
    assert.strictEqual(searches, 1);
    created.fire(vscode.Uri.file(ignore));
    assert.strictEqual(await listed(), "cached/.gitignore\ncached/b.ts");
    assert.strictEqual(searches, 2);
    // Nor for longer than a while.
    await fs.writeFile(ignore, "*.ts\n");
    now += IGNORE_FILES_KEPT_MS;
    assert.strictEqual(await listed(), "cached/.gitignore\ncached/b.ts");
    now += 1;
    assert.strictEqual(await listed(), "cached/.gitignore\ncached/a.log");
    assert.strictEqual(searches, 3);
  });

  test("fills result limits across overlapping workspace roots", async () => {
    const nested = await make("nested");
    const files = ["nested/a.ts", "nested/b.ts", "c.ts"].map((name) =>
      vscode.Uri.file(path.join(dir, name)),
    );
    for (const name of ["nested/a.ts", "nested/b.ts", "c.ts"]) await writeFile(name, "text");
    const roots = folders(nested, dir);
    replace(vscode.workspace, "workspaceFolders", roots);
    replace(vscode.workspace, "findFiles", async (include, _exclude, maxResults) => {
      assert.ok(include instanceof vscode.RelativePattern);
      if (include.pattern === "**/.gitignore") return [];
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

  test("takes an absolute glob in the one workspace folder that it starts with", async () => {
    const [first, second] = [await make("first"), await make("second")];
    await make("second/sub");
    for (const name of ["first/a.ts", "second/a.ts", "second/sub/b.ts"]) {
      await writeFile(name, "Needle");
    }
    replace(vscode.workspace, "workspaceFolders", folders(first, second));
    const secondFiles = [path.join(second, "a.ts"), path.join(second, "sub", "b.ts")];
    assert.strictEqual(
      await invoke(finder, { glob: "**/*.ts" }),
      ["a.ts", ...secondFiles].join("\n"),
    );
    // As the files outside the first folder are listed.
    assert.strictEqual(await invoke(finder, { glob: `${second}/**/*.ts` }), secondFiles.join("\n"));
    assert.strictEqual(await invoke(finder, { glob: `${first}/*.ts` }), "a.ts");
    assert.match(
      await invoke(searcher, { query: "Needle", glob: `${second}/sub/*` }),
      /^1 match in 1 file \(searched 1 file\)\.\n.*b\.ts\n {2}1: Needle$/,
    );
    assert.strictEqual(
      await invoke(finder, { glob: second }),
      `No files match ${JSON.stringify(second)}. To list the files in a folder, use the glob "${second}/**".`,
    );
    const refused =
      'Error: "glob" must be relative to workspace folders, or start with the path of one, and cannot contain "..".';
    for (const glob of [`${outside}/**`, `${second}2/**`, `${second}/../first/**`]) {
      assert.strictEqual(await invoke(finder, { glob }), refused, glob);
    }
    assert.ok(
      (await invoke(reader, { file: path.join(second, "sub") })).endsWith(
        ` is a folder, not a file. List its files with diagram_findFiles and the glob "${second}/sub/**".`,
      ),
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

  test("refuses local pipes and devices before attempting to read them", async function () {
    if (process.platform === "win32") this.skip();
    const pipe = path.join(dir, "input.pipe");
    execFileSync("mkfifo", [pipe]);
    afterTest(() => fs.rm(pipe, { force: true }));
    replace(vscode.workspace, "workspaceFolders", folders(dir, "/dev"));
    const readFile = vscode.workspace.fs.readFile;
    const files = [pipe, "/dev/null"];
    replace(vscode.workspace, "fs", {
      ...vscode.workspace.fs,
      readFile: (uri) => {
        assert.ok(!files.includes(uri.fsPath), "must reject special files before reading");
        return readFile(uri);
      },
    });
    for (const file of files) {
      assert.match(await invoke(reader, { file }), /[Nn]ot a regular file/);
    }
    // A provider or file-search race may still return a special file as a candidate.
    replace(vscode.workspace, "findFiles", async (include) =>
      include instanceof vscode.RelativePattern && include.pattern === "input.pipe"
        ? [vscode.Uri.file(pipe)]
        : [],
    );
    assert.match(
      await invoke(searcher, { glob: "input.pipe", query: "value" }),
      /No matches \(searched 0 files; skipped 1 file: unreadable\)/,
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
    await setting("files.encoding", "iso88591");
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
      /outside the open workspace folders/,
    );
    assert.strictEqual(
      await invoke(reader, { file: "../../../etc/passwd" }),
      'Error: "../../../etc/passwd" is outside the open workspace folders; give a path that diagram_findFiles lists.',
    );
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
      assert.match(await invoke(reader, { file }), /outside the open workspace folders/);
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
    const roots = folders("/one", "/two");
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
    assert.throws(
      () => resolveWorkspaceFile(path.resolve("/two-else/b.ts"), roots),
      /outside the open workspace/,
    );
    for (const file of ["file:///one/a.ts#L4", "a.ts#L4", "/one/a.ts#L4-L8", "a.ts#L4-8"]) {
      assert.throws(() => resolveWorkspaceFile(file, roots), /without a query, fragment or line/);
    }
  });

  test("resolves absolute paths in virtual workspace roots", () => {
    const roots = folders(
      ...["one", "two"].map((name) => vscode.Uri.parse(`vscode-vfs://github/owner/${name}`)),
    );
    assert.strictEqual(
      resolveWorkspaceFile("/owner/two/src/b.ts", roots).toString(),
      "vscode-vfs://github/owner/two/src/b.ts",
    );
    assert.throws(
      () => resolveWorkspaceFile("/owner/three/c.ts", roots),
      /outside the open workspace/,
    );
  });

  test("names files relative to a virtual workspace folder whose path has '.' and '..'", async () => {
    fileSystem("diagram-dots", {
      stat: (uri) => ({
        type: uri.path.endsWith(".ts") ? vscode.FileType.File : vscode.FileType.Directory,
        ctime: 0,
        mtime: 0,
        size: 4,
      }),
      readFile: () => Buffer.from("text"),
    });
    const root = vscode.Uri.parse("diagram-dots:/owner/x/../one/./");
    replace(vscode.workspace, "workspaceFolders", folders(root));
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

  test("says how to list a folder that no absolute path names", async () => {
    fileSystem("diagram-b", {
      stat: () => ({ type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 }),
    });
    const first = workspaceRoot();
    // "/src" would name a folder in either virtual workspace folder.
    replace(vscode.workspace, "workspaceFolders", [
      first,
      ...["diagram-a", "diagram-b"].map((scheme, index) => ({
        uri: vscode.Uri.parse(`${scheme}:/`),
        name: scheme,
        index: index + 1,
      })),
    ]);
    assert.strictEqual(
      await invoke(reader, { file: "diagram-b:/src" }),
      "Error: diagram-b:/src is a folder, not a file. List its files with diagram_findFiles.",
    );
  });

  test("rejects traversal in virtual URIs, including encoded dot segments", () => {
    const roots = folders(vscode.Uri.parse("memory:/root/"));
    assert.strictEqual(resolveWorkspaceFile("memory:/root/code.ts", roots).path, "/root/code.ts");
    for (const file of [
      "memory:/root/../outside",
      "memory:/root/%2e%2e/outside",
      "memory:/root/sub/../../outside",
      "memory:/root/..%5coutside",
      "memory:/root/sub%5c..%5c..%5coutside",
    ]) {
      assert.throws(() => resolveWorkspaceFile(file, roots), /outside the open workspace/);
    }
    const root = folders(vscode.Uri.parse("memory:/"));
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
    fileSystem("diagram-links", {
      stat: (uri) => {
        stats.push(uri.path);
        const type = types.get(uri.path);
        if (type === undefined) throw vscode.FileSystemError.FileNotFound(uri);
        return { type, ctime: 0, mtime: 0, size: 0 };
      },
    });
    const root = vscode.Uri.parse("diagram-links:/root");
    const check = boundary(folders(root), source.token);
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
    // Lines given as compilers and code links write them, rather than as startLine and endLine.
    for (const suffix of [":10", ":10:5", ":10-20", "#L10", "#L10-L20"]) {
      assert.strictEqual(
        await invoke(reader, { file: `${relative}/code.ts${suffix}` }),
        'Error: Give "file" without a query, fragment or line, such as "#L10" or ":10", and its lines as "startLine" and "endLine".',
      );
    }
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

  test("finds the ignore files for later calls also when the call that started it is cancelled", async function () {
    this.timeout(30_000);
    onlyTestFolder();
    await make("halted");
    await writeFile("halted/b.ts", "");
    let searches = 0;
    let cancelled = cancellationSource();
    const findFiles = vscode.workspace.findFiles;
    replace(vscode.workspace, "findFiles", (include, ...rest) => {
      if (include instanceof vscode.RelativePattern && include.pattern === "**/.gitignore") {
        searches++;
        cancelled.cancel();
      }
      return findFiles(include, ...rest);
    });
    // The watcher may clear the cache meanwhile, as it tells of the files of earlier tests.
    let reused = false;
    for (let attempt = 0; !reused && attempt < 5; attempt++) {
      // However long the calls take.
      const caching = cacheIgnoreFiles(() => 0);
      afterTest(() => caching.dispose());
      cancelled = cancellationSource();
      searches = 0;
      await assert.rejects(
        invoke(finder, { glob: "halted/**" }, cancelled.token),
        vscode.CancellationError,
      );
      assert.strictEqual(await invoke(finder, { glob: "halted/**" }), "halted/b.ts");
      reused = searches === 1;
    }
    assert.ok(reused);
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
