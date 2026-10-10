// Loading chart data from inline text, a file or a shell command.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { throwIfCancelled, unlessCancelled } from "./cancellation";
import type { ChartSpec } from "./chartSpec";
import { type DataTable, parseTable } from "./data";
import {
  contains,
  decodeFile,
  decodeText,
  fileError,
  fileName,
  inWorkspace,
  nearRoot,
  pathOutside,
  resolveFile,
} from "./files";

/** The largest file or command output that is read. */
const MAX_MIB = 10;
const MAX_BYTES = MAX_MIB * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 60_000;
/**
 * How long to wait for the rest of a command's output after it exits, in case a process it left
 * running in the background keeps its output open.
 */
const EXIT_GRACE_MS = 200;
const STDERR_TAIL = 2000;

/** The locale categories that LC_ALL sets, other than LC_NUMERIC. */
const LOCALE_CATEGORIES = [
  "LC_CTYPE",
  "LC_COLLATE",
  "LC_TIME",
  "LC_MONETARY",
  "LC_MESSAGES",
  "LC_PAPER",
  "LC_NAME",
  "LC_ADDRESS",
  "LC_TELEPHONE",
  "LC_MEASUREMENT",
  "LC_IDENTIFICATION",
];

/**
 * The environment for commands: this process's, but with LC_NUMERIC=C so that numbers are printed
 * with decimal points (du -h prints "1,5M" in some locales). LC_ALL would override LC_NUMERIC, so
 * it is replaced by setting the other categories to its value.
 */
export function commandEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env };
  const all = result.LC_ALL;
  delete result.LC_ALL;
  if (all !== undefined && all !== "") {
    for (const category of LOCALE_CATEGORIES) {
      result[category] = all;
    }
  }
  result.LC_NUMERIC = "C";
  return result;
}

/**
 * Whether a command prints sizes in powers of 1000, as du, df, ls and free do with --si, and df
 * with -H among its options. Word by word, since a regular expression for the options after "df"
 * takes quadratic time on "-df -df -df…".
 */
export function printsSiSizes(command: string): boolean {
  let afterDf = false;
  for (const word of command.split(/\s+/)) {
    if (/^--si\b/.test(word) || (afterDf && /^-[a-zA-Z]*H/.test(word))) return true;
    afterDf = /\bdf$/.test(word) || (afterDf && /^-./.test(word));
  }
  return false;
}

/** Whether reading a data file asks the user first, as for one outside the workspace. */
export function readAsks(uri: vscode.Uri): boolean {
  return !vscode.workspace.isTrusted || !inWorkspace(uri);
}

/**
 * Whether a tool asks before reading a data file: in an untrusted workspace, or for one outside it
 * by its path. As a link may change between when a tool call is prepared and when it runs, this
 * goes by the path alone, which the call can then tell again without the preparation keeping state.
 */
function toolAsks(uri: vscode.Uri): boolean {
  const roots = vscode.workspace.workspaceFolders ?? [];
  return !vscode.workspace.isTrusted || !roots.some((root) => nearRoot(root.uri, uri));
}

/**
 * For a tool invoked with `spec`, what {@link loadTable} takes if its data file was let through
 * without asking, so that it is read only while it is inside the workspace, links followed.
 */
export function toolUnasked({ file }: ChartSpec): Unasked | undefined {
  try {
    if (file === undefined || toolAsks(resolveFile(file))) return undefined;
  } catch {
    // Reported when loading.
    return undefined;
  }
  return {
    retry: "Call the tool again with the path that it leads to.",
    unnamed: "Ask the user to copy the file into the workspace, or to give its data another way.",
  };
}

/**
 * How to be asked about a data file that was let through without asking but leads out of the
 * workspace: by `retry`, or by `unnamed` if given when the path that it leads to cannot be named.
 */
interface Unasked {
  retry: string;
  unnamed?: string;
}

/**
 * Why a data file let through without asking was not read, by the path `outside` that it leads to
 * through a link, if known. On Windows, that may be a path inside the workspace, which Windows may
 * reach by the text of a link's target but the check does not take.
 */
export function unaskedError(name: string, outside: string | undefined, unasked: Unasked): Error {
  const notRead = "so it was not read without asking the user.";
  if (outside === undefined) {
    return new Error(
      `The file ${name} leads out of the workspace through a symbolic link whose target cannot be ` +
        `named, such as one that is not UTF-8, ${notRead} ${unasked.unnamed ?? unasked.retry}`,
    );
  }
  const roots = vscode.workspace.workspaceFolders ?? [];
  const inside = roots.some((root) => contains(root.uri, vscode.Uri.file(outside)));
  const leads = inside ? "leads, through a symbolic link," : "leads out of the workspace,";
  return new Error(`The file ${name} ${leads} to ${outside}, ${notRead} ${unasked.retry}`);
}

/** Shared consent for tools that expose file contents or command output to the model. */
export function prepareDataInvocation(
  spec: ChartSpec | undefined,
  invocationMessage: string,
): vscode.PreparedToolInvocation {
  const prepared: vscode.PreparedToolInvocation = { invocationMessage };
  if (spec?.command && vscode.workspace.isTrusted) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const message = new vscode.MarkdownString("Run this command and read its output?");
    if (folder) message.appendText(` Working folder: ${folder.name}.`);
    message.appendCodeblock(spec.command, "shell");
    prepared.confirmationMessages = { title: "Run a command to read data?", message };
  } else if (spec?.file) {
    try {
      const uri = resolveFile(spec.file);
      if (toolAsks(uri)) {
        const message = new vscode.MarkdownString("Read this file's data?");
        message.appendCodeblock(fileName(uri), "text");
        prepared.confirmationMessages = { title: "Read a data file?", message };
      }
    } catch {
      // Invalid paths are reported when the tool is invoked.
    }
  }
  return prepared;
}

/** Whether `bytes` start with a byte order mark of UTF-16, as {@link decodeText} reads them. */
function isUtf16(bytes: Uint8Array): boolean {
  return (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
}

/**
 * `text` decoded from `bytes`, or else `bytes` in Windows-1252, in which Excel on Windows saves CSV
 * files, if they are neither UTF-16 nor UTF-8. They are taken to be in it only when no character is
 * in UTF-8 either, so that a stray byte in UTF-8 text does not garble the rest.
 */
function orWindows1252(text: string, bytes: Uint8Array): string {
  if (
    !text.includes("\uFFFD") ||
    isUtf16(bytes) ||
    /[^\0-\x7F\uFFFD]/.test(new TextDecoder().decode(bytes))
  ) {
    return text;
  }
  return new TextDecoder("windows-1252").decode(bytes);
}

/**
 * Reads a data file. One that the user was not asked about is read only while it is inside the
 * workspace, checked right before, else `retry` follows the error to tell how to be asked.
 */
export async function readDataFile(file: string, unasked?: Unasked): Promise<string> {
  const uri = resolveFile(file);
  if (unasked && readAsks(uri)) {
    throw unaskedError(fileName(uri), pathOutside(uri), unasked);
  }
  const checkSize = (size: number): void => {
    if (size > MAX_BYTES) {
      throw new Error(
        `The file ${fileName(uri)} is larger than the ${MAX_MIB} MiB limit. ` +
          "Use a command that summarizes it instead.",
      );
    }
  };
  let bytes: Uint8Array;
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type & vscode.FileType.Directory) {
      throw vscode.FileSystemError.FileIsADirectory(uri);
    }
    checkSize(stat.size);
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch (error) {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    throw fileError(error, uri, {
      FileNotFound:
        folder !== undefined && !path.isAbsolute(file) && !file.startsWith("~")
          ? `Relative paths are read from the workspace folder ${folder.name}.`
          : undefined,
      FileIsADirectory: "To chart the files in it, use a command such as du.",
    });
  }
  checkSize(bytes.byteLength);
  // A file that the editor finds binary is refused as one with null characters is.
  // The editor reads Windows-1252 as UTF-8 unless files.encoding names it.
  const text = orWindows1252(await decodeFile(bytes, uri).catch(() => "\0"), bytes);
  if (text.includes("\0")) {
    throw new Error(
      `The file ${fileName(uri)} is not a text file (it may be a spreadsheet). ` +
        "Save its data as CSV, or use a command that prints it.",
    );
  }
  return text;
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > STDERR_TAIL ? `…${trimmed.slice(-STDERR_TAIL)}` : trimmed;
}

/**
 * Runs a shell command (with /bin/sh, or cmd.exe on Windows) in the first workspace folder and
 * returns its standard output, with a warning if it failed but printed something anyway (as du
 * does for unreadable directories).
 */
export async function runCommand(
  command: string,
  token: vscode.CancellationToken,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<{ output: string; warning?: string }> {
  if (!vscode.workspace.isTrusted) {
    throw new Error(
      "Commands are not run in an untrusted workspace. Trust the workspace (Workspaces: " +
        'Manage Workspace Trust), or give the data with "data" or "file" instead.',
    );
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder !== undefined && folder.uri.scheme !== "file") {
    throw new Error(
      `Commands run on this computer, but the workspace folder ${folder.name} is not on it. ` +
        'Give the data with "data" or "file" instead.',
    );
  }
  const cwd = folder?.uri.fsPath ?? os.homedir();
  if (!fs.existsSync(cwd)) {
    throw new Error(`Commands run in ${cwd}, which does not exist.`);
  }
  throwIfCancelled(token);
  const windows = process.platform === "win32";
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      env: commandEnvironment(),
      // The model writes POSIX shell commands, which the user's own shell (e.g. fish) may not run.
      shell: true,
      // A process group of its own, so that killing it also stops the command's children.
      detached: !windows,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;

    // Killing the shell alone would leave the command running.
    const killTree = (): void => {
      if (child.pid === undefined) {
        return;
      }
      if (!windows) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already exited.
        }
      } else if (child.exitCode === null && child.signalCode === null) {
        // Once the shell has exited, its process ID may belong to another process.
        spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true,
        }).on("error", () => {});
      }
    };
    // Settles the promise once. Output pipes are closed too, as a process that left the
    // command's process group (e.g. with setsid) may keep them open indefinitely.
    const finish = (result: Error | { output: string; warning?: string }): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      cancellation.dispose();
      child.stdout.destroy();
      child.stderr.destroy();
      if (result instanceof Error) {
        reject(result);
      } else {
        resolve(result);
      }
    };
    const kill = (reason: Error): void => {
      killTree();
      finish(reason);
    };
    const complete = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return;
      }
      // UTF-16 too, as cat prints Excel's "Unicode Text" files, and Windows-1252 as head prints
      // its CSV files.
      let bytes = Buffer.concat(stdout);
      // head -n ends UTF-16LE at the first byte of a newline, leaving half a character.
      if (isUtf16(bytes)) bytes = bytes.subarray(0, bytes.length - (bytes.length % 2));
      const output = orWindows1252(decodeText(bytes, false), bytes);
      const errors = tail(Buffer.concat(stderr).toString("utf8"));
      const errorOutput = errors === "" ? "" : ` Its error output:\n${errors}`;
      const failure =
        code === 0 ? "" : code === null ? `was killed by ${signal}` : `exited with code ${code}`;
      if (output.trim() === "") {
        const status = failure && ` and ${failure}`;
        finish(new Error(`The command printed nothing to standard output${status}.${errorOutput}`));
      } else if (failure === "") {
        finish({ output });
      } else {
        const warning = `The command ${failure}, so its output may be incomplete.${errorOutput}`;
        finish({ output, warning });
      }
    };

    const timeout = `The command timed out after ${timeoutMs / 1000} seconds. Make it do less.`;
    const timer = setTimeout(() => kill(new Error(timeout)), timeoutMs);
    const cancellation = token.onCancellationRequested(() => kill(new vscode.CancellationError()));

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_BYTES) {
        kill(
          new Error(
            `The command printed more than ${MAX_MIB} MiB. ` +
              "Narrow its output down, e.g. by filtering or with head.",
          ),
        );
      } else {
        stdout.push(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      stderr.push(chunk);
      // Keep only the recent part of long error output.
      while (stderrBytes > STDERR_TAIL * 4 && stderr.length > 1) {
        stderrBytes -= stderr.shift()?.length ?? 0;
      }
    });
    child.on("error", (error) => finish(new Error(`Could not run the command: ${error.message}`)));
    // "close" comes once the output pipes are closed, which a process left running in the
    // background may prevent; then the output so far is used shortly after the command exits.
    child.on("exit", (code, signal) => {
      if (!settled) {
        graceTimer = setTimeout(() => {
          killTree();
          complete(code, signal);
        }, EXIT_GRACE_MS);
      }
    });
    child.on("close", (code, signal) => complete(code, signal));
  });
}

/**
 * Loads and parses a chart's data: `spec.data`, the file `spec.file` or the output of
 * `spec.command`.
 *
 * `unasked` is given when the user was not asked about reading `spec.file`; see
 * {@link readDataFile}.
 *
 * @returns The table, and a warning when a command failed but printed data anyway.
 * @throws Error explaining why the data could not be loaded or parsed, or
 *   vscode.CancellationError.
 */
export async function loadTable(
  spec: ChartSpec,
  token: vscode.CancellationToken,
  unasked?: Unasked,
): Promise<{ table: DataTable; warning?: string }> {
  throwIfCancelled(token);
  let text: string;
  let warning: string | undefined;
  if (spec.data !== undefined) {
    text = spec.data;
  } else if (spec.file !== undefined) {
    text = await unlessCancelled(() => readDataFile(spec.file, unasked), token);
  } else {
    ({ output: text, warning } = await runCommand(spec.command, token));
  }
  throwIfCancelled(token);
  const si = spec.command !== undefined && printsSiSizes(spec.command);
  return { table: parseTable(text, spec.format, si), ...(warning ? { warning } : {}) };
}
