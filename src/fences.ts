// Finds fenced code blocks as CommonMark does, also in block quotes and list items.

import type { TextDocument } from "vscode";
import type { DiagramBlock } from "./blocks";
import { type DiagramLanguage, isDiagramLanguage, isPlainObject } from "./protocol";

const TAB_STOP = 4;

class Cursor {
  index = 0;
  column = 0;
  // Part of the tab at index was consumed, as the optional space after ">".
  private split = false;

  constructor(readonly line: string) {}

  nonspace(): number {
    let index = this.index;
    while (this.line[index] === " " || this.line[index] === "\t") index++;
    return index;
  }

  indent(): number {
    let column = this.column;
    for (let index = this.index; ; index++) {
      const char = this.line[index];
      if (char === " ") column++;
      else if (char === "\t") column += TAB_STOP - (column % TAB_STOP);
      else return column - this.column;
    }
  }

  skip(columns: number): void {
    const end = this.column + columns;
    while (this.column < end) {
      const char = this.line[this.index];
      if (char === " ") {
        this.index++;
        this.column++;
      } else if (char === "\t") {
        const stop = this.column + TAB_STOP - (this.column % TAB_STOP);
        if (stop > end) {
          this.column = end;
          this.split = true;
          return;
        }
        this.index++;
        this.column = stop;
        this.split = false;
      } else {
        return;
      }
    }
  }

  advance(chars = 1): void {
    this.index += chars;
    this.column += chars;
  }

  rest(): string {
    return this.split
      ? " ".repeat(TAB_STOP - (this.column % TAB_STOP)) + this.line.slice(this.index + 1)
      : this.line.slice(this.index);
  }
}

interface OpeningFence {
  fence: string;
  language: DiagramLanguage | undefined;
  // Removed from content lines.
  indent: number;
}

type LanguageOf = (marker: FenceMarker) => DiagramLanguage | undefined;

// VS Code's chat draws only mermaid fences.
const chatLanguage: LanguageOf = ({ fence, language }) =>
  isDiagramLanguage(language) && (language === "mermaid" || !fence.startsWith(":"))
    ? language
    : undefined;

// VS Code's preview draws a fence whose language contains a word of markdown-mermaid.languages,
// and any ::: mermaid container. It trims any whitespace, such as a no-break space, from the info
// string, and a container's first word ends at a space alone.
function documentLanguages(words: readonly string[]): {
  languageOf: LanguageOf;
  mayName: RegExp;
} {
  const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // No words, or an empty one, match every language.
  const alternatives = escaped.length > 0 ? escaped : [""];
  const mermaid = new RegExp(`\\b(?:${alternatives.join("|")})\\b`, "i");
  return {
    languageOf: ({ fence, info }) => {
      const trimmed = info.trim();
      if (fence.startsWith(":")) {
        return trimmed.split(" ", 1)[0]?.toLowerCase() === "mermaid" ? "mermaid" : undefined;
      }
      const language = trimmed.split(/\s/, 1)[0]?.toLowerCase();
      if (language === "echarts") return language;
      return language && mermaid.test(language) ? "mermaid" : undefined;
    },
    mayName: new RegExp(["mermaid", "echarts", ...alternatives].join("|"), "i"),
  };
}

let documents = documentLanguages(["mermaid"]);

export function setMermaidLanguages(words: readonly string[]): void {
  documents = documentLanguages(words);
  documentFences = new WeakMap();
}

interface FenceMarker {
  fence: string;
  language: string;
  info: string;
}

// In lower case, as VS Code's preview and GitHub compare languages. ":::" opens only a mermaid
// container.
function fenceMarker(text: string): FenceMarker | undefined {
  // Unicode line separators are not line endings in Markdown, so "." must match them.
  const match = /^(`{3,}|~{3,}|:{3,})(.*)$/s.exec(text);
  if (!match) {
    return undefined;
  }
  const [, fence = "", info = ""] = match;
  // As in ```mermaid``` inline.
  if (fence.startsWith("`") && info.includes("`")) {
    return undefined;
  }
  // CommonMark trims spaces and tabs only: a no-break space before a word leaves no language.
  return { fence, language: /^[ \t]*(\S*)/.exec(info)?.[1]?.toLowerCase() ?? "", info };
}

function opening(
  line: string,
  start: number,
  indent: number,
  languageOf: LanguageOf,
): OpeningFence | undefined {
  const marker = fenceMarker(line.slice(start));
  if (!marker) {
    return undefined;
  }
  const language = languageOf(marker);
  // As in Azure DevOps wikis.
  return language || !marker.fence.startsWith(":")
    ? { fence: marker.fence, language, indent }
    : undefined;
}

function closes(line: string, start: number, fence: string): boolean {
  // Lines may be megabytes of chart data: stop at the first other character.
  let index = start;
  while (line[index] === fence[0]) index++;
  if (index - start < fence.length) {
    return false;
  }
  for (; index < line.length; index++) {
    if (!" \t\r\n".includes(line[index] as string)) return false;
  }
  return true;
}

export function openingFence(line: string): OpeningFence | undefined {
  const cursor = new Cursor(line);
  const indent = cursor.indent();
  return indent < 4 ? opening(line, cursor.nonspace(), indent, chatLanguage) : undefined;
}

export function isClosingFence(line: string, { fence }: Pick<OpeningFence, "fence">): boolean {
  const cursor = new Cursor(line);
  return cursor.indent() < 4 && closes(line, cursor.nonspace(), fence);
}

type Container = ">" | ListItem;

interface ListItem {
  width: number;
  // Started with a blank line and holds nothing yet.
  empty: boolean;
}

function quote(cursor: Cursor, indent: number): void {
  cursor.skip(indent);
  cursor.advance();
  const next = cursor.line[cursor.index];
  if (next === " " || next === "\t") {
    cursor.skip(1);
  }
}

// Unlike CommonMark and VS Code's chat, the preview continues a block quote at a ">" indented 4
// columns or more.
function continues(cursor: Cursor, container: Container, preview: boolean): boolean {
  const indent = cursor.indent();
  if (container === ">") {
    if ((indent >= 4 && !preview) || cursor.line[cursor.nonspace()] !== ">") {
      return false;
    }
    quote(cursor, indent);
    return true;
  }
  if (cursor.nonspace() === cursor.line.length) {
    // A list item can begin with at most one blank line (5.2, example 280).
    cursor.skip(Math.min(indent, container.width));
    return !container.empty;
  }
  if (indent < container.width) {
    return false;
  }
  cursor.skip(container.width);
  return true;
}

function continued(cursor: Cursor, containers: readonly Container[], preview: boolean): number {
  let matched = 0;
  while (
    matched < containers.length &&
    continues(cursor, containers[matched] as Container, preview)
  ) {
    matched++;
  }
  return matched;
}

// List markers become spaces, and each ">" gets a space so that content does not lose its first
// space to the marker. Tabs after it become spaces to keep their width.
function continuationPrefix(line: string, end: number): string {
  let prefix = "";
  let column = 0;
  let shifted = false;
  for (let index = 0; index < end; index++) {
    const char = line[index];
    if (char === "\t") {
      const width = TAB_STOP - (column % TAB_STOP);
      column += width;
      prefix += shifted ? " ".repeat(width) : char;
    } else if (char === ">") {
      column++;
      prefix += ">";
      const next = line[index + 1];
      if (next !== " " && next !== "\t") {
        prefix += " ";
        shifted = true;
      }
    } else {
      column++;
      prefix += " ";
    }
  }
  return prefix;
}

type FenceLine =
  | { kind: "opening"; fence: OpeningFence; prefix: string }
  | { kind: "content"; text: string }
  | { kind: "closing" }
  | { kind: "other" };

const OTHER: FenceLine = { kind: "other" };
const ATX_HEADING = /#{1,6}(?:[ \t]|$)/y;
const SETEXT_UNDERLINE = /(?:=+|-+)[ \t]*$/y;
const THEMATIC_BREAK = /([-*_])[ \t]*(?:\1[ \t]*){2,}$/y;
const LIST_MARKER = /(?:[-+*]|\d{1,9}[.)])(?=[ \t]|$)/y;
const BLOCK_TAGS =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|" +
  "dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|" +
  "hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|" +
  "search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
const ATTRIBUTE = `\\s+[A-Za-z_:][\\w.:-]*(?:\\s*=\\s*(?:[^"'=<>\`\\s]+|'[^']*'|"[^"]*"))?`;
type HtmlBlock = [start: RegExp, end: RegExp | "blank line", interrupts: boolean];

const htmlBlocks = (declaration: RegExp): HtmlBlock[] => [
  [/^<(?:script|pre|style|textarea)(?=[\s>]|$)/i, /<\/(?:script|pre|style|textarea)>/i, true],
  [/^<!--/, /-->/, true],
  [/^<\?/, /\?>/, true],
  [declaration, />/, true],
  [/^<!\[CDATA\[/, /\]\]>/, true],
  [new RegExp(`^</?(?:${BLOCK_TAGS})(?=\\s|/?>|$)`, "i"), "blank line", true],
  [
    new RegExp(
      `^(?:<[A-Za-z][A-Za-z0-9-]*(?:${ATTRIBUTE})*\\s*/?>|</[A-Za-z][A-Za-z0-9-]*\\s*>)\\s*$`,
    ),
    "blank line",
    false,
  ],
];
const CHAT_HTML_BLOCKS = htmlBlocks(/^<![A-Za-z]/);
// markdown-it takes only an upper-case letter, as CommonMark 0.30 did.
const PREVIEW_HTML_BLOCKS = htmlBlocks(/^<![A-Z]/);

// The preview renders nothing that deep. Bounds the cost of lines such as "- - - x".
const MAX_DEPTH = 100;

function matchesAt(regex: RegExp, line: string, index: number): boolean {
  regex.lastIndex = index;
  return regex.test(line);
}

// Where a thematic break may start, at the earliest.
function thematicBreakTail(line: string): number {
  let index = line.length;
  let char: string | undefined;
  for (; index > 0; index--) {
    const before = line[index - 1] as string;
    if (before === " " || before === "\t" || before === char) continue;
    if (char !== undefined || !"-*_".includes(before)) break;
    char = before;
  }
  return index;
}

// Follows Markdown block structure as far as it decides where fenced code blocks are.
class FenceScanner {
  private readonly containers: Container[] = [];
  // Lines may continue a paragraph lazily.
  private paragraph = false;
  private code: OpeningFence | undefined;
  private html: RegExp | "blank line" | undefined;

  // As VS Code's chat reads them, unless reading a document as the preview does.
  constructor(
    private readonly languageOf = chatLanguage,
    private readonly preview = false,
  ) {}

  get inCode(): boolean {
    return this.code !== undefined;
  }

  // Whether a line starting with this surely stays in the code block's containers.
  continuesCode(start: string): boolean {
    const { containers } = this;
    if (containers.length === 0) {
      return true;
    }
    const cursor = new Cursor(start);
    return (
      continued(cursor, containers, this.preview) === containers.length &&
      cursor.nonspace() < start.length
    );
  }

  next(text: string): FenceLine {
    const line = text.endsWith("\r") ? text.slice(0, -1) : text;
    const cursor = new Cursor(line);
    const { containers } = this;
    const matched = continued(cursor, containers, this.preview);
    if (cursor.nonspace() < line.length) {
      for (const container of containers.slice(0, matched)) {
        if (container !== ">") container.empty = false;
      }
    }
    const all = matched === containers.length;
    if (this.code) {
      if (all) {
        const indent = cursor.indent();
        if (indent < 4 && closes(line, cursor.nonspace(), this.code.fence)) {
          this.code = undefined;
          return { kind: "closing" };
        }
        cursor.skip(Math.min(indent, this.code.indent));
        return { kind: "content", text: cursor.rest() };
      }
      // Code blocks have no lazy continuation lines.
      this.code = undefined;
    }
    if (this.html) {
      if (all && this.html !== "blank line") {
        if (this.html.test(cursor.rest())) this.html = undefined;
        return OTHER;
      }
      if (all && cursor.nonspace() < line.length) {
        return OTHER;
      }
      this.html = undefined;
    }

    // Container markers, then at most one leaf block, which closes containers not continued.
    let depth = matched;
    let leaf = false;
    let tail: number | undefined;
    for (;;) {
      const indent = cursor.indent();
      const at = cursor.nonspace();
      const char = line[at];
      if (indent >= 4 || char === undefined || depth === MAX_DEPTH) {
        break;
      }
      if (char === ">") {
        quote(cursor, indent);
        containers[depth++] = ">";
        this.paragraph = false;
        continue;
      }
      if (char === "`" || char === "~" || char === ":") {
        const fence = opening(line, at, indent, this.languageOf);
        if (fence) {
          while (containers.length > depth) containers.pop();
          this.paragraph = false;
          this.code = fence;
          return { kind: "opening", fence, prefix: continuationPrefix(line, at) };
        }
      }
      if (char === "<") {
        const text = line.slice(at);
        // Any other tag cannot interrupt a paragraph, not even one that continues lazily (4.6).
        const html = (this.preview ? PREVIEW_HTML_BLOCKS : CHAT_HTML_BLOCKS).find(
          ([opens, , interrupts]) => opens.test(text) && (interrupts || !this.paragraph),
        );
        if (html) {
          const [, end] = html;
          this.html = end === "blank line" || !end.test(text) ? end : undefined;
          leaf = true;
          break;
        }
      }
      // An underline turns a paragraph into a heading, but not a lazy one (4.3, example 93).
      if (this.paragraph && all && matchesAt(SETEXT_UNDERLINE, line, at)) {
        leaf = true;
        break;
      }
      tail ??= thematicBreakTail(line);
      if (matchesAt(ATX_HEADING, line, at) || (at >= tail && matchesAt(THEMATIC_BREAK, line, at))) {
        leaf = true;
        break;
      }
      if (!matchesAt(LIST_MARKER, line, at)) {
        break;
      }
      const marker = line.slice(at, LIST_MARKER.lastIndex);
      let end = at + marker.length;
      while (line[end] === " " || line[end] === "\t") end++;
      const empty = end === line.length;
      // Only with content, and an ordered one only from 1 (examples 285, 304).
      const ordered = marker.length > 1;
      if (this.paragraph && all && (empty || (ordered && Number.parseInt(marker, 10) !== 1))) {
        break;
      }
      cursor.skip(indent);
      cursor.advance(marker.length);
      // 5 or more columns is indented code, 1 column into the item (example 273).
      const spaces = cursor.indent();
      const padding = empty || spaces > 4 ? 1 : spaces;
      cursor.skip(padding);
      containers[depth++] = { width: indent + marker.length + padding, empty };
      this.paragraph = false;
    }

    const blank = cursor.nonspace() === line.length;
    if (!all && this.paragraph && !leaf && !blank) {
      // A lazy continuation line of a paragraph keeps the containers open (5.1, example 233).
      return OTHER;
    }
    while (containers.length > depth) containers.pop();
    // Indented code cannot interrupt a paragraph (4.4, example 113).
    this.paragraph = !blank && !leaf && (this.paragraph || cursor.indent() < 4);
    return OTHER;
  }
}

// Blank lines hold only spaces and tabs: a no-break space is content.
export function trimBlankLines(lines: readonly string[]): string {
  const first = lines.findIndex(isContent);
  return first === -1 ? "" : lines.slice(first, lines.findLastIndex(isContent) + 1).join("\n");
}

function isContent(line: string): boolean {
  return !/^[ \t]*$/.test(line);
}

// Lines are zero-based.
export interface DiagramFence extends DiagramBlock {
  openingLine: number;
  // Of the content, or the end of the text for an unclosed block.
  lastLine: number;
  // Block quote markers and indentation of content lines.
  prefix: string;
}

let documentFences = new WeakMap<
  Pick<TextDocument, "version" | "getText">,
  { version: number; fences: readonly DiagramFence[] }
>();

// Shared between CodeLens, opening and write-back.
export function findDocumentDiagramFences(
  document: Pick<TextDocument, "version" | "getText">,
): readonly DiagramFence[] {
  const cached = documentFences.get(document);
  if (cached?.version === document.version) return cached.fences;
  const fences = findDiagramFences(document.getText());
  documentFences.set(document, { version: document.version, fences });
  return fences;
}

interface CodeBlock {
  language: DiagramLanguage;
  prefix: string;
  openingLine: number;
  lastLine: number;
  lines: string[];
}

// As the preview hides it; none without the closing "---".
const FRONT_MATTER = /^---[^\S\n]*\n(?:[^\n]*\n)*?---[^\S\n]*(?:\n|$)/;

function* diagramBlocks(text: string): Generator<CodeBlock> {
  const scanner = new FenceScanner(documents.languageOf, true);
  let open: CodeBlock | undefined;
  // A fence in front matter is YAML, not a code block.
  const frontMatter = FRONT_MATTER.exec(text)?.[0] ?? "";
  // VS Code documents hold no lone CR. Unicode separators end no lines.
  let line = frontMatter.split("\n").length - 1;
  for (let start = frontMatter.length; start < text.length; line++) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    const scanned = scanner.next(text.slice(start, end));
    start = end + 1;
    if (scanned.kind === "content") {
      open?.lines.push(scanned.text);
      continue;
    }
    // Like CommonMark, a block that is never closed ends with its container or the document.
    if (open) {
      open.lastLine = line - 1;
      yield open;
      open = undefined;
    }
    if (scanned.kind === "opening" && scanned.fence.language) {
      const { language } = scanned.fence;
      open = { language, prefix: scanned.prefix, openingLine: line, lastLine: line, lines: [] };
    }
  }
  if (open) {
    open.lastLine = line - 1;
    yield open;
  }
}

export function findDiagramFences(text: string): DiagramFence[] {
  const fences: DiagramFence[] = [];
  // CodeLens scans every Markdown document on each edit, and most name no diagram language.
  if (!documents.mayName.test(text)) {
    return fences;
  }
  for (const { lines, ...block } of diagramBlocks(text)) {
    const source = trimBlankLines(lines);
    if (source) {
      fences.push({ source, ...block });
    }
  }
  return fences;
}

interface FenceRewrite {
  start: number;
  end: number;
  text: string;
  fence: DiagramFence;
}

function blockAt(
  text: string,
  language: DiagramLanguage,
  openingLine: number,
): CodeBlock | undefined {
  for (const block of diagramBlocks(text)) {
    if (block.openingLine >= openingLine) {
      return block.openingLine === openingLine && block.language === language ? block : undefined;
    }
  }
  return undefined;
}

function lineOffset(text: string, lines: number, from = 0): number {
  let offset = from;
  for (let line = 0; line < lines; line++) {
    const newline = text.indexOf("\n", offset);
    if (newline === -1) {
      return text.length;
    }
    offset = newline + 1;
  }
  return offset;
}

// Keeps the blank lines around the old source. Returns the source line that would end the block
// early, or undefined if it would not read back as the source for another reason.
export function rewriteFence(
  text: string,
  fence: DiagramFence,
  source: string,
  eol: string,
): FenceRewrite | { endingLine: number } | undefined {
  const { language, openingLine } = fence;
  const read = blockAt(text, language, openingLine);
  if (read?.lastLine !== fence.lastLine) {
    return undefined;
  }
  const first = openingLine + 1 + read.lines.findIndex(isContent);
  const last = openingLine + 1 + read.lines.findLastIndex(isContent);
  const start = lineOffset(text, first);
  const end = lineOffset(text, last + 1 - first, start);
  // A quoted empty line still needs its ">".
  const empty = fence.prefix.trimEnd();
  const lines = source.split("\n");
  const replacement = lines.map((line) => (line ? fence.prefix + line : empty)).join(eol);
  const replaced = text[end - 1] === "\n" ? replacement + eol : replacement;
  const written = text.slice(0, start) + replaced + text.slice(end);
  const lastLine = fence.lastLine + lines.length - (last + 1 - first);
  const block = blockAt(written, language, openingLine);
  if (block && block.lastLine < lastLine) {
    return { endingLine: block.lastLine + 1 - first };
  }
  if (block?.lastLine !== lastLine || trimBlankLines(block.lines) !== source) {
    return undefined;
  }
  return {
    start,
    end,
    text: replaced,
    fence: { language, source, openingLine, lastLine, prefix: block.prefix },
  };
}

export function emptyDiagramBlockAt(
  text: string,
  line: number,
): { language: DiagramLanguage; openingLine: number } | undefined {
  for (const { language, openingLine, lastLine, lines } of diagramBlocks(text)) {
    if (openingLine > line) {
      break;
    }
    if (line <= lastLine + 1 && !trimBlankLines(lines)) {
      return { language, openingLine };
    }
  }
  return undefined;
}

// The enclosing fence, the next below, or the last.
export function fenceAt(fences: readonly DiagramFence[], line: number): DiagramFence | undefined {
  const inside = fences.find((fence) => line >= fence.openingLine && line <= fence.lastLine + 1);
  return inside ?? fences.find((fence) => fence.openingLine > line) ?? fences.at(-1);
}

// At its line, else a unique match that moved. A block there in its language or with its source
// is taken to be it, edited. Ambiguous copies must be reopened, so as not to replace another.
export function relocateFence(
  fences: readonly DiagramFence[],
  read: DiagramFence,
): DiagramFence | undefined {
  const matches = (fence: DiagramFence) =>
    fence.language === read.language && fence.source === read.source;
  const original = fences.find(
    (fence) =>
      fence.openingLine === read.openingLine &&
      (fence.language === read.language || fence.source === read.source),
  );
  if (original) {
    return matches(original) ? original : undefined;
  }
  const found = fences.filter(matches);
  return found.length === 1 ? found[0] : undefined;
}

// Command arguments can come from other extensions.
export function isDiagramFence(value: unknown): value is DiagramFence {
  return (
    isPlainObject(value) &&
    isDiagramLanguage(value.language) &&
    typeof value.source === "string" &&
    typeof value.prefix === "string" &&
    isLine(value.openingLine) &&
    isLine(value.lastLine) &&
    value.lastLine > value.openingLine
  );
}

function isLine(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
