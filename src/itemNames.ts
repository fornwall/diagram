// The names that the tools taking item ids take for the items of a Mermaid drawing: their ids, and
// for an edge or sequence message also its ends' node ids with an arrow between, as in "A --> B",
// and its label to tell it from others between them, as in "A --> B: Yes", which a model knows from
// the source, unlike ids such as "edge:L_A_B_0" and "message:i3".

import type { DiagramNode } from "./protocol";
import { quoteAll } from "./text";

/**
 * The arrows between the ends of a relationship, at a place in a name: "-->", "->" or "→" as
 * documented, those of relationship labels, such as "↔", of ER diagrams, such as "||--o{", and the
 * others of Mermaid sources, such as "->>", "-)", "--x", "o--o", "<-->", "==>", "-.->", "<|--" and
 * "..>". A mark that starts one, as the "o" of "o--o", follows a space.
 */
const ARROWS = [
  /[→↔—]/y,
  /[|}][o|](?:--|\.\.)[o|][|{]/y,
  /(?:<<|<\|?|(?<=^|\s)[ox*])?(?:[-=.]+(?:>>|\|>|>|[xo)*])|[-=.]{2,})/y,
];
/** An arrow with a head at its start alone, as "<|--", which points from the second end. */
const BACKWARD = /^<(?!.*(?:>|[)xo*])$)/;
/**
 * A flowchart link with its label on it, as in "A -- Yes --> B", "A -. Yes .-> B" or
 * "A == Yes ==> B", or a requirement diagram's relationship, as in "sim - satisfies -> req": its
 * ends and label.
 */
const LABELED_LINK =
  /^(.+?)\s*(?:--|==|-\.|-)\s+(.+?)\s+(?:[-=.]*[-=.](?:>|[xo])|[-=.]{2,})\s*(.+)$/s;
/** A label of a stereotype alone, as a requirement diagram's "<<satisfies>>": its name. */
const STEREOTYPE = /^<<(.*)>>$/s;
/** A letter, digit or underscore, which an id goes on with. */
const WORD = /[\p{L}\p{N}_]/u;
/** A relationship id's prefix, which a model may also put before ends. */
const KIND = /^(?:edge|message):/;
/** A flowchart edge's label after its arrow, as in "A -->|Yes| B". */
const PIPED = /^\|([^|]*)\|(.*)$/s;

/** A key for the relationships from the source to the target. */
const pair = (source: string, target: string) => JSON.stringify([source, target]);

/**
 * Label text as compared: without quotes, the angle brackets of a stereotype, line breaks and runs
 * of spaces, in lowercase.
 */
const comparable = (text: string) =>
  text
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .replace(STEREOTYPE, "$1")
    .toLowerCase();

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

/** The ends that a name gives, and the label, if it gives one. */
interface Ends {
  source: string;
  target: string;
  label?: string | undefined;
}

export class ItemNames {
  private readonly nodes: ReadonlySet<string>;
  private readonly ids: ReadonlySet<string>;
  private readonly relationships = new Map<string, DiagramNode>();
  /** The relationships from one node to another, by both, as keyed by {@link pair}. */
  private readonly pairs = new Map<string, DiagramNode[]>();
  /** The label of each relationship, as compared. */
  private readonly texts = new Map<string, string>();
  /**
   * What the names that {@link named} tries name: those of many relationships between the same
   * nodes, with the same label, are the same.
   */
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
   * those from A to B, and those without a single direction between A and B either way, and of
   * these those with the label, if named, as in "A --> B: Yes" or "A -->|Yes| B".
   */
  resolve(name: string): Named {
    if (this.ids.has(name)) return { ids: [name] };
    // As an id may hold a dash or a colon, the first reading of ends and label that names any.
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
      const fixed = JSON.stringify(`${odd.source} --> ${odd.target}`);
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

  /** What each of the names names. */
  resolveAll(names: readonly string[]): Resolved[] {
    return names.map((name) => ({ name, ...this.resolve(name) }));
  }

  /** The relationship of the id, if it is one. */
  relationship(id: string): DiagramNode | undefined {
    return this.relationships.get(id);
  }

  /**
   * The shortest name of each item, for a model to use: node ids, and relationships by their ends,
   * and label if others go between them too, unless that names others too.
   */
  names(): string[] {
    return [...this.drawn.nodeIds, ...this.drawn.relationships.map(({ id }) => this.name(id))];
  }

  /** The shortest name of the item of the id, as {@link names} gives it. */
  name(id: string): string {
    return this.named(id)?.name ?? id;
  }

  /**
   * A relationship's name by its ends, as in "A --> B", or by its ends and label, as in
   * "A --> B: Yes", if that alone names it; else undefined.
   */
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

  /** The relationships from the source to the target, also those that go both or no way. */
  private between(source: string, target: string): readonly DiagramNode[] {
    return this.pairs.get(pair(source, target)) ?? [];
  }

  /**
   * The ends that the name may give on either side of an arrow, and the label after the second end
   * or the arrow, in order; and the reading to tell a model why it names nothing, if none does: of
   * the first arrow after a node id, or else set apart by spaces, or else the first, with the label
   * after the first colon rather than an end that holds it.
   */
  private readings(name: string): { readings: Ends[]; fallback: Ends | undefined } {
    const readings: Ends[] = [];
    const fallbacks: { ends: Ends; spaced: boolean }[] = [];
    const link = LABELED_LINK.exec(name);
    if (link) {
      const [, source = "", label = "", target = ""] = link;
      readings.push({ source: source.trim(), target: target.trim(), label: label.trim() });
    }
    /** The ends on either side of the arrow at the index, of the length. */
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
      const given = around(index, arrow.length);
      // An arrow with a head at its start alone goes from the second end to the first.
      const read = BACKWARD.test(arrow)
        ? given.map(({ source, target, label }) => ({ source: target, target: source, label }))
        : given;
      readings.push(...read);
      const ends = read[1] ?? read[0];
      const spaced =
        /\s/.test(name.charAt(index - 1)) && /\s/.test(name.charAt(index + arrow.length));
      if (ends) fallbacks.push({ ends, spaced });
      // A circle or cross at its end may start the second end's id instead, as in "A --xray".
      if (/[xo]$/.test(arrow)) readings.push(...around(index, arrow.length - 1));
      index += arrow.length;
    }
    const fallback =
      fallbacks.find(({ ends }) => this.nodes.has(ends.source)) ??
      fallbacks.find(({ spaced }) => spaced) ??
      fallbacks[0];
    return { readings, fallback: fallback?.ends };
  }

  /**
   * The node ids that the name starts and ends with, before any label, if no arrow that the tools
   * read goes between them, and what does.
   */
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

/** The arrow at the index of the name, if one starts there: the longest. */
function arrowAt(name: string, index: number): string | undefined {
  for (const arrow of ARROWS) {
    arrow.lastIndex = index;
    const found = arrow.exec(name)?.[0];
    if (found) return found;
  }
  return undefined;
}

/**
 * The relationship's own label, as "Yes" of "Start → Check: Yes", which the page gives apart from
 * the labels of its ends, as those may hold colons too, as in "Step 1: Parse"; of a stereotype, as
 * a requirement diagram's "<<satisfies>>", its name, as the source writes it.
 */
function labelText({ relationship }: DiagramNode): string {
  return (relationship?.text ?? "").replace(STEREOTYPE, "$1");
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
