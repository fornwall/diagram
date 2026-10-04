// Resolving and decoding the files that users and models name.

import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

/**
 * Resolves a path as given in a chart spec or a node link: "~" and "~/…" relative to the home
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
