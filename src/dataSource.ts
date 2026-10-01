// Loading chart data from inline text, a file or a shell command, and charting it.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ChartSpec } from "./chartSpec";
import { buildChart, describeTable } from "./charts";
import { type DataTable, parseTable } from "./data";
import { errorMessage } from "./protocol";

/** The largest file or command output that is read. */
const MAX_MB = 10;
const MAX_BYTES = MAX_MB * 1024 * 1024;
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
 * Resolves a data file path as given in a chart spec: "~" and "~/…" relative to the home
 * directory, absolute paths as they are, and other paths relative to the first workspace folder.
 *
 * @throws Error when the path is relative but no workspace folder is open.
 */
export function resolveFile(file: string): vscode.Uri {
  if (file === "~" || file.startsWith("~/")) {
    return vscode.Uri.file(path.join(os.homedir(), file.slice(1)));
  }
  if (path.isAbsolute(file)) {
    return vscode.Uri.file(file);
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) {
    throw new Error(
      `The file path ${JSON.stringify(file)} is relative, but no workspace folder is open. ` +
        "Give an absolute path.",
    );
  }
  return vscode.Uri.joinPath(folder.uri, file);
}

export async function readDataFile(file: string): Promise<string> {
  const uri = resolveFile(file);
  let stat: vscode.FileStat;
  try {
    stat = await vscode.workspace.fs.stat(uri);
  } catch (error) {
    if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
      throw new Error(`The file ${uri.fsPath} does not exist.`);
    }
    throw error;
  }
  if (stat.type & vscode.FileType.Directory) {
    throw new Error(
      `${uri.fsPath} is a directory, not a data file. To chart the files in it, use a command ` +
        "such as du.",
    );
  }
  if (stat.size > MAX_BYTES) {
    throw new Error(
      `The file ${uri.fsPath} is larger than the ${MAX_MB} MB limit. ` +
        "Use a command that summarizes it instead.",
    );
  }
  const bytes = await vscode.workspace.fs.readFile(uri);
  // UTF-16 files, as PowerShell writes with >, start with a byte order mark.
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes);
  }
  if (bytes.includes(0)) {
    throw new Error(
      `The file ${uri.fsPath} is not a text file (it may be a spreadsheet). ` +
        "Save its data as CSV, or use a command that prints it.",
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Excel on Windows saves CSV files in the Windows code page.
    return new TextDecoder("windows-1252").decode(bytes);
  }
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
  if (token.isCancellationRequested) {
    throw new vscode.CancellationError();
  }
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
      const output = Buffer.concat(stdout).toString("utf8");
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

    const timeout = `The command timed out after ${timeoutMs / 1000} s. Make it do less.`;
    const timer = setTimeout(() => kill(new Error(timeout)), timeoutMs);
    const cancellation = token.onCancellationRequested(() => kill(new vscode.CancellationError()));

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_BYTES) {
        kill(
          new Error(
            `The command printed more than ${MAX_MB} MB. ` +
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
      graceTimer = setTimeout(() => {
        killTree();
        complete(code, signal);
      }, EXIT_GRACE_MS);
    });
    child.on("close", (code, signal) => complete(code, signal));
  });
}

/**
 * Loads and parses a chart's data: `spec.data`, the file `spec.file` or the output of
 * `spec.command`.
 *
 * @returns The table, and a warning when a command failed but printed data anyway.
 * @throws Error explaining why the data could not be loaded or parsed, or
 *   vscode.CancellationError.
 */
export async function loadTable(
  spec: ChartSpec,
  token: vscode.CancellationToken,
): Promise<{ table: DataTable; warning?: string }> {
  if (spec.data !== undefined) {
    return { table: parseTable(spec.data, spec.format) };
  }
  if (spec.file !== undefined) {
    return { table: parseTable(await readDataFile(spec.file), spec.format) };
  }
  const { output, warning } = await runCommand(spec.command, token);
  return { table: parseTable(output, spec.format), ...(warning ? { warning } : {}) };
}

export interface LoadedChart {
  option: Record<string, unknown>;
  /** How the data was read and charted, for a language model. */
  report: string;
}

/**
 * Loads a chart's data with {@link loadTable} and charts it.
 *
 * @throws Error explaining why, with how the data was read if that worked, or
 *   vscode.CancellationError.
 */
export async function loadChart(
  spec: ChartSpec,
  token: vscode.CancellationToken,
): Promise<LoadedChart> {
  const { table, warning } = await loadTable(spec, token);
  const description = `The data was read as: ${describeTable(table)}`;
  try {
    const { option, summary } = buildChart(spec, table);
    const report = [summary, warning, description].filter((part) => part !== undefined);
    return { option, report: report.join("\n\n") };
  } catch (error) {
    throw new Error(`${errorMessage(error)}\n\n${description}`);
  }
}
