// Resolving and decoding the files that users and models name.

import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { readlink } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { errorMessage } from "./protocol";

/**
 * Whether `uri` is `root` or inside it, on the same file system. A path with "." or ".." segments
 * is never inside, as it could lead out of the root.
 */
export function contains(root: vscode.Uri, uri: vscode.Uri): boolean {
  return (
    // Providers may run on Windows even when this extension host does not.
    (uri.scheme === "file" || !uri.path.includes("\\")) &&
    !uri.path.split("/").some((part) => part === "." || part === "..") &&
    root.scheme === uri.scheme &&
    root.authority === uri.authority &&
    (root.scheme === "file"
      ? withinPath(root.fsPath, uri.fsPath)
      : `${uri.path}/`.startsWith(`${virtualFolderPath(root)}/`))
  );
}

/**
 * The path of `root`, a folder on a virtual file system, without a trailing "/", and with "." and
 * ".." taken by their text, as Uri.joinPath does, as such file systems have no links. VS Code keeps
 * them from a folder's "uri" in a workspace file.
 */
export function virtualFolderPath(root: vscode.Uri): string {
  return root.path && path.posix.normalize(root.path).replace(/\/$/, "");
}

function withinPath(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

/**
 * Whether `uri` is inside `root` by its path, also where it names the folders up to `root` in other
 * case or Unicode normalization that their file systems ignore, as on macOS and Windows by default.
 * Only such paths are resolved on the file system before the user is asked, as resolving any other
 * could reach a network share, sending the user's credentials, or hang on an unreachable mount.
 */
export function nearRoot(root: vscode.Uri, uri: vscode.Uri): boolean {
  const folded = (uri: vscode.Uri) =>
    uri.with({
      authority: uri.authority.toLowerCase(),
      path: uri.path.normalize("NFC").toLowerCase(),
    });
  return (
    contains(root, uri) ||
    (root.scheme === "file" &&
      contains(folded(root), folded(uri)) &&
      namesFolder(root.fsPath, uri.fsPath))
  );
}

/**
 * Whether `file`, which names the folder `root` or a file in it in other case or normalization,
 * leads into that folder: whether each folder on the way to `root` finds the same entry by the name
 * as typed, which is not followed if it is a link, as one on a case-sensitive file system could
 * lead to a network share. Windows is taken to ignore case, as path.relative does, though its
 * folders can be made case-sensitive.
 */
function namesFolder(root: string, file: string): boolean {
  const names = path.resolve(root).split(path.sep);
  const typed = path.resolve(file).split(path.sep);
  return names.every((name, index) => {
    const given = typed[index] ?? "";
    if (
      name === given ||
      (process.platform === "win32" && name.toLowerCase() === given.toLowerCase())
    ) {
      return true;
    }
    const parent = names.slice(0, index).join(path.sep) + path.sep;
    try {
      const one = lstatSync(parent + name, { bigint: true });
      const two = lstatSync(parent + given, { bigint: true });
      return one.dev === two.dev && one.ino === two.ino;
    } catch {
      return false;
    }
  });
}

/**
 * Whether `uri` is inside a workspace folder, by its path and once symbolic links on this computer
 * are followed, as one inside could lead out. A path that does not resolve for a missing name or
 * too many links goes by its path, as nothing can be read through it. Virtual file systems have no
 * links to follow.
 */
export function inWorkspace(
  uri: vscode.Uri,
  roots: readonly vscode.WorkspaceFolder[] = vscode.workspace.workspaceFolders ?? [],
): boolean {
  if (!roots.some((root) => nearRoot(root.uri, uri))) return false;
  if (uri.scheme === "file") {
    try {
      return followLinks(uri.fsPath, roots) === true;
    } catch (error) {
      // Other errors, as for a real path too long to name, need not stop the system.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "ELOOP") return false;
    }
  }
  return roots.some((root) => contains(root.uri, uri));
}

/**
 * The path by which `uri`, inside a workspace folder by its path, leads out of the folders through
 * symbolic links, as {@link linksInside} tells, if it does and that path is known.
 */
export function pathOutside(uri: vscode.Uri): string | undefined {
  const roots = vscode.workspace.workspaceFolders ?? [];
  if (uri.scheme !== "file" || !roots.some((root) => nearRoot(root.uri, uri))) return undefined;
  try {
    const followed = followLinks(uri.fsPath, roots);
    return typeof followed === "string" ? followed : undefined;
  } catch {
    return undefined;
  }
}

/** {@link linksInside} for a local `file`, reading each link as it goes. */
function followLinks(file: string, roots: readonly vscode.WorkspaceFolder[]): boolean | string {
  const local = roots
    .filter(({ uri }) => uri.scheme === "file")
    .map(({ uri }): LocalRoot => {
      const file = path.resolve(uri.fsPath);
      try {
        return [file, realpathSync.native(file)];
      } catch (error) {
        return [file, error as Error];
      }
    });
  const steps = linksInside(file, local);
  let step = steps.next();
  while (!step.done) {
    let target: Buffer | undefined;
    try {
      target = readlinkSync(step.value, "buffer");
    } catch (error) {
      target = noLink(error);
    }
    step = steps.next(target);
  }
  return step.value;
}

/** As {@link inWorkspace}, for a local `file` inside a workspace folder by its path. */
export async function staysInside(file: string, roots: readonly LocalRoot[]): Promise<boolean> {
  const steps = linksInside(file, roots);
  let step = steps.next();
  while (!step.done) step = steps.next(await readlink(step.value, "buffer").catch(noLink));
  return step.value === true;
}

/**
 * A workspace folder on this computer, by its path without "." and "..", which VS Code keeps from a
 * folder's "uri" in a workspace file but not in the names of files in it, and by its real path, or
 * the error for a folder that has none, from which nothing is followed: ".." steps up from a real
 * path.
 */
export type LocalRoot = readonly [file: string, real: string | Error];

/** The names in a path, without "." and empty ones, by the rules `p` of its system. */
function names(file: string, p: path.PlatformPath = path): string[] {
  return file.split(p.sep === "/" ? "/" : /[\\/]/).filter((name) => name && name !== ".");
}

/**
 * How a symbolic link's `target` continues from `dir`, the real folder the link is in, by the path
 * rules `p` of its system: the folder by its path that an absolute target starts in, if any, and
 * the names to follow from there or from `dir`. A target that Windows may take by its text is
 * named by the path it leads to by its text instead, and one that is relative to the current folder
 * of a drive, which is not known, is undefined.
 */
export function linkTarget(
  target: string,
  dir: string,
  p: path.PlatformPath = path,
): { start?: string; names: string[] } | { path: string } | undefined {
  let { root } = p.parse(target);
  const parts = names(target.slice(root.length), p);
  if (p.sep === "\\") {
    // "C:data" is relative to the current folder of drive C.
    if (/^[a-z]:$/i.test(root)) return undefined;
    // "\data" is on the drive or share of the link.
    if (root === "\\" || root === "/") root = p.parse(dir).root;
    // Windows may take ".." after a name by its text, not from where that name leads.
    const name = parts.findIndex((part) => part !== "..");
    if (name !== -1 && parts.lastIndexOf("..") > name) {
      return { path: root ? p.join(root, ...parts) : p.join(dir, ...parts) };
    }
  }
  if (!root) return { names: parts };
  // An absolute target starts in the folder that its names before any ".." are in.
  const up = parts.indexOf("..");
  const start = up === -1 ? parts.length : up;
  return { start: p.join(root, ...parts.slice(0, start)), names: parts.slice(start) };
}

/**
 * Follows the symbolic links in `file`, a path inside a workspace folder, one name at a time from
 * the folder's real path, and returns true if it ends inside one, else the path by which it leads
 * out, unresolved past the folders, when it is known. It yields each path to read as a
 * link, which is inside, and takes the link's target, or undefined for no link. A target outside
 * every folder by its path, as {@link nearRoot} tells, is never touched, as it could be on a network
 * share or an unreachable mount.
 *
 * A target is never resolved by its text, as the system follows "b/../key" to the folder above
 * where the link b leads. Its names are followed one at a time, as those of `file` are, and ".."
 * steps up from the real path reached so far. That may leave the folders, as "../two" does from a
 * folder beside two, when the next name leads back in.
 *
 * @throws Error when a name is missing, or for too many links, as realpath does, or for a folder
 * without a real path.
 */
function* linksInside(
  file: string,
  roots: readonly LocalRoot[],
): Generator<string, boolean | string, Buffer | undefined> {
  const inside = (file: string) =>
    roots.some(
      ([, real]) =>
        typeof real === "string" && contains(vscode.Uri.file(real), vscode.Uri.file(file)),
    );
  let dir = "";
  let rest: string[] = [];
  const enter = (target: string) => {
    const uri = vscode.Uri.file(target);
    for (const [root, real] of roots) {
      for (const name of typeof real === "string" ? [root, real] : [root]) {
        if (nearRoot(vscode.Uri.file(name), uri)) {
          if (typeof real !== "string") throw real;
          dir = real;
          rest = [...names(target).slice(names(name).length), ...rest];
          return true;
        }
      }
    }
    return false;
  };
  if (!enter(file)) return false;
  // As many as Linux follows.
  for (let links = 0, name = rest.shift(); name !== undefined; name = rest.shift()) {
    if (name === "..") {
      // The parent of a real path is real.
      dir = path.dirname(dir);
      continue;
    }
    const next = path.join(dir, name);
    if (!inside(next)) return [next, ...rest].join(path.sep);
    const link = yield next;
    if (link === undefined) {
      dir = next;
      continue;
    }
    if (++links > 40) {
      throw Object.assign(new Error("The path goes through too many symbolic links."), {
        code: "ELOOP",
      });
    }
    const text = link.toString();
    // A string names no target that is not UTF-8, as the file system takes it in UTF-8.
    if (!Buffer.from(text).equals(link)) return false;
    const target = linkTarget(text, dir);
    if (!target) return false;
    if ("path" in target) return [target.path, ...rest].join(path.sep);
    rest = [...target.names, ...rest];
    if (target.start !== undefined && !enter(target.start)) {
      return [target.start, ...rest].join(path.sep);
    }
  }
  return inside(dir) || dir;
}

/** No target for a path that is no symbolic link, and rethrows other errors. */
function noLink(error: unknown): undefined {
  if ((error as NodeJS.ErrnoException).code !== "EINVAL") throw error;
  return undefined;
}

/**
 * Resolves an absolute path on the file system of the workspace folders that contain it, such as
 * that of a GitHub repository opened with Remote Repositories, when they are all on one. Other
 * paths are on this computer, without "." and "..", which getWorkspaceFolder would take as names.
 */
export function absoluteFile(
  file: string,
  roots: readonly vscode.WorkspaceFolder[] = vscode.workspace.workspaceFolders ?? [],
): vscode.Uri {
  const local = vscode.Uri.file(path.normalize(file));
  const inside = new Map<string, vscode.Uri>();
  for (const { uri: root } of roots) {
    // A URI with an authority needs a path that starts with "/".
    const uri =
      root.scheme === "file" ? local : file.startsWith("/") ? root.with({ path: file }) : undefined;
    if (uri && contains(root, uri)) {
      inside.set(uri.toString(), uri);
    }
  }
  const [only, ...others] = inside.values();
  return only && others.length === 0 ? only : local;
}

/** The absolute path that names `uri`, as {@link absoluteFile} resolves it back, if one does. */
export function absolutePath(
  uri: vscode.Uri,
  roots?: readonly vscode.WorkspaceFolder[],
): string | undefined {
  if (uri.scheme === "file") {
    return uri.fsPath;
  }
  return absoluteFile(uri.path, roots).toString() === uri.toString() ? uri.path : undefined;
}

/**
 * Resolves a path as given in a chart spec or a node link: "~" and "~/…" relative to the home
 * directory, absolute paths as {@link absoluteFile} does, and other paths relative to the first
 * workspace folder.
 *
 * @throws Error when the path is relative but no workspace folder is open.
 */
export function resolveFile(file: string): vscode.Uri {
  if (file === "~" || file.startsWith("~/")) {
    return vscode.Uri.file(path.join(os.homedir(), file.slice(1)));
  }
  if (path.isAbsolute(file)) {
    return absoluteFile(file);
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

/**
 * Decodes UTF-16 when the bytes start with its byte order mark, as files that PowerShell writes
 * with > do, and UTF-8 otherwise.
 *
 * @param fatal Whether invalid bytes throw, rather than becoming "\uFFFD".
 * @throws TypeError when `fatal` and the bytes are not valid in that encoding.
 */
export function decodeText(bytes: Uint8Array, fatal = true): string {
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : "utf-8";
  return new TextDecoder(encoding, { fatal }).decode(bytes);
}

/**
 * Decodes a file's bytes with {@link decodeText} or else in the encoding that the editor would
 * open the file in, as files.encoding sets.
 *
 * @throws Error when the editor finds the file binary.
 */
export async function decodeFile(bytes: Uint8Array, uri: vscode.Uri): Promise<string> {
  try {
    return decodeText(bytes);
  } catch {
    return vscode.workspace.decode(bytes, { uri });
  }
}

/** The file system errors that are explained, by vscode.FileSystemError code. */
const EXPLANATIONS = {
  FileNotFound: (name: string) => `${name} does not exist.`,
  FileIsADirectory: (name: string) => `${name} is a folder, not a file.`,
  FileNotADirectory: (name: string) =>
    `The path ${name} goes through a file as if it were a folder.`,
  NoPermissions: (name: string) => `You do not have permission to read ${name}.`,
  Unavailable: (name: string) => `${name} cannot be reached right now.`,
};
type FileErrorCode = keyof typeof EXPLANATIONS;

/** Node.js errors, as fs.realpath throws, by their vscode.FileSystemError code. */
const NODE_CODES: Record<string, FileErrorCode> = {
  ENOENT: "FileNotFound",
  EISDIR: "FileIsADirectory",
  ENOTDIR: "FileNotADirectory",
  EACCES: "NoPermissions",
  EPERM: "NoPermissions",
};

/**
 * How messages name a file: relative to its workspace folder, else by its path, or by its URI
 * outside the workspace in a virtual file system, where a path alone does not tell which file.
 */
export function fileName(uri: vscode.Uri): string {
  return uri.scheme === "file" || vscode.workspace.getWorkspaceFolder(uri)
    ? vscode.workspace.asRelativePath(uri)
    : uri.toString(true);
}

/**
 * Says in one sentence why `uri` could not be read, naming it once by {@link fileName}, followed by
 * the hint for the error's code, if any. An unknown error is told by its message, without the file
 * names that VS Code and Node.js repeat in it.
 */
function explain(
  code: string | undefined,
  message: string,
  uri: vscode.Uri,
  hints: Partial<Record<FileErrorCode, string | undefined>> = {},
): Error {
  const name = fileName(uri);
  if (code !== undefined && code in EXPLANATIONS) {
    const hint = hints[code as FileErrorCode];
    return new Error(EXPLANATIONS[code as FileErrorCode](name) + (hint ? ` ${hint}` : ""));
  }
  const names = [...new Set([uri.toString(), uri.toString(true), uri.fsPath, uri.path])]
    .sort((a, b) => b.length - a.length)
    .map(RegExp.escape);
  const detail = message
    .replace(/^cannot open \S+\. Detail: /, "")
    .replace(new RegExp(`(?:, \\w+)? ?(['"]?)(?:${names.join("|")})\\1`, "g"), "")
    .replace(/^Error: /, "")
    .replace(/\.$/, "")
    .trim();
  return new Error(`${name} could not be read${detail ? `: ${detail}` : ""}.`);
}

/**
 * Explains why `uri` could not be read, if `error` is a vscode.FileSystemError or a Node.js file
 * error, with the hint for its code, if any. Other errors, such as cancellation, are returned as
 * they are.
 */
export function fileError(
  error: unknown,
  uri: vscode.Uri,
  hints?: Partial<Record<FileErrorCode, string | undefined>>,
): unknown {
  if (error instanceof vscode.FileSystemError) {
    return explain(error.code, error.message, uri, hints);
  }
  const { code, syscall, message } = error instanceof Error ? (error as NodeJS.ErrnoException) : {};
  if (typeof code === "string" && syscall !== undefined) {
    return explain(NODE_CODES[code] ?? code, message ?? "", uri, hints);
  }
  return error;
}

/** Opens a text document, or throws an Error that says why it cannot, naming it once. */
export async function openDocument(uri: vscode.Uri): Promise<vscode.TextDocument> {
  try {
    return await vscode.workspace.openTextDocument(uri);
  } catch (error) {
    // openTextDocument gives the file system error in its localized message only, so ask the
    // file system why, and else read the error's unlocalized name, as in
    // "(NoPermissions (FileSystemError): …)".
    const stat = await Promise.resolve(vscode.workspace.fs.stat(uri)).catch((cause) => cause);
    if (stat instanceof vscode.FileSystemError) {
      throw fileError(stat, uri);
    }
    const message = errorMessage(error);
    const code =
      (stat as vscode.FileStat).type & vscode.FileType.Directory
        ? "FileIsADirectory"
        : /\((\w+) \(FileSystemError\)/.exec(message)?.[1]?.replace(/^Entry/, "File");
    throw explain(code, message, uri);
  }
}
