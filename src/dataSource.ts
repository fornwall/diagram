// Loading chart data from inline text, a file or a shell command.

import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ChartSpec } from "./chartSpec";
import { type DataTable, parseTable } from "./data";

/** The largest file or command output that is read, in bytes. */
const MAX_BYTES = 10 * 1024 * 1024;
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

function firstWorkspaceFolder(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
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
  const folder = firstWorkspaceFolder();
  if (folder === undefined) {
    throw new Error(
      `The file path ${JSON.stringify(file)} is relative, but no workspace folder is open. ` +
        "Give an absolute path.",
    );
  }
  return vscode.Uri.joinPath(folder, file);
}

async function readDataFile(file: string): Promise<string> {
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
    throw new Error(`${uri.fsPath} is a directory, not a data file.`);
  }
  if (stat.size > MAX_BYTES) {
    throw new Error(
      `The file ${uri.fsPath} is ${(stat.size / 1024 / 1024).toFixed(1)} MB, more than the ` +
        `${MAX_BYTES / 1024 / 1024} MB limit. Use a command that summarizes it instead.`,
    );
  }
  return new TextDecoder("utf-8").decode(await vscode.workspace.fs.readFile(uri));
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > STDERR_TAIL ? `…${trimmed.slice(-STDERR_TAIL)}` : trimmed;
}

/** Runs a shell command and returns its standard output. */
function runCommand(command: string, token: vscode.CancellationToken): Promise<string> {
  if (!vscode.workspace.isTrusted) {
    return Promise.reject(
      new Error(
        "Commands are not run in an untrusted workspace. Trust the workspace (Workspaces: " +
          'Manage Workspace Trust), or give the data with "data" or "file" instead.',
      ),
    );
  }
  if (token.isCancellationRequested) {
    return Promise.reject(new vscode.CancellationError());
  }
  const cwd = firstWorkspaceFolder()?.fsPath ?? os.homedir();
  const windows = process.platform === "win32";
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      env: commandEnvironment(),
      shell: vscode.env.shell || true,
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

    const killGroup = (): void => {
      try {
        if (!windows && child.pid !== undefined) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill();
        }
      } catch {
        // Already exited.
      }
    };
    // Settles the promise once. Output pipes are closed too, as a process that left the
    // command's process group (e.g. with setsid) may keep them open indefinitely.
    const finish = (error: Error | undefined, output?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      cancellation.dispose();
      child.stdout.destroy();
      child.stderr.destroy();
      if (error !== undefined) {
        reject(error);
      } else {
        resolve(output ?? "");
      }
    };
    const kill = (reason: Error): void => {
      killGroup();
      finish(reason);
    };
    const complete = (code: number | null, signal: NodeJS.Signals | null): void => {
      const errors = tail(Buffer.concat(stderr).toString("utf8"));
      const errorOutput = errors === "" ? "" : `\nIts error output:\n${errors}`;
      if (code !== 0) {
        const status = code === null ? `was killed by ${signal}` : `failed with exit code ${code}`;
        finish(new Error(`The command \`${command}\` ${status}.${errorOutput}`));
        return;
      }
      const output = Buffer.concat(stdout).toString("utf8");
      if (output.trim() === "") {
        finish(
          new Error(
            `The command \`${command}\` printed nothing to standard output.` +
              (errorOutput === "" ? "" : errorOutput),
          ),
        );
        return;
      }
      finish(undefined, output);
    };

    const timer = setTimeout(
      () =>
        kill(
          new Error(`The command \`${command}\` timed out after ${COMMAND_TIMEOUT_MS / 1000} s.`),
        ),
      COMMAND_TIMEOUT_MS,
    );
    const cancellation = token.onCancellationRequested(() => kill(new vscode.CancellationError()));

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_BYTES) {
        kill(
          new Error(
            `The command \`${command}\` printed more than ${MAX_BYTES / 1024 / 1024} MB. ` +
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
    child.on("error", (error) =>
      finish(new Error(`Could not run the command \`${command}\`: ${error.message}`)),
    );
    // "close" comes once the output pipes are closed, which a process left running in the
    // background may prevent; then the output so far is used shortly after the command exits.
    child.on("exit", (code, signal) => {
      graceTimer = setTimeout(() => {
        killGroup();
        complete(code, signal);
      }, EXIT_GRACE_MS);
    });
    child.on("close", (code, signal) => complete(code, signal));
  });
}

/**
 * Loads the text of a chart's data, from `spec.data`, `spec.file` (absolute, or relative to the
 * first workspace folder) or the standard output of `spec.command` (run in a shell in the first
 * workspace folder, only in a trusted workspace). Files and command output are limited to 10 MB,
 * and commands to 60 seconds.
 *
 * @returns The text, and where it came from for messages, e.g. "file src/x.csv".
 * @throws Error explaining why the data could not be loaded, or vscode.CancellationError.
 */
export async function loadChartData(
  spec: ChartSpec,
  token: vscode.CancellationToken,
): Promise<{ text: string; origin: string }> {
  if (spec.data !== undefined) {
    return { text: spec.data, origin: "inline data" };
  }
  if (spec.file !== undefined) {
    return { text: await readDataFile(spec.file), origin: `file ${spec.file}` };
  }
  if (spec.command !== undefined) {
    return { text: await runCommand(spec.command, token), origin: `command \`${spec.command}\`` };
  }
  throw new Error('The chart has no data: give one of "data", "file" or "command".');
}

/**
 * Loads a chart's data with {@link loadChartData} and parses it with {@link parseTable}.
 *
 * @throws Error explaining why the data could not be loaded or parsed, or
 *   vscode.CancellationError.
 */
export async function loadTable(
  spec: ChartSpec,
  token: vscode.CancellationToken,
): Promise<{ table: DataTable; origin: string }> {
  const { text, origin } = await loadChartData(spec, token);
  try {
    return { table: parseTable(text, spec.format ?? "auto"), origin };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read the data from ${origin}: ${message}`);
  }
}
