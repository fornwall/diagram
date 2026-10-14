// How to fix the syntax errors that models commonly make in Mermaid, where the parser's message
// says no more than where it stopped and which tokens it expected. Each hint is checked to fix the
// error it is for (see webviewMermaidErrors.test.ts).

import { frontMatterEnd } from "../mermaidSyntax";
import { joinWords } from "../text";

/** Where a parser stopped. */
export interface Stop {
  /** The diagram type that Mermaid detected. */
  type: string;
  /** The source, with normalized line breaks. */
  normalized: string;
  /** The span of what the parser did not expect. */
  start: number;
  end: number;
  /** The tokens that the parser expected instead. */
  expected: readonly string[] | undefined;
}

/** A stop, with the line it is on. */
interface At extends Stop {
  /** The line, its number from 1, and where on it the parser stopped, from 0. */
  line: string;
  lineNumber: number;
  column: number;
  /** The line before and from where the parser stopped. */
  before: string;
  after: string;
  /** Whether the parser stopped at the end of the diagram. */
  atEnd: boolean;
}

/** A hint that tells how to fix the syntax error at the stop, if a common mistake explains it. */
export function syntaxHint(stop: Stop): string | undefined {
  const { normalized, start } = stop;
  const lineStart = normalized.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = normalized.indexOf("\n", start);
  const line = normalized.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
  const column = start - lineStart;
  const at: At = {
    ...stop,
    line,
    lineNumber: normalized.slice(0, lineStart).split("\n").length,
    column,
    before: line.slice(0, column),
    after: line.slice(column),
    atEnd: !normalized.slice(start).trim(),
  };
  for (const rule of RULES) {
    const hint = rule(at);
    if (hint) return hint;
  }
  return undefined;
}

type Rule = (at: At) => string | undefined;

const FLOWCHART = /^flowchart/;

/** An id as Mermaid takes it, made of the name. */
const idOf = (name: string) => name.trim().replace(/\W+/g, "_");

/** Comments: on lines of their own, starting with %%. */
const comments: Rule = ({ line, before, after }) => {
  const comment = /^\s*(\/\/|#(?![\w-]+;))\s*(.*)$/.exec(line);
  if (comment) {
    return `Comments start with %%, on a line of their own: "%% ${comment[2]}".`;
  }
  if (after.startsWith("%%") && before.trim()) {
    return `Comments go on lines of their own: move ${JSON.stringify(after.trim())} to a line of its own.`;
  }
  return undefined;
};

/** The blocks that a kind of diagram nests, by the lines that open and close them. */
interface Blocks {
  /** Opens a block, naming it in the first group. */
  open: RegExp;
  close: RegExp;
  /** What closes one. */
  closer: string;
  /** What the hint calls a block that the line opens. */
  name: (opening: RegExpExecArray) => string;
}

const END = /^\s*end\s*;?\s*$/;
const BRACES: Blocks = {
  open: /^.*\{\s*$/,
  close: /^\s*\}\s*$/,
  closer: "}",
  name: () => '"{"',
};
const SEQUENCE_BLOCKS = /^\s*(alt|opt|loop|par_over|par|critical|break|rect|box)(?:\s|$)/;

function blocksOf(type: string): Blocks | undefined {
  if (FLOWCHART.test(type)) {
    return { open: /^\s*subgraph\b/, close: END, closer: "end", name: () => "subgraph" };
  }
  if (type === "sequence") {
    return {
      open: SEQUENCE_BLOCKS,
      close: END,
      closer: "end",
      name: ([, keyword]) => `"${keyword}" block`,
    };
  }
  if (type === "block") {
    return { open: /^\s*block\b(?!-)/, close: END, closer: "end", name: () => "block" };
  }
  return /^(?:stateDiagram|classDiagram|er$)/.test(type) ? BRACES : undefined;
}

/**
 * The blocks open at the end of the lines before the line, as the numbers of the lines that opened
 * them, and whether a line before it closed a block that none opened.
 */
function openBlocks(normalized: string, blocks: Blocks, before: number): number[] | undefined {
  const open: number[] = [];
  const lines = normalized.split("\n");
  const first = normalized.slice(0, frontMatterEnd(normalized)).split("\n").length - 1;
  for (let i = first; i < Math.min(before, lines.length + 1) - 1; i++) {
    const line = (lines[i] as string).replace(/%%.*$/, "");
    if (blocks.open.test(line)) open.push(i + 1);
    else if (blocks.close.test(line) && open.pop() === undefined) return undefined;
  }
  return open;
}

/** A block that the diagram leaves open, which the parser stops at the end of the diagram for. */
const unclosedBlock: Rule = ({ type, normalized, atEnd }) => {
  const blocks = blocksOf(type);
  if (!atEnd || !blocks) return undefined;
  const lineCount = normalized.split("\n").length;
  const line = openBlocks(normalized, blocks, lineCount + 1)?.at(-1);
  if (line === undefined) return undefined;
  const opening = blocks.open.exec(normalized.split("\n")[line - 1] as string);
  return opening
    ? `The ${blocks.name(opening)} on line ${line} is not closed: add a line "${blocks.closer}" after its contents.`
    : undefined;
};

/** What a line that continues a sequence diagram block goes in. */
const CONTINUES: Record<string, string> = { else: "alt", and: "par", option: "critical" };

/** A line that closes or continues a block outside of any. */
const strayEnd: Rule = ({ type, normalized, line, lineNumber, after }) => {
  const blocks = blocksOf(type);
  if (!blocks || after.trim() !== line.trim()) return undefined;
  const word = /^(else|and|option)\b/.exec(after)?.[1];
  const block = word && CONTINUES[word];
  if (block) {
    return type === "sequence"
      ? `"${word}" goes inside ${/^[aeiou]/.test(block) ? "an" : "a"} "${block}" block, between "${block}" and "end".`
      : undefined;
  }
  if (!blocks.close.test(line) || openBlocks(normalized, blocks, lineNumber)?.length !== 0) {
    return undefined;
  }
  if (blocks === BRACES) return 'This "}" closes no "{": remove it.';
  return FLOWCHART.test(type)
    ? 'This "end" closes no subgraph: remove it.'
    : `This "end" closes no block: remove it, or open the block before it${type === "sequence" ? ", with alt, opt, loop, par, critical, break, rect or box" : ""}.`;
};

const DIRECTIONS = ["TB", "TD", "BT", "RL", "LR"];

/** A flowchart direction in lower case, or a word that is none. */
const flowchartDirection: Rule = ({ type, normalized, lineNumber }) => {
  if (!FLOWCHART.test(type)) return undefined;
  const lines = normalized.split("\n");
  const header = /^\s*(flowchart|graph)\s+(\S+)/.exec(lines[lineNumber - 1] as string);
  const direction = header?.[2]?.replace(/;$/, "");
  if (!header || !direction || DIRECTIONS.includes(direction)) return undefined;
  const fixed = DIRECTIONS.includes(direction.toUpperCase()) ? direction.toUpperCase() : "TD";
  return `The direction is TB, TD, BT, RL or LR, in capitals: "${header[1]} ${fixed}".`;
};

/** The words that flowcharts take as keywords wherever they are, such as "end" for a subgraph. */
const FLOWCHART_KEYWORDS =
  /^(end|subgraph|classDef|class|style|linkStyle|click|call|href|graph|flowchart)(?![\w-])/;

/** A keyword as a node id. */
const keywordId: Rule = ({ type, after, line }) => {
  const word = FLOWCHART.test(type) ? FLOWCHART_KEYWORDS.exec(after)?.[1] : undefined;
  if (!word || line.trim() === word) return undefined;
  return `"${word}" is a keyword, so it cannot be a node id: use another id, such as ${word}Node[${word}].`;
};

/** The shapes of flowchart nodes, by the brackets that open and close their labels. */
const SHAPES: [string, string[]][] = [
  ["(((", [")))"]],
  ["([", ["])"]],
  ["((", ["))"]],
  ["[[", ["]]"]],
  ["[(", [")]"]],
  ["[/", ["/]", "\\]"]],
  ["[\\", ["\\]", "/]"]],
  ["{{", ["}}"]],
  ["[", ["]"]],
  ["(", [")"]],
  ["{", ["}"]],
  [">", ["]"]],
];
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A node with its id and the bracket that opens its label. */
const NODE = new RegExp(
  `(?<![\\w.-])([A-Za-z0-9_](?:[\\w.-]*\\w)?)(${SHAPES.map(([open]) => literal(open)).join("|")})`,
  "g",
);
/** The opening bracket of each closing one. */
const OPENING: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
/** The characters that a label must be quoted for, besides quotes. */
const SPECIAL = /[()[\]{}|"]/;

/**
 * A label with brackets, parentheses, braces, pipes or quotes, which must be quoted, or any label of
 * a block diagram.
 */
const unquotedLabel: Rule = ({ type, line, column }) => {
  // Block diagrams take no label unquoted; mind maps take labels as flowcharts do.
  const block = type === "block";
  if (!FLOWCHART.test(type) && type !== "mindmap" && !block) return undefined;
  // The node whose label the parser stopped in: the last that starts before it, if no link
  // comes between.
  const node = Array.from(line.matchAll(NODE))
    .filter((match) => match.index + match[0].length <= column)
    .at(-1);
  if (node) {
    const [opened, id, open] = node as unknown as [string, string, string];
    const from = node.index + opened.length;
    if (!/<?--|==|-\.|~~~/.test(line.slice(from, column))) {
      const closers = SHAPES.find(([shape]) => shape === open)?.[1] ?? [];
      // The label ends with the closing bracket that balances the opening ones and those in it.
      const last = closers[0]?.at(-1) ?? "";
      let depth = 0;
      let end = from - open.length;
      for (; end < line.length; end++) {
        if (line[end] === OPENING[last]) depth++;
        else if (line[end] === last && --depth <= 0) break;
      }
      end -= (closers[0]?.length ?? 1) - 1;
      const close = closers.find((closer) => line.startsWith(closer, end));
      const label = close && end >= column ? line.slice(from, end) : undefined;
      if (label && (block || SPECIAL.test(label)) && !/^\s*".*"\s*$/.test(label)) {
        const quotes = label.includes('"') ? ", writing its quotes as #quot;" : "";
        return `Put the label in double quotes${quotes}: ${id}${open}"${label.replace(/"/g, "#quot;")}"${close}.`;
      }
    }
  }
  // An edge label between pipes.
  if (!FLOWCHART.test(type)) return undefined;
  const pipe = /(?:<?-->|<?---|-\.->|-\.-|<?==>|===|--[xo]|==[xo])\|([^|]*)$/.exec(
    line.slice(0, column),
  );
  const closing = pipe ? line.indexOf("|", column) : -1;
  if (pipe && closing >= 0) {
    const label = line.slice(pipe.index + pipe[0].length - (pipe[1] as string).length, closing);
    if (SPECIAL.test(label) && !/^\s*".*"\s*$/.test(label)) {
      const arrow = pipe[0].slice(0, -(pipe[1] as string).length - 1);
      return `Put the label in double quotes: ${arrow}|"${label.replace(/"/g, "#quot;")}"|.`;
    }
  }
  return undefined;
};

/** Something between an edge's label and the node it leads to, as in "-->|yes|> B". */
const afterEdgeLabel: Rule = ({ type, line, before, after }) => {
  if (!FLOWCHART.test(type) || !before.endsWith("|") || !after.startsWith(">")) return undefined;
  const fixed = `${before}${after.slice(1).trimStart() ? ` ${after.slice(1).trimStart()}` : ""}`;
  return line.includes("|") && /\|[^|]*\|$/.test(before)
    ? `Nothing goes between an edge's label and the node it leads to: ${fixed.trim()}.`
    : undefined;
};

/** A link written as an arrow of another language, such as -> or =>. */
const flowchartArrow: Rule = ({ type, before, after }) => {
  if (!FLOWCHART.test(type)) return undefined;
  const arrow = /^(->|=>)(?!>)/.exec(after)?.[1];
  if (!arrow || /[-=]$/.test(before)) return undefined;
  const fixed = `${before}${arrow === "->" ? "-->" : "==>"}${after.slice(arrow.length)}`;
  return `Write links as -->, ---, -.->, ==> or ~~~: ${fixed.trim()}.`;
};

/** Words of a node's name after its first, which the parser stops at: ids have no spaces. */
const spacedId: Rule = ({ type, normalized, before, after }) => {
  if (!FLOWCHART.test(type)) return undefined;
  const first = /(?:^|-->|---|==>|-\.->|&)\s*([A-Za-z0-9_][\w-]*)\s+$/.exec(before.trimStart());
  const more = /^\w[\w-]*(?:[^\S\n]+\w[\w-]*)*/.exec(after)?.[0];
  if (!first || !more) return undefined;
  const name = `${first[1]} ${more}`;
  const id = idOf(name);
  const subgraph = new RegExp(`^\\s*subgraph\\s+${literal(name)}\\s*$`, "m");
  return subgraph.test(normalized)
    ? `Give the subgraph an id to link to it: "subgraph ${id} [${name}]", and link to ${id}.`
    : `Ids have no spaces: write the node as ${id}["${name}"], and link to ${id}.`;
};

/** The words that start statements of sequence diagrams, which cannot name participants. */
const SEQUENCE_KEYWORDS =
  "alt|opt|loop|par|par_over|critical|break|rect|box|end|else|and|option|note|create|destroy|activate|deactivate";

/** A keyword that a message comes from or goes to, as a participant's name. */
const sequenceKeyword: Rule = ({ type, normalized }) => {
  if (type !== "sequence") return undefined;
  const message = new RegExp(
    `^[^\\S\\n]*(${SEQUENCE_KEYWORDS})[^\\S\\n]*(?:<<)?-|^[^\\S\\n]*\\S+?[^\\S\\n]*-[->x)]*[+-]?[^\\S\\n]*(${SEQUENCE_KEYWORDS})[^\\S\\n]*:`,
    "im",
  );
  const found = message.exec(normalized);
  const word = found?.[1] ?? found?.[2];
  if (!found || !word) return undefined;
  const line = normalized.slice(0, found.index).split("\n").length;
  return `"${word}" on line ${line} is a keyword, so it cannot be a participant's name: declare the participant as "participant P as ${word}" and use P.`;
};

/** A ";" in the text of a message or note, which ends the statement there. */
const sequenceSemicolon: Rule = ({ type, line }) => {
  const colon = line.indexOf(":");
  if (type !== "sequence" || colon < 0 || !line.includes(";", colon)) return undefined;
  const text = line.slice(colon + 1);
  const fixed = `${line.slice(0, colon + 1)}${text.replace(/&(\w+);|;/g, (_, name) => (name ? `#${name};` : "#59;"))}`;
  return /&\w+;/.test(text)
    ? `A ";" ends a statement: write entities as #name;, such as #amp; for &: ${fixed.trim()}.`
    : `A ";" ends a statement: write it as #59; in text: ${fixed.trim()}.`;
};

/** A note or message without the colon before its text. */
const sequenceColon: Rule = ({ type, line, expected }) => {
  if (type !== "sequence" || !expected?.includes("TXT") || line.includes(":")) return undefined;
  const note = /^\s*(note\s+(?:left of|right of|over)\s+[^\s:]+)\s+(\S.*)$/i.exec(line);
  if (note) return `Put a colon before the note's text: ${note[1]}: ${note[2]}.`;
  return `A message takes a colon before its text: ${line.trim()}: text.`;
};

/** An arrow of another language in a sequence diagram, such as => or <-. */
const sequenceArrow: Rule = ({ type, line, column }) => {
  if (type !== "sequence") return undefined;
  // The run of arrow characters that the parser stopped in or right before.
  let from = column;
  while (from > 0 && /[-=<>]/.test(line[from - 1] as string)) from--;
  let to = column;
  while (to < line.length && /[-=<>]/.test(line[to] as string)) to++;
  const arrow = line.slice(from, to);
  if (!/[=<]|-{3}/.test(arrow)) return undefined;
  const list = "Sequence arrows are ->>, -->>, ->, -->, -x, --x, -) and --)";
  const reverse = /^(\s*)(\S+?)\s*<-+\s*(\S+?)\s*:(.*)$/.exec(line);
  if (arrow.startsWith("<") && !arrow.startsWith("<<") && reverse) {
    return `${list}, from the sender: ${reverse[3]}->>${reverse[2]}:${reverse[4]}.`;
  }
  const fixed = `${line.slice(0, from)}${arrow.startsWith("--") ? "-->>" : "->>"}${line.slice(to)}`;
  return `${list}: ${fixed.trim()}.`;
};

/** Generic types in angle brackets, which class diagrams write with tildes. */
function withTildes(text: string): string {
  return text.replace(/(\w)<([^<>]*(?:<[^<>]*>[^<>]*)*)>/g, (_, name, inner: string) => {
    // Class names take no generics within generics.
    let flat = inner;
    while (/<[^<>]*>/.test(flat)) flat = flat.replace(/<[^<>]*>/g, "");
    return `${name}~${flat}~`;
  });
}

/** Generic types in angle brackets, where the parser stopped. */
const classGenerics: Rule = ({ type, line, column }) => {
  const generic = Array.from(line.matchAll(/\w<[^<>\n]*(?:<[^<>\n]*>[^<>\n]*)*>/g)).find(
    (match) => column >= match.index && column <= match.index + match[0].length,
  );
  if (type !== "classDiagram" || !generic) return undefined;
  const nested = /\w<[^<>]*</.test(line) ? "; class names cannot nest them" : "";
  return `Write generic types with tildes${nested}: ${withTildes(line)
    .replace(/\s*\{\s*$/, "")
    .trim()}.`;
};

/** A class relation: its classes, cardinalities and arrow. */
const CLASS_RELATION =
  /^(\s*)([\w.~]+)\s+(?:("?)([^\s"]+)\3\s+)?((?:<\||\*|o|<)?(?:--|\.\.)(?:\|>|\*|o|>)?)\s+(?:("?)([^\s"]+)\6\s+)?([\w.~]+)(.*)$/;

const classCardinality: Rule = ({ type, line }) => {
  const relation = type === "classDiagram" ? CLASS_RELATION.exec(line) : null;
  if (!relation) return undefined;
  const [, , from, quoted, left, arrow, quotedRight, right, to, rest] = relation;
  if ((!left || quoted) && (!right || quotedRight)) return undefined;
  const card = (value: string | undefined) => (value ? ` "${value}"` : "");
  return `Put cardinalities in double quotes: ${from}${card(left)} ${arrow}${card(right)} ${to}${rest}.`;
};

const classArrow: Rule = ({ type, line, expected, after }) => {
  if (type !== "classDiagram") return undefined;
  const arrow = /\s(->|=>|==>)\s/.exec(line);
  if (!arrow || !(expected?.includes("LINE") || after.startsWith("="))) return undefined;
  const fixed = line.replace(arrow[1] as string, "-->");
  return `Write relations as <|--, *--, o--, -->, --, ..>, ..|> or ..: ${fixed.trim()}.`;
};

const classNote: Rule = ({ type, line }) => {
  const note = type === "classDiagram" ? /^\s*(note\s+for\s+\S+)\s*:\s*(.*)$/.exec(line) : null;
  return note
    ? `Put the note's text in double quotes: ${note[1]} "${(note[2] as string).replace(/"/g, "#quot;")}".`
    : undefined;
};

const stateNoteOver: Rule = ({ type, line }) => {
  const note = type === "stateDiagram" ? /^\s*note\s+over\s+(.*)$/i.exec(line) : null;
  return note ? `A note goes left of or right of a state: note right of ${note[1]}.` : undefined;
};

const stateArrow: Rule = ({ type, before, after }) => {
  if (type !== "stateDiagram" || !/^(->|=>)(?!>)/.test(after) || /[-=]$/.test(before)) {
    return undefined;
  }
  return `Write transitions as -->: ${`${before}-->${after.slice(2)}`.trim()}.`;
};

const stateDash: Rule = ({ type, before, after }) => {
  const head = type === "stateDiagram" ? /(\w+)$/.exec(before)?.[1] : undefined;
  const tail = /^(?:-\w+)+/.exec(after)?.[0];
  if (!head || !tail) return undefined;
  const name = `${head}${tail}`;
  return `State ids have no "-": use ${idOf(name)}, and show the name with state "${name}" as ${idOf(name)}.`;
};

/** An attribute written name: type. */
const erAttribute: Rule = ({ type, line, after }) => {
  const attribute = /^\s*([\w-]+)\s*:\s*(\S+)(.*)$/.exec(line);
  if (type !== "er" || !after.startsWith(":") || !attribute) return undefined;
  return `Write an attribute as its type, then its name: ${attribute[2]} ${attribute[1]}${attribute[3]}.`;
};

/** Keys of an attribute without commas between them, or a comment in single quotes. */
const erKeys: Rule = ({ type, line, after }) => {
  if (type !== "er") return undefined;
  const keys = /\b(PK|FK|UK)\s+(?=(?:PK|FK|UK)\b)/g;
  if (/^(PK|FK|UK)\b/.test(after) && keys.test(line)) {
    return `Separate an attribute's keys with commas: ${line.replace(keys, "$1, ").trim()}.`;
  }
  return after.startsWith("'")
    ? `Write an attribute's comment in double quotes: ${line.replace(/'([^']*)'/, '"$1"').trim()}.`
    : undefined;
};

/** The cardinalities that ER diagrams write on the left and on the right of a relationship. */
const LEFT_CARDINALITY: Record<string, string> = {
  "1": "||",
  "0..1": "|o",
  "1..*": "}|",
  "*": "}o",
  "0..*": "}o",
  n: "}o",
};
const RIGHT_CARDINALITY: Record<string, string> = {
  "1": "||",
  "0..1": "o|",
  "1..*": "|{",
  "*": "o{",
  "0..*": "o{",
  n: "o{",
};
const ER_LEFT = new Set(["||", "|o", "}|", "}o"]);
const ER_RIGHT = new Set(["||", "o|", "|{", "o{"]);

/** A relationship of an ER diagram: its entities, cardinalities and label. */
const ER_RELATIONSHIP = /^\s*("[^"]*"|[\w-]+)\s+(\S+?)(--|\.\.)(\S+)\s+("[^"]*"|[\w-]+)(\s*:.*)?$/;

const erCardinality: Rule = ({ type, line, expected }) => {
  const relation = ER_RELATIONSHIP.exec(line);
  if (type !== "er" || !expected?.includes("ZERO_OR_MORE") || !relation) return undefined;
  const [, from, left = "", line_, right = "", to, label] = relation;
  const l = ER_LEFT.has(left) ? left : LEFT_CARDINALITY[left];
  const r = ER_RIGHT.has(right) ? right : RIGHT_CARDINALITY[right];
  const example = `${from} ${l ?? "||"}${line_}${r ?? "o{"} ${to}${label ?? " : has"}`;
  return `Write cardinalities as ||, |o, }| or }o left of -- or .., and ||, o|, |{ or o{ right of it: ${example.trim()}.`;
};

/** A relationship without a label, or with one that has characters that need quotes. */
const erLabel: Rule = ({ type, line, column, expected }) => {
  if (type !== "er" || !/--|\.\./.test(line)) return undefined;
  const colon = line.indexOf(":");
  if (colon < 0) {
    return expected?.includes("COLON")
      ? `A relationship takes a label after a colon, "" for none: ${line.trim()} : "".`
      : undefined;
  }
  const label = line.slice(colon + 1).trim();
  if (column <= colon || label.startsWith('"')) return undefined;
  return `Put the label in double quotes: ${line.slice(0, colon).trim()} : "${label.replace(/"/g, "#quot;")}".`;
};

/** Entity labels in a relationship, which they are declared apart from. */
const erAlias: Rule = ({ type, line }) => {
  const aliases = type === "er" ? Array.from(line.matchAll(/([\w-]+)\["[^"]*"\]/g)) : [];
  if (aliases.length === 0 || !/--|\.\./.test(line)) return undefined;
  const declared = joinWords(
    aliases.map(([alias]) => alias),
    "and",
  );
  return `Declare an entity's label on a line of its own, as ${declared}, and use its id in relationships: ${line.replace(/\["[^"]*"\]/g, "").trim()}.`;
};

/** A pie slice whose label is not quoted, or whose value is not a number alone. */
const pieSlice: Rule = ({ type, line, after }) => {
  if (type !== "pie") return undefined;
  const title = /^(\s*(?:pie\s+)?title)\s*:\s*(.*)$/.exec(line);
  if (title) return `Write the title without a colon: ${title[1]?.trim()} ${title[2]}.`;
  const slice = /^\s*("?)([^":]+?)\1\s*:\s*([-+]?[\d.]+)\s*(%?)\s*$/.exec(line);
  if (!slice) return undefined;
  const fixed = `"${slice[2]}" : ${slice[3]}`;
  if (after.startsWith("%")) return `Give the value as a number alone: ${fixed}.`;
  return slice[1] ? undefined : `Put the label in double quotes: ${fixed}.`;
};

/** An architecture edge without the sides that it joins, with sides in lower case, or a label. */
const architectureEdge: Rule = ({ type, line, after, expected }) => {
  if (type !== "architecture") return undefined;
  const sides = "Architecture edges join sides of services, L, R, T or B";
  const bare = /^\s*([\w-]+)\s*(<?--?>?)\s*([\w-]+)\s*$/.exec(line);
  if (bare && expected?.includes(":")) return `${sides}: ${bare[1]}:R ${bare[2]} L:${bare[3]}.`;
  if (expected?.includes("ARROW_DIRECTION")) {
    const fixed = line.replace(/:([lrtb])\b|\b([lrtb]):/g, (side) => side.toUpperCase());
    return `${sides}, in capitals: ${fixed.trim()}.`;
  }
  const labeled = /^\s*(\S+:[LRTB])\s*(<?)--?(>?)\s*([LRTB]:\S+)\s*:\s*"?([^"]*?)"?\s*$/.exec(line);
  if (labeled && after.startsWith(":")) {
    const [, from, start, end, to, label] = labeled;
    return `Put an edge's label in the edge: ${from} ${start}-[${label}]-${end} ${to}.`;
  }
  const group = /^\s*group\s+([\w-]+)/.exec(line);
  if (group && after.startsWith("{")) {
    return `A group takes no braces: end the lines of the services in it with "in ${group[1]}", as in service db(database)[Database] in ${group[1]}.`;
  }
  return undefined;
};

/** Subgraphs and "columns: 3" in block diagrams. */
const blockSyntax: Rule = ({ type, normalized, line }) => {
  if (type !== "block") return undefined;
  const subgraph = /^[^\S\n]*subgraph\s+([\w-]+)/m.exec(normalized);
  if (subgraph) {
    const lineNumber = normalized.slice(0, subgraph.index).split("\n").length;
    return `Block diagrams group blocks with "block:${subgraph[1]}" and "end", not with the subgraph on line ${lineNumber}.`;
  }
  const columns = /^\s*columns\s*:\s*(\S+)/.exec(line);
  return columns ? `Write "columns ${columns[1]}", without a colon.` : undefined;
};

/**
 * A quoted field that starts an indented line of a sankey diagram, which its parser fails on, or
 * a header row of such fields.
 */
const sankeyQuote: Rule = ({ type, line, before, after }) => {
  if (type !== "sankey" || !after.startsWith('"') || before.trim()) return undefined;
  // A flow's value is a number: a word there is the name of a column.
  return /,\s*"?\s*[A-Za-z][^,]*$/.test(line)
    ? "A sankey diagram has no header row: remove this line, and start with the first flow."
    : `Leave out the indentation of a line that starts with a quoted field: ${line.trim()}`;
};

/** Git commands rather than those of a git graph. */
const gitCommand: Rule = ({ type, line, after, column, expected }) => {
  if (type !== "gitGraph") return undefined;
  const checkout = /^\s*(?:checkout|switch)\s+-[bc]\s+(\S+)/.exec(line);
  if (checkout) {
    return `Create a branch with "branch ${checkout[1]}", which also checks it out.`;
  }
  const git = /^\s*git\s+(\w.*)$/.exec(line);
  if (git) return `Leave out "git": ${git[1]}.`;
  if (/^--?[a-z]/.test(after)) {
    return `Leave out git's options: ${line.replace(/\s+--?[a-z][\w-]*(?:[= ]\S+)?/g, "").trim()}.`;
  }
  const word = /^[\w.-]+/.exec(after)?.[0];
  if (word && expected?.includes("STRING")) {
    return `Put it in double quotes: ${`${line.slice(0, column)}"${word}"${line.slice(column + word.length)}`.trim()}.`;
  }
  return undefined;
};

const RULES: Rule[] = [
  comments,
  blockSyntax,
  unclosedBlock,
  strayEnd,
  flowchartDirection,
  keywordId,
  unquotedLabel,
  afterEdgeLabel,
  flowchartArrow,
  spacedId,
  sequenceKeyword,
  sequenceSemicolon,
  sequenceColon,
  sequenceArrow,
  classGenerics,
  classCardinality,
  classArrow,
  classNote,
  stateNoteOver,
  stateArrow,
  stateDash,
  erAttribute,
  erKeys,
  erCardinality,
  erAlias,
  erLabel,
  pieSlice,
  architectureEdge,
  sankeyQuote,
  gitCommand,
];
