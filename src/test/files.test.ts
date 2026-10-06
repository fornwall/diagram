import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { absoluteFile, absolutePath, fileError, openDocument } from "../files";

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
