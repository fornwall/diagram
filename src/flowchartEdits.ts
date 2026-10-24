import { frontMatterEnd } from "./mermaidSyntax";

export type StructureEdit =
  | { operation: "rename"; id: string; label: string }
  | { operation: "insert"; edgeIndex: number; id: string; label: string }
  | {
      operation: "reconnect";
      edgeIndex: number;
      source?: string | undefined;
      target?: string | undefined;
    }
  | { operation: "move"; id: string; group: string }
  | { operation: "addNode"; id: string; label: string; group?: string | undefined }
  | { operation: "addEdge"; source: string; target: string; label?: string | undefined }
  | { operation: "removeNode"; id: string }
  | { operation: "removeEdge"; edgeIndex: number };

interface Statement {
  start: number;
  end: number;
  text: string;
  indent: string;
}

interface NodeReference {
  id: string;
  start: number;
  end: number;
  idEnd: number;
  labelStart?: number;
  labelEnd?: number;
  groups: string[];
  statement: Statement;
  standalone: boolean;
}

export interface FlowchartEdge {
  source: string;
  target: string;
  label: string;
  direction: "forward" | "both" | "undirected";
  explicitId?: string | undefined;
}

interface Edge extends FlowchartEdge {
  from: NodeReference;
  to: NodeReference;
  statement: Statement;
  arrow: string;
}

interface Group {
  id: string;
  path: string[];
  closing?: Statement;
}

interface Model {
  references: NodeReference[];
  edges: Edge[];
  groups: Map<string, Group>;
  linkStyles: { start: number; end: number; indices: number[]; statement: Statement }[];
  statements: Statement[];
}

const ID = /^[A-Za-z_][A-Za-z0-9_]*/;
const OPENINGS: [string, string[]][] = [
  ["[[", ["]]"]],
  ["[(", [")]"]],
  ["((", ["))"]],
  ["([", ["])"]],
  ["{{", ["}}"]],
  ["[/", ["/]", "\\]"]],
  ["[\\", ["\\]", "/]"]],
  ["[", ["]"]],
  ["(", [")"]],
  ["{", ["}"]],
];

const unsupported = (reason: string): never => {
  throw new Error(`${reason} Use diagram_edit for this source syntax.`);
};

/** A conservative source model: every structural statement must be understood before editing. */
function parseFlowchart(source: string): Model {
  const statements = sourceStatements(source);
  const header = statements.shift();
  if (!header || !/^(?:flowchart|graph)\s+(?:TD|TB|BT|LR|RL)$/.test(header.text)) {
    return unsupported(
      "Structural edits support flowcharts with an explicit direction, such as flowchart LR.",
    );
  }
  const model: Model = { references: [], edges: [], groups: new Map(), linkStyles: [], statements };
  const stack: Group[] = [];
  for (const statement of statements) {
    const { text, start } = statement;
    if (/^subgraph\b/.test(text)) {
      const match = /^subgraph\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*\[.*\]|\s+[^[\]]+)?$/s.exec(text);
      const id = match?.[1];
      if (!id || model.groups.has(id)) return unsupported("Subgraphs need unique explicit ids.");
      const group = { id, path: [...stack.map((entry) => entry.id), id] };
      model.groups.set(id, group);
      stack.push(group);
      continue;
    }
    if (text === "end") {
      const group = stack.pop();
      if (!group) return unsupported("An end statement has no subgraph.");
      group.closing = statement;
      continue;
    }
    if (/^(?:style|classDef|class|direction|click|accTitle|accDescr)\b/.test(text)) continue;
    if (/^linkStyle\b/.test(text)) {
      const match = /^linkStyle\s+(default|\d+(?:\s*,\s*\d+)*)\s+/.exec(text);
      if (!match) return unsupported("A linkStyle statement is not understood.");
      const indices = match[1] as string;
      if (indices !== "default") {
        const offset = start + text.indexOf(indices);
        model.linkStyles.push({
          start: offset,
          end: offset + indices.length,
          indices: indices.split(",").map(Number),
          statement,
        });
      }
      continue;
    }
    const groups = stack.map((group) => group.id);
    const from = readReference(source, start, statement, groups);
    let position = skipSpaces(source, from.end, statement.end);
    if (position === statement.end) {
      from.standalone = true;
      model.references.push(from);
      continue;
    }
    const explicit = /^([A-Za-z_][A-Za-z0-9_]*)@/.exec(source.slice(position, statement.end));
    if (explicit) position += explicit[0].length;
    const arrow = /^(?:<-\.->|<-->|<==>|-\.->|-\.-|-->|==>|---|===)/.exec(
      source.slice(position, statement.end),
    )?.[0];
    if (!arrow)
      return unsupported(
        `The edge on line ${lineNumber(source, start)} is not a supported simple link.`,
      );
    position = skipSpaces(source, position + arrow.length, statement.end);
    let label = "";
    if (source[position] === "|") {
      const close = source.indexOf("|", position + 1);
      if (close < 0 || close >= statement.end) return unsupported("An edge label is not closed.");
      label = source.slice(position + 1, close).replace(/^"(.*)"$/s, "$1");
      position = skipSpaces(source, close + 1, statement.end);
    }
    const to = readReference(source, position, statement, groups);
    if (skipSpaces(source, to.end, statement.end) !== statement.end) {
      return unsupported(
        `Line ${lineNumber(source, start)} has chained, grouped or unsupported edge syntax.`,
      );
    }
    model.references.push(from, to);
    model.edges.push({
      source: from.id,
      target: to.id,
      label,
      direction: arrow.startsWith("<") ? "both" : arrow.endsWith(">") ? "forward" : "undirected",
      explicitId: explicit?.[1],
      from,
      to,
      statement,
      arrow,
    });
  }
  if (stack.length > 0) return unsupported("A subgraph is not closed.");
  return model;
}

/** Structured edges for comparing supported flowchart sources. */
export function flowchartStructure(source: string): {
  nodes: string[];
  edges: FlowchartEdge[];
  groups: string[];
} {
  const model = parseFlowchart(source);
  return {
    nodes: [...new Set(model.references.map(({ id }) => id))],
    edges: model.edges.map(({ source, target, label, direction, explicitId }) => ({
      source,
      target,
      label,
      direction,
      ...(explicitId && { explicitId }),
    })),
    groups: [...model.groups.keys()],
  };
}

/** Applies one operation while keeping every unrelated source slice verbatim. */
export function editFlowchart(source: string, edit: StructureEdit): string {
  const model = parseFlowchart(source);
  const patches: { start: number; end: number; text: string }[] = [];
  const newline = /\r\n|\r|\n/.exec(source)?.[0] ?? "\n";
  const references = (id: string) => {
    validateId(id);
    if (model.groups.has(id)) throw new Error(`${JSON.stringify(id)} is a subgraph, not a node.`);
    const found = model.references.filter((reference) => reference.id === id);
    if (found.length === 0) throw new Error(`Unknown node id ${JSON.stringify(id)}.`);
    return found;
  };
  const append = (text: string, groupId?: string) => {
    if (groupId !== undefined) {
      const group = model.groups.get(groupId);
      if (!group?.closing) throw new Error(`Unknown subgraph id ${JSON.stringify(groupId)}.`);
      patches.push({
        start: group.closing.start,
        end: group.closing.start,
        text: `  ${text}${newline}${group.closing.indent}`,
      });
    } else {
      patches.push({
        start: source.length,
        end: source.length,
        text: `${source.endsWith("\n") || source.endsWith("\r") ? "" : newline}  ${text}`,
      });
    }
  };
  if (edit.operation === "addNode") {
    validateId(edit.id);
    if (model.references.some(({ id }) => id === edit.id) || model.groups.has(edit.id))
      throw new Error(`The id ${JSON.stringify(edit.id)} already exists.`);
    append(`${edit.id}[${quotedLabel(edit.label)}]`, edit.group);
  } else if (edit.operation === "addEdge") {
    references(edit.source);
    references(edit.target);
    append(
      `${edit.source} -->${edit.label === undefined ? "" : `|${quotedLabel(edit.label).replace(/\|/g, "#124;")}|`} ${edit.target}`,
    );
  } else if (edit.operation === "removeNode" || edit.operation === "removeEdge") {
    if (edit.operation === "removeNode") references(edit.id);
    else if (!Number.isSafeInteger(edit.edgeIndex) || !model.edges[edit.edgeIndex])
      throw new Error("The selected edge is not found in the supported source structure.");
    const removed = new Set(
      model.edges.flatMap((edge, index) =>
        (
          edit.operation === "removeNode"
            ? edge.source === edit.id || edge.target === edit.id
            : index === edit.edgeIndex
        )
          ? [index]
          : [],
      ),
    );
    const removedIds = new Set<string>(edit.operation === "removeNode" ? [edit.id] : []);
    for (const index of removed) {
      const edge = model.edges[index] as Edge;
      if (edge.explicitId) removedIds.add(edge.explicitId);
      const kept = [edge.from, edge.to].filter(
        (reference) => edit.operation !== "removeNode" || reference.id !== edit.id,
      );
      patches.push({
        start: edge.statement.start,
        end: edge.statement.end,
        text: kept
          .map((reference) => source.slice(reference.start, reference.end))
          .join(`${newline}${edge.statement.indent}`),
      });
    }
    if (edit.operation === "removeNode") {
      for (const reference of model.references.filter(
        (reference) => reference.standalone && reference.id === edit.id,
      ))
        patches.push({ start: reference.start, end: reference.end, text: "" });
    }
    for (const style of model.linkStyles) {
      const indices = style.indices
        .filter((index) => !removed.has(index))
        .map((index) => index - [...removed].filter((deleted) => deleted < index).length);
      patches.push(
        indices.length
          ? { start: style.start, end: style.end, text: indices.join(",") }
          : { start: style.statement.start, end: style.statement.end, text: "" },
      );
    }
    for (const statement of model.statements) {
      const match = /^(style|click|class)\s+([^\s]+)(\s+.*)$/s.exec(statement.text);
      if (!match) continue;
      const ids = (match[2] as string).split(",");
      if (!ids.some((id) => removedIds.has(id))) continue;
      const kept = ids.filter((id) => !removedIds.has(id));
      patches.push({
        start: statement.start,
        end: statement.end,
        text: kept.length ? `${match[1]} ${kept.join(",")}${match[3]}` : "",
      });
    }
  } else if (edit.operation === "rename") {
    const found = references(edit.id);
    const label = quotedLabel(edit.label);
    const definitions = found.filter((reference) => reference.labelStart !== undefined);
    if (definitions.length > 0) {
      for (const reference of definitions)
        patches.push({
          start: reference.labelStart as number,
          end: reference.labelEnd as number,
          text: label,
        });
    } else {
      const reference = found[0] as NodeReference;
      patches.push({ start: reference.idEnd, end: reference.idEnd, text: `[${label}]` });
    }
  } else if (edit.operation === "move") {
    const found = references(edit.id);
    const group = model.groups.get(edit.group);
    if (!group?.closing) throw new Error(`Unknown subgraph id ${JSON.stringify(edit.group)}.`);
    const declarations = found.filter((reference) => reference.standalone);
    const declaration = declarations[0];
    if (
      declarations.length !== 1 ||
      !declaration ||
      found.some((reference) => reference !== declaration && reference.labelStart !== undefined)
    ) {
      return unsupported(
        "Moving a node requires one standalone declaration and no inline declarations.",
      );
    }
    if (
      found.some(
        (reference) =>
          reference !== declaration && reference.groups.some((id) => !group.path.includes(id)),
      )
    ) {
      return unsupported(
        "Other subgraphs still reference this node, so moving its declaration would not reliably move its membership.",
      );
    }
    if (declaration.groups.at(-1) === group.id) return source;
    patches.push({ start: declaration.start, end: declaration.end, text: "" });
    patches.push({
      start: group.closing.start,
      end: group.closing.start,
      text: `  ${source.slice(declaration.start, declaration.end)}${newline}${group.closing.indent}`,
    });
  } else {
    const edge = model.edges[edit.edgeIndex];
    if (!Number.isSafeInteger(edit.edgeIndex) || edit.edgeIndex < 0 || !edge)
      throw new Error("The selected edge is not found in the supported source structure.");
    if (edit.operation === "insert") {
      validateId(edit.id);
      if (model.references.some(({ id }) => id === edit.id) || model.groups.has(edit.id))
        throw new Error(`The id ${JSON.stringify(edit.id)} already exists.`);
      const label = quotedLabel(edit.label);
      const prefix = source.slice(edge.statement.start, edge.to.start);
      const suffix = source.slice(edge.to.start, edge.statement.end);
      patches.push({
        start: edge.statement.start,
        end: edge.statement.end,
        text: `${prefix}${edit.id}[${label}]${newline}${edge.statement.indent}${edit.id} ${edge.arrow} ${suffix}`,
      });
      for (const style of model.linkStyles) {
        const indices = style.indices.flatMap((index) =>
          index < edit.edgeIndex
            ? [index]
            : index === edit.edgeIndex
              ? [index, index + 1]
              : [index + 1],
        );
        patches.push({ start: style.start, end: style.end, text: indices.join(",") });
      }
    } else {
      const keptDefinitions: string[] = [];
      for (const [id, reference] of [
        [edit.source, edge.from],
        [edit.target, edge.to],
      ] as const) {
        if (id === undefined || id === reference.id) continue;
        references(id);
        if (reference.labelStart !== undefined || reference.end > reference.idEnd)
          keptDefinitions.push(source.slice(reference.start, reference.end));
        patches.push({ start: reference.start, end: reference.end, text: id });
      }
      if (keptDefinitions.length > 0)
        patches.push({
          start: edge.statement.end,
          end: edge.statement.end,
          text: keptDefinitions
            .map((definition) => `${newline}${edge.statement.indent}${definition}`)
            .join(""),
        });
    }
  }
  let result = source;
  for (const patch of patches.sort((a, b) => b.start - a.start || b.end - a.end)) {
    result = result.slice(0, patch.start) + patch.text + result.slice(patch.end);
  }
  return result;
}

export function validateId(id: string): void {
  if (
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(id) ||
    /^(?:end|subgraph|flowchart|graph|style|class|classDef|linkStyle|direction|click)$/.test(id)
  ) {
    throw new Error(
      `Unsupported node id ${JSON.stringify(id)}. Use a letter or underscore followed by letters, digits or underscores.`,
    );
  }
}

function quotedLabel(label: string): string {
  if (
    typeof label !== "string" ||
    !label.trim() ||
    label.length > 1_000 ||
    [...label].some((character) => character.charCodeAt(0) < 32 && !"\t\r\n".includes(character))
  )
    throw new Error("Labels must contain 1–1,000 characters of text.");
  const escaped = label
    .replace(/[#&<>"`]/g, (character) => `#${character.charCodeAt(0)};`)
    .replace(/\r\n?|\n/g, "<br/>");
  return `"${escaped}"`;
}

function readReference(
  source: string,
  start: number,
  statement: Statement,
  groups: string[],
): NodeReference {
  const id = ID.exec(source.slice(start, statement.end))?.[0];
  if (!id)
    return unsupported(
      `The node on line ${lineNumber(source, start)} needs a supported explicit id.`,
    );
  validateId(id);
  const reference: NodeReference = {
    id,
    start,
    end: start + id.length,
    idEnd: start + id.length,
    statement,
    groups,
    standalone: false,
  };
  let position = skipSpaces(source, reference.end, statement.end);
  const shape = OPENINGS.find(([opening]) => source.startsWith(opening, position));
  if (shape) {
    const [opening, closings] = shape;
    const labelStart = position + opening.length;
    position = labelStart;
    let quoted = false;
    let closing: string | undefined;
    while (position < statement.end) {
      if (source[position] === '"') quoted = !quoted;
      if (!quoted) closing = closings.find((candidate) => source.startsWith(candidate, position));
      if (closing) break;
      position++;
    }
    if (!closing) return unsupported("A node label or shape is not closed.");
    reference.labelStart = labelStart;
    reference.labelEnd = position;
    reference.end = position + closing.length;
    position = skipSpaces(source, reference.end, statement.end);
  }
  if (source.startsWith(":::", position)) {
    const classes = /^:::[A-Za-z_][A-Za-z0-9_-]*(?:,[A-Za-z_][A-Za-z0-9_-]*)*/.exec(
      source.slice(position, statement.end),
    );
    if (!classes) return unsupported("A node's class suffix is not understood.");
    reference.end = position + classes[0].length;
  }
  return reference;
}

function skipSpaces(source: string, from: number, end: number): number {
  while (from < end && /\s/.test(source[from] as string)) from++;
  return from;
}

function lineNumber(source: string, offset: number): number {
  return source.slice(0, offset).split(/\r\n?|\n/).length;
}

/** Splits only outside labels and keeps offsets into the original CRLF or LF source. */
function sourceStatements(source: string): Statement[] {
  const statements: Statement[] = [];
  let start = frontMatterEnd(source);
  let position = start;
  let quoted = false;
  const brackets: string[] = [];
  const flush = (end: number) => {
    const text = source.slice(start, end).trim();
    if (!text) return;
    const offset = start + source.slice(start, end).indexOf(text);
    const lineStart =
      Math.max(source.lastIndexOf("\n", offset - 1), source.lastIndexOf("\r", offset - 1)) + 1;
    const indent = source.slice(lineStart, offset);
    statements.push({
      start: offset,
      end: offset + text.length,
      text,
      indent: /^[\t ]*$/.test(indent) ? indent : "  ",
    });
  };
  while (position < source.length) {
    const character = source[position] as string;
    if (!quoted && brackets.length === 0 && source.startsWith("%%", position)) {
      flush(position);
      if (source.startsWith("%%{", position)) {
        const end = source.indexOf("}%%", position + 3);
        if (end < 0) return unsupported("A Mermaid directive is not closed.");
        position = end + 3;
      } else {
        while (position < source.length && !/[\r\n]/.test(source[position] as string)) position++;
      }
      start = position;
      continue;
    }
    if (character === '"') quoted = !quoted;
    if (!quoted) {
      if ("[({".includes(character)) brackets.push(character);
      if ("])}".includes(character)) {
        const opening = brackets.pop();
        if (opening !== ({ "]": "[", ")": "(", "}": "{" } as Record<string, string>)[character])
          return unsupported("A source bracket is not balanced.");
      }
    }
    if (!quoted && brackets.length === 0 && /[;\r\n]/.test(character)) {
      flush(position);
      start = position + 1;
    }
    position++;
  }
  if (quoted || brackets.length > 0) return unsupported("A source label or bracket is not closed.");
  flush(source.length);
  return statements;
}
