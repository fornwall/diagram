// The names that the tools taking item ids take for the items of a Mermaid drawing: their ids, and
// for an edge or sequence message also its ends' node ids with an arrow between, as in "A --> B",
// which a model knows from the source, unlike ids such as "edge:L_A_B_0" and "message:i3".

import type { DiagramNode } from "./protocol";
import { quoteAll } from "./text";

/**
 * An arrow between the ends of a relationship: "-->", "->" or "→" as documented, and the other
 * arrows of Mermaid sources and of relationship labels, such as "->>", "<-->", "---" and "↔".
 */
const ARROW = /<?[-=.]*[-=]>{1,2}|-{2,3}|[→↔—]/g;
/** A relationship id's prefix, which a model may also put before ends. */
const KIND = /^(?:edge|message):/;
/** A key for the relationships from the source to the target. */
const pair = (source: string, target: string) => JSON.stringify([source, target]);

/** The items of a drawing: its nodes, and its edges or sequence messages between them. */
export interface DrawnItems {
  nodeIds: readonly string[];
  relationships: readonly DiagramNode[];
}

/** What a name names: the ids of the items, and why it names none, if it names ends. */
export interface Named {
  ids: string[];
  why?: string;
}

/** A name that a model gave, and what it names. */
export type Resolved = Named & { name: string };

export class ItemNames {
  private readonly nodes: ReadonlySet<string>;
  private readonly ids: ReadonlySet<string>;
  private readonly relationships = new Map<string, DiagramNode>();
  /** The relationships from one node to another, by both, as keyed by {@link pair}. */
  private readonly pairs = new Map<string, DiagramNode[]>();

  constructor(readonly drawn: DrawnItems) {
    this.nodes = new Set(drawn.nodeIds);
    this.ids = new Set([...drawn.nodeIds, ...drawn.relationships.map(({ id }) => id)]);
    const add = (source: string, target: string, node: DiagramNode) => {
      const key = pair(source, target);
      this.pairs.set(key, [...(this.pairs.get(key) ?? []), node]);
    };
    for (const node of drawn.relationships) {
      const relation = node.relationship;
      if (!relation) continue;
      this.relationships.set(node.id, node);
      const { source, target, direction } = relation;
      add(source, target, node);
      // One both or no way goes between its ends either way.
      if (direction !== "forward" && source !== target) add(target, source, node);
    }
  }

  /** Whether an item has the id. */
  has(id: string): boolean {
    return this.ids.has(id);
  }

  /**
   * The item of the id, or else the edges or messages between the ends named, as in "A --> B":
   * those from A to B, and those without a single direction between A and B either way.
   */
  resolve(name: string): Named {
    if (this.ids.has(name)) return { ids: [name] };
    const ends = this.ends(name.replace(KIND, ""));
    if (!ends) return { ids: [] };
    const [source, target] = ends;
    const unknown = [...new Set(ends)].filter((end) => !this.nodes.has(end));
    if (unknown.length > 0) {
      return {
        ids: [],
        why: `${quoteAll(unknown)} ${unknown.length === 1 ? "is not a node id" : "are not node ids"}`,
      };
    }
    const between = this.between(source, target);
    if (between.length > 0) return { ids: between.map(({ id }) => id) };
    const from = (a: string, b: string) => `from ${JSON.stringify(a)} to ${JSON.stringify(b)}`;
    return {
      ids: [],
      why:
        `nothing goes ${from(source, target)}` +
        (this.between(target, source).length > 0 ? `, only ${from(target, source)}` : ""),
    };
  }

  /** What each of the names names. */
  resolveAll(names: readonly string[]): Resolved[] {
    return names.map((name) => ({ name, ...this.resolve(name) }));
  }

  /** The relationship of the id, if it is one. */
  relationship(id: string): DiagramNode | undefined {
    return this.relationships.get(id);
  }

  /**
   * The shortest name of each item, for a model to use: node ids, and relationships by their ends
   * unless others go between them too.
   */
  names(): string[] {
    return [...this.drawn.nodeIds, ...this.drawn.relationships.map(({ id }) => this.name(id))];
  }

  /**
   * The shortest name of the item of the id: a relationship's ends, as in "A --> B", unless that
   * names others too, and else its id.
   */
  name(id: string): string {
    const relation = this.relationships.get(id)?.relationship;
    if (!relation) return id;
    const name = `${relation.source} --> ${relation.target}`;
    const named = this.resolve(name).ids;
    return named.length === 1 && named[0] === id ? name : id;
  }

  /** The relationships from the source to the target, also those that go both or no way. */
  private between(source: string, target: string): readonly DiagramNode[] {
    return this.pairs.get(pair(source, target)) ?? [];
  }

  /**
   * The ends that the name gives on either side of an arrow: the first two that are nodes, as an id
   * may hold a dash, or else the first two.
   */
  private ends(name: string): [string, string] | undefined {
    let first: [string, string] | undefined;
    for (const arrow of name.matchAll(ARROW)) {
      const ends = [
        name.slice(0, arrow.index).trim(),
        name.slice(arrow.index + arrow[0].length).trim(),
      ] as [string, string];
      if (!ends[0] || !ends[1]) continue;
      if (ends.every((end) => this.nodes.has(end))) return ends;
      first ??= ends;
    }
    return first;
  }
}

/** E.g. `"X", "A --> C" (nothing goes from "A" to "C")`. */
export function resolvedList(resolved: readonly Resolved[]): string {
  return resolved
    .map(({ name, why }) => (why ? `${JSON.stringify(name)} (${why})` : JSON.stringify(name)))
    .join(", ");
}

/**
 * Names of ends with the relationships between them, by id and label, e.g.
 * `"A --> B" (ids: "edge:L_A_B_0" for "Parser → Checker: Yes", "edge:L_A_B_1" for …)`.
 */
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

/** E.g. `"Parser → Checker: validates" (id: "edge:L_A_B_0")`. */
export function relationshipList(relationships: readonly DiagramNode[]): string {
  return relationships
    .map(({ label, id }) => `${JSON.stringify(label)} (id: ${JSON.stringify(id)})`)
    .join(", ");
}
