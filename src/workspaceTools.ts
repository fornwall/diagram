// Read-only workspace tools that let a model find, search and read code to diagram. Results are
// plain text, as models read numbered lines and paths more reliably and cheaply than JSON.

import { realpath } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { throwIfCancelled, unlessCancelled } from "./cancellation";
import {
  absoluteFile,
  absolutePath,
  contains,
  decodeFile,
  fileError,
  inWorkspace,
  nearRoot,
  withinPath,
} from "./files";
import { errorMessage, FIND_FILES_TOOL, isPlainObject } from "./protocol";
import { plural, quote, toolInput } from "./text";
import { textResult } from "./tools";

const MIB = 1024 * 1024;
/** Searches skip larger files, which are rarely source code. */
const MAX_SEARCHED_BYTES = MIB;
/** A read returns only a page of lines, so it may read larger files than a search. */
const MAX_READ_BYTES = 16 * MIB;
const MAX_SCANNED_FILES = 1000;
const MAX_SCANNED_BYTES = 16 * MIB;
const MAX_OUTPUT_CHARS = 40_000;
const MAX_LINE_CHARS = 1000;
/** How much of a long line to show before a search match. */
const MATCH_CONTEXT_CHARS = 200;
const MAX_READ_LINES = 500;
const DEFAULT_READ_LINES = 200;
/** Files read ahead while searching, as reading them one by one waits on each. */
const READ_AHEAD = 8;
const DEFAULT_EXCLUDES = ["**/.git/**", "**/node_modules/**"];

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
  // A glob that starts with "./", as a shell path would, matches nothing.
  return value.replace(/^(?:\.\/)+/, "") || "**/*";
}

function folders(): readonly vscode.WorkspaceFolder[] {
  const roots = vscode.workspace.workspaceFolders;
  if (!roots?.length) throw new Error("Open a workspace folder first.");
  return roots;
}

/**
 * Relative names use the first root; absolute paths and URIs disambiguate multiple roots. A URI's
 * scheme is followed by "/", which tells it from a file named "a:b.md" or a drive letter. A file
 * is inside by its path, or by its real path when typed in other case on a case-insensitive file
 * system; {@link boundary} then checks where links lead.
 */
export function resolveWorkspaceFile(
  file: unknown,
  roots: readonly vscode.WorkspaceFolder[],
): vscode.Uri {
  if (typeof file !== "string" || !file.trim() || file.includes("\0") || file.length > 4096) {
    throw new Error('Give "file" as a workspace file path or URI.');
  }
  const firstRoot = roots[0];
  if (!firstRoot) throw new Error("Open a workspace folder first.");
  const uri = path.isAbsolute(file)
    ? absoluteFile(file, roots)
    : /^[a-zA-Z][\w+.-]+:\//.test(file)
      ? vscode.Uri.parse(file, true)
      : vscode.Uri.joinPath(firstRoot.uri, file);
  if (
    uri.query ||
    uri.fragment ||
    !(roots.some((root) => contains(root.uri, uri)) || inWorkspace(uri, roots))
  ) {
    throw new Error(
      "The file must be inside an open workspace folder, without a query or fragment.",
    );
  }
  return uri;
}

/** The glob that lists a folder's files with diagram_findFiles, if it is in the workspace. */
export function filesGlob(folder: vscode.Uri): string | undefined {
  const root = vscode.workspace.getWorkspaceFolder(folder)?.uri.path.replace(/\/$/, "");
  if (root === undefined) return undefined;
  // Names such as Next.js's "[id]" are matched literally, each glob character in brackets.
  const relative = folder.path.slice(root.length + 1).replace(/[[\]{}*?]/g, "[$&]");
  return relative ? `${relative}/**` : "**";
}

/**
 * How a result names a file, as {@link resolveWorkspaceFile} and code links accept it: relative to
 * the first workspace folder when inside it, else absolute, or as a URI when no path names it.
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
  return absolutePath(uri, roots) ?? uri.toString();
}

/**
 * A check, for the duration of one tool call, that files are inside a workspace folder, also when
 * resolving symbolic links. It caches what it resolves.
 */
export function boundary(
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
  const outside = () => new Error("The file is outside the workspace folders.");
  return async (uri) => {
    throwIfCancelled(token);
    const root = roots.find((root) => contains(root.uri, uri));
    if (uri.scheme !== "file") {
      if (!root) throw outside();
      return unlessCancelled(() => noLinks(uri, root.uri), token);
    }
    if (!roots.some((root) => nearRoot(root.uri, uri))) throw outside();
    // The real path decides, as it has the case of the names on disk, which a path typed for a
    // case-insensitive file system may not.
    const [actual, actualRoots] = await unlessCancelled(
      () =>
        Promise.all([
          realpath(uri.fsPath).catch((error: unknown) => {
            throw root ? error : outside();
          }),
          realRoots,
        ]),
      token,
    );
    if (!actualRoots.some((actualRoot) => actualRoot && withinPath(actualRoot, actual))) {
      throw root
        ? new Error("The file resolves through a symbolic link outside the workspace.")
        : outside();
    }
  };
}

function exists(uri: vscode.Uri): Promise<boolean> {
  return Promise.resolve(vscode.workspace.fs.stat(uri)).then(
    () => true,
    () => false,
  );
}

/**
 * Whether a relative path matches a glob as in VS Code, whose "*" and "**" match a name's leading
 * dot, unlike Node's: a leading dot is "\u0001" in the path and pattern alike. A dot that starts a
 * brace alternative, as in "*{.js,.map}", may or may not start a name, so it matches either.
 */
function matchesGlob(relative: string, pattern: string): boolean {
  const undot = (glob: string) => glob.replace(/(^|\/)\./g, "$1\u0001");
  const dots = undot(pattern).replace(/\[[^\]]*\]|([{,])\./g, (match, before?: string) =>
    before === undefined ? match : `${before}[.\u0001]`,
  );
  return path.matchesGlob(undot(relative), dots);
}

/**
 * Leaves out the files that a conditional exclude hides, as a sibling file named by its "when",
 * such as `{ "when": "$(basename).ts" }`, exists. "$(basename)" is the file name without its
 * extension, as in VS Code.
 */
async function withoutHiddenSiblings(
  root: vscode.WorkspaceFolder,
  files: readonly vscode.Uri[],
  conditions: readonly [pattern: string, when: string][],
  token: vscode.CancellationToken,
): Promise<vscode.Uri[]> {
  const hidden = await unlessCancelled(
    () =>
      Promise.all(
        files.map(async (uri) => {
          const relative = path.posix.relative(root.uri.path, uri.path);
          const name = path.posix.basename(uri.path);
          const stem = name.slice(0, name.length - path.posix.extname(name).length);
          for (const [pattern, when] of conditions) {
            const sibling = when.replace("$(basename)", stem);
            if (
              !sibling.includes("/") &&
              matchesGlob(relative, pattern) &&
              (await exists(vscode.Uri.joinPath(uri, "..", sibling)))
            ) {
              return true;
            }
          }
          return false;
        }),
      ),
    token,
  );
  return files.filter((_, index) => !hidden[index]);
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
    // An exclude passed to findFiles replaces files.exclude, so pass both settings. It cannot
    // carry a condition on sibling files, which is checked on the files found.
    const patterns = new Set(DEFAULT_EXCLUDES);
    const conditions: [string, string][] = [];
    for (const section of ["files", "search"]) {
      const excludes = vscode.workspace
        .getConfiguration(section, root.uri)
        .get<Record<string, unknown>>("exclude", {});
      for (const [pattern, enabled] of Object.entries(excludes)) {
        const when = isPlainObject(enabled) ? enabled.when : undefined;
        if (typeof when === "string") conditions.push([pattern, when]);
        else if (enabled) patterns.add(pattern);
      }
    }
    // Nested workspace roots may return files already found in an earlier root.
    const overlapping = files.filter((uri) => contains(root.uri, uri)).length;
    const limit = max + 1 - files.length + overlapping;
    const found = await unlessCancelled(
      async () =>
        vscode.workspace.findFiles(
          new vscode.RelativePattern(root, glob),
          `{${[...patterns].join(",")}}`,
          limit,
          token,
        ),
      token,
    );
    throwIfCancelled(token);
    const shown =
      conditions.length > 0 ? await withoutHiddenSiblings(root, found, conditions, token) : found;
    for (const uri of shown) {
      if (!seen.has(uri.toString())) {
        seen.add(uri.toString());
        files.push(uri);
      }
    }
    // Hidden files may leave fewer than the limit while more remain.
    if (files.length > max || found.length >= limit) {
      return { files: files.slice(0, max), truncated: true };
    }
  }
  return { files, truncated: false };
}

/** Whether reading a file failed in the file system, rather than at the workspace boundary. */
function isFileError(error: unknown, uri: vscode.Uri): boolean {
  return fileError(error, uri) !== error;
}

/** The text of a file, or why it is not read, with the bytes read to find out. */
type FileText = { bytes: number; unsaved?: boolean } & ({ text: string } | { error: string });

async function readText(
  uri: vscode.Uri,
  check: (uri: vscode.Uri) => Promise<void>,
  token: vscode.CancellationToken,
  maxBytes: number,
): Promise<FileText> {
  await check(uri);
  const open = vscode.workspace.textDocuments.find(
    (document) => document.uri.toString() === uri.toString() && !document.isClosed,
  );
  const tooLarge = `The file exceeds the ${maxBytes / MIB} MiB text limit.`;
  const binary = "Binary files are not supported.";
  if (open?.isDirty) {
    const text = open.getText();
    const bytes = Buffer.byteLength(text);
    if (bytes > maxBytes) return { bytes: 0, error: tooLarge };
    return text.includes("\0") ? { bytes, error: binary } : { bytes, text, unsaved: true };
  }
  const stat = await unlessCancelled(async () => vscode.workspace.fs.stat(uri), token);
  if (stat.type & vscode.FileType.Directory) {
    throw vscode.FileSystemError.FileIsADirectory(uri);
  }
  if (stat.size > maxBytes) return { bytes: 0, error: tooLarge };
  const content = await unlessCancelled(async () => vscode.workspace.fs.readFile(uri), token);
  const bytes = content.byteLength;
  if (bytes > maxBytes) return { bytes, error: tooLarge };
  let text: string;
  try {
    text = await unlessCancelled(() => decodeFile(content, uri), token);
  } catch (error) {
    if (error instanceof vscode.CancellationError) throw error;
    return { bytes, error: binary };
  }
  return text.includes("\0") ? { bytes, error: binary } : { bytes, text };
}

/**
 * A read-only workspace tool, which asks before reading an untrusted workspace and reports invalid
 * input and failures to the model.
 */
abstract class WorkspaceTool implements vscode.LanguageModelTool<unknown> {
  constructor(private readonly keys: readonly string[]) {}

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<unknown>,
  ): vscode.PreparedToolInvocation {
    const invocationMessage = this.message(isPlainObject(options.input) ? options.input : {});
    if (vscode.workspace.isTrusted) {
      return { invocationMessage };
    }
    return {
      invocationMessage,
      confirmationMessages: {
        title: "Read workspace files?",
        message: "Allow the diagram agent to read files in this untrusted workspace?",
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<unknown>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      throwIfCancelled(token);
      return textResult(await this.run(toolInput(options.input, this.keys), token));
    } catch (error) {
      if (error instanceof vscode.CancellationError) throw error;
      return textResult(`Error: ${errorMessage(error)}`);
    }
  }

  /** What the chat shows while the tool runs, from its input as the model gave it. */
  protected abstract message(input: Record<string, unknown>): string;

  protected abstract run(
    input: Record<string, unknown>,
    token: vscode.CancellationToken,
  ): Promise<string>;
}

/** A string input as the chat shows it, if the model gave one. */
function shown(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? quote(value, 80) : undefined;
}

export class FindWorkspaceFilesTool extends WorkspaceTool {
  constructor() {
    super(["glob", "maxResults"]);
  }

  protected message({ glob }: Record<string, unknown>) {
    const pattern = shown(glob);
    return pattern ? `Finding workspace files matching ${pattern}` : "Finding workspace files";
  }

  protected async run(input: Record<string, unknown>, token: vscode.CancellationToken) {
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
        // A file that the file system fails on, such as one deleted since, is left out unsaid.
        if (!isFileError(error, uri)) outsideFiles++;
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
      lines.push(
        `No files match ${JSON.stringify(glob)}.` +
          (/[*?[{]/.test(glob)
            ? ""
            : ` To list the files in a folder, use the glob "${glob.replace(/\/$/, "")}/**".`),
      );
    }
    if (outsideFiles > 0) {
      lines.push(`Left out ${plural(outsideFiles, "file")} linked outside the workspace.`);
    }
    if (truncated) {
      lines.push(`Showing the first ${plural(listed, "file")}; narrow the glob to see more.`);
    }
    return lines.join("\n");
  }
}

export class SearchWorkspaceTextTool extends WorkspaceTool {
  constructor() {
    super(["query", "glob", "caseSensitive", "maxResults"]);
  }

  protected message({ query, glob }: Record<string, unknown>) {
    const text = shown(query);
    const pattern = shown(glob);
    if (!text) return "Searching workspace text";
    return `Searching ${pattern ? `files matching ${pattern}` : "the workspace"} for ${text}`;
  }

  protected async run(input: Record<string, unknown>, token: vscode.CancellationToken) {
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
    const needle = new RegExp(RegExp.escape(query), caseSensitive ? "gu" : "giu");
    const output: string[] = [];
    let matches = 0;
    let matchedFiles = 0;
    const skipped = {
      "binary or over 1 MiB": 0,
      "linked outside the workspace": 0,
      unreadable: 0,
    };
    let scanned = 0;
    let scannedBytes = 0;
    let outputChars = 0;
    let stopped: string | undefined;
    const reads: Promise<FileText | { failure: unknown }>[] = [];
    const read = (index: number) => {
      const uri = files[index];
      if (uri && !reads[index]) {
        reads[index] = readText(uri, check, token, MAX_SEARCHED_BYTES).catch(
          (failure: unknown) => ({ failure }),
        );
      }
    };
    search: for (const [index, uri] of files.entries()) {
      for (let ahead = index; ahead < index + READ_AHEAD; ahead++) read(ahead);
      const content = await unlessCancelled(async () => reads[index], token);
      throwIfCancelled(token);
      if (!content || "failure" in content) {
        if (content?.failure instanceof vscode.CancellationError) throw content.failure;
        skipped[
          isFileError(content?.failure, uri) ? "unreadable" : "linked outside the workspace"
        ]++;
        continue;
      }
      // Count binary and invalid text too, which is read before it is rejected.
      if (scannedBytes + content.bytes > MAX_SCANNED_BYTES) {
        stopped = "it reached the 16 MiB scan limit";
        break;
      }
      scannedBytes += content.bytes;
      if ("error" in content) {
        skipped["binary or over 1 MiB"]++;
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
      let fileMatched = false;
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
        const found = `  ${line}: ${preview}`;
        // The file's first match comes under its path.
        const unsaved = content.unsaved ? " (unsaved changes)" : "";
        const entry = fileMatched ? found : `${displayPath(uri, roots)}${unsaved}\n${found}`;
        outputChars += entry.length + 1;
        if (outputChars > MAX_OUTPUT_CHARS) {
          stopped = "its output reached the size limit";
          break search;
        }
        output.push(entry);
        matches++;
        if (!fileMatched) matchedFiles++;
        fileMatched = true;
        if (!newline) break;
        line++;
        lineStart = newline.index + newline[0].length;
        needle.lastIndex = lineStart;
      }
    }
    if (!stopped && tooManyFiles) {
      stopped = `more than ${MAX_SCANNED_FILES} files match the glob`;
    }
    const reasons = Object.entries(skipped).filter(([, count]) => count > 0);
    const skippedFiles = reasons.reduce((sum, [, count]) => sum + count, 0);
    const summary = [
      matches > 0
        ? `${plural(matches, "match", "matches")} in ${plural(matchedFiles, "file")}`
        : "No matches",
      ` (searched ${plural(scanned, "file")}`,
      reasons.length > 0
        ? `; skipped ${plural(skippedFiles, "file")}: ${reasons.map(([reason, count]) => (reasons.length > 1 ? `${count} ${reason}` : reason)).join(", ")}`
        : "",
      ").",
      stopped
        ? ` Incomplete: the search stopped because ${stopped}. Narrow the glob or use a more specific query.`
        : "",
    ].join("");
    return [summary, ...output].join("\n");
  }
}

export class ReadWorkspaceFileTool extends WorkspaceTool {
  constructor() {
    super(["file", "startLine", "endLine"]);
  }

  protected message({ file, startLine, endLine }: Record<string, unknown>) {
    const name = shown(file);
    if (!name) return "Reading a workspace file";
    const lines =
      typeof startLine === "number" && typeof endLine === "number"
        ? `, lines ${startLine}-${endLine}`
        : typeof startLine === "number"
          ? ` from line ${startLine}`
          : "";
    return `Reading ${name}${lines}`;
  }

  protected async run(input: Record<string, unknown>, token: vscode.CancellationToken) {
    const start = integer(input.startLine, 1, "startLine");
    const requestedEnd = integer(input.endLine, start + DEFAULT_READ_LINES - 1, "endLine");
    if (requestedEnd < start) {
      throw new Error('"endLine" must not be less than "startLine".');
    }
    const end = Math.min(requestedEnd, start + MAX_READ_LINES - 1);
    const roots = folders();
    const uri = resolveWorkspaceFile(input.file, roots);
    const content = await readText(uri, boundary(roots, token), token, MAX_READ_BYTES).catch(
      (error: unknown) => {
        throw fileError(error, uri, {
          FileIsADirectory: `List its files with ${FIND_FILES_TOOL} and the glob "${filesGlob(uri)}".`,
        });
      },
    );
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
        `"startLine" ${start} is past the end of the file, which has ${plural(totalLines, "line")}.`,
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
  }
}
