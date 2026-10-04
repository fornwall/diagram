// Read-only workspace tools that let a model find, search and read code to diagram. Results are
// plain text, as models read numbered lines and paths more reliably and cheaply than JSON.

import { realpath } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { throwIfCancelled, unlessCancelled } from "./cancellation";
import { errorMessage, isPlainObject } from "./protocol";
import { plural, unknownProperties } from "./text";

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
/** How much of a long line to show before a search match. */
const MATCH_CONTEXT_CHARS = 200;
const MAX_READ_LINES = 500;
const DEFAULT_READ_LINES = 200;
/** Files read ahead while searching, as reading them one by one waits on each. */
const READ_AHEAD = 8;
const DEFAULT_EXCLUDES = ["**/.git/**", "**/node_modules/**"];

/** The input without the null values some models send for omitted properties. */
function objectInput(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error("Give the tool input as an object.");
  const input = Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null));
  const unknown = unknownProperties(input, keys);
  if (unknown !== undefined) {
    throw new Error(unknown);
  }
  return input;
}

function integer(value: unknown, fallback: number, name: string, max?: number): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    (max !== undefined && value > max)
  ) {
    throw new Error(
      `"${name}" must be ${max === undefined ? "a positive integer" : `an integer from 1 to ${max}`}.`,
    );
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

/**
 * How a result names a file, as {@link resolveWorkspaceFile} and code links accept it: relative to
 * the first workspace folder when inside it, else absolute.
 */
function displayPath(uri: vscode.Uri, roots: readonly vscode.WorkspaceFolder[]): string {
  const first = roots[0]?.uri;
  if (first && contains(first, uri)) {
    const relative =
      first.scheme === "file"
        ? path.relative(first.fsPath, uri.fsPath).split(path.sep).join("/")
        : uri.path.slice(first.path.replace(/\/$/, "").length + 1);
    if (relative) return relative;
  }
  return uri.scheme === "file" ? uri.fsPath : uri.toString();
}

/**
 * A check, for the duration of one tool call, that files are inside a workspace folder, also when
 * resolving symbolic links. It caches what it resolves.
 */
function boundary(
  roots: readonly vscode.WorkspaceFolder[],
  token: vscode.CancellationToken,
): (uri: vscode.Uri) => Promise<void> {
  // A missing workspace folder must not prevent reading from the others.
  const realRoots = Promise.all(
    roots
      .filter(({ uri }) => uri.scheme === "file")
      .map(({ uri }) => realpath(uri.fsPath).catch(() => undefined)),
  );
  const checkedDirectories = new Map<string, Promise<void>>();
  /** Providers have no realpath API. Refuse reported symbolic links, including parent directories. */
  const noLinks = (uri: vscode.Uri, root: vscode.Uri): Promise<void> => {
    const key = uri.toString();
    if (uri.path.replace(/\/$/, "") === root.path.replace(/\/$/, "")) return Promise.resolve();
    let checked = checkedDirectories.get(key);
    if (!checked) {
      checked = Promise.resolve(vscode.workspace.fs.stat(uri)).then((stat) => {
        if (stat.type & vscode.FileType.SymbolicLink) {
          throw new Error("Symbolic links cannot be read safely through this filesystem provider.");
        }
        return noLinks(vscode.Uri.joinPath(uri, ".."), root);
      });
      checkedDirectories.set(key, checked);
    }
    return checked;
  };
  return async (uri) => {
    throwIfCancelled(token);
    const root = roots.find((root) => contains(root.uri, uri));
    if (!root) throw new Error("The file is outside the workspace folders.");
    if (uri.scheme !== "file") {
      return unlessCancelled(() => noLinks(uri, root.uri), token);
    }
    const [actual, actualRoots] = await unlessCancelled(
      () => Promise.all([realpath(uri.fsPath), realRoots]),
      token,
    );
    if (!actualRoots.some((actualRoot) => actualRoot && withinPath(actualRoot, actual))) {
      throw new Error("The file resolves through a symbolic link outside the workspace.");
    }
  };
}

async function candidates(
  roots: readonly vscode.WorkspaceFolder[],
  glob: string,
  max: number,
  token: vscode.CancellationToken,
): Promise<{ files: vscode.Uri[]; truncated: boolean }> {
  const files: vscode.Uri[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    throwIfCancelled(token);
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
    // Nested workspace roots may return files already found in an earlier root.
    const overlapping = files.filter((uri) => contains(root.uri, uri)).length;
    const found = await unlessCancelled(
      async () =>
        vscode.workspace.findFiles(
          new vscode.RelativePattern(root, glob),
          `{${[...patterns].join(",")}}`,
          max + 1 - files.length + overlapping,
          token,
        ),
      token,
    );
    throwIfCancelled(token);
    for (const uri of found) {
      if (!seen.has(uri.toString())) {
        seen.add(uri.toString());
        files.push(uri);
      }
    }
    if (files.length > max) return { files: files.slice(0, max), truncated: true };
  }
  return { files, truncated: false };
}

/** The text of a file, or why it is not read, with the bytes read to find out. */
type FileText = { bytes: number; unsaved?: boolean } & ({ text: string } | { error: string });

async function readText(
  uri: vscode.Uri,
  check: (uri: vscode.Uri) => Promise<void>,
  token: vscode.CancellationToken,
): Promise<FileText> {
  await check(uri);
  const open = vscode.workspace.textDocuments.find(
    (document) => document.uri.toString() === uri.toString() && !document.isClosed,
  );
  const tooLarge = "The file exceeds the 1 MiB text limit.";
  const binary = "Binary files are not supported.";
  if (open?.isDirty) {
    const text = open.getText();
    const bytes = Buffer.byteLength(text);
    if (bytes > MAX_FILE_BYTES) return { bytes: 0, error: tooLarge };
    return text.includes("\0") ? { bytes, error: binary } : { bytes, text, unsaved: true };
  }
  const stat = await unlessCancelled(async () => vscode.workspace.fs.stat(uri), token);
  if (stat.type & vscode.FileType.Directory) {
    return { bytes: 0, error: "The path is a directory; give a text file." };
  }
  if (stat.size > MAX_FILE_BYTES) return { bytes: 0, error: tooLarge };
  const content = await unlessCancelled(async () => vscode.workspace.fs.readFile(uri), token);
  const bytes = content.byteLength;
  if (bytes > MAX_FILE_BYTES) return { bytes, error: tooLarge };
  let text: string;
  try {
    const encoding =
      content[0] === 0xff && content[1] === 0xfe
        ? "utf-16le"
        : content[0] === 0xfe && content[1] === 0xff
          ? "utf-16be"
          : "utf-8";
    text = new TextDecoder(encoding, { fatal: true }).decode(content);
  } catch {
    return { bytes, error: "The file is not valid UTF-8 or UTF-16 text." };
  }
  return text.includes("\0") ? { bytes, error: binary } : { bytes, text };
}

async function result(operation: () => Promise<string>): Promise<vscode.LanguageModelToolResult> {
  let text: string;
  try {
    text = await operation();
  } catch (error) {
    if (error instanceof vscode.CancellationError) throw error;
    text = `Error: ${errorMessage(error)}`;
  }
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

function prepare(message: string): vscode.PreparedToolInvocation {
  return {
    invocationMessage: message,
    confirmationMessages: vscode.workspace.isTrusted
      ? undefined
      : {
          title: "Read workspace files?",
          message: "Allow the diagram agent to read files in this untrusted workspace?",
        },
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
      throwIfCancelled(token);
      const input = objectInput(options.input, ["glob", "maxResults"]);
      const max = integer(input.maxResults, 100, "maxResults", 200);
      const glob = globInput(input.glob);
      const roots = folders();
      const check = boundary(roots, token);
      const found = await candidates(roots, glob, max, token);
      const lines: string[] = [];
      let outsideFiles = 0;
      let outputChars = 0;
      let truncated = found.truncated;
      for (const uri of found.files) {
        try {
          await check(uri);
        } catch (error) {
          if (error instanceof vscode.CancellationError) throw error;
          outsideFiles++;
          continue;
        }
        const line = displayPath(uri, roots);
        outputChars += line.length + 1;
        if (outputChars > MAX_OUTPUT_CHARS) {
          truncated = true;
          break;
        }
        lines.push(line);
      }
      const listed = lines.length;
      if (listed === 0 && !truncated && outsideFiles === 0) {
        lines.push(`No files match ${JSON.stringify(glob)}.`);
      }
      if (outsideFiles > 0) {
        lines.push(`Left out ${plural(outsideFiles, "file")} linked outside the workspace.`);
      }
      if (truncated) {
        lines.push(`Showing the first ${plural(listed, "file")}; narrow the glob to see more.`);
      }
      return lines.join("\n");
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
      throwIfCancelled(token);
      const input = objectInput(options.input, ["query", "glob", "caseSensitive", "maxResults"]);
      const { query, caseSensitive } = input;
      if (typeof query !== "string" || !query || query.length > 500 || /[\r\n\0]/.test(query)) {
        throw new Error(
          'Give "query" as a nonempty, single-line literal string of at most 500 characters.',
        );
      }
      if (caseSensitive !== undefined && typeof caseSensitive !== "boolean") {
        throw new Error('"caseSensitive" must be a boolean.');
      }
      const max = integer(input.maxResults, 50, "maxResults", 100);
      const glob = globInput(input.glob);
      const roots = folders();
      const check = boundary(roots, token);
      const { files, truncated: tooManyFiles } = await candidates(
        roots,
        glob,
        MAX_SCANNED_FILES,
        token,
      );
      // A Unicode regexp keeps source offsets correct when case folding changes string length.
      const needle = new RegExp(
        query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        caseSensitive ? "gu" : "giu",
      );
      const output: string[] = [];
      let matches = 0;
      let matchedFiles = 0;
      let skipped = 0;
      let scanned = 0;
      let scannedBytes = 0;
      let outputChars = 0;
      let stopped: string | undefined;
      const reads: Promise<FileText | { failure: unknown }>[] = [];
      const read = (index: number) => {
        const uri = files[index];
        if (uri && !reads[index]) {
          reads[index] = readText(uri, check, token).catch((failure: unknown) => ({ failure }));
        }
      };
      search: for (const [index, uri] of files.entries()) {
        for (let ahead = index; ahead < index + READ_AHEAD; ahead++) read(ahead);
        const content = await unlessCancelled(async () => reads[index], token);
        throwIfCancelled(token);
        if (!content || "failure" in content) {
          if (content?.failure instanceof vscode.CancellationError) throw content.failure;
          skipped++;
          continue;
        }
        // Count binary and invalid text too, which is read before it is rejected.
        if (scannedBytes + content.bytes > MAX_SCANNED_BYTES) {
          stopped = "it reached the 16 MiB scan limit";
          break;
        }
        scannedBytes += content.bytes;
        if ("error" in content) {
          skipped++;
          continue;
        }
        scanned++;
        const { text } = content;
        // Search the whole file and skip the remainder of each matching line. This avoids
        // splitting and searching every line, and stops as soon as the output limit is reached.
        needle.lastIndex = 0;
        const lineBreaks = /\r\n|\r|\n/g;
        let line = 1;
        let lineStart = 0;
        let fileHeader = false;
        for (let match = needle.exec(text); match; match = needle.exec(text)) {
          if (matches >= max) {
            stopped = `it reached ${plural(max, "match", "matches")}`;
            break search;
          }
          let newline = lineBreaks.exec(text);
          while (newline && newline.index < match.index) {
            line++;
            lineStart = newline.index + newline[0].length;
            newline = lineBreaks.exec(text);
          }
          const lineEnd = newline?.index ?? text.length;
          let start = Math.max(lineStart, match.index - MATCH_CONTEXT_CHARS);
          // Leading indentation says little in a search result.
          while (start < match.index && (text[start] === " " || text[start] === "\t")) start++;
          const end = Math.min(lineEnd, start + MAX_LINE_CHARS);
          const preview =
            (start > lineStart && /\S/.test(text.slice(lineStart, start)) ? "…" : "") +
            text.slice(start, end) +
            (end < lineEnd ? "…" : "");
          const entry = [
            ...(fileHeader
              ? []
              : [`${displayPath(uri, roots)}${content.unsaved ? " (unsaved changes)" : ""}`]),
            `  ${line}: ${preview}`,
          ];
          outputChars += entry.join("\n").length + 1;
          if (outputChars > MAX_OUTPUT_CHARS) {
            stopped = "its output reached the size limit";
            break search;
          }
          output.push(...entry);
          matches++;
          if (!fileHeader) {
            fileHeader = true;
            matchedFiles++;
          }
          if (!newline) break;
          line++;
          lineStart = newline.index + newline[0].length;
          needle.lastIndex = lineStart;
        }
      }
      if (!stopped && tooManyFiles) {
        stopped = `more than ${MAX_SCANNED_FILES} files match the glob`;
      }
      const summary = [
        matches > 0
          ? `${plural(matches, "match", "matches")} in ${plural(matchedFiles, "file")}`
          : "No matches",
        ` (searched ${plural(scanned, "file")}`,
        skipped > 0
          ? `; skipped ${plural(skipped, "file")}: binary, not UTF-8 or UTF-16, over 1 MiB or linked outside the workspace`
          : "",
        ").",
        stopped
          ? ` Incomplete: the search stopped because ${stopped}. Narrow the glob or use a more specific query.`
          : "",
      ].join("");
      return [summary, ...output].join("\n");
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
      throwIfCancelled(token);
      const input = objectInput(options.input, ["file", "startLine", "endLine"]);
      const start = integer(input.startLine, 1, "startLine");
      const requestedEnd = integer(input.endLine, start + DEFAULT_READ_LINES - 1, "endLine");
      if (requestedEnd < start) throw new Error("endLine must not be less than startLine.");
      const end = Math.min(requestedEnd, start + MAX_READ_LINES - 1);
      const roots = folders();
      const uri = resolveWorkspaceFile(input.file, roots);
      const content = await readText(uri, boundary(roots, token), token);
      if ("error" in content) throw new Error(content.error);
      const { text } = content;
      const lines: string[] = [];
      let outputChars = 0;
      let cutLines = false;
      let totalLines = 0;
      let lastLine = start - 1;
      let lineStart = 0;
      const nextBreak = (character: string, from: number): number => {
        const index = text.indexOf(character, from);
        return index < 0 ? text.length : index;
      };
      let lf = nextBreak("\n", 0);
      let cr = nextBreak("\r", 0);
      // Count every line, but allocate text only for the requested page. A large file may
      // contain hundreds of thousands of short lines while a read returns at most 500.
      for (;;) {
        const lineEnd = lf < cr ? lf : cr;
        totalLines++;
        if (totalLines === lastLine + 1 && totalLines <= end) {
          const cut = lineEnd - lineStart > MAX_LINE_CHARS;
          const entry = `${totalLines}: ${text.slice(lineStart, cut ? lineStart + MAX_LINE_CHARS : lineEnd)}${cut ? `… (${lineEnd - lineStart} characters)` : ""}`;
          outputChars += entry.length + 1;
          if (outputChars <= MAX_OUTPUT_CHARS) {
            cutLines ||= cut;
            lines.push(entry);
            lastLine = totalLines;
          }
        }
        if (lineEnd === text.length) break;
        lineStart = lineEnd + (cr === lineEnd && lf === cr + 1 ? 2 : 1);
        // Each cursor advances only when consumed, so mixed endings remain a linear scan.
        if (lf < lineStart) lf = nextBreak("\n", lineStart);
        if (cr < lineStart) cr = nextBreak("\r", lineStart);
      }
      if (start > totalLines) {
        throw new Error(
          `startLine ${start} is past the end of the file, which has ${totalLines} lines.`,
        );
      }
      const notes = [
        cutLines ? `Lines longer than ${MAX_LINE_CHARS} characters are cut.` : "",
        lastLine < totalLines ? `Continue with startLine ${lastLine + 1}.` : "",
      ].filter(Boolean);
      return [
        `${displayPath(uri, roots)}, lines ${start}-${lastLine} of ${totalLines}${content.unsaved ? ", with unsaved changes" : ""}:`,
        ...lines,
        ...notes,
      ].join("\n");
    });
  }
}
