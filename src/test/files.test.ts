import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  absoluteFile,
  absolutePath,
  contains,
  fileError,
  inWorkspace,
  openDocument,
  resolveFile,
} from "../files";
import { afterTest, recordFilePaths, suiteTempDir } from "./afterTest";

suite("files", () => {
  const dir = suiteTempDir("diagram-files-");

  test("resolves an absolute path on the file system of the workspace folders that contain it", () => {
    const folder = (uri: string, index: number) => ({
      uri: vscode.Uri.parse(uri),
      name: uri,
      index,
    });
    const github = [
      folder("vscode-vfs://github/owner/one", 0),
      folder("vscode-vfs://github/owner/two", 1),
    ];
    for (const file of ["/owner/one/src/a.ts", "/owner/two/b.ts"]) {
      const uri = absoluteFile(file, github);
      assert.strictEqual(uri.toString(), `vscode-vfs://github${file}`);
      assert.strictEqual(absolutePath(uri, github), file);
    }
    // A path that no folder contains, or that folders on two file systems do, is on this computer.
    const local = path.join(path.sep, "owner", "three", "c.ts");
    assert.strictEqual(absoluteFile(local, github).scheme, "file");
    const both = [...github, folder("memory:/owner/one", 2)];
    assert.strictEqual(absoluteFile("/owner/one/src/a.ts", both).scheme, "file");
    assert.strictEqual(
      absolutePath(vscode.Uri.parse("vscode-vfs://github/owner/one/src/a.ts"), both),
      undefined,
    );
    assert.strictEqual(absolutePath(vscode.Uri.file(local), github), local);
  });

  test("takes a virtual workspace folder's '.' and '..' by their text", () => {
    const root = vscode.Uri.parse("vscode-vfs://github/owner/x/../one/./");
    const inside = (file: string) => contains(root, vscode.Uri.parse(`vscode-vfs://github${file}`));
    assert.ok(inside("/owner/one"));
    assert.ok(inside("/owner/one/src/a.ts"));
    assert.ok(!inside("/owner/x/a.ts"));
    assert.ok(!inside("/owner/oneself"));
  });

  test("resolves an absolute path that leads out of the workspace outside it", () => {
    const root = vscode.workspace.workspaceFolders?.[0];
    assert.ok(root);
    // Links and data files outside the workspace are confirmed first.
    const uri = resolveFile([root.uri.fsPath, "..", "secret.txt"].join(path.sep));
    assert.strictEqual(uri.fsPath, path.join(path.dirname(root.uri.fsPath), "secret.txt"));
    assert.strictEqual(vscode.workspace.getWorkspaceFolder(uri), undefined);
  });

  test("finds files inside the workspace also once symbolic links are resolved", () => {
    const root = vscode.workspace.workspaceFolders?.[0];
    assert.ok(root);
    fs.writeFileSync(path.join(dir, "secret.csv"), "a\n1\n");
    const link = path.join(root.uri.fsPath, "diagram-files-link");
    fs.symlinkSync(dir, link);
    afterTest(() => fs.rmSync(link));
    const inside = (file: string) => inWorkspace(resolveFile(file));
    assert.ok(inside("sizes.tsv"));
    // Nothing can be read through a path that does not resolve.
    assert.ok(inside("made-up.csv"));
    assert.ok(!inside("diagram-files-link/secret.csv"));
    assert.ok(!inside("diagram-files-link"));
  });

  test("follows links one name at a time, touching no target outside the workspace", () => {
    const root = vscode.workspace.workspaceFolders?.[0];
    assert.ok(root);
    const far = path.join(dir, "far-away");
    fs.mkdirSync(far, { recursive: true });
    fs.writeFileSync(path.join(far, "data.csv"), "a\n1\n");
    for (const [name, target] of [
      ["diagram-files-hop", "diagram-files-next"],
      ["diagram-files-next", "sizes.tsv"],
      ["diagram-files-out", far],
      ["diagram-files-up", path.relative(root.uri.fsPath, far)],
      ["diagram-files-loop", "diagram-files-loop"],
    ] as const) {
      const link = path.join(root.uri.fsPath, name);
      fs.symlinkSync(target, link);
      afterTest(() => fs.rmSync(link));
    }
    const paths = recordFilePaths();
    const inside = (file: string) => inWorkspace(vscode.Uri.joinPath(root.uri, file));
    assert.ok(inside("diagram-files-hop"));
    assert.ok(!inside("diagram-files-out/data.csv"));
    assert.ok(!inside("diagram-files-up/data.csv"));
    // As a missing file, as realpath would not resolve it either.
    assert.ok(inside("diagram-files-loop"));
    // Nor through the links, as realpath would. By name, as in the test of outside paths below.
    const seen = (pattern: RegExp) => paths.filter((file) => pattern.test(file));
    assert.notDeepStrictEqual(seen(/diagram-files-hop$/), [], "The paths are recorded.");
    assert.deepStrictEqual(seen(/far-away|data\.csv/), []);
  });

  test('follows ".." in a link target from where the link before it leads', function () {
    if (process.platform === "win32") this.skip();
    const root = vscode.workspace.workspaceFolders?.[0];
    assert.ok(root);
    const inner = path.join(dir, "inner");
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(path.join(dir, "diagram-files-key"), "secret");
    const deep = path.join(root.uri.fsPath, "diagram-files-dir", "deep");
    fs.mkdirSync(deep, { recursive: true });
    afterTest(() => fs.rmSync(path.dirname(deep), { recursive: true }));
    // A decoy for the target read by its text.
    fs.writeFileSync(path.join(root.uri.fsPath, "diagram-files-key"), "decoy");
    afterTest(() => fs.rmSync(path.join(root.uri.fsPath, "diagram-files-key")));
    for (const [name, target] of [
      ["diagram-files-b", inner],
      ["diagram-files-a", "diagram-files-b/../diagram-files-key"],
      ["diagram-files-in", "diagram-files-dir/deep"],
      ["diagram-files-back", "diagram-files-in/../../sizes.tsv"],
      [
        "diagram-files-chain",
        "diagram-files-dir/./deep/../deep/../../diagram-files-in/../../sizes.tsv",
      ],
      ["diagram-files-climb", "diagram-files-dir/deep/../../../diagram-files-x"],
      ["diagram-files-abs", `${root.uri.fsPath}/diagram-files-b/../diagram-files-key`],
    ] as const) {
      const link = path.join(root.uri.fsPath, name);
      fs.symlinkSync(target, link);
      afterTest(() => fs.rmSync(link));
    }
    const read = (name: string) => fs.readFileSync(path.join(root.uri.fsPath, name), "utf8");
    assert.strictEqual(read("diagram-files-a"), "secret");
    assert.strictEqual(read("diagram-files-abs"), "secret");
    const paths = recordFilePaths();
    const inside = (file: string) => inWorkspace(vscode.Uri.joinPath(root.uri, file));
    assert.ok(!inside("diagram-files-a"));
    assert.ok(inside("diagram-files-back"));
    assert.ok(inside("diagram-files-chain"));
    assert.ok(!inside("diagram-files-climb"));
    assert.ok(!inside("diagram-files-abs"));
    assert.deepStrictEqual(
      paths.filter((file) => file.startsWith(dir) || file.endsWith("diagram-files-x")),
      [],
    );
  });

  test('follows ".." in a link target into the workspace folder beside it', function () {
    if (process.platform === "win32") this.skip();
    const one = path.join(dir, "one");
    const two = path.join(dir, "two");
    for (const folder of [one, two]) fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(two, "data.csv"), "a\n1\n");
    fs.writeFileSync(path.join(dir, "secret.csv"), "a\n1\n");
    for (const [name, target] of [
      ["beside", "../two/data.csv"],
      ["up", "../secret.csv"],
      ["back", "../two/../secret.csv"],
      ["dotted", `${dir}/./two//data.csv`],
    ] as const) {
      fs.symlinkSync(target, path.join(one, name));
    }
    const roots = [one, two].map((file, index) => ({
      uri: vscode.Uri.file(file),
      name: file,
      index,
    }));
    const paths = recordFilePaths();
    const inside = (name: string) => inWorkspace(vscode.Uri.file(path.join(one, name)), roots);
    assert.ok(inside("beside"));
    assert.ok(!inside("up"));
    assert.ok(!inside("back"));
    assert.ok(inside("dotted"));
    assert.deepStrictEqual(
      paths.filter((file) => file.endsWith("secret.csv")),
      [],
    );
  });

  test('takes a workspace folder\'s ".." by its text, as files in it are named', function () {
    if (process.platform === "win32") this.skip();
    const one = path.join(dir, "dotted", "one");
    fs.mkdirSync(one, { recursive: true });
    fs.mkdirSync(path.join(dir, "dotted", "x"));
    fs.symlinkSync(dir, path.join(one, "away"));
    fs.writeFileSync(path.join(dir, "secret.csv"), "a\n1\n");
    // As VS Code gives the folder of {"uri": "file:///…/x/../one"} in a .code-workspace file.
    const uri = vscode.Uri.file(path.join(dir, "dotted", "x"));
    const root = uri.with({ path: `${uri.path}/../one` });
    assert.match(root.fsPath, /\/x\/\.\.\/one$/);
    const roots = [{ uri: root, name: "one", index: 0 }];
    fs.writeFileSync(path.join(one, "data.csv"), "a\n1\n");
    assert.ok(inWorkspace(vscode.Uri.file(path.join(one, "data.csv")), roots));
    assert.ok(!inWorkspace(vscode.Uri.file(path.join(one, "away", "secret.csv")), roots));
  });

  test("refuses a link whose target is not UTF-8, which no string names", function () {
    if (process.platform !== "linux") this.skip();
    const root = vscode.workspace.workspaceFolders?.[0];
    assert.ok(root);
    fs.writeFileSync(path.join(dir, "secret.csv"), "a\n1\n");
    // Read as a string, "\xff" becomes "�", a name that the walk would take instead.
    const name = Buffer.from("diagram-files-\xff", "latin1");
    const away = Buffer.concat([Buffer.from(`${root.uri.fsPath}/`), name]);
    fs.symlinkSync(dir, away);
    afterTest(() => fs.rmSync(away));
    const link = path.join(root.uri.fsPath, "diagram-files-bytes");
    fs.symlinkSync(Buffer.concat([name, Buffer.from("/secret.csv")]), link);
    afterTest(() => fs.rmSync(link));
    assert.strictEqual(fs.readFileSync(link, "utf8"), "a\n1\n");
    assert.ok(!inWorkspace(vscode.Uri.joinPath(root.uri, "diagram-files-bytes")));
  });

  test("refuses a link that it cannot follow where the system can", function () {
    if (process.platform !== "linux") this.skip();
    const root = vscode.workspace.workspaceFolders?.[0];
    assert.ok(root);
    fs.writeFileSync(path.join(dir, "secret.csv"), "a\n1\n");
    // Short links to deep folders reach a real path longer than the system takes, 4096 bytes.
    const deep = Array(8).fill("d".repeat(200)).join("/");
    const long = path.join(root.uri.fsPath, "diagram-files-long");
    afterTest(() => fs.rmSync(long, { recursive: true }));
    let short = long;
    for (let i = 0; i < 3; i++) {
      fs.mkdirSync(path.join(short, deep), { recursive: true });
      fs.symlinkSync(deep, path.join(short, "s"));
      short = path.join(short, "s");
    }
    fs.symlinkSync(path.join(dir, "secret.csv"), path.join(short, "x"));
    assert.strictEqual(fs.readFileSync(path.join(short, "x"), "utf8"), "a\n1\n");
    assert.ok(!inWorkspace(vscode.Uri.file(path.join(short, "x"))));
    // Nor from a workspace folder there, as ".." steps up from its real path, not from its path.
    const roots = [short, root.uri.fsPath].map((file, index) => ({
      uri: vscode.Uri.file(file),
      name: file,
      index,
    }));
    fs.symlinkSync("../x", path.join(short, "up"));
    fs.symlinkSync(path.join(dir, "secret.csv"), path.join(short, "..", path.dirname(deep), "x"));
    fs.writeFileSync(path.join(path.dirname(short), "x"), "decoy");
    assert.strictEqual(fs.readFileSync(path.join(short, "up"), "utf8"), "a\n1\n");
    assert.ok(!inWorkspace(vscode.Uri.file(path.join(short, "up")), roots));
  });

  test("resolves no path outside the workspace, which could reach a network share", () => {
    const root = vscode.workspace.workspaceFolders?.[0];
    assert.ok(root);
    const inward = path.join(dir, "inward.tsv");
    fs.symlinkSync(path.join(root.uri.fsPath, "sizes.tsv"), inward);
    const paths = recordFilePaths();
    for (const uri of [
      vscode.Uri.file(path.join(dir, "secret.csv")),
      // Even a link into the workspace, as a path outside it could be on a network share.
      vscode.Uri.file(inward),
      vscode.Uri.parse("file://attacker.example/share/data.csv"),
      root.uri.with({ authority: "attacker.example" }),
    ]) {
      assert.ok(!inWorkspace(uri), uri.toString());
    }
    assert.ok(inWorkspace(vscode.Uri.joinPath(root.uri, "sizes.tsv")));
    // By file name, as Uri.file gives Windows drive letters in lower case, unlike os.tmpdir().
    const seen = (pattern: RegExp) => paths.filter((file) => pattern.test(file));
    assert.notDeepStrictEqual(seen(/sizes\.tsv$/), [], "The paths are recorded.");
    assert.deepStrictEqual(seen(/secret\.csv|inward\.tsv|attacker\.example/), []);
  });

  test("resolves a path in other case only where the file system ignores case", function () {
    if (process.platform === "win32") this.skip();
    const real = path.join(dir, "real");
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, "data.csv"), "a\n1\n");
    // The folder's last name is a link, which a hard link can stand for in other case.
    const folder = path.join(dir, "Folder");
    fs.symlinkSync(real, folder);
    const roots = [{ uri: vscode.Uri.file(folder), name: "Folder", index: 0 }];
    const typed = vscode.Uri.file(path.join(dir, "folder", "data.csv"));
    if (!fs.existsSync(path.join(dir, "FOLDER"))) {
      // On a case-sensitive file system, as a macOS volume can be, "folder" is another folder.
      const other = path.join(dir, "folder");
      fs.mkdirSync(other);
      fs.writeFileSync(path.join(dir, "secret.csv"), "a\n1\n");
      fs.symlinkSync(path.join(dir, "secret.csv"), path.join(other, "data.csv"));
      assert.ok(!inWorkspace(typed, roots));
      fs.rmSync(other, { recursive: true });
      // A case-insensitive file system finds the same entry by either name.
      fs.linkSync(folder, other);
    }
    assert.ok(inWorkspace(typed, roots));
  });

  test("names a file it cannot open once, relative to the workspace where possible", async () => {
    const root = vscode.workspace.workspaceFolders?.[0];
    assert.ok(root);
    await assert.rejects(openDocument(vscode.Uri.joinPath(root.uri, "docs/gone.md")), {
      message: "docs/gone.md does not exist.",
    });
    const file = path.join(dir, "file.md");
    fs.writeFileSync(file, "text");
    const binary = path.join(dir, "binary.bin");
    fs.writeFileSync(binary, Buffer.from([0, 1, 2, 0]));
    for (const [opened, message] of [
      [dir, `${dir} is a folder, not a file.`],
      [
        path.join(file, "more.md"),
        `The path ${file}/more.md goes through a file as if it were a folder.`,
      ],
      [
        binary,
        `${binary} could not be read: File seems to be binary and cannot be opened as text.`,
      ],
    ] as const) {
      await assert.rejects(openDocument(vscode.Uri.file(opened)), { message });
    }
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      fs.chmodSync(file, 0);
      await assert.rejects(openDocument(vscode.Uri.file(file)), {
        message: `You do not have permission to read ${file}.`,
      });
    }
  });

  test("explains file system errors that a provider throws", async () => {
    const provider = vscode.workspace.registerFileSystemProvider("diagram-files", {
      onDidChangeFile: new vscode.EventEmitter<vscode.FileChangeEvent[]>().event,
      stat: (uri) => {
        if (uri.path === "/denied.md") throw vscode.FileSystemError.NoPermissions(uri);
        if (uri.path === "/offline.md") throw vscode.FileSystemError.Unavailable(uri);
        return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 1 };
      },
      watch: () => new vscode.Disposable(() => {}),
      readDirectory: () => [],
      createDirectory: () => {},
      readFile: () => new Uint8Array(),
      writeFile: () => {},
      delete: () => {},
      rename: () => {},
    });
    try {
      for (const [file, message] of [
        ["denied.md", "You do not have permission to read diagram-files:/denied.md."],
        ["offline.md", "diagram-files:/offline.md cannot be reached right now."],
      ] as const) {
        await assert.rejects(openDocument(vscode.Uri.parse(`diagram-files:/${file}`)), { message });
      }
      const uri = vscode.Uri.parse("diagram-files:/offline.md");
      const error = await Promise.resolve(vscode.workspace.fs.stat(uri)).catch((e) => e);
      assert.strictEqual(
        (fileError(error, uri, { Unavailable: "Try again later." }) as Error).message,
        "diagram-files:/offline.md cannot be reached right now. Try again later.",
      );
    } finally {
      provider.dispose();
    }
  });

  test("explains Node.js file errors, and passes other errors on as they are", async () => {
    const missing = path.join(dir, "missing.md");
    const error = await fs.promises.realpath(missing).catch((e) => e);
    assert.strictEqual(
      (fileError(error, vscode.Uri.file(missing)) as Error).message,
      `${missing} does not exist.`,
    );
    const other = Object.assign(new Error(`EMFILE: too many open files, open '${missing}'`), {
      code: "EMFILE",
      syscall: "open",
    });
    assert.strictEqual(
      (fileError(other, vscode.Uri.file(missing)) as Error).message,
      `${missing} could not be read: EMFILE: too many open files.`,
    );
    const cancelled = new vscode.CancellationError();
    assert.strictEqual(fileError(cancelled, vscode.Uri.file(missing)), cancelled);
  });
});
