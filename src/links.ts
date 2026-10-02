// Validate and resolve Mermaid node links.

import * as vscode from "vscode";
import { resolveFile } from "./dataSource";
import { type DiagramLanguage, errorMessage, isPlainObject } from "./protocol";

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

function parseLink(location: unknown): NodeLink | string {
  if (typeof location !== "string" || !location.trim()) {
    return "the location must be a non-empty string.";
  }
  const text = location.trim();
  // The line follows the last "#", so that a path may contain one.
  const hash = text.lastIndexOf("#");
  const file = (hash === -1 ? text : text.slice(0, hash)).trim();
  const fragment = hash === -1 ? undefined : text.slice(hash + 1).trim();
  if (!file) {
    return `${quote(text)} has no file path before its line.`;
  }
  // A model may give the line as "src/parser.ts:42" or ":42:7", which would otherwise pass as the
  // name of a file that does not exist.
  if (/:\d+(?::\d+)?$/.test(file)) {
    return `${quote(text)} gives its line after a colon; write it as "#L42" or "#L42-L80".`;
  }
  let line: number | undefined;
  let endLine: number | undefined;
  if (fragment !== undefined) {
    const match = LINE_FRAGMENT.exec(fragment);
    if (!match) {
      return `${quote(text)} does not give its line as "#L42" or "#L42-L80".`;
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

/** Bound quoted locations in error messages. */
function quote(text: string): string {
  return JSON.stringify(text.length > 60 ? `${text.slice(0, 60)}…` : text);
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
