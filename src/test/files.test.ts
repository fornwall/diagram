import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  absoluteFile,
  absolutePath,
  fileError,
  inWorkspace,
  openDocument,
  resolveFile,
} from "../files";
import { afterTest, recordFilePaths } from "./afterTest";

suite("files", () => {
  let dir: string;

  suiteSetup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "diagram-files-"));
  });

  suiteTeardown(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

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
    const far = path.join(dir, "far");
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
    // Nor through the links, as realpath would.
    assert.deepStrictEqual(
      paths.filter((file) => file.startsWith(dir) || file.endsWith("data.csv")),
      [],
    );
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
    assert.deepStrictEqual(
      paths.filter((file) => file.startsWith(dir) || file.includes("attacker.example")),
      [],
    );
  });

  test("resolves a path in other case where file systems ignore case", function () {
    const platform = process.platform;
    if (platform !== "linux" && platform !== "darwin" && platform !== "win32") this.skip();
    const real = path.join(dir, "Folder");
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, "data.csv"), "a\n1\n");
    const roots = [{ uri: vscode.Uri.file(real), name: "Folder", index: 0 }];
    const typed = vscode.Uri.file(path.join(dir, "folder", "data.csv"));
    if (platform !== "linux") {
      assert.ok(inWorkspace(typed, roots));
      return;
    }
    // A link stands for the folder in other case, as a case-insensitive file system would.
    fs.symlinkSync(real, path.join(dir, "folder"));
    assert.ok(!inWorkspace(typed, roots));
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    assert.ok(descriptor);
    // Restored before anything else runs, which might go by the platform.
    Object.defineProperty(process, "platform", { ...descriptor, value: "darwin" });
    try {
      assert.ok(inWorkspace(typed, roots));
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
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
