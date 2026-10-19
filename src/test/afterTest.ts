import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

/** What to undo once the current test ends, such as a replaced VS Code API. */
const cleanups: (() => unknown)[] = [];

// At the top level, this runs after each test of every suite: the last change is undone first,
// and every one is, also when the test or another cleanup fails.
teardown(async () => {
  let failure: unknown;
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
});

/** Runs the cleanup once the current test ends, whether it passes or fails. */
export function afterTest(cleanup: () => unknown): void {
  cleanups.push(cleanup);
}

/** Replaces a property, such as a VS Code API, also one with a getter, until the current test ends. */
export function replace<T extends object, K extends keyof T>(object: T, key: K, value: T[K]): void {
  const original = Object.getOwnPropertyDescriptor(object, key);
  Object.defineProperty(object, key, { value, configurable: true, writable: true });
  afterTest(() => {
    if (original) Object.defineProperty(object, key, original);
    else delete object[key];
  });
}

/** Sets a user setting, such as "files.encoding", until the current test ends. */
export async function setting(key: string, value: unknown): Promise<void> {
  const settings = vscode.workspace.getConfiguration();
  afterTest(() => settings.update(key, undefined, vscode.ConfigurationTarget.Global));
  await settings.update(key, value, vscode.ConfigurationTarget.Global);
}

/** Answers the command with `handle` instead of running it, until the current test ends. */
export function interceptCommand(id: string, handle: (...args: unknown[]) => unknown): void {
  const execute = vscode.commands.executeCommand;
  replace(vscode.commands, "executeCommand", (async (command: string, ...args: unknown[]) =>
    command === id ? handle(...args) : execute(command, ...args)) as typeof execute);
}

/** A source of cancellation, disposed once the current test ends. */
export function cancellationSource(): vscode.CancellationTokenSource {
  const source = new vscode.CancellationTokenSource();
  afterTest(() => source.dispose());
  return source;
}

/** A new temporary folder, which is removed once the current test ends. */
export function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  afterTest(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A new temporary folder for the tests of the suite, which is removed once they end. */
export function suiteTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  suiteTeardown(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** This extension, which the tests run in. */
export function diagramExtension(): vscode.Extension<unknown> {
  const extension = vscode.extensions.getExtension("fornwall.diagram-chat");
  assert.ok(extension);
  return extension;
}

/** The first workspace folder, which the tests open. */
export function workspaceRoot(): vscode.WorkspaceFolder {
  const root = vscode.workspace.workspaceFolders?.[0];
  assert.ok(root);
  return root;
}

/** Workspace folders of the paths or URIs, each named as its last name. */
export function folders(...roots: (string | vscode.Uri)[]): vscode.WorkspaceFolder[] {
  return roots.map((root, index) => {
    const uri = typeof root === "string" ? vscode.Uri.file(root) : root;
    return { uri, name: path.posix.basename(uri.path), index };
  });
}

/** Makes a symbolic link in the first workspace folder, removed once the current test ends. */
export function workspaceLink(name: string, target: string | Buffer): string {
  const link = path.join(workspaceRoot().uri.fsPath, name);
  fs.symlinkSync(target, link);
  afterTest(() => fs.rmSync(link));
  return link;
}

/**
 * Serves the scheme from the provider's members until the current test ends, refusing what it
 * leaves out.
 */
export function fileSystem(
  scheme: string,
  provider: Pick<vscode.FileSystemProvider, "stat"> & Partial<vscode.FileSystemProvider>,
  options?: { isReadonly?: boolean },
): void {
  const refuse = () => {
    throw vscode.FileSystemError.NoPermissions();
  };
  const registration = vscode.workspace.registerFileSystemProvider(
    scheme,
    {
      onDidChangeFile: new vscode.EventEmitter<vscode.FileChangeEvent[]>().event,
      watch: () => new vscode.Disposable(() => {}),
      readDirectory: refuse,
      createDirectory: refuse,
      readFile: refuse,
      writeFile: refuse,
      delete: refuse,
      rename: refuse,
      ...provider,
    },
    options,
  );
  afterTest(() => registration.dispose());
}

/** The paths that Node.js file system functions are called with until the current test ends. */
export function recordFilePaths(): string[] {
  const paths: string[] = [];
  const spy = (object: object, keys: readonly string[]) => {
    for (const key of keys) {
      const original = (object as Record<string, (...args: unknown[]) => unknown>)[key];
      assert.ok(original, key);
      const recorded = (file: unknown, ...rest: unknown[]) => {
        paths.push(String(file));
        return original.call(object, file, ...rest);
      };
      // Keeps realpath.native.
      replace(object as Record<string, unknown>, key, Object.assign(recorded, original));
    }
  };
  // The module itself, which `import * as` copies.
  const fs: typeof import("node:fs") = require("node:fs");
  const names = ["lstat", "stat", "readlink", "realpath", "access", "open", "readdir"];
  spy(fs, [...names, ...names.map((name) => `${name}Sync`), "existsSync"]);
  spy(fs.promises, names);
  for (const realpath of [fs.realpath, fs.realpathSync]) spy(realpath, ["native"]);
  return paths;
}

type MessageKind = "showInformationMessage" | "showWarningMessage" | "showErrorMessage";

/**
 * The messages that VS Code shows as the kind says until the current test ends, instead of
 * showing them, each answered as `answer` says: by default as if the user closed it.
 */
export function recordMessages(
  kind: MessageKind,
  answer: (message: string, ...rest: unknown[]) => unknown = () => undefined,
): string[] {
  const messages: string[] = [];
  const show = async (message: string, ...rest: unknown[]) => {
    messages.push(message);
    return answer(message, ...rest);
  };
  replace(vscode.window, kind, show as (typeof vscode.window)[MessageKind]);
  return messages;
}

/**
 * How long the smaller size of a work takes at least, beside which the millisecond more that the
 * bound allows does not let the larger take as long as quadratic time would.
 */
const MIN_TIMED_MS = 1;

/** The time that the fastest of some runs of the work takes. */
function fastestOf(work: () => unknown, runs: number): number {
  let fastest = Number.POSITIVE_INFINITY;
  for (let run = 0; run < runs; run++) {
    const start = performance.now();
    work();
    fastest = Math.min(fastest, performance.now() - start);
  }
  return fastest;
}

/**
 * Asserts that the work takes time linear in the size of its input rather than quadratic: four
 * times the size takes well under the sixteen times as long that quadratic time would. Each size is
 * timed by its fastest of a few runs, which a busy machine does not slow down as it may a single
 * one. `prepare` makes the input of a size, untimed, and gives the work to time, which it may run
 * several times. A size that takes under a millisecond is timed at four times it instead: beside
 * its time, the millisecond that the bound allows more would let quadratic time pass. Not larger
 * still, where collecting the garbage of a work that keeps what it makes takes more than linear
 * time.
 */
export function assertLinearTime(prepare: (size: number) => () => unknown, size: number): void {
  const base = fastestOf(prepare(size), 3) < MIN_TIMED_MS ? 4 * size : size;
  const works = [prepare(base), prepare(4 * base)];
  const fastest = works.map(() => Number.POSITIVE_INFINITY);
  for (let round = 0; round < 5; round++) {
    for (const [index, work] of works.entries()) {
      fastest[index] = Math.min(fastest[index] ?? 0, fastestOf(work, 1));
    }
  }
  const [small = 0, large = 0] = fastest;
  // And a millisecond more, which a measure of under a millisecond is not exact to.
  assert.ok(
    large < 8 * small + 1,
    `${small.toFixed(1)} ms for size ${base}, but ${large.toFixed(1)} ms for ${4 * base}`,
  );
}
