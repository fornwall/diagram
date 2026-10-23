// Read-only workspace tools with paged, plain-text paths and numbered source lines.

import { realpath } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { throwIfCancelled, unlessCancelled } from "./cancellation";
import {
  absoluteFile,
  absolutePath,
  contains,
  decodeFile,
  decodeText,
  fileError,
  inWorkspace,
  type LocalRoot,
  nearRoot,
  staysInside,
  virtualFolderPath,
} from "./files";
import {
  type IgnoreFiles,
  type IgnoreRule,
  ignoredGlobs,
  ignoreMatcher,
  ignoreRules,
} from "./gitignore";
import { errorMessage, FIND_FILES_TOOL, isPlainObject } from "./protocol";
import { formatCount, plural, quote, toolInput } from "./text";
import { textResult } from "./toolResults";

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
/** Files read concurrently while searching or loading ignore rules. */
const READ_AHEAD = 8;
const DEFAULT_EXCLUDES = ["**/.git/**", "**/node_modules/**"];
const IGNORE_FILE = ".gitignore";
/** Maximum ignore files read per workspace folder. */
const MAX_IGNORE_FILES = 1000;
/**
 * Find extra ignore files so ignored folders do not consume the read limit.
 */
const MAX_FOUND_IGNORE_FILES = 10 * MAX_IGNORE_FILES;
/**
 * Bound ripgrep's exclude argument below Linux's 128 KiB argument limit and Windows' 32,767
 * character command-line limit.
 */
const MAX_IGNORED_GLOB_CHARS = 10_000;
/** Cache ignore files across nearby tool calls. */
export const IGNORE_FILES_KEPT_MS = 10_000;

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

/** Where to look for files: a glob to match in each of some workspace folders. */
interface FileScope {
  /** The glob as given, without a leading "./", for messages. */
  given: string;
  glob: string;
  roots: readonly vscode.WorkspaceFolder[];
}

/**
 * Where a glob looks for files. A relative glob applies to every workspace folder. An absolute
 * one, as files outside the first folder are listed, applies to the folder whose path, taken
 * literally, it starts with, the innermost where folders nest.
 */
function globInput(value: unknown, roots: readonly vscode.WorkspaceFolder[]): FileScope {
  if (value === undefined) return { given: "**/*", glob: "**/*", roots };
  if (typeof value !== "string" || !value.trim() || value.length > 1000 || value.includes("\0")) {
    throw new Error(
      'Give "glob" as a nonempty workspace-relative glob of at most 1,000 characters.',
    );
  }
  const outside = new Error(
    '"glob" must be relative to workspace folders, or start with the path of one, and cannot contain "..".',
  );
  if (value.split(/[\\/]/).includes("..")) throw outside;
  if (!path.isAbsolute(value)) {
    // A glob that starts with "./", as a shell path would, matches nothing.
    const glob = value.replace(/^(?:\.\/)+/, "") || "**/*";
    return { given: glob, glob, roots };
  }
  const typed = forwardSlashes(value);
  let scope: { root: vscode.WorkspaceFolder; start: string } | undefined;
  for (const root of roots) {
    const start = absoluteRoot(root.uri, roots);
    if (
      start !== undefined &&
      samePath(typed.slice(0, start.length), start) &&
      (typed.length === start.length || typed[start.length] === "/") &&
      start.length >= (scope?.start.length ?? 0)
    ) {
      scope = { root, start };
    }
  }
  if (!scope) throw outside;
  // The folder itself, which is no file, matches nothing, as a relative folder path does.
  const glob = typed.slice(scope.start.length + 1);
  return { given: value, glob, roots: glob ? [scope.root] : [] };
}

/** A path with "/" between names, as globs have, also on Windows. */
function forwardSlashes(file: string): string {
  return process.platform === "win32" ? file.replaceAll("\\", "/") : file;
}

/** Whether two paths are the same, ignoring case on Windows, as its file systems do. */
function samePath(one: string, other: string): boolean {
  return process.platform === "win32" ? one.toLowerCase() === other.toLowerCase() : one === other;
}

/**
 * The absolute path of a workspace folder as files in it are listed, with "/" between names and
 * without a trailing "/", if one names it.
 */
function absoluteRoot(
  root: vscode.Uri,
  roots: readonly vscode.WorkspaceFolder[],
): string | undefined {
  const absolute = root.scheme === "file" ? root.fsPath : absolutePath(root, roots);
  return absolute === undefined ? undefined : forwardSlashes(absolute).replace(/\/$/, "");
}

const NO_FOLDER = "No workspace folder is open; ask the user to open one.";

function folders(): readonly vscode.WorkspaceFolder[] {
  const roots = vscode.workspace.workspaceFolders;
  if (!roots?.length) throw new Error(NO_FOLDER);
  return roots;
}

/**
 * Relative names use the first root; absolute paths and URIs disambiguate multiple roots. A URI's
 * scheme is followed by "/", which tells it from a file named "a:b.md" or a drive letter. A file
 * is inside by its path, also typed in other case where its file system ignores case, as
 * {@link nearRoot} tells; {@link boundary} then checks where links lead.
 */
export function resolveWorkspaceFile(
  file: unknown,
  roots: readonly vscode.WorkspaceFolder[],
): vscode.Uri {
  if (typeof file !== "string" || !file.trim() || file.includes("\0") || file.length > 4096) {
    throw new Error('Give "file" as a workspace file path or URI.');
  }
  const firstRoot = roots[0];
  if (!firstRoot) throw new Error(NO_FOLDER);
  const uri = path.isAbsolute(file)
    ? absoluteFile(file, roots)
    : /^[a-zA-Z][\w+.-]+:\//.test(file)
      ? vscode.Uri.parse(file, true)
      : vscode.Uri.joinPath(firstRoot.uri, file);
  // A path may end with lines as code links or compilers give them, e.g. "src/a.ts#L10-L20" or
  // "src/a.ts:10".
  if (uri.query || uri.fragment || /#L\d+(?:-L?\d+)?$|:\d+(?:[-:]\d+)*$/.test(file)) {
    throw new Error(
      'Give "file" without a query, fragment or line, such as "#L10" or ":10", and its lines as "startLine" and "endLine".',
    );
  }
  if (!(roots.some((root) => contains(root.uri, uri)) || inWorkspace(uri, roots))) {
    throw new Error(
      `${quote(file, 200)} is outside the open workspace folders; give a path that ${FIND_FILES_TOOL} lists.`,
    );
  }
  return uri;
}

/**
 * The glob that lists a folder's files with diagram_findFiles, if it is in the workspace: relative
 * inside the first workspace folder, else absolute, as the files are listed. VS Code finds no
 * folder for it in a virtual workspace folder whose path has "." or "..".
 */
export function filesGlob(
  folder: vscode.Uri,
  roots: readonly vscode.WorkspaceFolder[] = vscode.workspace.workspaceFolders ?? [],
): string | undefined {
  const first = roots[0]?.uri;
  const root =
    first && contains(first, folder)
      ? first
      : (vscode.workspace.getWorkspaceFolder(folder)?.uri ??
        roots.find((root) => contains(root.uri, folder))?.uri);
  if (root === undefined) return undefined;
  // Names such as Next.js's "[id]" are matched literally, each glob character in brackets.
  const relative = folder.path.slice(rootPath(root).length + 1).replace(/[[\]{}*?]/g, "[$&]");
  const glob = relative ? `${relative}/**` : "**";
  if (root === first) return glob;
  const start = absoluteRoot(root, roots);
  return start === undefined ? undefined : `${start}/${glob}`;
}

/** The path of a workspace folder, as that of a file in it starts, without a trailing "/". */
function rootPath(root: vscode.Uri): string {
  return root.scheme === "file" ? root.path.replace(/\/$/, "") : virtualFolderPath(root);
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
        : uri.path.slice(rootPath(first).length + 1);
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
  const localRoots = Promise.all(
    roots
      .filter(({ uri }) => uri.scheme === "file")
      .map(async ({ uri }): Promise<LocalRoot> => {
        const file = path.resolve(uri.fsPath);
        return [file, await realpath(file).catch((error: Error) => error)];
      }),
  );
  const checkedDirectories = new Map<string, Promise<void>>();
  /** Providers have no realpath API. Refuse reported symbolic links, including parent directories. */
  const noLinks = (uri: vscode.Uri, root: vscode.Uri): Promise<void> => {
    const key = uri.toString();
    if (uri.path.replace(/\/$/, "") === virtualFolderPath(root)) return Promise.resolve();
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
    const inside = await unlessCancelled(
      async () =>
        staysInside(uri.fsPath, await localRoots).catch((error: unknown) => {
          throw root ? error : outside();
        }),
      token,
    );
    if (!inside) {
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

/**
 * The ignore files found in each workspace folder, by the folder and the globs that excluded
 * folders from the search, and when they were looked for, while {@link cacheIgnoreFiles} keeps
 * them.
 */
let ignoreCache:
  | { found: Map<string, { files: Promise<IgnoreFiles>; since: number }>; now: () => number }
  | undefined;

/**
 * Keeps the .gitignore files found in each workspace folder, until one is created, changed or
 * deleted, rather than searching the folder for them on each call, but for at most
 * {@link IGNORE_FILES_KEPT_MS}: VS Code's watcher misses a file made right after its folder, as a
 * checkout or a copy makes them, and the ignore files of a renamed folder. `now` tells the time in
 * milliseconds.
 */
export function cacheIgnoreFiles(now: () => number = Date.now): vscode.Disposable {
  const found = new Map<string, { files: Promise<IgnoreFiles>; since: number }>();
  const cache = { found, now };
  ignoreCache = cache;
  const clear = () => found.clear();
  const watcher = vscode.workspace.createFileSystemWatcher(`**/${IGNORE_FILE}`);
  const disposables = [
    watcher,
    watcher.onDidCreate(clear),
    watcher.onDidChange(clear),
    watcher.onDidDelete(clear),
  ];
  return new vscode.Disposable(() => {
    if (ignoreCache === cache) ignoreCache = undefined;
    for (const disposable of disposables) disposable.dispose();
  });
}

/**
 * The .gitignore files of a workspace folder, by which VS Code's search leaves out what they
 * ignore, unless search.useIgnoreFiles is off: findFiles leaves ignore files to its caller.
 */
async function ignoreFiles(
  root: vscode.WorkspaceFolder,
  excludes: readonly string[],
  token: vscode.CancellationToken,
): Promise<IgnoreFiles> {
  if (!vscode.workspace.getConfiguration("search", root.uri).get("useIgnoreFiles", true)) {
    return new Map();
  }
  const cache = ignoreCache;
  if (!cache) return findIgnoreFiles(root, excludes, token);
  const key = `${root.uri.toString()}\n${excludes.join(",")}`;
  const now = cache.now();
  let kept = cache.found.get(key);
  if (!kept || now - kept.since > IGNORE_FILES_KEPT_MS) {
    // Finished for later calls, also when this one is cancelled.
    const files = findIgnoreFiles(root, excludes, new vscode.CancellationTokenSource().token);
    const finding = { files, since: now };
    cache.found.set(key, finding);
    files.catch(() => {
      if (cache.found.get(key) === finding) cache.found.delete(key);
    });
    kept = finding;
  }
  const { files } = kept;
  return unlessCancelled(() => files, token);
}

/**
 * Finds and reads the .gitignore files of a workspace folder, at most {@link MAX_IGNORE_FILES}.
 * It looks neither in what `excludes` exclude nor in what the top-level one ignores, as a large
 * repository may have many in its dependencies and build output, and git reads none there; nor
 * are those read that are in folders a shallower one ignores. A folder that the top-level one
 * ignores but a deeper one includes again goes unsearched, as in a "!build/" pattern.
 */
async function findIgnoreFiles(
  root: vscode.WorkspaceFolder,
  excludes: readonly string[],
  token: vscode.CancellationToken,
): Promise<IgnoreFiles> {
  const files = new Map<string, readonly IgnoreRule[]>();
  const check = boundary([root], token);
  // The top-level one is read even where files.exclude hides it.
  const top = await unlessCancelled(
    () => readIgnoreFile(vscode.Uri.joinPath(root.uri, IGNORE_FILE), check),
    token,
  );
  if (top.length > 0) files.set("", top);
  // Only what is in ignored folders, as git reads an ignore file that is itself ignored, as by
  // ".*" or ".gitignore".
  const folders = fittingGlobs(ignoredGlobs(files).filter((glob) => glob.endsWith("/**")));
  const exclude = `{${[...excludes, ...folders].join(",")}}`;
  const found = await unlessCancelled(
    async () =>
      vscode.workspace.findFiles(
        new vscode.RelativePattern(root, `**/${IGNORE_FILE}`),
        exclude,
        MAX_FOUND_IGNORE_FILES,
        token,
      ),
    token,
  );
  const start = rootPath(root.uri).length + 1;
  // By depth, so that the files that say whether a folder is ignored are read before it.
  const levels: { uri: vscode.Uri; folder: string }[][] = [];
  for (const uri of found) {
    const folder = uri.path.slice(start, -(IGNORE_FILE.length + 1));
    if (folder === "") continue;
    const depth = folder.split("/").length;
    const level = levels[depth] ?? [];
    level.push({ uri, folder });
    levels[depth] = level;
  }
  const ignored = ignoreMatcher(files);
  let read = 0;
  for (const level of levels) {
    // Those in ignored folders, which the exclude may not have left out, are not read and do not
    // count towards the limit.
    const kept = (level ?? [])
      .filter(({ folder }) => !ignored(folder, true))
      .slice(0, MAX_IGNORE_FILES - read);
    read += kept.length;
    for (let offset = 0; offset < kept.length; offset += READ_AHEAD) {
      const batch = kept.slice(offset, offset + READ_AHEAD);
      const rules = await unlessCancelled(
        () => Promise.all(batch.map(({ uri }) => readIgnoreFile(uri, check))),
        token,
      );
      for (const [index, { folder }] of batch.entries()) {
        const folderRules = rules[index] ?? [];
        if (folderRules.length > 0) files.set(folder, folderRules);
      }
    }
    if (read === MAX_IGNORE_FILES) break;
  }
  return files;
}

/**
 * Prefer shallower ignore rules within the argument limit. Filter remaining rules after search.
 */
function fittingGlobs(globs: readonly string[]): string[] {
  const fitting: string[] = [];
  let chars = 0;
  for (const glob of globs) {
    chars += glob.length + 1;
    if (chars > MAX_IGNORED_GLOB_CHARS) break;
    fitting.push(glob);
  }
  return fitting;
}

/** The patterns of an ignore file, or none if it cannot be read or is too large to be one. */
async function readIgnoreFile(
  uri: vscode.Uri,
  check: (uri: vscode.Uri) => Promise<void>,
): Promise<IgnoreRule[]> {
  try {
    await check(uri);
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > MAX_SEARCHED_BYTES || !(stat.type & vscode.FileType.File)) return [];
    const bytes = await vscode.workspace.fs.readFile(uri);
    return bytes.byteLength > MAX_SEARCHED_BYTES ? [] : ignoreRules(decodeText(bytes, false));
  } catch (error) {
    if (error instanceof vscode.CancellationError) throw error;
    return [];
  }
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
    // What the ignore files ignore is left out of the files found, and excluded from the search
    // where globs can say so, so that it does not take up the limit.
    const ignores = await ignoreFiles(root, [...patterns], token);
    const ignored = ignoreMatcher(ignores);
    for (const glob of fittingGlobs(ignoredGlobs(ignores))) patterns.add(glob);
    // Nested workspace roots may return files already found in an earlier root.
    const overlapping = files.filter((uri) => contains(root.uri, uri)).length;
    const limit = max + 1 - files.length + overlapping;
    // In path order, which groups files by folder, as findFiles returns them in no fixed order.
    const found = (
      await unlessCancelled(
        async () =>
          vscode.workspace.findFiles(
            new vscode.RelativePattern(root, glob),
            `{${[...patterns].join(",")}}`,
            limit,
            token,
          ),
        token,
      )
    ).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    throwIfCancelled(token);
    const start = rootPath(root.uri).length + 1;
    const kept = found.filter((uri) => !ignored(uri.path.slice(start)));
    const shown =
      conditions.length > 0 ? await withoutHiddenSiblings(root, kept, conditions, token) : kept;
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
  // Local pipes and devices may block forever or produce unbounded output. Providers can
  // report an unknown type for ordinary files, so only require this for local files.
  if (uri.scheme === "file" && !(stat.type & vscode.FileType.File)) {
    throw new vscode.FileSystemError("Not a regular file; devices and pipes cannot be read.");
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
    const input = isPlainObject(options.input) ? options.input : {};
    const invocationMessage = this.message(input, 80);
    if (vscode.workspace.isTrusted) {
      return { invocationMessage };
    }
    // In full, so that the user sees all of what they allow.
    const message = new vscode.MarkdownString(
      "Allow the diagram agent to read files in this untrusted workspace?",
    ).appendCodeblock(this.message(input, Infinity), "text");
    return { invocationMessage, confirmationMessages: { title: "Read workspace files?", message } };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<unknown>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      throwIfCancelled(token);
      const output = await this.run(toolInput(options.input, this.keys), token);
      return textResult(await fit(output, options.tokenizationOptions, token));
    } catch (error) {
      if (error instanceof vscode.CancellationError) throw error;
      return textResult(`Error: ${errorMessage(error)}`);
    }
  }

  /**
   * What the chat shows while the tool runs, from its input as the model gave it, with its strings
   * shortened to `max` characters.
   */
  protected abstract message(input: Record<string, unknown>, max: number): string;

  protected abstract run(
    input: Record<string, unknown>,
    token: vscode.CancellationToken,
  ): Promise<Paged>;
}

/** Render a prefix of the entries, with continuation instructions. */
interface Paged {
  count: number;
  render: (shown: number) => string;
}

/** Fit whole entries; report insufficient room instead of returning truncated source. */
async function fit(
  { count, render }: Paged,
  options: vscode.LanguageModelToolTokenizationOptions | undefined,
  token: vscode.CancellationToken,
): Promise<string> {
  let shown = count;
  let text = render(shown);
  if (!options) return text;
  const { tokenBudget, countTokens } = options;
  // Text plainly within the budget, as a token takes at least a byte of UTF-8, which takes at most
  // 3 for each UTF-16 code unit, is not counted, which may take a request to the model's provider.
  while (text.length * 3 > tokenBudget) {
    const size = await unlessCancelled(async () => countTokens(text, token), token);
    if (size <= tokenBudget) break;
    if (shown <= 1) {
      const message = "Result exceeds the token budget. Retry with a larger budget.";
      const size = await unlessCancelled(async () => countTokens(message, token), token);
      return size <= tokenBudget ? message : "";
    }
    // Tokens are not spread evenly over the entries, so this may take a few tries.
    shown = Math.max(1, Math.floor(shown * Math.min(tokenBudget / size, 0.9)));
    text = render(shown);
  }
  throwIfCancelled(token);
  return text;
}

/** Says that a glob matches no files, and what the model may have meant instead. */
function noFilesMatch(given: string): string {
  const hint = !/[*?[{]/.test(given)
    ? ` To list the files in a folder, use the glob "${given.replace(/\/$/, "")}/**".`
    : given.includes("/")
      ? ""
      : ` A glob matches from the workspace folder: "**/${given}" matches at any depth.`;
  return `No files match ${JSON.stringify(given)}.${hint}`;
}

/** A string input as the chat shows it, if the model gave one. */
function shown(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? quote(value, max) : undefined;
}

export class FindWorkspaceFilesTool extends WorkspaceTool {
  constructor() {
    super(["glob", "maxResults"]);
  }

  protected message({ glob }: Record<string, unknown>, max: number) {
    const pattern = shown(glob, max);
    return pattern ? `Finding workspace files matching ${pattern}` : "Finding workspace files";
  }

  protected async run(input: Record<string, unknown>, token: vscode.CancellationToken) {
    const max = integer(input.maxResults, 100, "maxResults", 200);
    const roots = folders();
    const { given, glob, roots: searched } = globInput(input.glob, roots);
    const check = boundary(roots, token);
    const found = await candidates(searched, glob, max, token);
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
    const render = (listed: number) => {
      const shown = lines.slice(0, listed);
      if (listed === 0 && !truncated && outsideFiles === 0) shown.push(noFilesMatch(given));
      if (outsideFiles > 0) {
        shown.push(`Left out ${plural(outsideFiles, "file")} linked outside the workspace.`);
      }
      if (truncated || listed < lines.length) {
        shown.push(`Showing the first ${plural(listed, "file")}; narrow the glob to see more.`);
      }
      return shown.join("\n");
    };
    return { count: lines.length, render };
  }
}

export class SearchWorkspaceTextTool extends WorkspaceTool {
  constructor() {
    super(["query", "glob", "caseSensitive", "maxResults"]);
  }

  protected message({ query, glob }: Record<string, unknown>, max: number) {
    const text = shown(query, max);
    const pattern = shown(glob, max);
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
      throw new Error('"caseSensitive" must be true or false.');
    }
    const max = integer(input.maxResults, 50, "maxResults", 100);
    const roots = folders();
    const { given, glob, roots: searched } = globInput(input.glob, roots);
    const check = boundary(roots, token);
    const { files, truncated: tooManyFiles } = await candidates(
      searched,
      glob,
      MAX_SCANNED_FILES,
      token,
    );
    // A Unicode regexp keeps source offsets correct when case folding changes string length.
    const needle = new RegExp(RegExp.escape(query), caseSensitive ? "gu" : "giu");
    const output: string[] = [];
    /** Where each file's matches start in `output`. */
    const fileStarts: number[] = [];
    const tooLarge = `binary or over ${MAX_SEARCHED_BYTES / MIB} MiB`;
    const skipped = {
      [tooLarge]: 0,
      "linked outside the workspace": 0,
      unreadable: 0,
    };
    let scanned = 0;
    let scannedBytes = 0;
    let outputChars = 0;
    let stopped: string | undefined;
    const reads: (Promise<FileText | { failure: unknown }> | undefined)[] = [];
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
      // Release the decoded file once consumed instead of retaining every searched file.
      reads[index] = undefined;
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
        stopped = `it reached the ${MAX_SCANNED_BYTES / MIB} MiB scan limit`;
        break;
      }
      scannedBytes += content.bytes;
      if ("error" in content) {
        skipped[tooLarge]++;
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
        if (output.length >= max) {
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
        if (!fileMatched) fileStarts.push(output.length);
        output.push(entry);
        fileMatched = true;
        if (!newline) break;
        line++;
        lineStart = newline.index + newline[0].length;
        needle.lastIndex = lineStart;
      }
    }
    if (!stopped && tooManyFiles) {
      stopped = `more than ${plural(MAX_SCANNED_FILES, "file")} match the glob`;
    }
    const reasons = Object.entries(skipped).filter(([, count]) => count > 0);
    const skippedFiles = reasons.reduce((sum, [, count]) => sum + count, 0);
    // A glob that matches no files likely means another.
    const noFiles = files.length === 0 ? ` ${noFilesMatch(given)}` : "";
    const render = (matches: number) => {
      const files = fileStarts.filter((start) => start < matches).length;
      const end = matches < output.length ? "its output reached the size limit" : stopped;
      const summary = [
        matches > 0
          ? `${plural(matches, "match", "matches")} in ${plural(files, "file")}`
          : "No matches",
        ` (searched ${plural(scanned, "file")}`,
        reasons.length > 0
          ? `; skipped ${plural(skippedFiles, "file")}: ${reasons.map(([reason, count]) => (reasons.length > 1 ? `${formatCount(count)} ${reason}` : reason)).join(", ")}`
          : "",
        ").",
        end
          ? ` Incomplete: the search stopped because ${end}. Narrow the glob or use a more specific query.`
          : "",
        noFiles,
      ].join("");
      return [summary, ...output.slice(0, matches)].join("\n");
    };
    return { count: output.length, render };
  }
}

export class ReadWorkspaceFileTool extends WorkspaceTool {
  constructor() {
    super(["file", "startLine", "endLine"]);
  }

  protected message({ file, startLine, endLine }: Record<string, unknown>, max: number) {
    const name = shown(file, max);
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
        // No glob names a folder that no absolute path names, as in some virtual workspaces.
        const glob = filesGlob(uri, roots);
        throw fileError(error, uri, {
          FileIsADirectory: `List its files with ${FIND_FILES_TOOL}${glob === undefined ? "" : ` and the glob "${glob}"`}.`,
        });
      },
    );
    if ("error" in content) throw new Error(content.error);
    const { text } = content;
    const lines: string[] = [];
    let outputChars = 0;
    /** The index in `lines` of the first line that is cut. */
    let firstCut = Infinity;
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
      const lineEnd = Math.min(lf, cr);
      totalLines++;
      if (totalLines === lastLine + 1 && totalLines <= end) {
        const cut = lineEnd - lineStart > MAX_LINE_CHARS;
        const entry = `${totalLines}: ${text.slice(lineStart, cut ? lineStart + MAX_LINE_CHARS : lineEnd)}${cut ? `… (${plural(lineEnd - lineStart, "character")})` : ""}`;
        outputChars += entry.length + 1;
        if (outputChars <= MAX_OUTPUT_CHARS) {
          if (cut) firstCut = Math.min(firstCut, lines.length);
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
    const render = (shown: number) => {
      const last = start + shown - 1;
      const notes = [
        firstCut < shown ? `Lines longer than ${plural(MAX_LINE_CHARS, "character")} are cut.` : "",
        last < totalLines ? `Continue with "startLine" ${last + 1}.` : "",
      ].filter(Boolean);
      return [
        `${displayPath(uri, roots)}, lines ${start}-${last} of ${totalLines}${content.unsaved ? ", with unsaved changes" : ""}:`,
        ...lines.slice(0, shown),
        ...notes,
      ].join("\n");
    };
    return { count: lines.length, render };
  }
}
