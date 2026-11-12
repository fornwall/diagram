// Hints for syntax errors models commonly make, where Mermaid's message says little.

import { frontMatterEnd } from "../mermaidSyntax";
import { joinWords } from "../text";
import type { LabelRepair } from "./mermaidRecovery";

export interface Stop {
  type: string;
  // With normalized line breaks.
  normalized: string;
  // The span the parser did not expect.
  start: number;
  end: number;
  expected: readonly string[] | undefined;
}

interface At extends Stop {
  line: string;
  // From 1.
  lineNumber: number;
  // From 0.
  column: number;
  before: string;
  after: string;
  atEnd: boolean;
}

export function syntaxHint(stop: Stop, repair?: (edit: LabelRepair) => void): string | undefined {
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
    if (typeof hint === "string") return hint;
    if (hint) {
      if (hint.repair) repair?.(hint.repair);
      return hint.message;
    }
  }
  return undefined;
}

type Rule = (at: At) => string | { message: string; repair?: LabelRepair } | undefined;

const FLOWCHART = /^flowchart/;

// As Mermaid makes ids from names.
const idOf = (name: string) => name.trim().replace(/\W+/g, "_");

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

interface Blocks {
  // Names the block in the first group.
  open: RegExp;
  close: RegExp;
  closer: string;
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

// Opening line numbers of blocks still open before the line; undefined if one closes too many.
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

// The sequence block each continuation goes in.
const CONTINUES: Record<string, string> = { else: "alt", and: "par", option: "critical" };

// A line that closes or continues a block outside of any.
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

const flowchartDirection: Rule = ({ type, normalized, lineNumber }) => {
  if (!FLOWCHART.test(type)) return undefined;
  const lines = normalized.split("\n");
  const header = /^\s*(flowchart|graph)\s+(\S+)/.exec(lines[lineNumber - 1] as string);
  const direction = header?.[2]?.replace(/;$/, "");
  if (!header || !direction || DIRECTIONS.includes(direction)) return undefined;
  const fixed = DIRECTIONS.includes(direction.toUpperCase()) ? direction.toUpperCase() : "TD";
  return `The direction is TB, TD, BT, RL or LR, in capitals: "${header[1]} ${fixed}".`;
};

// Keywords wherever they are, such as "end".
const FLOWCHART_KEYWORDS =
  /^(end|subgraph|classDef|class|style|linkStyle|click|call|href|graph|flowchart)(?![\w-])/;

const keywordId: Rule = ({ type, after, line }) => {
  const word = FLOWCHART.test(type) ? FLOWCHART_KEYWORDS.exec(after)?.[1] : undefined;
  if (!word || line.trim() === word) return undefined;
  return `"${word}" is a keyword, so it cannot be a node id: use another id, such as ${word}Node[${word}].`;
};

// Opening bracket and closing alternatives.
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
// A node id and its opening bracket.
const NODE = new RegExp(
  `(?<![\\w.-])([A-Za-z0-9_](?:[\\w.-]*\\w)?)(${SHAPES.map(([open]) => RegExp.escape(open)).join("|")})`,
  "g",
);
const OPENING: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
// Characters that need a label quoted.
const SPECIAL = /[()[\]{}|"]/;

// Labels with special characters must be quoted, and block diagram labels always.
const unquotedLabel: Rule = ({ type, line, lineNumber, column }) => {
  // Mind maps take labels as flowcharts do.
  const block = type === "block";
  if (!FLOWCHART.test(type) && type !== "mindmap" && !block) return undefined;
  // The last node starting before the stop, if no link comes between.
  const node = Array.from(line.matchAll(NODE))
    .filter((match) => match.index + match[0].length <= column)
    .at(-1);
  if (node) {
    const [opened, id, open] = node as unknown as [string, string, string];
    const from = node.index + opened.length;
    const closers = SHAPES.find(([shape]) => shape === open)?.[1] ?? [];
    // The closing bracket that balances, outside quotes.
    const last = closers[0]?.at(-1) ?? "";
    let depth = 0;
    let quoted = false;
    let end = from - open.length;
    for (; end < line.length; end++) {
      if (line[end] === '"') quoted = !quoted;
      else if (quoted) continue;
      else if (line[end] === OPENING[last]) depth++;
      else if (line[end] === last && --depth <= 0) break;
    }
    const linked = /<?--|==|-\.|~~~/.test(line.slice(from, column));
    if (end >= line.length && column >= from) {
      const text = line
        .slice(from)
        .replace(/\s*(?:<?--|==|-\.|~~~).*$/, "")
        .trim();
      return `The label of ${id} is not closed: close it with "${closers[0]}" after its text, as in ${id}${open}"${text}"${closers[0]}.`;
    }
    end -= (closers[0]?.length ?? 1) - 1;
    const close = closers.find((closer) => line.startsWith(closer, end));
    const label = close && end >= column && !linked ? line.slice(from, end) : undefined;
    if (label && (block || SPECIAL.test(label)) && !/^\s*".*"\s*$/.test(label)) {
      const quotes = label.includes('"') ? ", writing its quotes as #quot;" : "";
      const text = `"${label.replace(/"/g, "#quot;")}"`;
      return {
        message: `Put the label in double quotes${quotes}: ${id}${open}${text}${close}.`,
        ...(FLOWCHART.test(type) ? { repair: { line: lineNumber, start: from, end, text } } : {}),
      };
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
      const text = `"${label.replace(/"/g, "#quot;")}"`;
      return {
        message: `Put the label in double quotes: ${arrow}|${text}|.`,
        repair: { line: lineNumber, start: closing - label.length, end: closing, text },
      };
    }
  }
  return undefined;
};

// As a sequence message's text: "A --> B: yes".
const colonLabel: Rule = ({ type, line, column }) => {
  const link = FLOWCHART.test(type)
    ? /^(\s*\S.*?)\s*(<?-->|---|-\.->|-\.-|==>|===)\s*([\w-]+):\s*(\S.*)$/.exec(line)
    : null;
  if (!link || column < line.length - (link[4] as string).length) return undefined;
  return `A link's label goes between pipes after the arrow: ${(link[1] as string).trim()} ${link[2]}|${link[4]}| ${link[3]}.`;
};

const danglingLink: Rule = ({ type, before, atEnd }) => {
  const link =
    FLOWCHART.test(type) && atEnd
      ? /([\w-]+)\s*(<?-->|---|-\.->|-\.-|==>|===|~~~)\s*(?:\|[^|]*\|)?\s*$/.exec(before)
      : null;
  return link
    ? `The link from ${link[1]} leads to no node: add the node it leads to after the ${link[2]}, or remove the link.`
    : undefined;
};

const directionColon: Rule = ({ type, line }) => {
  const direction = FLOWCHART.test(type) ? /^\s*direction\s*:\s*(\w+)/.exec(line) : null;
  return direction ? `Write "direction ${direction[1]}", without a colon.` : undefined;
};

// As in "-->|yes|> B".
const afterEdgeLabel: Rule = ({ type, line, before, after }) => {
  if (!FLOWCHART.test(type) || !before.endsWith("|") || !after.startsWith(">")) return undefined;
  const fixed = `${before}${after.slice(1).trimStart() ? ` ${after.slice(1).trimStart()}` : ""}`;
  return line.includes("|") && /\|[^|]*\|$/.test(before)
    ? `Nothing goes between an edge's label and the node it leads to: ${fixed.trim()}.`
    : undefined;
};

// Arrows of other languages, such as -> or =>.
const flowchartArrow: Rule = ({ type, before, after }) => {
  if (!FLOWCHART.test(type)) return undefined;
  const arrow = /^(->|=>)(?!>)/.exec(after)?.[1];
  if (!arrow || /[-=]$/.test(before)) return undefined;
  const fixed = `${before}${arrow === "->" ? "-->" : "==>"}${after.slice(arrow.length)}`;
  return `Write links as -->, ---, -.->, ==> or ~~~: ${fixed.trim()}.`;
};

// A node id with spaces.
const spacedId: Rule = ({ type, normalized, before, after }) => {
  if (!FLOWCHART.test(type)) return undefined;
  const first = /(?:^|-->|---|==>|-\.->|&)\s*([A-Za-z0-9_][\w-]*)\s+$/.exec(before.trimStart());
  const more = /^\w[\w-]*(?:[^\S\n]+\w[\w-]*)*/.exec(after)?.[0];
  if (!first || !more) return undefined;
  const name = `${first[1]} ${more}`;
  const id = idOf(name);
  const subgraph = new RegExp(`^\\s*subgraph\\s+${RegExp.escape(name)}\\s*$`, "m");
  return subgraph.test(normalized)
    ? `Give the subgraph an id to link to it: "subgraph ${id} [${name}]", and link to ${id}.`
    : `Ids have no spaces: write the node as ${id}["${name}"], and link to ${id}.`;
};

const SEQUENCE_KEYWORDS =
  "alt|opt|loop|par|par_over|critical|break|rect|box|end|else|and|option|note|create|destroy|activate|deactivate";

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

// A ";" in a message or note ends the statement.
const sequenceSemicolon: Rule = ({ type, line }) => {
  const colon = line.indexOf(":");
  if (type !== "sequence" || colon < 0 || !line.includes(";", colon)) return undefined;
  const text = line.slice(colon + 1);
  const fixed = `${line.slice(0, colon + 1)}${text.replace(/&(\w+);|;/g, (_, name) => (name ? `#${name};` : "#59;"))}`;
  return /&\w+;/.test(text)
    ? `A ";" ends a statement: write entities as #name;, such as #amp; for &: ${fixed.trim()}.`
    : `A ";" ends a statement: write it as #59; in text: ${fixed.trim()}.`;
};

const sequenceColon: Rule = ({ type, line, expected }) => {
  if (type !== "sequence" || !expected?.includes("TXT") || line.includes(":")) return undefined;
  const note = /^\s*(note\s+(?:left of|right of|over)\s+[^\s:]+)\s+(\S.*)$/i.exec(line);
  if (note) return `Put a colon before the note's text: ${note[1]}: ${note[2]}.`;
  return `A message takes a colon before its text: ${line.trim()}: text.`;
};

// As in "Note A: text".
const notePlace: Rule = ({ type, line }) => {
  const note =
    type === "sequence"
      ? /^\s*note\s+(?!over\b|left of\b|right of\b)([^\s:]+)\s*:\s*(.*)$/i.exec(line)
      : null;
  return note
    ? `A note goes over, left of or right of a participant: Note right of ${note[1]}: ${note[2]}.`
    : undefined;
};

// A box left open before the messages, which only participants can follow.
const openBox: Rule = ({ type, normalized, lineNumber, expected }) => {
  if (type !== "sequence" || !expected?.includes("participant")) return undefined;
  const open = openBlocks(normalized, blocksOf(type) as Blocks, lineNumber)?.at(-1);
  return open !== undefined && /^\s*box\b/.test(normalized.split("\n")[open - 1] as string)
    ? `The "box" on line ${open} is not closed: add a line "end" after its participants.`
    : undefined;
};

// Arrows of other languages, such as => or <-.
const sequenceArrow: Rule = ({ type, line, column }) => {
  if (type !== "sequence") return undefined;
  // The arrow characters at the stop.
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

function withTildes(text: string): string {
  return text.replace(/(\w)<([^<>]*(?:<[^<>]*>[^<>]*)*)>/g, (_, name, inner: string) => {
    // Class names take no generics within generics.
    let flat = inner;
    while (/<[^<>]*>/.test(flat)) flat = flat.replace(/<[^<>]*>/g, "");
    return `${name}~${flat}~`;
  });
}

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

// Written "name: type".
const erAttribute: Rule = ({ type, line, after }) => {
  const attribute = /^\s*([\w-]+)\s*:\s*(\S+)(.*)$/.exec(line);
  if (type !== "er" || !after.startsWith(":") || !attribute) return undefined;
  return `Write an attribute as its type, then its name: ${attribute[2]} ${attribute[1]}${attribute[3]}.`;
};

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

const ER_RELATIONSHIP = /^\s*("[^"]*"|[\w-]+)\s+(\S+?)(--|\.\.)(\S+)\s+("[^"]*"|[\w-]+)(\s*:.*)?$/;

const ER_BARE_RELATIONSHIP = /^\s*("[^"]*"|[\w-]+)\s+()(--|\.\.)()\s+("[^"]*"|[\w-]+)(\s*:.*)?$/;

const erCardinality: Rule = ({ type, line, expected, after }) => {
  if (type !== "er") return undefined;
  const relation =
    (expected?.includes("ZERO_OR_MORE") ? ER_RELATIONSHIP.exec(line) : null) ??
    (/^(?:--|\.\.)\s/.test(after) ? ER_BARE_RELATIONSHIP.exec(line) : null);
  if (!relation) return undefined;
  const [, from, left = "", line_, right = "", to, label] = relation;
  const l = ER_LEFT.has(left) ? left : LEFT_CARDINALITY[left];
  const r = ER_RIGHT.has(right) ? right : RIGHT_CARDINALITY[right];
  const example = `${from} ${l ?? "||"}${line_}${r ?? "o{"} ${to}${label ?? " : has"}`;
  return `Write cardinalities as ||, |o, }| or }o left of -- or .., and ||, o|, |{ or o{ right of it: ${example.trim()}.`;
};

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

const erAlias: Rule = ({ type, line }) => {
  const aliases = type === "er" ? Array.from(line.matchAll(/([\w-]+)\["[^"]*"\]/g)) : [];
  if (aliases.length === 0 || !/--|\.\./.test(line)) return undefined;
  const declared = joinWords(
    aliases.map(([alias]) => alias),
    "and",
  );
  return `Declare an entity's label on a line of its own, as ${declared}, and use its id in relationships: ${line.replace(/\["[^"]*"\]/g, "").trim()}.`;
};

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

// The sankey parser fails on indented lines starting with a quoted field, as in header rows.
const sankeyQuote: Rule = ({ type, line, before, after }) => {
  if (type !== "sankey" || !after.startsWith('"') || before.trim()) return undefined;
  // A word where the value goes names a column.
  return /,\s*"?\s*[A-Za-z][^,]*$/.test(line)
    ? "A sankey diagram has no header row: remove this line, and start with the first flow."
    : `Leave out the indentation of a line that starts with a quoted field: ${line.trim()}`;
};

const sankeyFlow: Rule = ({ type, line }) => {
  const flow =
    type === "sankey"
      ? /^\s*([^,:\n]+?)\s*(?:-+>|→|,)\s*([^,:\n]+?)\s*(?::|,)?\s*([-+]?[\d.]+)?\s*$/.exec(line)
      : null;
  if (!flow || line.split(",").length > 2) return undefined;
  return `A sankey diagram lists its flows as source,target,value: ${flow[1]},${flow[2]},${flow[3] ?? 10}.`;
};

const packetName: Rule = ({ type, line, after }) => {
  const field =
    type === "packet" ? /^\s*(\+?\d+(?:\s*-\s*\d+)?)\s*:\s*([^"\n]+?)\s*$/.exec(line) : null;
  return field && after.startsWith(field[2] as string)
    ? `Put the field's name in double quotes: ${field[1]}: "${field[2]}".`
    : undefined;
};

const treemapName: Rule = ({ type, line, expected }) => {
  const item =
    type === "treemap" && expected?.includes("STRING2")
      ? /^\s*([^":\n]+?)\s*(?::\s*(\S+))?\s*$/.exec(line)
      : null;
  return item
    ? `Put the name in double quotes: "${item[1]}"${item[2] ? `: ${item[2]}` : ""}.`
    : undefined;
};

const radarValues: Rule = ({ type, line, expected }) => {
  const curve =
    type === "radar" && expected?.includes("STRING")
      ? /^\s*curve\s+(\w+(?:\s*\[\s*"[^"]*"\s*\])?)\s*\[\s*([-\d.,\s]*\d)\s*\]\s*$/.exec(line)
      : null;
  return curve ? `A curve's values go in braces: curve ${curve[1]}{${curve[2]}}.` : undefined;
};

const quadrantPoint: Rule = ({ type, line }) => {
  const point = type === "quadrantChart" ? /^(\s*[^:\n]+:\s*)\[([^\]]*)\]/.exec(line) : null;
  if (!point) return undefined;
  const values = (point[2] as string).split(",").map((value) => value.trim());
  const range = "Point coordinates go from 0 to 1, across and up the chart";
  // Percentages, with or without the sign.
  const percent = (value: string) => value.endsWith("%") || Number(value) > 1;
  const valid = (value: string) =>
    percent(value)
      ? /^\d+%?$/.test(value) && Number.parseInt(value, 10) <= 100
      : /^[\d.]+$/.test(value);
  if (values.some(percent) && values.every(valid)) {
    const fixed = values.map((value) =>
      percent(value) ? String(Number.parseInt(value, 10) / 100) : value,
    );
    return `${range}: ${(point[1] as string).trim()} [${fixed.join(", ")}].`;
  }
  const beyond = values.find((value) => Number(value) < 0 || Number(value) > 1);
  return beyond === undefined ? undefined : `${range}, not to ${beyond}.`;
};

const usecaseRelation: Rule = ({ type, line }) => {
  if (type !== "usecase") return undefined;
  const arrow = /(?<![-<.ox])(->|=>|<-)(?![->])/.exec(line);
  if (arrow) {
    const fixed = line.replace(arrow[0], arrow[0] === "<-" ? "<--" : "-->");
    return `Write relationships as -->, <--, --, --o, --x, --|> or ..>: ${fixed.trim()}.`;
  }
  const parens = /\(\s*([^()]*?)\s*\)/.exec(line);
  if (!parens || /^\s*(?:actor|usecase)\b/.test(line)) return undefined;
  const name = /^[\w-]+$/.test(parens[1] as string) ? (parens[1] as string) : `"${parens[1]}"`;
  return `A use case goes by its name, without parentheses: ${line.replace(parens[0], name).trim()}.`;
};

const C4_STATEMENT =
  /^[^\S\n]*((?:Person|System|Container|Component|Enterprise_Boundary|System_Boundary|Container_Boundary|Boundary|Deployment_Node|Node|Rel|BiRel)\w*)\(([^\n]*)$/gm;

// The first C4 statement with an unquoted label, which Mermaid reads past the closing
// parenthesis and following lines, and the statement with its labels quoted.
export function c4UnquotedArguments(normalized: string): { at: number; fixed: string } | undefined {
  for (const { 1: keyword = "", 2: rest = "", index } of normalized.matchAll(C4_STATEMENT)) {
    const aliases = /^(?:Rel|BiRel)/.test(keyword) ? 2 : 1;
    const args = rest.replace(/\)\s*$/, "").split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    const quoted = (arg: string, i: number) => i < aliases || /^\s*(?:["$]|$)/.test(arg);
    if (args.every(quoted)) continue;
    const fixed = args.map((arg, i) => (quoted(arg, i) ? arg.trim() : `"${arg.trim()}"`));
    return { at: index, fixed: `${keyword}(${fixed.join(", ")})` };
  }
  return undefined;
}

const c4Quotes: Rule = ({ type, normalized }) => {
  const unquoted = type === "c4" ? c4UnquotedArguments(normalized) : undefined;
  return unquoted ? `Put the labels in double quotes: ${unquoted.fixed}.` : undefined;
};

const xyAxisRange: Rule = ({ type, line, expected }) => {
  const range =
    type === "xychart" && expected?.includes("ARROW_DELIMITER")
      ? /^(\s*[xy]-axis\b.*?[\d.])\s*(?:-+|to|\.\.+)\s*([\d.].*)$/.exec(line)
      : null;
  return range
    ? `Write the range of an axis with an arrow: ${(range[1] as string).trim()} --> ${range[2]}.`
    : undefined;
};

const gitCommand: Rule = ({ type, line, after, column, expected }) => {
  if (type !== "gitGraph") return undefined;
  const checkout = /^\s*(?:checkout|switch)\s+-[bc]\s+(\S+)/.exec(line);
  if (checkout) {
    return `Create a branch with "branch ${checkout[1]}", which also checks it out.`;
  }
  const git = /^\s*git\s+(\w.*)$/.exec(line);
  if (git) return `Leave out "git": ${git[1]}.`;
  const message = /^\s*commit\b.*?\b(message)\s*:/.exec(line);
  if (message && after.startsWith(message[1] as string)) {
    const fixed = line.replace(/\s*\bmessage\s*:/, " id:").replace(/\s+/g, " ");
    return `A commit shows its id, not a message: ${fixed.trim()}.`;
  }
  if (/^--?[a-z]/.test(after)) {
    return `Leave out git's options: ${line.replace(/\s+--?[a-z][\w-]*(?:[= ]\S+)?/g, "").trim()}.`;
  }
  const word = /^[\w.-]+/.exec(after)?.[0];
  if (word && expected?.includes("STRING")) {
    return `Put it in double quotes: ${`${line.slice(0, column)}"${word}"${line.slice(column + word.length)}`.trim()}.`;
  }
  return undefined;
};

const RISKS = ["low", "medium", "high"];
const VERIFY_METHODS = ["analysis", "inspection", "test", "demonstration"];

const requirementText: Rule = ({ type, line, column, expected }) => {
  const field = type === "requirement" ? /^(\s*(\w+)\s*:\s*)([^"\n].*?)\s*$/.exec(line) : null;
  if (!field || column < (field[1] as string).length) return undefined;
  const [, , key = "", value = ""] = field;
  const name = key.toLowerCase();
  const options = name === "risk" ? RISKS : name === "verifymethod" ? VERIFY_METHODS : undefined;
  if (options) {
    const words = value.toLowerCase().split(/\W+/);
    const given = options.find((option) => words.includes(option)) ?? options[0];
    return `The ${key} is ${joinWords(options, "or")}: ${key}: ${given}.`;
  }
  return /^(?:id|text|type|docref)$/.test(name) && expected?.includes("NEWLINE")
    ? `Put the ${key} in double quotes: ${key}: "${value}".`
    : undefined;
};

const radarLabel: Rule = ({ type, line, after, expected }) => {
  if (type !== "radar") return undefined;
  if (expected?.includes("STRING") && /\w\[[^"\]\n]+\]/.test(line)) {
    return `Put the labels in double quotes: ${line.replace(/(\w)\[([^"\]\n]+)\]/g, '$1["$2"]').trim()}.`;
  }
  return /^\s*curve\b/.test(line) && after.startsWith("-")
    ? 'A curve\'s values are not negative: give values from 0 up, and "min 0" for the scale.'
    : undefined;
};

const agentflowArrow: Rule = ({ type, line, column }) => {
  if (type !== "agentflow") return undefined;
  // The arrow characters at the stop.
  let from = column;
  while (from > 0 && /[-=.<>]/.test(line[from - 1] as string)) from--;
  let to = column;
  while (to < line.length && /[-=.<>]/.test(line[to] as string)) to++;
  const arrow = line.slice(from, to);
  if (!/^(?:=+>|-\.->|<-->)$/.test(arrow)) return undefined;
  const fixed = `${line.slice(0, from)}${arrow === "-.->" ? "-.-" : "-->"}${line.slice(to)}`;
  return `Agent flow edges are -->, --x and -.-: ${fixed.trim()}.`;
};

const eventModelName: Rule = ({ type, line, column, after }) => {
  const frame =
    type === "eventmodeling" && /^\w/.test(after)
      ? /^(\s*(?:tf|timeframe)\s+\S+\s+\w+\s+)(\w+(?:\s+\w+)+)(.*)$/.exec(line)
      : null;
  if (!frame) return undefined;
  const [, head = "", words = "", rest = ""] = frame;
  // A stop before the words is another mistake.
  if (column < head.length || column >= head.length + words.length) return undefined;
  return `Names are one word: ${`${head.trim()} ${words.replace(/\s+/g, "")}${rest}`.trim()}.`;
};

// Including names of earlier versions.
const CYNEFIN_DOMAINS: Record<string, string> = {
  complex: "complex",
  complicated: "complicated",
  clear: "clear",
  obvious: "clear",
  simple: "clear",
  chaotic: "chaotic",
  confusion: "confusion",
  disorder: "confusion",
};

const cynefinItem: Rule = ({ type, line, after }) => {
  if (type !== "cynefin" || after.trim() !== line.trim()) return undefined;
  const item = /^\s*([^"\s][^\n]*?)\s*$/.exec(line)?.[1];
  if (!item || /^title\b|-->/i.test(item)) return undefined;
  const domain = CYNEFIN_DOMAINS[item.toLowerCase()];
  return domain
    ? `The domains are complex, complicated, clear, chaotic and confusion, in lowercase: ${domain}.`
    : `Put the item in double quotes: "${item}".`;
};

// The parser stops at the next rule.
const railroadSemicolon: Rule = ({ type, normalized, lineNumber, expected }) => {
  if (!type.startsWith("railroad") || !expected?.includes(";")) return undefined;
  const lines = normalized.split("\n");
  for (let i = lineNumber - 2; i >= 0; i--) {
    const text = (lines[i] as string).trim();
    if (!text || /^\(\*|^#|^;/.test(text)) continue;
    return text.endsWith(";")
      ? undefined
      : `The rule on line ${i + 1} is not ended: add ";" after it.`;
  }
  return undefined;
};

const wardleyNumber: Rule = ({ type, line, expected }) => {
  if (type !== "wardley" || !expected?.includes("WARDLEY_NUMBER")) return undefined;
  const fixed = line.replace(/\[([^\]]*)\]/, (list) =>
    list.replace(/(?<![\d.])(\d+)(?![\d.])/g, "$1.0"),
  );
  return `Coordinates are decimals from 0 to 1, with a dot: ${fixed.trim()}.`;
};

const RULES: Rule[] = [
  comments,
  blockSyntax,
  unclosedBlock,
  strayEnd,
  flowchartDirection,
  keywordId,
  unquotedLabel,
  colonLabel,
  danglingLink,
  directionColon,
  afterEdgeLabel,
  flowchartArrow,
  spacedId,
  sequenceKeyword,
  sequenceSemicolon,
  notePlace,
  sequenceColon,
  sequenceArrow,
  openBox,
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
  sankeyFlow,
  packetName,
  treemapName,
  radarValues,
  quadrantPoint,
  usecaseRelation,
  c4Quotes,
  xyAxisRange,
  gitCommand,
  requirementText,
  radarLabel,
  agentflowArrow,
  eventModelName,
  cynefinItem,
  railroadSemicolon,
  wardleyNumber,
];
