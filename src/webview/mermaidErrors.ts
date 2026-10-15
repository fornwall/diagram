// Describes Mermaid's errors concisely, at their positions in the source.

import { DIRECTIVE, frontMatterEnd } from "../mermaidSyntax";
import { editDistance, joinWords, lineAndColumn, quote } from "../text";
import { c4UnquotedArguments, syntaxHint } from "./mermaidHints";
import { diagramHeader } from "./mermaidLayout";
import type { DiagramDb } from "./mermaidNodes";

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

const COMMON_TYPES = joinWords(DIAGRAM_TYPES.slice(0, 11), "or");

/** The first statements of diagrams without a type, and the type line that they need. */
const STATEMENTS: [RegExp, string][] = [
  [/^\s*\[\*\]\s*-->/, "stateDiagram-v2"],
  [/<?<?-?->>|-[x)]\s*\w/, "sequenceDiagram"],
  [/[|}][|o]--|--[|o][|{]|[|}][|o]\.\.|\.\.[|o][|{]/, "erDiagram"],
  [/<\|--|--\|>|\*--|--\*|\bo--|--o\b|\.\.>|\.\.\|>/, "classDiagram"],
  [/-->|---|==>|-\.->|^\s*[\w-]+\s*(?:\[|\(|\{)/, "flowchart TD"],
];

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
  // The source starts with a statement, as a model that leaves out the type writes it.
  const statement = text.split("\n", 1)[0] ?? "";
  const missing = STATEMENTS.find(([pattern]) => pattern.test(statement))?.[1];
  if (missing) {
    return new Error(`The diagram has no type: start it with a line "${missing}".`);
  }
  const lower = type.toLowerCase();
  const matches = DIAGRAM_TYPES.filter(
    (known) =>
      // A letter starts too many types to tell.
      (lower.length > 1 && known.toLowerCase().startsWith(lower)) ||
      editDistance(lower, known.toLowerCase()) <= Math.max(1, Math.floor(type.length / 4)),
  ).slice(0, 3);
  return new Error(
    matches.length > 0
      ? `Unknown diagram type "${type}": did you mean ${joinWords(
          matches.map((match) => `"${match}"`),
          "or",
        )}?`
      : `Unknown diagram type "${type}": start the diagram with its type, such as ${COMMON_TYPES}.`,
  );
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
    [DIRECTIVE, remove],
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
  // Use case diagrams give offsets in their message, which their parser adds to Chevrotain's (see
  // usecase.chevrotain.ts in Mermaid), and the line and column of invalid JSON data.
  const { line, column } = error as { line?: unknown; column?: unknown };
  if (error.name === "UsecaseJsonError" && typeof line === "number" && typeof column === "number") {
    const start = Math.min(
      (lineStarts(parsed)[line - 1] ?? parsed.length) + column - 1,
      parsed.length,
    );
    // Leave out where in the JSON it failed, which the position in the diagram says better.
    const message = error.message
      .replace(/ \(line \d+, column \d+\)$/, "")
      .replace(/ at position \d+(?: \(line \d+ column \d+\))?/, "");
    return [{ start, end: start + 1, message: `${message}.` }];
  }
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

/** Describes a problem with a span of the source. */
function describe(source: string, start: number, end: number, expected?: string[]): string {
  const span = source.slice(start, end).split("\n", 1)[0] as string;
  const text = span.trim();
  let found = quote(text, 30);
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
  const instead =
    names.length > 0 && names.length <= 8 ? `; expected ${joinWords(names, "or")}` : "";
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
  const { line, column } = lineAndColumn(
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
  let diagramType: string;
  let parsed: ParsedText;
  try {
    diagramType = type();
    parsed = parsedText(normalized, diagramType);
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
    const { line, column } = lineAndColumn(normalized, start);
    const { expected } = problem;
    const hint =
      problem.message === undefined
        ? syntaxHint({ type: diagramType, normalized, start, end, expected })
        : undefined;
    // A hint says what to write better than the names of the tokens that the parser expected.
    const message = problem.message
      ? `Error on line ${line}, column ${column}: ${problem.message}`
      : `Parse error on line ${line}, column ${column}: ${describe(normalized, start, end, hint ? undefined : expected)}${hint ? ` ${hint}` : ""}`;
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
    at === undefined ? message : `Error on line ${lineAndColumn(normalized, at).line}: ${message}`,
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
  // Mermaid gives its cose-bilkent layout the root node that it needs for mind maps alone.
  [
    /^Root node is required$/,
    () => [
      undefined,
      'The cose-bilkent layout only lays out mind maps: set "layout" to "dagre" or "elk" instead.',
    ],
  ],
  // Mermaid's dagre layout fails on any group inside itself, where its ELK one may hang.
  [
    /^Setting (.*?) as parent of .* would create a cycle$/,
    ([, id = ""], normalized) => insideItself(normalized, id),
  ],
  // Event models count the line in the text after the front matter: find the second frame.
  [
    /^Duplicate event modeling frame ID "(.*)"/,
    ([, id = ""], normalized) => {
      const frame = `^[^\\S\\n]*(?:tf|timeframe)[^\\S\\n]+${word(id)}`;
      return [
        find(normalized, `(?<=${frame}[^]*)${frame}`),
        `Two time frames are numbered "${id}": give each its own number.`,
      ];
    },
  ],
  // A branch can be checked out only after it is created, and never deleted: the first checkout.
  [
    /^Trying to checkout branch which is not yet created\. \(Help try using "branch (.*)"\)$/,
    ([, name = ""], normalized) => [
      find(normalized, `^[^\\S\\n]*(?:checkout|switch)[^\\S\\n]+${word(name)}`),
      `There is no branch "${name}" to check out: create it first, with "branch ${name}".`,
    ],
  ],
  // A set can be in a union only after it is declared: the first union of the first one.
  [
    /^unknown set identifier: (.*)$/,
    ([, list = ""], normalized) => {
      const names = list.split(", ");
      const quoted = joinWords(
        names.map((name) => `"${name}"`),
        "and",
      );
      return [
        find(normalized, `^[^\\S\\n]*union[^\\S\\n]+[^\\[\\n:]*${word(names[0] as string)}`),
        names.length > 1
          ? `${quoted} are not sets: declare them, as in "set ${names[0]}", before the union.`
          : `${quoted} is not a set: declare it, as in "set ${names[0]}", before the union.`,
      ];
    },
  ],
  // A Gantt chart takes a line with a colon for a task, such as "title: Plan", and fails on its
  // dates; a task of a duration alone starts where the task before it ends, and the first has none.
  [
    /^Cannot read properties of undefined \(reading 'endTime'\)$/,
    (_, normalized) => {
      const keyword =
        "title|dateFormat|axisFormat|tickInterval|todayMarker|excludes|includes|weekday|weekend|section|displayMode|inclusiveEndDates|topAxis";
      const at = find(normalized, `^[^\\S\\n]*(?:${keyword})[^\\S\\n]*:`);
      const statement =
        at === undefined
          ? null
          : /^\s*(\w+)\s*:\s*(.*)/.exec(normalized.slice(at).split("\n")[0] ?? "");
      return statement
        ? [at, `"${statement[1]}" takes no colon: write "${statement[1]} ${statement[2]}".`]
        : firstTaskWithoutStart(normalized);
    },
  ],
  // The C4 lexer takes a label that is not quoted up to the next comma, the closing parenthesis
  // and the lines after it included, which leaves the element out.
  [
    /^C4 rel "(.*?)" -> "(.*?)" references an unknown shape or boundary$/,
    ([, from = "", to = ""], normalized) => {
      const unquoted = c4UnquotedArguments(normalized);
      if (unquoted) return [unquoted.at, `Put the labels in double quotes: ${unquoted.fixed}.`];
      const declared = (alias: string) =>
        find(normalized, `^[^\\S\\n]*\\w+\\([^\\S\\n]*${word(alias)}[^\\S\\n]*,`) !== undefined;
      const missing = [from, to].find((alias) => !declared(alias)) ?? from;
      return [
        find(normalized, `^[^\\S\\n]*(?:Bi)?Rel\\w*\\([^\\n]*${word(missing)}`),
        `"${missing}" is not an element or boundary of the diagram: declare it before the relationship, as in Person(${missing}, "Label").`,
      ];
    },
  ],
  // A class diagram annotates a class declared before the annotation, and fails on another.
  [
    /^Cannot read properties of undefined \(reading 'annotations'\)$/,
    (_, normalized) => {
      const at = find(normalized, "^[^\\S\\n]*<<[^>\\n]*>>[^\\S\\n]*[\\w.~]+");
      const annotation =
        at === undefined ? null : /<<([^>\n]*)>>\s*([\w.~]+)/.exec(normalized.slice(at));
      return annotation
        ? [
            at,
            `<<${annotation[1]}>> ${annotation[2]} annotates a class that is not declared before it: declare it first, with "class ${annotation[2]}".`,
          ]
        : undefined;
    },
  ],
  // A timeline adds an event to the last period, and fails on one before any: the first event.
  [
    /^Cannot read properties of undefined \(reading 'events'\)$/,
    (_, normalized) => {
      const at = find(normalized, "^[^\\S\\n]*:");
      return at === undefined || find(normalized, "^[^\\S\\n]*timeline\\b") === undefined
        ? undefined
        : [at, 'The event has no time period: start the line with one, as in "2024 : Launch".'];
    },
  ],
  // A packet field given by its bits, out of order or backwards, or as "+0".
  [/^Packet block \d+(?: - \d+)? is /, (_, normalized) => [badPacketField(normalized)]],
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

/** The tags of a Gantt task, before its data. */
const TASK_TAGS = /^(?:\s*(?:active|done|crit|milestone|vert)\s*,)*/;

/**
 * The first task of a Gantt chart, if it has a duration or an end alone, with which Mermaid starts
 * a task where the one before it ends: where it is, and the error for there being none before.
 */
function firstTaskWithoutStart(normalized: string): [number | undefined, string] | undefined {
  // Keywords take no colon but accTitle and accDescr; a click's URL has one after "href".
  const at = find(normalized, "^[^\\S\\n]*(?!accTitle|accDescr|click\\b)[^:\\n]*\\S[^\\S\\n]*:");
  const task =
    at === undefined ? null : /^\s*(.*?)\s*:(.*)$/.exec(normalized.slice(at).split("\n")[0] ?? "");
  if (!task) return undefined;
  const [, name = "", data = ""] = task;
  const fields = data.replace(TASK_TAGS, "").split(",");
  if (fields.length !== 1) return undefined;
  const format = /^[^\S\n]*dateFormat[^\S\n]+(.*\S)/m.exec(normalized)?.[1] ?? "YYYY-MM-DD";
  const example =
    format === "YYYY-MM-DD"
      ? `as in "${name} :2024-01-15, ${fields[0]?.trim()}"`
      : `as the dateFormat says, ${format}, before its ${fields[0]?.trim()}`;
  return [
    at,
    `Task ${quote(name, 40)} has no start date, and no task before it to start after: give it one, ${example}.`,
  ];
}

/**
 * Where the first packet field is that does not start where the one before ends, ends before it
 * starts, or has no bits, as Mermaid checks the fields in order.
 */
function badPacketField(normalized: string): number | undefined {
  const start = frontMatterEnd(normalized);
  const fields = /^[^\S\n]*(?:(\d+)(?:[^\S\n]*-[^\S\n]*(\d+))?|\+[^\S\n]*(\d+))[^\S\n]*:/gm;
  let last = -1;
  for (const { 1: from, 2: to, 3: bits, index } of normalized.slice(start).matchAll(fields)) {
    const first = from === undefined ? last + 1 : Number(from);
    const end = to === undefined ? first + Number(bits ?? 1) - 1 : Number(to);
    if (first !== last + 1 || end < first || Number(bits) === 0) {
      return start + index;
    }
    last = end;
  }
  return undefined;
}

/** Where the group is declared, and the error for it being inside itself. */
const insideItself = (normalized: string, id: string): [number | undefined, string] => [
  find(normalized, `^[^\\S\\n]*(?:state|subgraph|namespace)[^\\S\\n]+${word(id)}`),
  `"${id}" is inside itself, which Mermaid cannot lay out: give the group and what it contains different ids.`,
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

/**
 * Errors of Mermaid's checks of the statements of a git graph or a Venn diagram, as it runs them
 * in order, which depend on the statements before them: of merges, cherry-picks, branches that
 * exist, and unions and texts.
 */
const STATEMENT_ERROR =
  /^(?:Incorrect usage of "?(?:merge|cherryPick|cherry-pick)\b|Cannot merge branch |Invalid operation: The specified parent commit |Trying to create an existing branch\.|union requires multiple identifiers$|text requires set$)/;

/**
 * The error for a statement that Mermaid's checks fail on, on its line: the first line that the
 * source up to fails on in the same way, which Mermaid runs the same statements up to. `parse`
 * rejects with the error that Mermaid fails to parse a text with; it is given the source up to a
 * line as the renderer gives Mermaid the whole source, so that lines count in the source.
 */
export async function statementError(
  error: unknown,
  source: string,
  parse: (text: string) => Promise<unknown>,
): Promise<Error | undefined> {
  if (!(error instanceof Error) || !STATEMENT_ERROR.test(error.message)) return undefined;
  const normalized = source.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  /** How the source up to the line parses: whether it fails the same way, or otherwise. */
  const outcomes = new Map<number, Promise<"parses" | "same" | "other">>();
  const outcome = (line: number) => {
    let found = outcomes.get(line);
    if (!found) {
      found = parse(parsableSource(lines.slice(0, line).join("\n"))).then(
        () => "parses" as const,
        (failure: unknown) =>
          failure instanceof Error && failure.message === error.message ? "same" : "other",
      );
      outcomes.set(line, found);
    }
    return found;
  };
  // A search of the lines after the front matter, if the whole text fails so.
  let low = lineStarts(normalized.slice(0, frontMatterEnd(normalized))).length;
  let high = lines.length;
  if ((await outcome(high)) !== "same") return undefined;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    // The source up to a line inside a statement of several lines, such as "accDescr {", fails
    // otherwise: take the last line before it that it does not.
    let line = middle;
    let found = await outcome(line);
    while (found === "other" && line > low) found = await outcome(--line);
    if (found === "same") high = line;
    else low = found === "parses" ? line + 1 : middle + 1;
  }
  // Without the line, the statements before it must run, or the search went astray.
  return (await outcome(high - 1)) === "parses"
    ? new Error(`Error on line ${high}: ${error.message}`)
    : undefined;
}

/**
 * The error for a composite state with no states in it, which Mermaid's dagre layout draws as a
 * state, failing to find a state shape for it. Mermaid leaves out the states that a composite
 * state declares with nothing but "state B", which can leave it empty.
 */
export function emptyStateError(
  error: unknown,
  db: DiagramDb | undefined,
  source: string,
): Error | undefined {
  if (!(error instanceof Error) || !/^No such shape: roundedWithTitle\b/.test(error.message)) {
    return undefined;
  }
  const { nodes = [] } = db?.getData?.() ?? {};
  const empty = nodes.find(
    ({ id, isGroup }) => isGroup && !nodes.some((node) => node.parentId === id && node.id !== id),
  );
  if (!empty) return undefined;
  const normalized = source.replace(/\r\n?/g, "\n");
  return errorAt(
    normalized,
    find(
      normalized,
      `^[^\\S\\n]*state[^\\S\\n]+(?:"[^"\\n]*"[^\\S\\n]+as[^\\S\\n]+)?${word(empty.id)}[^\\S\\n]*\\{`,
    ),
    `The composite state "${empty.id}" has no states in it, which the dagre layout cannot draw: put states in it, or lay it out with elk.`,
  );
}

/**
 * The error for two links of a flowchart with the same id, which Mermaid fails to draw with
 * "Cannot read properties of undefined (reading 'filter')". Mermaid names a link by the ids of its
 * ends, as L_P_Q_R_0 for both P_Q --> R and P --> Q_R, unless the source names it, also with a
 * name that Mermaid gives another link.
 */
export function duplicateEdgeError(
  error: unknown,
  db: DiagramDb | undefined,
  source: string,
): Error | undefined {
  if (!(error instanceof Error) || !/^Cannot read properties of undefined\b/.test(error.message)) {
    return undefined;
  }
  const edges = db?.getData?.().edges ?? [];
  const ids = new Set(edges.map(({ id }) => id));
  const first = new Map<string, (typeof edges)[number]>();
  for (const edge of edges) {
    const other = first.get(edge.id);
    if (!other) {
      first.set(edge.id, edge);
      continue;
    }
    const normalized = source.replace(/\r\n?/g, "\n");
    const lineAt = (at: number | undefined) =>
      at === undefined ? undefined : lineAndColumn(normalized, at).line;
    const statement = (line: number | undefined) =>
      line === undefined ? "" : (normalized.split("\n")[line - 1] ?? "").trim();
    let free = 1;
    while (ids.has(`e${free}`)) free++;
    const named = [other, edge].find(({ isUserDefinedId }) => isUserDefinedId);
    if (named) {
      const generated = named === edge ? other : edge;
      const line = lineAt(find(normalized, `${literal(named.id)}@`));
      const fixed = statement(line).replace(`${named.id}@`, `e${free}@`);
      return errorAt(
        normalized,
        find(normalized, `${literal(named.id)}@`),
        `The link's id "${named.id}" is also the id that Mermaid gives the link from "${generated.start}" to "${generated.end}", and it cannot draw both: give the link another id, as in ${fixed}.`,
      );
    }
    const [a, b] = [other, edge].map(({ start, end }) =>
      find(normalized, `${word(start)}.*${word(end)}`),
    );
    const fixed = statement(lineAt(b)).replace(
      new RegExp(`(${word(edge.start)}\\s*)((?:<|o|x)?(?:--|==|-\\.)[-.=]*[>ox]?)`),
      `$1e${free}@$2`,
    );
    const where = a === undefined ? "" : ` on line ${lineAt(a)}`;
    return errorAt(
      normalized,
      b,
      `The links from "${other.start}" to "${other.end}"${where} and from "${edge.start}" to "${edge.end}" both get the id "${edge.id}", as Mermaid names a link by its ends, and it cannot draw both: rename a node, or give one link an id of its own, as in ${fixed}.`,
    );
  }
  return undefined;
}

/**
 * The error for a relationship to something that the diagram does not define, such as an
 * undeclared requirement, on which Mermaid's layouts fail without saying what it is.
 */
export function undefinedEndError(db: DiagramDb | undefined, source: string): Error | undefined {
  const { nodes = [], edges = [] } = db?.getData?.() ?? {};
  const ids = new Set(nodes.map(({ id }) => id));
  const missing = [
    ...edges.flatMap(({ start, end }) => [start, end]),
    ...(db?.getRelationships?.() ?? []).flatMap(({ src, dst }) => [src, dst]),
  ].find((id) => typeof id === "string" && !ids.has(id));
  if (typeof missing !== "string") return undefined;
  const normalized = source.replace(/\r\n?/g, "\n");
  return errorAt(
    normalized,
    find(normalized, word(missing)),
    `A relationship refers to "${missing}", which the diagram does not define: define it, or correct the name.`,
  );
}

/**
 * The error for a number that is not one, which Mermaid would draw out of place: the score of a
 * user journey task, drawn as a face out of place and a broken line to it, or the value of a
 * sankey flow, for which it draws no flows and every node at one place.
 */
export function numberError(db: DiagramDb | undefined, source: string): Error | undefined {
  const type = diagramHeader(source).typeLine ?? "";
  const normalized = source.replace(/\r\n?/g, "\n");
  // Not the tasks of a Gantt chart, which it fails on invalid dates in, to describe as it draws.
  const tasks = /^journey\b/.test(type) ? (db?.getTasks?.() ?? []) : [];
  const task = tasks.find(({ score }) => Number.isNaN(score))?.task?.trim();
  if (task !== undefined) {
    return errorAt(
      normalized,
      find(normalized, `^[^\\S\\n]*${literal(task)}[^\\S\\n]*:`),
      `The score of "${task}" is not a number: score each task from 1 to 5, as in "Make tea: 5: Me".`,
    );
  }
  const flows = /^sankey\b/.test(type) ? (db?.getGraph?.().links ?? []) : [];
  const flow = flows.find(({ value }) => Number.isNaN(value));
  if (flow === undefined) return undefined;
  // The value is the last field, which Mermaid reads the number at the start of.
  const ends = [flow.source, flow.target].map((end) => `(?=.*${literal(end)})`).join("");
  const at = find(normalized, `^${ends}.*,(?![^\\S\\n]*"?[^\\S\\n]*[-+]?\\.?\\d)[^,\\n]*$`);
  // A first line of words is a header, as of a CSV file, whose names no flow links.
  const header =
    flow === flows[0] &&
    at !== undefined &&
    !flows.some(
      (other) =>
        other !== flow &&
        [other.source, other.target].some((end) => end === flow.source || end === flow.target),
    ) &&
    /^\s*"?[A-Za-z][^,\n]*,[^,\n]+,\s*"?[A-Za-z][^,\n]*$/.test(
      normalized.slice(at).split("\n")[0] ?? "",
    );
  return errorAt(
    normalized,
    at,
    header
      ? "A sankey diagram has no header row: remove this line, and start with the first flow."
      : `The value of the flow from "${flow.source}" to "${flow.target}" is not a number: write the number alone, such as 10, without units.`,
  );
}

/**
 * The error for an edge that Mermaid's ELK layout would loop over forever, freezing the panel: one
 * at a node in a group inside itself, such as a composite state that refers to itself inside.
 * ELK's findCommonAncestor follows the parents of the edge's start until it meets its end, and
 * then those of its end until it meets one of the start's, which a group inside itself never does.
 * A group inside itself without such edges draws, as does one in a kanban, which has no edges.
 * Other layouts draw none of these either: dagre fails on any group inside itself.
 */
export function nestingError(db: DiagramDb | undefined, source: string): Error | undefined {
  const { nodes = [], edges = [] } = db?.getData?.() ?? {};
  // As the layout finds them, group by group: of the groups that hold nodes of an id, such as a
  // class and a namespace of a class diagram, the last is its parent.
  const parents = new Map<string, string>();
  for (const group of nodes.filter(({ isGroup }) => isGroup)) {
    for (const node of nodes) if (node.parentId === group.id) parents.set(node.id, group.id);
  }
  /** The node and its ancestors, up to the first that is its own ancestor, if one is. */
  const ancestry = (id: string) => {
    const seen = new Set<string>();
    for (let at: string | undefined = id; at !== undefined; at = parents.get(at)) {
      if (seen.has(at)) return { seen, loop: at };
      seen.add(at);
    }
    return { seen, loop: undefined };
  };
  for (const { start, end } of edges) {
    if (start === end) continue;
    const from = ancestry(start);
    const loop = from.loop === undefined ? ancestry(end).loop : !from.seen.has(end) && from.loop;
    if (loop) {
      const normalized = source.replace(/\r\n?/g, "\n");
      return errorAt(normalized, ...insideItself(normalized, loop));
    }
  }
  return undefined;
}
