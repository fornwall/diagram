// Resolving and decoding the files that users and models name.

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

export function withinPath(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
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
 * @throws TypeError when the bytes are not valid in that encoding.
 */
export function decodeText(bytes: Uint8Array): string {
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : "utf-8";
  return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}

/**
 * Decodes a file's bytes with {@link decodeText} or else in the encoding that the editor would
 * open the file in, as files.encoding sets, unless that leaves bytes undecoded: then as
 * Windows-1252, in which Excel on Windows saves CSV files.
 *
 * @throws Error when the editor finds the file binary.
 */
export async function decodeFile(bytes: Uint8Array, uri: vscode.Uri): Promise<string> {
  try {
    return decodeText(bytes);
  } catch {
    const text = await vscode.workspace.decode(bytes, { uri });
    return text.includes("�") ? new TextDecoder("windows-1252").decode(bytes) : text;
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
