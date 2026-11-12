// Item names for tools: ids, or for edges and messages "A --> B" or "A --> B: Yes", which a model
// knows from the source, unlike ids such as "edge:L_A_B_0".

import type { DiagramNode } from "./protocol";
import { quoteAll } from "./text";

// Documented arrows, those of labels and ER diagrams, and Mermaid's others. A leading mark, as the
// "o" of "o--o", follows a space.
const ARROWS = [
  /[→↔—]/y,
  /[|}][o|](?:--|\.\.)[o|][|{]/y,
  /(?:<<|<\|?|(?<=^|\s)[ox*])?(?:[-=.]+(?:>>|\|>|>|[xo)*])|[-=.]{2,})/y,
];
// Points from the second end, as "<|--".
const BACKWARD = /^<(?!.*(?:>|[)xo*])$)/;
// As in "A -- Yes --> B", "A -. Yes .-> B", "A == Yes ==> B" or "sim - satisfies -> req".
const LABELED_LINK =
  /^(.+?)\s*(?:--|==|-\.|-)\s+(.+?)\s+(?:[-=.]*[-=.](?:>|[xo])|[-=.]{2,})\s*(.+)$/s;
const STEREOTYPE = /^<<(.*)>>$/s;
const WORD = /[\p{L}\p{N}_]/u;
// A model may also put it before ends.
const KIND = /^(?:edge|message):/;
// As in "A -->|Yes| B".
const PIPED = /^\|([^|]*)\|(.*)$/s;

const pair = (source: string, target: string) => JSON.stringify([source, target]);

const comparable = (text: string) =>
  text
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .replace(STEREOTYPE, "$1")
    .toLowerCase();

interface DrawnItems {
  nodeIds: readonly string[];
  relationships: readonly DiagramNode[];
}

export interface Named {
  ids: string[];
  why?: string;
}

export type Resolved = Named & { name: string };

interface Ends {
  source: string;
  target: string;
  label?: string | undefined;
}

export class ItemNames {
  private readonly nodes: ReadonlySet<string>;
  private readonly ids: ReadonlySet<string>;
  private readonly relationships = new Map<string, DiagramNode>();
  private readonly pairs = new Map<string, DiagramNode[]>();
  private readonly texts = new Map<string, string>();
  // Cached, as relationships between the same nodes try the same names.
  private readonly tried = new Map<string, Named>();

  constructor(readonly drawn: DrawnItems) {
    this.nodes = new Set(drawn.nodeIds);
    this.ids = new Set([...drawn.nodeIds, ...drawn.relationships.map(({ id }) => id)]);
    const add = (source: string, target: string, node: DiagramNode) => {
      const key = pair(source, target);
      const between = this.pairs.get(key);
      if (between) between.push(node);
      else this.pairs.set(key, [node]);
    };
    for (const node of drawn.relationships) {
      const relation = node.relationship;
      if (!relation) continue;
      this.relationships.set(node.id, node);
      this.texts.set(node.id, comparable(labelText(node)));
      const { source, target, direction } = relation;
      add(source, target, node);
      // Bidirectional or undirected.
      if (direction !== "forward" && source !== target) add(target, source, node);
    }
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  // The item of the id, or else the relationships between the ends named, with the label if any.
  resolve(name: string): Named {
    if (this.ids.has(name)) return { ids: [name] };
    // An id may hold a dash or a colon: take the first reading that names any.
    const { readings, fallback } = this.readings(name.replace(KIND, ""));
    const between = readings.filter(
      ({ source, target }) => this.nodes.has(source) && this.nodes.has(target),
    );
    for (const ends of between) {
      const label = ends.label === undefined ? undefined : comparable(ends.label);
      const ids = this.between(ends.source, ends.target)
        .filter(({ id }) => label === undefined || this.texts.get(id) === label)
        .map(({ id }) => id);
      if (ids.length > 0) return { ids };
    }
    const odd = between.length === 0 ? this.withoutArrow(name.replace(KIND, "")) : undefined;
    if (odd) {
      const back = /^[<←⇐⟵]/.test(odd.between) && !/[>→⇒⟶]$/.test(odd.between);
      const [from, to] = back ? [odd.target, odd.source] : [odd.source, odd.target];
      const fixed = JSON.stringify(`${from} --> ${to}`);
      return {
        ids: [],
        why: odd.between
          ? `${JSON.stringify(odd.between)} is not an arrow: write ${fixed}`
          : `it has no arrow: write ${fixed}`,
      };
    }
    const ends = between[0] ?? fallback;
    if (!ends) return { ids: [] };
    const { source, target, label } = ends;
    const unknown = [...new Set([source, target])].filter((end) => !this.nodes.has(end));
    if (unknown.length > 0) {
      return {
        ids: [],
        why: `${quoteAll(unknown)} ${unknown.length === 1 ? "is not a node id" : "are not node ids"}`,
      };
    }
    const from = (a: string, b: string) => `from ${JSON.stringify(a)} to ${JSON.stringify(b)}`;
    return {
      ids: [],
      why:
        label !== undefined && this.between(source, target).length > 0
          ? `nothing labeled ${JSON.stringify(label)} goes ${from(source, target)}`
          : `nothing goes ${from(source, target)}` +
            (this.between(target, source).length > 0 ? `, only ${from(target, source)}` : ""),
    };
  }

  resolveAll(names: readonly string[]): Resolved[] {
    return names.map((name) => ({ name, ...this.resolve(name) }));
  }

  relationship(id: string): DiagramNode | undefined {
    return this.relationships.get(id);
  }

  // The shortest name of each item.
  names(): string[] {
    return [...this.drawn.nodeIds, ...this.drawn.relationships.map(({ id }) => this.name(id))];
  }

  name(id: string): string {
    return this.named(id)?.name ?? id;
  }

  // "A --> B" or "A --> B: Yes", if that names it alone.
  named(id: string): { name: string; labeled: boolean } | undefined {
    const node = this.relationships.get(id);
    const relation = node?.relationship;
    if (!node || !relation) return undefined;
    const only = (name: string) => {
      let named = this.tried.get(name);
      if (!named) {
        named = this.resolve(name);
        this.tried.set(name, named);
      }
      return named.ids.length === 1 && named.ids[0] === id;
    };
    const ends = `${relation.source} --> ${relation.target}`;
    if (only(ends)) return { name: ends, labeled: false };
    const label = labelText(node);
    const labeled = `${ends}: ${label}`;
    return label && only(labeled) ? { name: labeled, labeled: true } : undefined;
  }

  private between(source: string, target: string): readonly DiagramNode[] {
    return this.pairs.get(pair(source, target)) ?? [];
  }

  // Possible ends and labels, in order, and a fallback reading to explain a name that names
  // nothing.
  private readings(name: string): { readings: Ends[]; fallback: Ends | undefined } {
    const readings: Ends[] = [];
    const fallbacks: { ends: Ends; spaced: boolean }[] = [];
    const link = LABELED_LINK.exec(name);
    if (link) {
      const [, source = "", label = "", target = ""] = link;
      readings.push({ source: source.trim(), target: target.trim(), label: label.trim() });
    }
    const around = (index: number, length: number): Ends[] => {
      const source = name.slice(0, index).trim();
      const after = name.slice(index + length).trim();
      // A sequence message may activate or deactivate its target, as in "A->>+B".
      const rests = /^[+-]/.test(after) ? [after, after.slice(1).trim()] : [after];
      return rests
        .flatMap((rest): Ends[] => {
          const piped = PIPED.exec(rest);
          return piped
            ? [{ source, target: (piped[2] ?? "").trim(), label: piped[1]?.trim() || undefined }]
            : [
                { source, target: rest },
                ...Array.from(rest.matchAll(/:/g), ({ index }) => ({
                  source,
                  target: rest.slice(0, index).trim(),
                  label: rest.slice(index + 1).trim() || undefined,
                })),
              ];
        })
        .filter((ends) => ends.source && ends.target);
    };
    for (let index = 0; index < name.length; ) {
      const arrow = arrowAt(name, index);
      if (!arrow) {
        index++;
        continue;
      }
      // A leading circle or cross is an id where nothing is before it, as "o" of "o-->x".
      const marked = /^[ox*]/.test(arrow) && name.slice(0, index).trim() === "";
      const given = marked ? around(index + 1, arrow.length - 1) : around(index, arrow.length);
      const read = BACKWARD.test(arrow)
        ? given.map(({ source, target, label }) => ({ source: target, target: source, label }))
        : given;
      readings.push(...read);
      const ends = read[1] ?? read[0];
      const spaced =
        /\s/.test(name.charAt(index - 1)) && /\s/.test(name.charAt(index + arrow.length));
      if (ends) fallbacks.push({ ends, spaced });
      // A trailing circle or cross may start an id, as in "A --xray".
      if (/[xo]$/.test(arrow)) readings.push(...around(index, arrow.length - 1));
      index += arrow.length;
    }
    const fallback =
      fallbacks.find(({ ends }) => this.nodes.has(ends.source)) ??
      fallbacks.find(({ spaced }) => spaced) ??
      fallbacks[0];
    return { readings, fallback: fallback?.ends };
  }

  // Ends with an arrow the tools do not read between them.
  private withoutArrow(
    name: string,
  ): { source: string; target: string; between: string } | undefined {
    const text = name.trim();
    const ids = [...this.nodes].sort((a, b) => b.length - a.length);
    const source = ids.find(
      (id) => text.startsWith(id) && !WORD.test(text.charAt(id.length)) && text.length > id.length,
    );
    if (source === undefined) return undefined;
    // Up to a label after a colon.
    const ends = [text, ...Array.from(text.matchAll(/:/g), ({ index }) => text.slice(0, index))];
    for (const end of ends.map((each) => each.trimEnd())) {
      const target = ids.find(
        (id) =>
          end.endsWith(id) &&
          end.length - id.length >= source.length &&
          !WORD.test(end.charAt(end.length - id.length - 1)),
      );
      if (target !== undefined) {
        return {
          source,
          target,
          between: end.slice(source.length, end.length - target.length).trim(),
        };
      }
    }
    return undefined;
  }
}

// The longest.
function arrowAt(name: string, index: number): string | undefined {
  for (const arrow of ARROWS) {
    arrow.lastIndex = index;
    const found = arrow.exec(name)?.[0];
    if (found) return found;
  }
  return undefined;
}

// Given apart from its ends' labels, which may hold colons. A stereotype's is its name.
function labelText({ relationship }: DiagramNode): string {
  return (relationship?.text ?? "").replace(STEREOTYPE, "$1");
}

// As `"X", "A --> C" (nothing goes from "A" to "C")`.
export function resolvedList(resolved: readonly Resolved[]): string {
  return resolved
    .map(({ name, why }) => (why ? `${JSON.stringify(name)} (${why})` : JSON.stringify(name)))
    .join(", ");
}

// As `"A --> B" (ids: "edge:L_A_B_0" for "Parser → Checker: Yes", …)`.
export function severalList(several: readonly Resolved[], names: ItemNames): string {
  return several
    .map(({ name, ids }) => {
      const labeled = ids.map((id) => {
        const label = names.relationship(id)?.label;
        return label === undefined
          ? JSON.stringify(id)
          : `${JSON.stringify(id)} for ${JSON.stringify(label)}`;
      });
      return `${JSON.stringify(name)} (ids: ${labeled.join(", ")})`;
    })
    .join(", ");
}

// As `"Parser → Checker: validates" (id: "edge:L_A_B_0")`.
export function relationshipList(relationships: readonly DiagramNode[]): string {
  return relationships
    .map(({ label, id }) => `${JSON.stringify(label)} (id: ${JSON.stringify(id)})`)
    .join(", ");
}
