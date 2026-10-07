// Resolving and decoding the files that users and models name.

import { readlinkSync, realpathSync } from "node:fs";
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

/**
 * Whether `uri` is inside `root` by its path, also in other case where file systems usually ignore
 * case, as on macOS and Windows. Only such paths are resolved on the file system before the user
 * is asked, as resolving any other could reach a network share, sending the user's credentials,
 * or hang on an unreachable mount.
 */
export function nearRoot(root: vscode.Uri, uri: vscode.Uri): boolean {
  const folded = (uri: vscode.Uri) =>
    uri.with({
      authority: uri.authority.toLowerCase(),
      path: uri.path.normalize("NFC").toLowerCase(),
    });
  return (
    contains(root, uri) ||
    ((process.platform === "darwin" || process.platform === "win32") &&
      contains(folded(root), folded(uri)))
  );
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
    const local = roots
      .filter(({ uri }) => uri.scheme === "file")
      .map(({ uri }): LocalRoot => {
        try {
          return [uri.fsPath, realpathSync.native(uri.fsPath)];
        } catch {
          return [uri.fsPath, uri.fsPath];
        }
      });
    try {
      const steps = linksInside(uri.fsPath, local);
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
    } catch (error) {
      // Other errors, as for a real path too long to name, need not stop the system.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "ELOOP") return false;
    }
  }
  return roots.some((root) => contains(root.uri, uri));
}

/** As {@link inWorkspace}, for a local `file` inside a workspace folder by its path. */
export async function staysInside(file: string, roots: readonly LocalRoot[]): Promise<boolean> {
  const steps = linksInside(file, roots);
  let step = steps.next();
  while (!step.done) step = steps.next(await readlink(step.value, "buffer").catch(noLink));
  return step.value;
}

/** A workspace folder on this computer, by its path and its real path. */
export type LocalRoot = readonly [file: string, real: string];

/** What separates names in a path on this system. */
const SEPARATORS = path.sep === "/" ? "/" : /[\\/]/;

/**
 * Follows the symbolic links in `file`, a path inside a workspace folder, one name at a time from
 * the folder's real path, and returns whether it stays inside. It yields each path to read as a
 * link, which is inside, and takes the link's target, or undefined for no link. A target outside
 * every folder by its path, as {@link nearRoot} tells, is never touched, as it could be on a network
 * share or an unreachable mount.
 *
 * A target is never resolved by its text, as the system follows "b/../key" to the folder above
 * where the link b leads. Its names are followed one at a time, as those of `file` are, and ".."
 * steps up from the real path reached so far, which must stay inside.
 *
 * @throws Error when a name is missing, or for too many links, as realpath does.
 */
function* linksInside(
  file: string,
  roots: readonly LocalRoot[],
): Generator<string, boolean, Buffer | undefined> {
  const names = (file: string) => file.split(SEPARATORS).filter(Boolean);
  let dir = "";
  let rest: string[] = [];
  const enter = (target: string) => {
    const uri = vscode.Uri.file(target);
    for (const [root, real] of roots) {
      for (const name of [root, real]) {
        if (nearRoot(vscode.Uri.file(name), uri)) {
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
    if (name === ".") continue;
    if (name === "..") {
      dir = path.dirname(dir);
      if (!roots.some(([, real]) => nearRoot(vscode.Uri.file(real), vscode.Uri.file(dir)))) {
        return false;
      }
      continue;
    }
    const next = path.join(dir, name);
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
    const target = link.toString();
    // A string names no target that is not UTF-8, as the file system takes it in UTF-8.
    if (!Buffer.from(target).equals(link)) return false;
    const parts = target.split(SEPARATORS);
    const up = parts.indexOf("..");
    // Windows may take ".." after a name in a target by its text, not from where that name leads.
    if (
      process.platform === "win32" &&
      up !== -1 &&
      parts.slice(0, up).some((part) => part !== "" && part !== ".")
    ) {
      return false;
    }
    if (path.parse(target).root) {
      // An absolute target starts in the folder that its names before any "." or ".." are in.
      const dots = parts.findIndex((part) => part === "." || part === "..");
      const start = dots === -1 ? parts.length : dots;
      rest = [...parts.slice(start).filter(Boolean), ...rest];
      if (!enter(parts.slice(0, start).join(path.sep))) return false;
    } else {
      rest = [...parts.filter(Boolean), ...rest];
    }
  }
  return true;
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
