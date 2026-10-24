import type { DiagramNode } from "./protocol";

export const GRAPH_OPERATIONS = ["upstream", "downstream", "path", "cycles", "components"] as const;
export type GraphOperation = (typeof GRAPH_OPERATIONS)[number];

export interface GraphQuery {
  operation: GraphOperation;
  id?: string | undefined;
  target?: string | undefined;
  maxDepth?: number | undefined;
}

export interface GraphMatch {
  item: DiagramNode;
  group?: number | undefined;
  depth?: number | undefined;
}

export interface GraphResult {
  matches: GraphMatch[];
  groupCount?: number | undefined;
  /** Undirected links participate in reachability, but not directed cycle detection. */
  ignoredUndirected?: number | undefined;
}

interface Arc {
  target: string;
  edge: DiagramNode;
}

/** Queries rendered identities without reconstructing the graph from labels. */
export function queryGraph(items: readonly DiagramNode[], query: GraphQuery): GraphResult {
  const nodes = new Map(items.filter((item) => !item.relationship).map((item) => [item.id, item]));
  const edges = items.filter((item) => item.relationship?.kind === "edge");
  const adjacency = new Map<string, Arc[]>();
  const reverse = new Map<string, Arc[]>();
  const add = (from: string, to: string, edge: DiagramNode) => {
    if (!nodes.has(from) || !nodes.has(to)) return;
    const outgoing = adjacency.get(from) ?? [];
    outgoing.push({ target: to, edge });
    adjacency.set(from, outgoing);
    const incoming = reverse.get(to) ?? [];
    incoming.push({ target: from, edge });
    reverse.set(to, incoming);
  };
  let ignoredUndirected = 0;
  for (const edge of edges) {
    const relation = edge.relationship;
    if (!relation) continue;
    if (query.operation === "cycles" && relation.direction === "undirected") {
      ignoredUndirected++;
      continue;
    }
    add(relation.source, relation.target, edge);
    if (relation.direction !== "forward" || query.operation === "components") {
      add(relation.target, relation.source, edge);
    }
  }
  if (query.operation === "components" || query.operation === "cycles") {
    const groups = components(nodes, adjacency, reverse, query.operation === "cycles");
    const membership = new Map<string, number>();
    const kept = groups.filter(
      (group) =>
        query.operation === "components" ||
        group.length > 1 ||
        (adjacency.get(group[0] ?? "") ?? []).some((arc) => arc.target === group[0]),
    );
    kept.forEach((group, index) => {
      for (const id of group) membership.set(id, index + 1);
    });
    const matches = items.flatMap((item): GraphMatch[] => {
      const relation = item.relationship;
      if (!relation) {
        const group = membership.get(item.id);
        return group === undefined ? [] : [{ item, group }];
      }
      if (relation.kind !== "edge") return [];
      if (query.operation === "cycles" && relation.direction === "undirected") return [];
      const group = membership.get(relation.source);
      return group !== undefined && group === membership.get(relation.target)
        ? [{ item, group }]
        : [];
    });
    return { matches, groupCount: kept.length, ...(ignoredUndirected && { ignoredUndirected }) };
  }

  const start = query.id;
  if (start === undefined || !nodes.has(start)) {
    throw new Error(
      `Unknown node id ${JSON.stringify(start)}. Read diagram_getState with detail:"items" for exact ids.`,
    );
  }
  const target = query.target;
  if (query.operation === "path" && (target === undefined || !nodes.has(target))) {
    throw new Error(`Unknown target node id ${JSON.stringify(target)}.`);
  }
  const links = query.operation === "upstream" ? reverse : adjacency;
  const depth = new Map([[start, 0]]);
  const previous = new Map<string, { from: string; edge: DiagramNode }>();
  const queue = [start];
  for (let index = 0; index < queue.length; index++) {
    const from = queue[index] as string;
    if (query.operation === "path" && from === target) break;
    const distance = depth.get(from) as number;
    if (query.maxDepth !== undefined && distance >= query.maxDepth) continue;
    for (const { target: to, edge } of links.get(from) ?? []) {
      if (depth.has(to)) continue;
      depth.set(to, distance + 1);
      previous.set(to, { from, edge });
      queue.push(to);
    }
  }
  if (query.operation === "path") {
    if (target === undefined || !depth.has(target)) return { matches: [] };
    const matches: GraphMatch[] = [{ item: nodes.get(target) as DiagramNode }];
    for (let step = previous.get(target); step; step = previous.get(step.from)) {
      matches.push({ item: step.edge }, { item: nodes.get(step.from) as DiagramNode });
    }
    return { matches: matches.reverse() };
  }
  return {
    matches: items.flatMap((item): GraphMatch[] => {
      const relation = item.relationship;
      if (relation) {
        return relation.kind === "edge" && depth.has(relation.source) && depth.has(relation.target)
          ? [{ item }]
          : [];
      }
      const distance = depth.get(item.id);
      return distance === undefined ? [] : [{ item, depth: distance }];
    }),
  };
}

/** Iterative Kosaraju avoids overflowing on long dependency chains. */
function components(
  nodes: ReadonlyMap<string, DiagramNode>,
  adjacency: ReadonlyMap<string, readonly Arc[]>,
  reverse: ReadonlyMap<string, readonly Arc[]>,
  directed: boolean,
): string[][] {
  const visited = new Set<string>();
  const order: string[] = [];
  for (const id of nodes.keys()) {
    if (visited.has(id)) continue;
    const stack: { id: string; next: number }[] = [{ id, next: 0 }];
    visited.add(id);
    while (stack.length > 0) {
      const frame = stack.at(-1) as { id: string; next: number };
      const neighbors = adjacency.get(frame.id) ?? [];
      const next = neighbors[frame.next++];
      if (!next) {
        order.push(frame.id);
        stack.pop();
      } else if (!visited.has(next.target)) {
        visited.add(next.target);
        stack.push({ id: next.target, next: 0 });
      }
    }
  }
  visited.clear();
  const groups: string[][] = [];
  const links = directed ? reverse : adjacency;
  for (const id of order.reverse()) {
    if (visited.has(id)) continue;
    const group = [id];
    visited.add(id);
    for (let index = 0; index < group.length; index++) {
      for (const { target } of links.get(group[index] as string) ?? []) {
        if (visited.has(target)) continue;
        visited.add(target);
        group.push(target);
      }
    }
    groups.push(group);
  }
  const orderById = new Map([...nodes.keys()].map((id, index) => [id, index]));
  for (const group of groups) {
    group.sort((a, b) => (orderById.get(a) ?? 0) - (orderById.get(b) ?? 0));
  }
  return groups.sort((a, b) => (orderById.get(a[0] ?? "") ?? 0) - (orderById.get(b[0] ?? "") ?? 0));
}
