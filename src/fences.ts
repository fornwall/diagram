// Find fenced code blocks as CommonMark does, also in block quotes and list items, to collect
// diagrams from chat replies and to open Markdown diagrams and write them back.

import type { TextDocument } from "vscode";
import type { DiagramBlock } from "./blocks";
import { type DiagramLanguage, isDiagramLanguage, isPlainObject } from "./protocol";

/** CommonMark measures indentation in columns, with tab stops every 4 columns. */
const TAB_STOP = 4;

/** A position in a line, in characters and in columns. */
class Cursor {
  index = 0;
  column = 0;
  /** Whether part of the tab at index was consumed, e.g. as the optional space after ">". */
  private split = false;

  constructor(readonly line: string) {}

  /** The index of the first character at or after the cursor that is not a space or tab. */
  nonspace(): number {
    let index = this.index;
    while (this.line[index] === " " || this.line[index] === "\t") index++;
    return index;
  }

  /** The columns of spaces and tabs ahead of the cursor. */
  indent(): number {
    let column = this.column;
    for (let index = this.index; ; index++) {
      const char = this.line[index];
      if (char === " ") column++;
      else if (char === "\t") column += TAB_STOP - (column % TAB_STOP);
      else return column - this.column;
    }
  }

  /** Consumes spaces and tabs for up to this many columns, splitting a tab that spans the end. */
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

  /** Consumes marker characters. */
  advance(chars = 1): void {
    this.index += chars;
    this.column += chars;
  }

  /** The text after the cursor, where the rest of a split tab becomes spaces. */
  rest(): string {
    return this.split
      ? " ".repeat(TAB_STOP - (this.column % TAB_STOP)) + this.line.slice(this.index + 1)
      : this.line.slice(this.index);
  }
}

/** An opening code fence: its marker, the diagram language it names, if any, and its indent. */
interface OpeningFence {
  fence: string;
  language: DiagramLanguage | undefined;
  /** Columns from the start of the fence's container, which are removed from its content lines. */
  indent: number;
}

/** Which diagram language, if any, a fence names, given its marker as {@link fenceMarker} reads it. */
type LanguageOf = (marker: FenceMarker) => DiagramLanguage | undefined;

/** As in chat, where VS Code draws mermaid fences alone, and in CommonMark. */
const chatLanguage: LanguageOf = ({ fence, language }) =>
  isDiagramLanguage(language) && (language === "mermaid" || !fence.startsWith(":"))
    ? language
    : undefined;

/**
 * How Markdown documents name languages: VS Code's preview draws a fence as Mermaid if its language
 * contains a word of the markdown-mermaid.languages setting, given here, and draws a ::: mermaid
 * container whatever the setting. It trims any whitespace, such as a no-break space, from the info
 * string, and a container's first word ends at a space alone.
 */
function documentLanguages(words: readonly string[]): {
  languageOf: LanguageOf;
  /** Whether a document may name a diagram language, without which it holds no diagram. */
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

/** Takes the words of the markdown-mermaid.languages setting, for documents read from now on. */
export function setMermaidLanguages(words: readonly string[]): void {
  documents = documentLanguages(words);
  documentFences = new WeakMap();
}

/** A fence marker, the first word of its info string in lower case, and the info string. */
interface FenceMarker {
  fence: string;
  language: string;
  info: string;
}

/**
 * Parses a fence marker at the start of text, comparing languages in lower case as VS Code's
 * preview and GitHub do. The marker may also be ":::", which opens a block only as a mermaid
 * container.
 */
export function fenceMarker(text: string): FenceMarker | undefined {
  // Unicode line separators are not line endings in Markdown, so "." must match them.
  const match = /^(`{3,}|~{3,}|:{3,})(.*)$/s.exec(text);
  if (!match) {
    return undefined;
  }
  const [, fence = "", info = ""] = match;
  // The info string of a backtick fence may not contain backticks, e.g. ```mermaid``` inline.
  if (fence.startsWith("`") && info.includes("`")) {
    return undefined;
  }
  // As CommonMark has it, the info string is trimmed of spaces and tabs only: a no-break space
  // before a word leaves no language. The word ends at any whitespace.
  return { fence, language: /^[ \t]*(\S*)/.exec(info)?.[1]?.toLowerCase() ?? "", info };
}

/** Parses the fence marker at `start`, which is preceded by `indent` columns of indentation. */
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
  // VS Code's preview, as Azure DevOps wikis, draws a ::: mermaid container as a diagram, and other
  // containers as text.
  return language || !marker.fence.startsWith(":")
    ? { fence: marker.fence, language, indent }
    : undefined;
}

/** Whether the text at `start` closes a block: the fence's character, as many or more, then spaces. */
function closes(line: string, start: number, fence: string): boolean {
  // Most lines are source, sometimes megabytes of chart data: stop at the first other character.
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

/** Parses a line of a model's reply that opens a code block outside block quotes and lists. */
export function openingFence(line: string): OpeningFence | undefined {
  const cursor = new Cursor(line);
  const indent = cursor.indent();
  return indent < 4 ? opening(line, cursor.nonspace(), indent, chatLanguage) : undefined;
}

/** Whether a line outside block quotes and lists closes the block that the opening fence opened. */
export function isClosingFence(line: string, { fence }: Pick<OpeningFence, "fence">): boolean {
  const cursor = new Cursor(line);
  return cursor.indent() < 4 && closes(line, cursor.nonspace(), fence);
}

/** A block quote, or a list item whose content starts `width` columns into its container's. */
type Container = ">" | ListItem;

interface ListItem {
  width: number;
  /** Whether it started with a blank line and holds nothing yet. */
  empty: boolean;
}

/** Consumes a block quote marker after `indent` columns, and the optional space after it. */
function quote(cursor: Cursor, indent: number): void {
  cursor.skip(indent);
  cursor.advance();
  const next = cursor.line[cursor.index];
  if (next === " " || next === "\t") {
    cursor.skip(1);
  }
}

/** Consumes a line's continuation of a container: ">" or a list item's indentation. */
function continues(cursor: Cursor, container: Container): boolean {
  const indent = cursor.indent();
  if (container === ">") {
    if (indent >= 4 || cursor.line[cursor.nonspace()] !== ">") {
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

/** Consumes the containers that a line continues, returning how many it continues. */
function continued(cursor: Cursor, containers: readonly Container[]): number {
  let matched = 0;
  while (matched < containers.length && continues(cursor, containers[matched] as Container)) {
    matched++;
  }
  return matched;
}

/**
 * Turns the container markers in front of an opening fence at `end` into what the lines below
 * start with: list markers become spaces, and each ">" gets a space after it, so that a line that
 * starts with a space does not lose it to the marker. Tabs after such an added space become spaces
 * to keep their width.
 */
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

/** How a line takes part in fenced code blocks. */
type FenceLine =
  // The prefix is what the block's content lines start with.
  | { kind: "opening"; fence: OpeningFence; prefix: string }
  // The text is the line without its container markers and fence indentation.
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
/** HTML blocks: how they start, what ends them, and whether they interrupt a paragraph. */
const HTML_BLOCKS: [start: RegExp, end: RegExp | "blank line", interrupts: boolean][] = [
  [/^<(?:script|pre|style|textarea)(?=[\s>]|$)/i, /<\/(?:script|pre|style|textarea)>/i, true],
  [/^<!--/, /-->/, true],
  [/^<\?/, /\?>/, true],
  [/^<![A-Za-z]/, />/, true],
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

/**
 * How many block quotes and list items deep a line is read for more of them. VS Code's preview
 * renders no blocks that deep. The bound keeps a line of many markers, such as "- - - x", from
 * costing each line after it a step per container, and from being scanned to its end per marker.
 */
const MAX_DEPTH = 100;

/** Whether a sticky regex matches a line at an index, after which its lastIndex is the match's end. */
function matchesAt(regex: RegExp, line: string, index: number): boolean {
  regex.lastIndex = index;
  return regex.test(line);
}

/**
 * Where the end of a line made of one of "-", "*" and "_", and spaces and tabs, starts: a thematic
 * break can start there or after, and nowhere before.
 */
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

/**
 * Follows the block structure of Markdown line by line, as far as it decides where fenced code
 * blocks are: in block quotes and list items, but not in indented code, HTML or a paragraph. A
 * line that ends a container also ends a code block in it.
 */
export class FenceScanner {
  private readonly containers: Container[] = [];
  /** Whether the innermost container ends with a paragraph, which lines may continue lazily. */
  private paragraph = false;
  /** The open code block, in the innermost container. */
  private code: OpeningFence | undefined;
  /** What ends the open HTML block. */
  private html: RegExp | "blank line" | undefined;

  /** Reads lines of a model's reply, unless given how a document's fences name languages. */
  constructor(private readonly languageOf = chatLanguage) {}

  /** Whether the lines so far end inside a code block. */
  get inCode(): boolean {
    return this.code !== undefined;
  }

  /**
   * Whether a line that starts with this text is sure to belong to the open code block, as its
   * content or closing fence, rather than end it by leaving the block's block quote or list item.
   */
  continuesCode(start: string): boolean {
    const { containers } = this;
    if (containers.length === 0) {
      return true;
    }
    const cursor = new Cursor(start);
    // Until a line has more than indentation, it may yet turn out to be blank or less indented.
    return continued(cursor, containers) === containers.length && cursor.nonspace() < start.length;
  }

  /** Reads the next line, without its line break. */
  next(text: string): FenceLine {
    const line = text.endsWith("\r") ? text.slice(0, -1) : text;
    const cursor = new Cursor(line);
    const { containers } = this;
    const matched = continued(cursor, containers);
    if (cursor.nonspace() < line.length) {
      // A list item that started with a blank line holds something now.
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
      // A blank line, or a line that does not continue its containers, ends it.
      this.html = undefined;
    }

    // Container markers, then at most one leaf block. A block that starts on the line closes the
    // containers that the line does not continue, and new containers take their place.
    let depth = matched;
    let leaf = false;
    // A line of list markers would otherwise be scanned to its end for a thematic break per marker.
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
        const html = HTML_BLOCKS.find(
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
      // A list item interrupts a paragraph only with content, and an ordered one only from 1
      // (5.2, example 285, and 5.3, example 304). Otherwise the paragraph continues.
      const ordered = marker.length > 1;
      if (this.paragraph && all && (empty || (ordered && Number.parseInt(marker, 10) !== 1))) {
        break;
      }
      cursor.skip(indent);
      cursor.advance(marker.length);
      // Content indented by 5 or more columns is indented code, 1 column into the item (5.2,
      // example 273).
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

/**
 * Joins the lines of a code block without the blank lines around them, which, as in Markdown, hold
 * only spaces and tabs: a no-break space is content.
 */
export function trimBlankLines(lines: readonly string[]): string {
  const first = lines.findIndex(isContent);
  return first === -1 ? "" : lines.slice(first, lines.findLastIndex(isContent) + 1).join("\n");
}

function isContent(line: string): boolean {
  return !/^[ \t]*$/.test(line);
}

/** A Markdown diagram with zero-based line positions for write-back. */
export interface DiagramFence extends DiagramBlock {
  /** The line the opening fence marker is on; the content starts on the line after it. */
  openingLine: number;
  /** The last line of the content, which runs to the end of the text in a block that is never closed. */
  lastLine: number;
  /**
   * What the content lines start with: the markers of the block quotes the block is in, the
   * indentation of the list items it is in, and the indentation of its opening fence.
   */
  prefix: string;
}

let documentFences = new WeakMap<
  Pick<TextDocument, "version" | "getText">,
  { version: number; fences: readonly DiagramFence[] }
>();

/** Share a scan between CodeLens, opening and write-back; edits invalidate it immediately. */
export function findDocumentDiagramFences(
  document: Pick<TextDocument, "version" | "getText">,
): readonly DiagramFence[] {
  const cached = documentFences.get(document);
  if (cached?.version === document.version) return cached.fences;
  const fences = findDiagramFences(document.getText());
  // Weak keys let closed documents and their potentially large diagram sources be collected.
  documentFences.set(document, { version: document.version, fences });
  return fences;
}

/** A code block in a document, with its content lines if it is a diagram block. */
interface CodeBlock {
  language: DiagramLanguage | undefined;
  prefix: string;
  openingLine: number;
  lastLine: number;
  lines: string[];
}

/**
 * YAML front matter, as VS Code's Markdown preview hides it: from a first line of "---" to the next
 * line of "---", each followed by whitespace only. Without that closing line there is none.
 */
const FRONT_MATTER = /^---[^\S\n]*\n(?:[^\n]*\n)*?---[^\S\n]*(?:\n|$)/;

/** Yields the code blocks in a document in order. */
function* codeBlocks(text: string): Generator<CodeBlock> {
  const scanner = new FenceScanner(documents.languageOf);
  let open: CodeBlock | undefined;
  // A fence in front matter is YAML, not a code block.
  const frontMatter = FRONT_MATTER.exec(text)?.[0] ?? "";
  // Lines end at LF, as in VS Code, whose documents hold no lone CR, and not at Unicode separators.
  // A final line break ends the last line rather than starting another one.
  let line = frontMatter.split("\n").length - 1;
  for (let start = frontMatter.length; start < text.length; line++) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    const scanned = scanner.next(text.slice(start, end));
    start = end + 1;
    if (scanned.kind === "content") {
      if (open?.language) open.lines.push(scanned.text);
      continue;
    }
    // Like CommonMark, a block that is never closed ends with its container or the document.
    if (open) {
      open.lastLine = line - 1;
      yield open;
      open = undefined;
    }
    if (scanned.kind === "opening") {
      const { language } = scanned.fence;
      open = { language, prefix: scanned.prefix, openingLine: line, lastLine: line, lines: [] };
    }
  }
  if (open) {
    open.lastLine = line - 1;
    yield open;
  }
}

/** Find nonempty diagram blocks in document order, skipping fences inside other code blocks. */
export function findDiagramFences(text: string): DiagramFence[] {
  const fences: DiagramFence[] = [];
  // CodeLens scans every Markdown document on each edit, and most name no diagram language.
  if (!documents.mayName.test(text)) {
    return fences;
  }
  for (const { language, lines, ...block } of codeBlocks(text)) {
    const source = trimBlankLines(lines);
    if (language && source) {
      fences.push({ language, source, ...block });
    }
  }
  return fences;
}

/** A replacement of a block's content lines that reads back as the source that was written. */
interface FenceRewrite {
  start: number;
  end: number;
  text: string;
  /** The block as it is after the replacement. */
  fence: DiagramFence;
}

/** The block of a language in `text` that opens at a line. */
function blockAt(
  text: string,
  language: DiagramLanguage,
  openingLine: number,
): CodeBlock | undefined {
  for (const block of codeBlocks(text)) {
    if (block.openingLine >= openingLine) {
      return block.openingLine === openingLine && block.language === language ? block : undefined;
    }
  }
  return undefined;
}

/** The offset at which a line starts, counting lines from the one at `from`. */
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

/**
 * Replaces the source of a block found in `text` with `source`, which has no blank lines around
 * it, writing every line behind the block's prefix. The blank lines around the old source are
 * kept, as the user laid them out. Returns the zero-based source line that would end the block
 * early, or undefined if the block would not read back as the source for another reason.
 */
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
  // The lines from the first to the last line of the old source.
  const first = openingLine + 1 + read.lines.findIndex(isContent);
  const last = openingLine + 1 + read.lines.findLastIndex(isContent);
  const start = lineOffset(text, first);
  const end = lineOffset(text, last + 1 - first, start);
  // Empty lines carry the prefix up to its last marker: a quoted empty line still needs its ">".
  const empty = fence.prefix.trimEnd();
  const lines = source.split("\n");
  const replacement = lines.map((line) => (line ? fence.prefix + line : empty)).join(eol);
  // The old source's last line, which is not empty, has no line break to keep at the end of the text.
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

/** The diagram block holding no diagram that a line is in, from its opening to its closing fence. */
export function emptyDiagramBlockAt(
  text: string,
  line: number,
): { language: DiagramLanguage; openingLine: number } | undefined {
  for (const { language, openingLine, lastLine, lines } of codeBlocks(text)) {
    if (openingLine > line) {
      break;
    }
    if (line <= lastLine + 1 && language && !trimBlankLines(lines)) {
      return { language, openingLine };
    }
  }
  return undefined;
}

/** Open the enclosing fence, the next below the cursor, or the last in the document. */
export function fenceAt(fences: readonly DiagramFence[], line: number): DiagramFence | undefined {
  const inside = fences.find((fence) => line >= fence.openingLine && line <= fence.lastLine + 1);
  return inside ?? fences.find((fence) => fence.openingLine > line) ?? fences.at(-1);
}

/**
 * Finds an unchanged block at its original line, or a unique matching block that moved.
 * An edited block or ambiguous copies must be reopened before writing to avoid replacing another
 * diagram that happens to have the same source.
 */
export function relocateFence(
  fences: readonly DiagramFence[],
  read: DiagramFence,
): DiagramFence | undefined {
  const matches = (fence: DiagramFence) =>
    fence.language === read.language && fence.source === read.source;
  const original = fences.find((fence) => fence.openingLine === read.openingLine);
  if (original) {
    return matches(original) ? original : undefined;
  }
  const found = fences.filter(matches);
  return found.length === 1 ? found[0] : undefined;
}

/** Validate command arguments, which can also come from other extensions. */
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
