import type { DiagramNode } from "../protocol";

/** A shortest path following arrow directions, with source order breaking ties. */
export function shortestPath(
  items: readonly DiagramNode[],
  from: string,
  to: string,
): DiagramNode[] | undefined {
  const nodes = new Map(items.filter((item) => !item.relationship).map((item) => [item.id, item]));
  if (!nodes.has(from) || !nodes.has(to)) return undefined;
  const adjacency = new Map<string, { target: string; edge: DiagramNode }[]>();
  const add = (source: string, target: string, edge: DiagramNode) => {
    if (!nodes.has(source) || !nodes.has(target)) return;
    const list = adjacency.get(source) ?? [];
    list.push({ target, edge });
    adjacency.set(source, list);
  };
  for (const edge of items) {
    const relation = edge.relationship;
    if (relation?.kind !== "edge") continue;
    add(relation.source, relation.target, edge);
    if (relation.direction !== "forward") add(relation.target, relation.source, edge);
  }
  const visited = new Map<string, { source: string; edge: DiagramNode } | undefined>([
    [from, undefined],
  ]);
  const queue = [from];
  for (let i = 0; i < queue.length && !visited.has(to); i++) {
    const source = queue[i] as string;
    for (const { target, edge } of adjacency.get(source) ?? []) {
      if (!visited.has(target)) {
        visited.set(target, { source, edge });
        queue.push(target);
      }
    }
  }
  if (!visited.has(to)) return undefined;
  const reversed: DiagramNode[] = [nodes.get(to) as DiagramNode];
  let cursor = to;
  while (cursor !== from) {
    const step = visited.get(cursor);
    if (!step) return undefined;
    reversed.push(step.edge, nodes.get(step.source) as DiagramNode);
    cursor = step.source;
  }
  return reversed.reverse();
}
