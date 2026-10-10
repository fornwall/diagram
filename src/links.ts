// Validate, resolve and open Mermaid node links.

import * as vscode from "vscode";
import { absolutePath, fileError, inWorkspace, openDocument, resolveFile } from "./files";
import { type DiagramLanguage, errorMessage, isPlainObject } from "./protocol";
import { quote } from "./text";

/** Resolve paths when opened so saved links follow their workspace. Lines are one-based. */
export interface NodeLink {
  /** The file, absolute or relative to the first workspace folder; see {@link resolveFile}. */
  file: string;
  line?: number;
  endLine?: number;
}

/** The places a diagram's nodes link to, by node id as written in the Mermaid source. */
export type NodeLinks = Record<string, NodeLink>;

export const LINK_SYNTAX = '"src/parser.ts", "src/parser.ts#L42" or "src/parser.ts#L42-L80"';

/** Bound line numbers before parsing to avoid silently rounding oversized inputs. */
const LINE_FRAGMENT = /^L(\d{1,7})(?:-L(\d{1,7}))?$/;

/** Skip malformed links and report them without preventing the diagram from rendering. */
export function validateLinks(
  value: unknown,
  language: DiagramLanguage,
): { links?: NodeLinks; problems: string[] } {
  // Some models send null for the properties they leave out.
  if (value === undefined || value === null) {
    return { problems: [] };
  }
  if (language === "echarts") {
    return {
      problems: [
        "Links are only for the nodes of a Mermaid diagram; a chart's items are data points rather " +
          "than places in the code.",
      ],
    };
  }
  if (!isPlainObject(value)) {
    return {
      problems: [
        'Links must be an object mapping node ids to locations, e.g. {"parse": "src/parser.ts#L42"}.',
      ],
    };
  }
  const links: [string, NodeLink][] = [];
  const problems: string[] = [];
  for (const [key, location] of Object.entries(value)) {
    const id = key.trim();
    if (!id) {
      problems.push("A node id must not be empty.");
      continue;
    }
    const link = parseLink(location);
    if (typeof link === "string") {
      problems.push(`${JSON.stringify(id)}: ${link}`);
    } else {
      links.push([id, link]);
    }
  }
  return links.length > 0 ? { links: Object.fromEntries(links), problems } : { problems };
}

/**
 * Leaves out the links to workspace files that do not exist, which a model may make up, saying why
 * for each. Files outside the workspace are not looked up, as that would tell the model, without
 * asking, which exist. Other file system errors, such as one that a later click may not meet, keep
 * the link.
 */
export async function withoutMissingFiles(
  links: NodeLinks,
): Promise<{ links?: NodeLinks; problems: string[] }> {
  const checks = new Map<string, Promise<string | undefined>>();
  const exists = (uri: vscode.Uri) =>
    Promise.resolve(vscode.workspace.fs.stat(uri)).then(
      () => true,
      (error: unknown) =>
        error instanceof vscode.FileSystemError && error.code === "FileNotFound"
          ? error
          : undefined,
    );
  const missing = (file: string) => {
    let check = checks.get(file);
    if (!check) {
      const uri = resolveFile(file);
      check = (async () => {
        const found = inWorkspace(uri) && (await exists(uri));
        if (!(found instanceof vscode.FileSystemError)) return undefined;
        // The part before the last "#" exists, as for "README.md#usage", so the "#" was meant to
        // start a line rather than be part of the path.
        const hash = file.lastIndexOf("#");
        return hash > 0 && (await exists(resolveFile(file.slice(0, hash)))) === true
          ? misspeltLine(file)
          : errorMessage(fileError(found, uri));
      })();
      checks.set(file, check);
    }
    return check;
  };
  const entries = Object.entries(links);
  const found = await Promise.all(entries.map(([, link]) => missing(link.file)));
  const kept: [string, NodeLink][] = [];
  const problems: string[] = [];
  for (const [index, [id, link]] of entries.entries()) {
    const problem = found[index];
    if (problem) {
      problems.push(`${JSON.stringify(id)}: ${problem}`);
    } else {
      kept.push([id, link]);
    }
  }
  return kept.length > 0 ? { links: Object.fromEntries(kept), problems } : { problems };
}

function parseLink(location: unknown): NodeLink | string {
  if (typeof location !== "string" || !location.trim()) {
    return "the location must be a non-empty string.";
  }
  const text = location.trim();
  // The line follows the last "#", if what follows it starts like a line, as "#L42" or a misspelt
  // "#42" does, so that a path may contain one, as "docs/C#/intro.md" does.
  const hash = text.lastIndexOf("#");
  const fragment = hash === -1 ? undefined : text.slice(hash + 1).trim();
  const isLine = fragment !== undefined && /^(?:L\d|\d+(?:-\d+)?$)/i.test(fragment);
  let file = (isLine ? text.slice(0, hash) : text).trim();
  if (!file) {
    return `${quote(text)} has no file path before its line.`;
  }
  // A model may give the line as "src/parser.ts:42" or ":42:7", which would otherwise pass as the
  // name of a file that does not exist.
  if (/:\d+(?::\d+)?$/.test(file)) {
    return `${quote(text)} gives its line after a colon; write it as "#L42" or "#L42-L80".`;
  }
  // A model may copy a file URI, whose path is percent-encoded, e.g. from a Markdown link, or that
  // of a file in a virtual workspace folder.
  if (/^[a-z][a-z\d+.-]+:\/\//i.test(file)) {
    const absolute = absolutePath(vscode.Uri.parse(file));
    if (absolute === undefined) {
      return `${quote(text)} is a URL; give a path in the workspace instead.`;
    }
    file = absolute;
  }
  let line: number | undefined;
  let endLine: number | undefined;
  if (isLine) {
    const match = LINE_FRAGMENT.exec(fragment);
    if (!match) {
      return misspeltLine(text);
    }
    line = Number(match[1]);
    endLine = match[2] === undefined ? undefined : Number(match[2]);
    if (line === 0) {
      return `${quote(text)} starts at line 0, but lines are counted from 1.`;
    }
    if (endLine !== undefined && endLine < line) {
      return `${quote(text)} ends before it starts.`;
    }
  }
  try {
    resolveFile(file);
  } catch (error) {
    return errorMessage(error);
  }
  if (line === undefined) {
    return { file };
  }
  return endLine === undefined ? { file, line } : { file, line, endLine };
}

function misspeltLine(text: string): string {
  return `${quote(text)} does not give its line as "#L42" or "#L42-L80".`;
}

/** A link as it was written, e.g. "src/panel.ts#L120-L138", for the panel and the model. */
export function linkText({ file, line, endLine }: NodeLink): string {
  if (line === undefined) {
    return file;
  }
  return endLine === undefined ? `${file}#L${line}` : `${file}#L${line}-L${endLine}`;
}

export function linkTexts(links: NodeLinks): Record<string, string> {
  return Object.fromEntries(Object.entries(links).map(([id, link]) => [id, linkText(link)]));
}

/** Clamp stale line references to the document; a path without a line opens at the top. */
export function linkSelection(
  { line, endLine }: NodeLink,
  document: vscode.TextDocument,
): vscode.Range {
  if (line === undefined) {
    return new vscode.Range(0, 0, 0, 0);
  }
  const last = document.lineCount - 1;
  const from = Math.min(line - 1, last);
  const to = Math.min((endLine ?? line) - 1, last);
  return new vscode.Range(from, 0, to, document.lineAt(to).text.length);
}

/**
 * Opens the code a node links to, selecting the lines it points at, beside the diagram in its
 * column. The link was written by a language model, so a file outside the workspace, or any file
 * in an untrusted workspace, is confirmed first; inside a trusted workspace the click is the
 * user's own action. confirm asks the question, so that the panel can ask one at a time.
 */
export async function openLink(
  link: NodeLink,
  label: string,
  diagramColumn: vscode.ViewColumn | undefined,
  confirm: (ask: () => Thenable<boolean>) => Promise<boolean>,
): Promise<void> {
  try {
    const uri = resolveFile(link.file);
    if (
      (!vscode.workspace.isTrusted || !inWorkspace(uri)) &&
      !(await confirm(async () => {
        const open = await vscode.window.showWarningMessage(
          `Open the file that "${label}" links to?`,
          {
            modal: true,
            detail: `${uri.scheme === "file" ? uri.fsPath : uri.toString(true)}\n\nThe diagram's links were written by a model.`,
          },
          "Open",
        );
        return open !== undefined;
      }))
    ) {
      return;
    }
    const document = await openDocument(uri);
    // The click made the diagram's tab group active, so show the code in another one, leaving the
    // diagram visible beside it.
    const elsewhere = vscode.window.tabGroups.all.find(
      (group) => group.viewColumn !== diagramColumn,
    );
    await vscode.window.showTextDocument(document, {
      selection: linkSelection(link, document),
      viewColumn: elsewhere?.viewColumn ?? vscode.ViewColumn.Beside,
    });
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Could not open the code that "${label}" links to: ${errorMessage(error)}`,
    );
  }
}

/** What a link in a diagram may open: what VS Code opens outside itself, as a browser would. */
const WEB_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * Opens a link that the Mermaid source drew, from a click directive or a label, or that the HTML of
 * a chart holds, such as its tooltip's, which the page posts as written; noun names which drew it.
 * VS Code asks before opening a website outside its trusted domains, which it would not for a link
 * clicked in the page itself. Another scheme could run a command or open a file that a model chose.
 * askFirst, once the page ran chart code that could post this as if the user clicked, has the panel
 * ask too, naming the whole URL, as VS Code shortens long ones.
 */
export async function openUrl(
  url: string,
  noun: "diagram" | "chart",
  askFirst: boolean,
  confirm: (ask: () => Thenable<boolean>) => Promise<boolean>,
): Promise<void> {
  const parsed = URL.parse(url);
  if (!parsed || !WEB_PROTOCOLS.has(parsed.protocol)) {
    void vscode.window.showErrorMessage(
      `Cannot open ${quote(url)}, which the ${noun} links to: the panel opens only http, https ` +
        'and mailto URLs, written in full, e.g. "https://example.com/docs".',
    );
    return;
  }
  const target = parsed.href;
  if (
    askFirst &&
    !(await confirm(async () => {
      const open = await vscode.window.showWarningMessage(
        `Open the link that you clicked in the ${noun}?`,
        {
          modal: true,
          detail: `${target}\n\nThe panel ran JavaScript code from a chart, which can click links as if you had.`,
        },
        "Open",
      );
      return open !== undefined;
    }))
  ) {
    return;
  }
  try {
    // VS Code opens a string as written, though the type says Uri. A Uri would be decoded and
    // encoded again, turning "?q=C%2B%2B" into "?q=C++", a search for "C  ".
    await vscode.env.openExternal(target as unknown as vscode.Uri);
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not open ${target}: ${errorMessage(error)}`);
  }
}
