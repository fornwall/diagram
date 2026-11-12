import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { errorMessage } from "./protocol";

// A path with "." or ".." segments is never inside, as it could lead out.
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

// VS Code keeps "." and ".." from a workspace file's folder "uri". Virtual file systems have no
// links, so resolve them by text.
function virtualFolderPath(root: vscode.Uri): string {
  return root.path && path.posix.normalize(root.path).replace(/\/$/, "");
}

function withinPath(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

// Also in other case or Unicode normalization, as macOS and Windows ignore. Only such paths are
// resolved before asking the user: others could reach a network share or an unreachable mount.
function nearRoot(root: vscode.Uri, uri: vscode.Uri): boolean {
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

// Whether each folder up to `root` finds the same entry by the name as typed, without following
// links, which could lead to a network share. Windows is taken to ignore case, as path.relative.
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

// Also with links followed, which could lead out. A path that does not resolve goes by its path,
// as nothing can be read through it.
export function inWorkspace(
  uri: vscode.Uri,
  roots: readonly vscode.WorkspaceFolder[] = vscode.workspace.workspaceFolders ?? [],
): boolean {
  if (!roots.some((root) => nearRoot(root.uri, uri))) return false;
  if (uri.scheme === "file") {
    try {
      return followLinks(uri.fsPath, roots) === true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "ELOOP") return false;
    }
  }
  return roots.some((root) => contains(root.uri, uri));
}

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

// A folder's path without "." and "..", and its real path, from which ".." steps up.
type LocalRoot = readonly [file: string, real: string | Error];

function names(file: string, p: typeof path.posix = path): string[] {
  return file.split(p.sep === "/" ? "/" : /[\\/]/).filter((name) => name && name !== ".");
}

// Where an absolute target starts, if any, and the names to follow from there or from `dir`.
// Undefined for a target relative to a drive's unknown current folder.
export function linkTarget(
  target: string,
  dir: string,
  p: typeof path.posix = path,
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

// Follows links one name at a time, yielding each path inside to read as a link. Returns true if
// it ends inside, else the path out, if known. Targets outside every folder are never touched, as
// they could be on a network share or an unreachable mount. Targets are not resolved by text, as
// the system follows "b/../key" from where b leads. Throws as realpath does.
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
    // The file system takes strings in UTF-8.
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

function noLink(error: unknown): undefined {
  if ((error as NodeJS.ErrnoException).code !== "EINVAL") throw error;
  return undefined;
}

// On the workspace folders' file system, such as Remote Repositories', when all are on one.
// getWorkspaceFolder would take "." and ".." as names.
export function absoluteFile(
  file: string,
  roots: readonly vscode.WorkspaceFolder[] = vscode.workspace.workspaceFolders ?? [],
): vscode.Uri {
  const local = vscode.Uri.file(path.normalize(file));
  const inside = new Map<string, vscode.Uri>();
  for (const { uri: root } of roots) {
    // A URI with an authority needs a path that starts with "/".
    const uri =
      root.scheme === "file"
        ? local
        : file.startsWith("/")
          ? root.with({ path: path.posix.normalize(file) })
          : undefined;
    if (uri && contains(root, uri)) {
      inside.set(uri.toString(), uri);
    }
  }
  const [only, ...others] = inside.values();
  return only && others.length === 0 ? only : local;
}

export function absolutePath(
  uri: vscode.Uri,
  roots?: readonly vscode.WorkspaceFolder[],
): string | undefined {
  if (uri.scheme === "file") {
    return uri.fsPath;
  }
  return absoluteFile(uri.path, roots).toString() === uri.toString() ? uri.path : undefined;
}

// "~" is the home directory; relative paths are in the first workspace folder.
export function resolveFile(file: string): vscode.Uri {
  if (
    file === "~" ||
    file.startsWith("~/") ||
    (process.platform === "win32" && file.startsWith("~\\"))
  ) {
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

function utf16(bytes: Uint8Array): "utf-16le" | "utf-16be" | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  return bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : undefined;
}

// UTF-16 with a byte order mark, as PowerShell's > writes, else UTF-8.
function decodeText(bytes: Uint8Array, fatal = true): string {
  return new TextDecoder(utf16(bytes) ?? "utf-8", { fatal }).decode(bytes);
}

// Else in the editor's encoding for the file. Throws for binary files.
export async function decodeFile(bytes: Uint8Array, uri: vscode.Uri): Promise<string> {
  try {
    return decodeText(bytes);
  } catch {
    return vscode.workspace.decode(bytes, { uri });
  }
}

const EXPLANATIONS = {
  FileNotFound: (name: string) => `${name} does not exist.`,
  FileIsADirectory: (name: string) => `${name} is a folder, not a file.`,
  FileNotADirectory: (name: string) =>
    `The path ${name} goes through a file as if it were a folder.`,
  NoPermissions: (name: string) => `You do not have permission to read ${name}.`,
  Unavailable: (name: string) => `${name} cannot be reached right now.`,
};
type FileErrorCode = keyof typeof EXPLANATIONS;

const NODE_CODES: Record<string, FileErrorCode> = {
  ENOENT: "FileNotFound",
  EISDIR: "FileIsADirectory",
  ENOTDIR: "FileNotADirectory",
  EACCES: "NoPermissions",
  EPERM: "NoPermissions",
};

export function baseName(uri: vscode.Uri): string {
  return uri.path.split("/").pop() || uri.path;
}

// By URI outside the workspace in a virtual file system, where a path is ambiguous.
export function fileName(uri: vscode.Uri): string {
  return uri.scheme === "file" || vscode.workspace.getWorkspaceFolder(uri)
    ? vscode.workspace.asRelativePath(uri)
    : uri.toString(true);
}

// Names the file once, though VS Code and Node.js repeat it in messages.
function explain(
  code: string | undefined,
  message: string,
  uri: vscode.Uri,
  hints: Partial<Record<FileErrorCode, string | undefined>> = {},
): Error {
  const name = fileName(uri);
  if (code !== undefined && Object.hasOwn(EXPLANATIONS, code)) {
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

// Other errors, such as cancellation, are returned as they are.
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
    return explain(
      Object.hasOwn(NODE_CODES, code) ? NODE_CODES[code] : code,
      message ?? "",
      uri,
      hints,
    );
  }
  return error;
}

export async function openDocument(uri: vscode.Uri): Promise<vscode.TextDocument> {
  try {
    return await vscode.workspace.openTextDocument(uri);
  } catch (error) {
    // openTextDocument only gives a localized message: ask the file system why, or else read the
    // unlocalized name, as in "(NoPermissions (FileSystemError): …)".
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
