import { realpath } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { unlessCancelled } from "./cancellation";
import { errorMessage, isPlainObject } from "./protocol";

interface FindInput {
  glob?: string;
  maxResults?: number;
}
interface SearchInput extends FindInput {
  query: string;
  caseSensitive?: boolean;
}
interface ReadInput {
  file: string;
  startLine?: number;
  endLine?: number;
}

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SCANNED_FILES = 1000;
const MAX_SCANNED_BYTES = 16 * MAX_FILE_BYTES;
const MAX_OUTPUT_CHARS = 40_000;
const MAX_LINE_CHARS = 1000;
const DEFAULT_EXCLUDES = ["**/.git/**", "**/node_modules/**"];

function checkCancelled(token: vscode.CancellationToken): void {
  if (token.isCancellationRequested) throw new vscode.CancellationError();
}

function objectInput(value: unknown): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error("Give the tool input as an object.");
}

function integer(
  value: unknown,
  fallback: number,
  name: string,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`"${name}" must be an integer from 1 to ${max}.`);
  }
  return value;
}

function globInput(value: unknown): string {
  if (value === undefined) return "**/*";
  if (typeof value !== "string" || !value.trim() || value.length > 1000 || value.includes("\0")) {
    throw new Error(
      'Give "glob" as a nonempty workspace-relative glob of at most 1000 characters.',
    );
  }
  if (path.isAbsolute(value) || value.split(/[\\/]/).includes("..")) {
    throw new Error('"glob" must be relative to workspace folders and cannot contain "..".');
  }
  return value;
}

function folders(): readonly vscode.WorkspaceFolder[] {
  const roots = vscode.workspace.workspaceFolders;
  if (!roots?.length) throw new Error("Open a workspace folder first.");
  return roots;
}

function contains(root: vscode.Uri, uri: vscode.Uri): boolean {
  return (
    // Providers may run on Windows even when this extension host does not.
    (uri.scheme === "file" || !uri.path.includes("\\")) &&
    !uri.path.split("/").some((part) => part === "." || part === "..") &&
    root.scheme === uri.scheme &&
    root.authority === uri.authority &&
    (root.scheme === "file"
      ? withinPath(root.fsPath, uri.fsPath)
      : uri.path === root.path || uri.path.startsWith(`${root.path.replace(/\/$/, "")}/`))
  );
}

function withinPath(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

/** Relative names use the first root; absolute paths and URIs disambiguate multiple roots. */
export function resolveWorkspaceFile(
  file: unknown,
  roots: readonly vscode.WorkspaceFolder[] = folders(),
): vscode.Uri {
  if (typeof file !== "string" || !file.trim() || file.includes("\0") || file.length > 4096) {
    throw new Error('Give "file" as a workspace file path or URI.');
  }
  const firstRoot = roots[0];
  if (!firstRoot) throw new Error("Open a workspace folder first.");
  const uri = path.isAbsolute(file)
    ? vscode.Uri.file(file)
    : /^[a-zA-Z][\w+.-]*:/.test(file)
      ? vscode.Uri.parse(file, true)
      : vscode.Uri.joinPath(firstRoot.uri, file);
  if (uri.query || uri.fragment || !roots.some((root) => contains(root.uri, uri))) {
    throw new Error(
      "The file must be inside an open workspace folder, without a query or fragment.",
    );
  }
  return uri;
}

async function ensureContained(uri: vscode.Uri, token: vscode.CancellationToken): Promise<void> {
  checkCancelled(token);
  const roots = folders().filter((root) => contains(root.uri, uri));
  const firstRoot = roots[0];
  if (!firstRoot) throw new Error("The file is outside the workspace.");
  if (uri.scheme === "file") {
    const actual = await unlessCancelled(() => realpath(uri.fsPath), token);
    for (const root of roots) {
      const actualRoot = await unlessCancelled(() => realpath(root.uri.fsPath), token);
      if (withinPath(actualRoot, actual)) return;
    }
    throw new Error("The file resolves through a symbolic link outside the workspace.");
  }
  // Providers have no realpath API. Refuse reported symbolic links, including parent directories.
  const root = firstRoot.uri;
  let current = uri;
  while (current.path.replace(/\/$/, "") !== root.path.replace(/\/$/, "")) {
    const stat = await unlessCancelled(async () => vscode.workspace.fs.stat(current), token);
    if (stat.type & vscode.FileType.SymbolicLink) {
      throw new Error("Symbolic links cannot be read safely through this filesystem provider.");
    }
    current = vscode.Uri.joinPath(current, "..");
  }
}

function location(uri: vscode.Uri): {
  file: string;
  uri: string;
  workspace: string;
  relativePath: string;
} {
  const root = vscode.workspace.getWorkspaceFolder(uri);
  return {
    file: uri.scheme === "file" ? uri.fsPath : uri.toString(),
    uri: uri.toString(),
    workspace: root?.name ?? "",
    relativePath: vscode.workspace.asRelativePath(uri, true),
  };
}

async function candidates(
  glob: string,
  max: number,
  token: vscode.CancellationToken,
): Promise<{ files: vscode.Uri[]; truncated: boolean }> {
  const files: vscode.Uri[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const root of folders()) {
    checkCancelled(token);
    // Passing an explicit exclude replaces files.exclude, so preserve both sets of settings.
    // Conditional exclusions are conservatively excluded too: they must not leak into searches.
    const patterns = new Set(DEFAULT_EXCLUDES);
    for (const section of ["files", "search"]) {
      const excludes = vscode.workspace
        .getConfiguration(section, root.uri)
        .get<Record<string, unknown>>("exclude", {});
      for (const [pattern, enabled] of Object.entries(excludes)) {
        if (enabled) patterns.add(pattern);
      }
    }
    const exclude = `{${[...patterns].join(",")}}`;
    const remaining = max + 1 - files.length;
    const found = await unlessCancelled(
      async () =>
        vscode.workspace.findFiles(
          new vscode.RelativePattern(root, glob),
          exclude,
          remaining,
          token,
        ),
      token,
    );
    checkCancelled(token);
    for (const uri of found) {
      if (!seen.has(uri.toString())) {
        seen.add(uri.toString());
        files.push(uri);
      }
    }
    if (files.length > max) {
      truncated = true;
      break;
    }
  }
  return { files: files.slice(0, max), truncated };
}

class ScanBudgetExceeded extends Error {}

interface ReadBudget {
  remaining: number;
}

function reserveBytes(budget: ReadBudget | undefined, bytes: number): void {
  if (!budget) return;
  if (bytes > budget.remaining) throw new ScanBudgetExceeded();
  budget.remaining -= bytes;
}

async function readText(
  uri: vscode.Uri,
  token: vscode.CancellationToken,
  budget?: ReadBudget,
): Promise<{ text: string; bytes: number; unsaved: boolean }> {
  await ensureContained(uri, token);
  const open = vscode.workspace.textDocuments.find(
    (document) => document.uri.toString() === uri.toString() && !document.isClosed,
  );
  if (open?.isDirty) {
    const text = open.getText();
    const bytes = Buffer.byteLength(text);
    if (bytes > MAX_FILE_BYTES) throw new Error("File exceeds the 1 MiB text limit.");
    reserveBytes(budget, bytes);
    if (text.includes("\0")) throw new Error("Binary files are not supported.");
    return { text, bytes, unsaved: true };
  }
  const stat = await unlessCancelled(async () => vscode.workspace.fs.stat(uri), token);
  if (stat.type & vscode.FileType.Directory)
    throw new Error("The path is a directory; give a text file.");
  if (stat.size > MAX_FILE_BYTES) throw new Error("File exceeds the 1 MiB text limit.");
  // Charge before reading and decoding, including files later rejected as binary/invalid text.
  reserveBytes(budget, stat.size);
  const bytes = await unlessCancelled(async () => vscode.workspace.fs.readFile(uri), token);
  if (bytes.byteLength > stat.size) reserveBytes(budget, bytes.byteLength - stat.size);
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("File exceeds the 1 MiB text limit.");
  let text: string;
  try {
    const encoding =
      bytes[0] === 0xff && bytes[1] === 0xfe
        ? "utf-16le"
        : bytes[0] === 0xfe && bytes[1] === 0xff
          ? "utf-16be"
          : "utf-8";
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new Error("File is not valid UTF-8 or UTF-16 text.");
  }
  if (text.includes("\0")) throw new Error("Binary files are not supported.");
  return { text, bytes: bytes.byteLength, unsaved: false };
}

async function result(operation: () => Promise<unknown>): Promise<vscode.LanguageModelToolResult> {
  let value: unknown;
  try {
    value = await operation();
  } catch (error) {
    if (error instanceof vscode.CancellationError) throw error;
    value = { error: errorMessage(error) };
  }
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(JSON.stringify(value)),
  ]);
}

function prepare(message: string): vscode.PreparedToolInvocation {
  return {
    invocationMessage: message,
    ...(!vscode.workspace.isTrusted
      ? {
          confirmationMessages: {
            title: "Read workspace files?",
            message: "Allow the diagram agent to read files in this untrusted workspace?",
          },
        }
      : {}),
  };
}

export class FindWorkspaceFilesTool implements vscode.LanguageModelTool<FindInput> {
  prepareInvocation(): vscode.PreparedToolInvocation {
    return prepare("Finding workspace files");
  }

  invoke(
    options: vscode.LanguageModelToolInvocationOptions<FindInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    return result(async () => {
      checkCancelled(token);
      objectInput(options.input);
      const max = integer(options.input.maxResults, 100, "maxResults", 200);
      const found = await candidates(globInput(options.input.glob), max, token);
      const files = [];
      let skipped = 0;
      let outputChars = 0;
      let truncated = found.truncated;
      for (const uri of found.files) {
        try {
          await ensureContained(uri, token);
        } catch (error) {
          if (error instanceof vscode.CancellationError) throw error;
          skipped++;
          continue;
        }
        const entry = location(uri);
        outputChars += JSON.stringify(entry).length;
        if (outputChars > MAX_OUTPUT_CHARS) {
          truncated = true;
          break;
        }
        files.push(entry);
      }
      return {
        files,
        skipped,
        truncated,
        ...(truncated ? { hint: "Narrow glob to see more files." } : {}),
      };
    });
  }
}

export class SearchWorkspaceTextTool implements vscode.LanguageModelTool<SearchInput> {
  prepareInvocation(): vscode.PreparedToolInvocation {
    return prepare("Searching workspace text");
  }

  invoke(
    options: vscode.LanguageModelToolInvocationOptions<SearchInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    return result(async () => {
      checkCancelled(token);
      objectInput(options.input);
      const { query, caseSensitive } = options.input;
      if (typeof query !== "string" || !query || query.length > 500 || /[\r\n\0]/.test(query)) {
        throw new Error(
          'Give "query" as a nonempty, single-line literal string of at most 500 characters.',
        );
      }
      if (caseSensitive !== undefined && typeof caseSensitive !== "boolean")
        throw new Error('"caseSensitive" must be a boolean.');
      const max = integer(options.input.maxResults, 50, "maxResults", 100);
      const found = await candidates(globInput(options.input.glob), MAX_SCANNED_FILES, token);
      const matches = [];
      let skipped = 0;
      let scannedFiles = 0;
      const budget = { remaining: MAX_SCANNED_BYTES };
      let outputChars = 0;
      let truncated = found.truncated;
      // A Unicode regexp keeps source offsets correct when case folding changes string length.
      const needle = new RegExp(
        query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        caseSensitive ? "gu" : "giu",
      );
      search: for (const uri of found.files) {
        checkCancelled(token);
        let content: Awaited<ReturnType<typeof readText>>;
        try {
          content = await readText(uri, token, budget);
        } catch (error) {
          if (error instanceof vscode.CancellationError) throw error;
          if (error instanceof ScanBudgetExceeded) {
            truncated = true;
            break;
          }
          skipped++;
          continue;
        }
        scannedFiles++;
        const lines = content.text.split(/\r\n|\r|\n/);
        for (let i = 0; i < lines.length; i++) {
          checkCancelled(token);
          const line = lines[i] ?? "";
          needle.lastIndex = 0;
          const match = needle.exec(line);
          if (match) {
            if (matches.length >= max) {
              truncated = true;
              break search;
            }
            const start = Math.max(0, match.index - 200);
            const entry = {
              ...location(uri),
              line: i + 1,
              column: match.index + 1,
              text: line.slice(start, start + MAX_LINE_CHARS),
              previewStartColumn: start + 1,
              previewTruncated: start > 0 || line.length > start + MAX_LINE_CHARS,
              unsaved: content.unsaved,
            };
            outputChars += JSON.stringify(entry).length;
            if (outputChars > MAX_OUTPUT_CHARS) {
              truncated = true;
              break search;
            }
            matches.push(entry);
          }
        }
      }
      return {
        matches,
        scannedFiles,
        scannedBytes: MAX_SCANNED_BYTES - budget.remaining,
        skipped,
        truncated,
        limits: { files: MAX_SCANNED_FILES, bytes: MAX_SCANNED_BYTES },
        ...(truncated
          ? { hint: "Narrow glob or use a more specific query; these results are incomplete." }
          : {}),
      };
    });
  }
}

export class ReadWorkspaceFileTool implements vscode.LanguageModelTool<ReadInput> {
  prepareInvocation(): vscode.PreparedToolInvocation {
    return prepare("Reading workspace file lines");
  }

  invoke(
    options: vscode.LanguageModelToolInvocationOptions<ReadInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    return result(async () => {
      checkCancelled(token);
      objectInput(options.input);
      const start = integer(options.input.startLine, 1, "startLine");
      const end = integer(options.input.endLine, start + 199, "endLine");
      if (end < start || end - start >= 500)
        throw new Error("Request an inclusive range of 1 to 500 lines, with endLine >= startLine.");
      const uri = resolveWorkspaceFile(options.input.file);
      const content = await readText(uri, token);
      const allLines = content.text.split(/\r\n|\r|\n/);
      if (start > allLines.length)
        throw new Error(`startLine exceeds the file's ${allLines.length} lines.`);
      const lines = [];
      let outputChars = 0;
      let shortenedLines = 0;
      for (let i = start - 1; i < Math.min(end, allLines.length); i++) {
        checkCancelled(token);
        const full = allLines[i] ?? "";
        const truncated = full.length > MAX_LINE_CHARS;
        const entry = {
          line: i + 1,
          text: full.slice(0, MAX_LINE_CHARS),
          ...(truncated ? { truncated: true } : {}),
        };
        outputChars += JSON.stringify(entry).length;
        if (outputChars > MAX_OUTPUT_CHARS) break;
        if (truncated) shortenedLines++;
        lines.push(entry);
      }
      const last = lines.at(-1)?.line ?? start - 1;
      return {
        ...location(uri),
        totalLines: allLines.length,
        startLine: start,
        endLine: last,
        unsaved: content.unsaved,
        lines,
        truncated: shortenedLines > 0 || last < Math.min(end, allLines.length),
        shortenedLines,
        ...(last < allLines.length ? { nextStartLine: last + 1 } : {}),
      };
    });
  }
}
