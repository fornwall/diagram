// Describes Mermaid's errors concisely, at their positions in the source.

/** The words that start each kind of diagram that Mermaid detects, the common ones first. */
export const DIAGRAM_TYPES = [
  "flowchart",
  "graph",
  "sequenceDiagram",
  "classDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "gantt",
  "pie",
  "mindmap",
  "timeline",
  "gitGraph",
  "journey",
  "quadrantChart",
  "xychart",
  "sankey",
  "block",
  "packet",
  "architecture-beta",
  "kanban",
  "requirementDiagram",
  "C4Context",
  "C4Container",
  "C4Component",
  "C4Dynamic",
  "C4Deployment",
  "radar-beta",
  "treemap",
  "info",
  "stateDiagram",
  "agentflow-beta",
  "swimlane-beta",
  "treeView-beta",
  "eventmodeling",
  "ishikawa-beta",
  "venn-beta",
  "usecase-beta",
  "wardley-beta",
  "cynefin-beta",
  "railroad-beta",
  "railroad-ebnf-beta",
  "railroad-abnf-beta",
  "railroad-peg-beta",
];

/** Lists the words as alternatives: "a, b or c". */
function alternatives(words: string[]): string {
  return words.length > 1
    ? `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`
    : (words[0] ?? "");
}

const COMMON_TYPES = alternatives(DIAGRAM_TYPES.slice(0, 11));

/** The edit distance between two words, ignoring case. */
function distance(a: string, b: string): number {
  a = a.toLowerCase();
  b = b.toLowerCase();
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] as number;
}

/** Replaces Mermaid's error for an unknown diagram type, which quotes the whole source. */
function unknownTypeError(message: string): Error {
  // Mermaid quotes the source without front matter, directives and comments.
  const text = /for text: (.*)$/s.exec(message)?.[1]?.trim() ?? "";
  if (text.startsWith("```")) {
    return new Error(
      `Remove the code fence around the diagram: the source must start with the diagram type, such as ${COMMON_TYPES}.`,
    );
  }
  if (!text) {
    return new Error(
      `The diagram is empty: start it with the diagram type, such as ${COMMON_TYPES}.`,
    );
  }
  const type = text.split(/\s/, 1)[0]?.slice(0, 40) ?? "";
  if (type === "mermaid") {
    return new Error(
      `Remove the "mermaid" line: the source must start with the diagram type, such as ${COMMON_TYPES}.`,
    );
  }
  const lower = type.toLowerCase();
  const matches = DIAGRAM_TYPES.filter(
    (known) =>
      known.toLowerCase().startsWith(lower) ||
      distance(type, known) <= Math.max(1, Math.floor(type.length / 4)),
  ).slice(0, 3);
  return new Error(
    matches.length > 0
      ? `Unknown diagram type "${type}": did you mean ${alternatives(matches.map((match) => `"${match}"`))}?`
      : `Unknown diagram type "${type}": start the diagram with its type, such as ${COMMON_TYPES}.`,
  );
}

/** Where the front matter ends, as Mermaid's matchFrontMatter finds it, or 0 without front matter. */
function frontMatterEnd(text: string): number {
  const indent = /^[^\S\n]*/.exec(text)?.[0] ?? "";
  // The line breaks in the run of whitespace from the offset.
  const breaks = (from: number) => {
    const found: number[] = [];
    for (let i = from; i < text.length && /\s/.test(text[i] as string); i++) {
      if (text[i] === "\n") found.push(i);
    }
    return found;
  };
  const openings = breaks(indent.length + 3);
  if (!text.startsWith("---", indent.length) || openings.length === 0) {
    return 0;
  }
  const fence = `\n${indent}---`;
  /** The end of the closing fence that starts at the offset, with the blank lines after it. */
  const closingEnd = (i: number) =>
    text.startsWith(fence, i) ? (breaks(i + fence.length).at(-1) ?? -1) : -1;
  let lastClosing = -1;
  for (
    let i = text.indexOf(fence, (openings[0] as number) + 1);
    i >= 0;
    i = text.indexOf(fence, i + 1)
  ) {
    if (closingEnd(i) >= 0) lastClosing = i;
  }
  if (lastClosing < 0) {
    return 0;
  }
  const body = (openings.findLast((opening) => opening < lastClosing) as number) + 1;
  for (
    let i = text.indexOf(fence, body);
    i >= 0 && i <= lastClosing;
    i = text.indexOf(fence, i + 1)
  ) {
    const end = closingEnd(i);
    if (end >= 0) return end + 1;
  }
  return 0;
}

/**
 * Blank lines straight after the type of a mind map, kanban board or Ishikawa diagram, and comment
 * lines, which Mermaid removes to leave blank ones: their parsers take them for a statement that
 * must end with a line break, and fail on the indentation of the next line.
 */
const BLANK_LINES_AFTER_TYPE =
  /^((?:[^\S\n]*(?:%%[^\n]*)?\n)*?[^\S\n]*(?:mindmap|kanban|ishikawa(?:-beta)?)\b[^\n]*\n)(?:[^\S\n]*(?:%%(?!\{)[^\n]*)?\n)+/gi;

/** Removes from text after the front matter what Mermaid would parse but fail on. */
function withoutBlankLinesAfterType(text: string): string {
  return text.replace(BLANK_LINES_AFTER_TYPE, "$1");
}

/** The source as Mermaid can parse it, which describeError maps its errors back from. */
export function parsableSource(source: string): string {
  const normalized = source.replace(/\r\n?/g, "\n");
  const start = frontMatterEnd(normalized);
  return normalized.slice(0, start) + withoutBlankLinesAfterType(normalized.slice(start));
}

/** The text that Mermaid parses, with the offset in the source of each of its characters. */
interface ParsedText {
  text: string;
  origins: number[];
}

/**
 * Replaces each match in the text, as Mermaid does before parsing, keeping track of where each
 * character comes from: a replacement's characters in common with the start or end of the match
 * come from those of the match, the others from where the match differs.
 */
function edit(
  { text, origins }: ParsedText,
  pattern: RegExp,
  replace: (match: string) => string,
): ParsedText {
  const edited: ParsedText = { text: "", origins: [] };
  let from = 0;
  for (const { 0: match, index } of text.matchAll(pattern)) {
    edited.text += text.slice(from, index);
    edited.origins.push(...origins.slice(from, index));
    const replacement = replace(match);
    let prefix = 0;
    while (prefix < replacement.length && replacement[prefix] === match[prefix]) prefix++;
    let suffix = 0;
    while (
      prefix + suffix < replacement.length &&
      prefix + suffix < match.length &&
      replacement.at(-1 - suffix) === match.at(-1 - suffix)
    ) {
      suffix++;
    }
    for (let i = 0; i < replacement.length; i++) {
      const at =
        i < prefix
          ? i
          : i >= replacement.length - suffix
            ? i - replacement.length + match.length
            : prefix;
      edited.origins.push(origins[index + at] as number);
    }
    edited.text += replacement;
    from = index + match.length;
  }
  edited.text += text.slice(from);
  edited.origins.push(...origins.slice(from));
  return edited;
}

/**
 * The text that Mermaid parses for a diagram of the type, from the source with normalized line
 * breaks: without front matter and directives, and usually without comment lines and leading
 * whitespace (see preprocessDiagram and Diagram.fromText in Mermaid), with entities encoded, and as
 * the diagram's parser changes it.
 */
function parsedText(normalized: string, type: string): ParsedText {
  const start = frontMatterEnd(normalized);
  let parsed: ParsedText = {
    text: normalized.slice(start),
    origins: Array.from({ length: normalized.length - start }, (_, i) => start + i),
  };
  const remove = () => "";
  const dropLast = (match: string) => match.slice(0, -1);
  const edits: [RegExp, (match: string) => string][] = [
    [BLANK_LINES_AFTER_TYPE, withoutBlankLinesAfterType],
    [/%{2}{\s*(?:(\w+)\s*:|(\w+))\s*(?:(\w+)|((?:(?!}%{2}).|\r?\n)*))?\s*(?:}%{2})?/gi, remove],
  ];
  // Agent flows and event models keep comments for the diagram.
  if (type !== "agentflow" && type !== "eventmodeling") {
    edits.push([/^\s*%%(?!{)[^\n]+\n?/gm, remove], [/^\s+/g, remove]);
  }
  edits.push(
    [/style.*:\S*#.*;/g, dropLast],
    [/classDef.*:\S*#.*;/g, dropLast],
    [/#\w+;/g, (match) => `ﬂ°${/^#\+?\d+;$/.test(match) ? "°" : ""}${match.slice(1, -1)}¶ß`],
  );
  if (type.startsWith("flowchart") || type === "swimlane") {
    edits.push([/}\s*\n/g, () => "}\n"]);
  } else if (type === "agentflow") {
    edits.push([/}[^\S\n]*\n/g, () => "}\n"]);
  } else if (type === "sankey") {
    edits.push([/^[^\S\n]+|[^\S\n]+$/g, remove], [/\n+/g, () => "\n"], [/^\s+|\s+$/g, remove]);
  }
  for (const [pattern, replace] of edits) {
    parsed = edit(parsed, pattern, replace);
  }
  return parsed;
}

/** The offsets at which the lines of the text start. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

/** A Jison parser's error details (see parseError in the parsers that Jison generates). */
interface JisonHash {
  /** The text of the token that the parser did not expect, or of none for a lexer error. */
  text: string;
  token: string | null;
  /** The line of the token, from 0. */
  line: number;
  /** Where the token before it is, from line 1 and column 0. */
  loc?: { first_line: number; first_column: number; last_line: number; last_column: number };
  expected?: string[];
}

/** The errors of the parsers that Mermaid generates with Langium, as @mermaid-js/parser reports them. */
interface LangiumResult {
  lexerErrors: { offset: number; length: number }[];
  parserErrors: { message: string; token: { startOffset: number; endOffset: number } }[];
}

/** A problem with a span of the parsed text. */
interface Problem {
  start: number;
  end: number;
  /** What the parser expected instead. */
  expected?: string[] | undefined;
  /** A message other than the default "unexpected …". */
  message?: string;
}

/** The tokens that a Langium parser error says it expected. */
function langiumExpected(message: string): string[] {
  // "Expecting token of type 'EOF' but found …", or token sequences listed as "[A, B]".
  const single = /^Expecting token of type '(.+?)'/.exec(message)?.[1];
  return single
    ? [single]
    : [...new Set(Array.from(message.matchAll(/\[([^\],\]]+)/g), (match) => match[1] as string))];
}

/** Where a Jison lexer stopped, on the line from 0, from the excerpt its error message shows. */
function lexerErrorOffset(message: string, line: number, parsed: string): number | undefined {
  // The excerpt shows the 20 characters before the position, without line breaks, and a caret.
  const excerpt = /\n(.*)\n(-*)\^$/.exec(message);
  if (!excerpt) return undefined;
  const before = (excerpt[1] as string)
    .slice(0, (excerpt[2] as string).length)
    .replace(/^\.\.\./, "");
  const starts = lineStarts(parsed);
  const end = (starts[line + 1] ?? parsed.length + 1) - 1;
  for (let at = starts[line] ?? parsed.length; at <= end; at++) {
    if (
      parsed
        .slice(Math.max(0, at - 40), at)
        .replace(/\n/g, "")
        .endsWith(before)
    )
      return at;
  }
  return undefined;
}

/** The problems that a Mermaid parser's error reports, in the parsed text. */
function problemsOf(error: Error, parsed: string, frontMatterLines: number): Problem[] {
  const { result } = error as { result?: LangiumResult };
  if (result?.lexerErrors && result.parserErrors) {
    return [
      ...result.lexerErrors.map(({ offset, length }) => ({ start: offset, end: offset + length })),
      // Chevrotain gives no offsets, NaN, for the end of the text.
      ...result.parserErrors.map(({ message, token }) => ({
        start: token.startOffset || parsed.length,
        end: (token.endOffset || parsed.length) + 1,
        expected: langiumExpected(message),
      })),
    ];
  }
  // Use case diagrams give offsets in their message.
  const span =
    /^Error (?:lexing|parsing) \w+ diagram: (.*) at line \d+, column \d+ \[(\d+),(\d+)\)$/s.exec(
      error.message,
    );
  if (span) {
    return [
      {
        start: Number(span[2]),
        end: Number(span[3]),
        expected: langiumExpected(span[1] as string),
      },
    ];
  }
  const { hash } = error as { hash?: JisonHash };
  // Some of Mermaid's checks of what it parsed make up the details of a parser's error.
  if (!hash || (hash.token !== null && !/^(?:Parse|Lexical) error/.test(error.message))) return [];
  const starts = lineStarts(parsed);
  const offset = (line: number, column: number) =>
    Math.min((starts[line - 1] ?? parsed.length) + column, parsed.length);
  if (!hash.loc) {
    const start = error.message.startsWith("Lexical error")
      ? lexerErrorOffset(error.message, hash.line, parsed)
      : undefined;
    return start === undefined ? [] : [{ start, end: start + 1 }];
  }
  const { first_line, first_column, last_line, last_column } = hash.loc;
  if (hash.token === null) {
    // Agent flows report errors in node metadata as Jison would, in lines after the front matter.
    return [
      {
        start: offset(first_line - frontMatterLines, first_column),
        end: offset(last_line - frontMatterLines, last_column),
        message: error.message,
      },
    ];
  }
  // The location is that of the last token the parser accepted: the unexpected one is next.
  const after = offset(last_line, last_column);
  const found = hash.text ? parsed.indexOf(hash.text, after) : -1;
  const start =
    found >= 0 && lineStarts(parsed.slice(0, found)).length <= hash.line + 1 ? found : after;
  return [
    {
      start,
      end: start + hash.text.length,
      expected: hash.expected?.map((token) => token.replace(/^'(.*)'$/, "$1")),
    },
  ];
}

/** The line and column of an offset in the text, from 1. */
function position(text: string, offset: number): { line: number; column: number } {
  const starts = lineStarts(text);
  const line = starts.findLastIndex((start) => start <= offset);
  return { line: line + 1, column: offset - (starts[line] as number) + 1 };
}

/** Describes a problem with a span of the source. */
function describe(source: string, start: number, end: number, expected?: string[]): string {
  const span = source.slice(start, end).split("\n", 1)[0] as string;
  const text = span.trim();
  let found = JSON.stringify(text.length > 30 ? `${text.slice(0, 30)}…` : text);
  if (!text) {
    // Spaces at the end of a line, or of the diagram, are not what the parser stopped at.
    const rest = source.slice(start);
    found = !rest.trim()
      ? "end of the diagram"
      : span && (rest.split("\n", 1)[0] as string).trim()
        ? /(?:^|\n)$/.test(source.slice(0, start))
          ? "indentation"
          : "space"
        : "end of line";
  }
  // A longer list is of every kind of statement, which does not help.
  const names = expected?.map((name) => (name === "EOF" ? "end of the diagram" : name)) ?? [];
  const instead = names.length > 0 && names.length <= 8 ? `; expected ${alternatives(names)}` : "";
  return `unexpected ${found}${instead}.`;
}

/** Describes an error of js-yaml, in Mermaid's front matter or a node's metadata. */
function yamlError(
  error: Error & { reason?: string },
  { buffer = "", position: at }: { buffer?: string; position: number },
  normalized: string,
): Error {
  const reason = error.reason ?? error.message.split("\n", 1)[0];
  // Mermaid wraps metadata on one line in braces; js-yaml adds a final line break.
  const inline = buffer.startsWith("{\n") && buffer.endsWith("\n}\n");
  const yaml = inline ? buffer.slice(2, -3) : buffer.replace(/\n$/, "");
  const start = yaml ? normalized.indexOf(yaml) : -1;
  if (start < 0) {
    return new Error(`Invalid YAML: ${reason}.`);
  }
  const where = start < frontMatterEnd(normalized) ? "the front matter" : "the node's metadata";
  const { line, column } = position(
    normalized,
    start + Math.max(0, Math.min(at - (inline ? 2 : 0), yaml.length)),
  );
  return new Error(`Invalid YAML in ${where} on line ${line}, column ${column}: ${reason}.`);
}

/** Makes Mermaid's error clear, at its position in the source. */
export function describeError(error: unknown, source: string, type: () => string): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  if (error.name === "UnknownDiagramError") {
    return unknownTypeError(error.message);
  }
  const normalized = source.replace(/\r\n?/g, "\n");
  const { mark } = error as { mark?: { buffer?: string; position: number } };
  if (error.name === "YAMLException" && mark) {
    return yamlError(error, mark, normalized);
  }
  // Mermaid loads the image of an image shape to lay it out, which only a data: URL lets the panel.
  if (error.name === "EncodingError") {
    const url = Array.from(
      normalized.matchAll(/\bimg:\s*["']?([^\s"',}]+)/g),
      (match) => match[1],
    ).find((url) => !url?.startsWith("data:"));
    return new Error(
      url
        ? `Cannot load the image ${url}: the panel loads no images, so give it as a data: URL.`
        : `An image in the diagram cannot be shown: ${error.message}`,
    );
  }
  const edgeLimit = /^Edge limit exceeded.* the limit is (\d+)/.exec(error.message);
  if (edgeLimit) {
    return new Error(
      `The diagram has more than ${edgeLimit[1]} edges, more than Mermaid draws: split it into smaller diagrams.`,
    );
  }
  let parsed: ParsedText;
  try {
    parsed = parsedText(normalized, type());
  } catch {
    return error;
  }
  const frontMatterLines = lineStarts(normalized.slice(0, frontMatterEnd(normalized))).length - 1;
  const problems = problemsOf(error, parsed.text, frontMatterLines).map((problem) => {
    let start = parsed.origins[problem.start] ?? normalized.length;
    const end =
      problem.end > problem.start ? (parsed.origins[problem.end - 1] ?? start) + 1 : start;
    // A token can start with the whitespace before it; the end of the text is after the last token.
    const space = /^\s*/.exec(normalized.slice(start, end))?.[0].length ?? 0;
    if (start + space < end) start += space;
    if (!normalized.slice(start).trim()) start = normalized.trimEnd().length;
    const { line, column } = position(normalized, start);
    const message = problem.message
      ? `Error on line ${line}, column ${column}: ${problem.message}`
      : `Parse error on line ${line}, column ${column}: ${describe(normalized, start, end, problem.expected)}`;
    return { line, column, message };
  });
  // The first problem on each line: the others are usually its consequences.
  const messages = problems
    .sort((a, b) => a.line - b.line || a.column - b.column)
    .filter((problem, i) => problems[i - 1]?.line !== problem.line)
    .map(({ message }) => message);
  return messages.length > 0
    ? new Error(messages.join("\n"))
    : (unplacedError(error.message, normalized) ?? error);
}

/** A pattern for the text. */
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A pattern for the text as a word of its own. */
const word = (text: string) => `(?<![\\w-])${literal(text)}(?![\\w-])`;

/** The offset of the first match of the pattern in the source, after the front matter. */
function find(normalized: string, pattern: string): number | undefined {
  const start = frontMatterEnd(normalized);
  const found = new RegExp(pattern, "m").exec(normalized.slice(start));
  return found ? start + found.index : undefined;
}

/** The error, on the line of the offset in the source if there is one. */
const errorAt = (normalized: string, at: number | undefined, message: string) =>
  new Error(
    at === undefined ? message : `Error on line ${position(normalized, at).line}: ${message}`,
  );

/**
 * Where a sequence diagram first deactivates the participant more often than it activated it:
 * `deactivate` and a message from it with "-" after the arrow deactivate it.
 */
function deactivation(normalized: string, name: string): number | undefined {
  const arrow = "[^\\S\\n]*<?<?-{1,2}(?:>>|>|x|\\))";
  const statements = new RegExp(
    `^[^\\S\\n]*(?:(de)?activate[^\\S\\n]+${word(name)}|${literal(name)}${arrow}(-)|.*?${arrow}(\\+)[^\\S\\n]*${word(name)})`,
    "gm",
  );
  let active = 0;
  for (const match of normalized.matchAll(statements)) {
    active += match[1] || match[2] ? -1 : 1;
    if (active < 0) return match.index;
  }
  return undefined;
}

/** The largest index that linkStyle statements give, which no link has when one fails. */
function linkStyleIndex(normalized: string): string | undefined {
  const indices = Array.from(
    normalized.matchAll(/^[^\S\n]*linkStyle[^\S\n]+([\d,\s]*\d)/gm),
    (match) => (match[1] as string).split(/[,\s]+/).map(Number),
  ).flat();
  return indices.length > 0 ? String(Math.max(...indices)) : undefined;
}

/**
 * Errors of Mermaid's checks of what it parsed, which do not say where in the source they are: by
 * their messages, where they are, and clearer messages for some.
 */
const UNPLACED: [
  RegExp,
  (match: RegExpExecArray, normalized: string) => [number | undefined, string?] | undefined,
][] = [
  [
    /^Invalid date:(.*)$/s,
    ([, date = ""], normalized) => [
      find(normalized, word(date)),
      `Invalid date "${date}": write dates as the dateFormat says, ${/^[^\S\n]*dateFormat[^\S\n]+(.*\S)/m.exec(normalized)?.[1] ?? "YYYY-MM-DD"}.`,
    ],
  ],
  [
    /^No such shape: (.*?)\./,
    ([, shape = ""], normalized) => [find(normalized, `shape\\s*:\\s*["']?${word(shape)}`)],
  ],
  [
    /^There can be only one root\. No parent could be found for \("(.*)"\)$/s,
    ([, node = ""], normalized) => [
      find(normalized, `^[^\\S\\n]*${word(node)}`),
      `A mind map has one root: indent "${node}" below it.`,
    ],
  ],
  [
    /^Trying to inactivate an inactive participant \((.*)\)$/,
    ([, name = ""], normalized) => [
      deactivation(normalized, name),
      `"${name}" is deactivated, but it is not active.`,
    ],
  ],
  // Mermaid's own check of the indices misses them.
  [
    /^Cannot set properties of undefined \(setting 'style'\)$/,
    (_, normalized) => {
      const index = linkStyleIndex(normalized);
      return index === undefined
        ? undefined
        : [
            find(normalized, `^[^\\S\\n]*linkStyle[^\\S\\n]+(?:[\\d,\\s]*[,\\s])?${index}\\b`),
            `linkStyle ${index} refers to no link: links are numbered from 0, in the order the diagram defines them.`,
          ];
    },
  ],
  // Mermaid lays diagrams out with ELK, which fails on an edge of a node that it was not given.
  [
    /^org\.eclipse\.elk\..*: Referenced shape does not exist: (.*)$/,
    ([, id = ""], normalized) => [
      find(normalized, word(id)),
      `Mermaid cannot lay out the edges of "${id}": give the groups and the nodes different ids.`,
    ],
  ],
  [
    /^org\.eclipse\.elk\..*: Id must be a string or an integer: 'null'\.$/,
    () => [
      undefined,
      "An edge or relationship refers to something that the diagram does not define.",
    ],
  ],
  // Others quote what they are about: the first line with all of it.
  [
    /"[^"\n]+"|\[[^\]\n]+\]/,
    ({ input }, normalized) => {
      const quoted = Array.from(
        input.matchAll(/"([^"\n]+)"|\[([^\]\n]+)\]/g),
        (quote) => `(?=.*${word((quote[1] ?? quote[2]) as string)})`,
      );
      return [find(normalized, `^${quoted.join("")}`)];
    },
  ],
];

/** Describes an error that Mermaid gives no position for, where in the source it can tell. */
function unplacedError(message: string, normalized: string): Error | undefined {
  for (const [pattern, describe] of UNPLACED) {
    const match = pattern.exec(message);
    const described = match && describe(match, normalized);
    if (described) return errorAt(normalized, described[0], described[1] ?? message);
  }
  return undefined;
}
