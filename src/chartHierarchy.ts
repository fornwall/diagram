// Charts of rows read as paths of levels: treemap and sunburst nest them, sankey flows along them.

import { chained, columnName } from "./chartColumns";
import { addValues, label, type Reading, type Row } from "./chartRows";
import { plural, quoteAll } from "./text";

/** A node of a hierarchy, before the values of the rows under it are summed up into it. */
interface Level {
  name: string;
  /** The value of the rows that named it, which a leaf alone has, as parent rows are left out. */
  own: number;
  children: Map<string, Level>;
}

/** A node of a hierarchy as ECharts takes it. */
interface Node {
  name: string;
  value: number;
  children?: Node[];
}

/** Sum leaf values into their ancestors. Parent rows have already been removed. */
function buildHierarchy(rows: Row[]): { nodes: Node[]; depth: number } {
  const roots = new Map<string, Level>();
  for (const { labels, values } of rows) {
    let siblings = roots;
    let node: Level | undefined;
    for (const name of labels) {
      let level = siblings.get(name);
      if (level === undefined) {
        level = { name, own: 0, children: new Map() };
        siblings.set(name, level);
      }
      node = level;
      siblings = level.children;
    }
    if (node !== undefined) {
      node.own = addValues(node.own, values[0] ?? 0);
    }
  }
  let depth = 0;
  const total = (level: Level, deep: number): Node => {
    depth = Math.max(depth, deep);
    if (level.children.size === 0) {
      return { name: level.name, value: level.own };
    }
    const children = [...level.children.values()].map((child) => total(child, deep + 1));
    return {
      name: level.name,
      value: children.reduce((sum, child) => addValues(sum, child.value), 0),
      children,
    };
  };
  return { nodes: [...roots.values()].map((root) => total(root, 1)), depth };
}

/** Omit shared root levels so children receive distinct colors in a treemap or sunburst. */
export function hierarchyOption(
  type: "treemap" | "sunburst",
  { names, rows, notes }: Reading,
): Record<string, unknown> {
  const { nodes, depth } = buildHierarchy(rows);
  let data = nodes;
  const dropped: string[] = [];
  while (data.length === 1) {
    const children = data[0]?.children;
    if (children === undefined) {
      break;
    }
    dropped.push(data[0]?.name ?? "");
    data = children;
  }
  const levels = depth - dropped.length;
  if (levels > 1) {
    notes.push(`nested the rows ${levels} levels deep`);
  }
  if (dropped.length > 0) {
    notes.push(`showed what is inside ${quoteAll(dropped)}, which holds every row`);
  }
  return { series: [{ type, name: names[0] ?? "", data }] };
}

/**
 * ECharts puts a gap of 8px between the nodes of a column whatever its height, so more nodes than
 * this would have no height left in a small panel; their layout also takes a second at thousands.
 */
const MAX_COLUMN_NODES = 30;

/** A node of a sankey, under a key that tells apart the same name in two stages. */
interface FlowNode {
  name: string;
  /** Its id if another node has the same name, e.g. "Yes (Q2)" or "src/webview". */
  distinct: string;
  /** Its column, unless ECharts works it out from the flows. */
  depth?: number;
}

/** The nodes, and the flows between them by node key, summed up per pair. */
interface Graph {
  nodes: Map<string, FlowNode>;
  flows: Map<string, { source: string; target: string; value: number }>;
}

function addFlow({ flows }: Graph, source: string, target: string, value: number): void {
  const key = JSON.stringify([source, target]);
  const flow = flows.get(key);
  if (flow === undefined) {
    flows.set(key, { source, target, value });
  } else {
    flow.value = addValues(flow.value, value);
  }
}

/** Join the nodes of the same name, as two columns that list the edges of a graph mean them. */
function joinByName({ nodes, flows }: Graph): Graph {
  const joined: Graph = { nodes: new Map(), flows: new Map() };
  const keyOf = (key: string): string => {
    const name = nodes.get(key)?.name ?? "";
    const joinedKey = JSON.stringify([name]);
    joined.nodes.set(joinedKey, { name, distinct: name });
    return joinedKey;
  };
  for (const { source, target, value } of flows.values()) {
    addFlow(joined, keyOf(source), keyOf(target), value);
  }
  return joined;
}

/**
 * Each node's column, as ECharts lays them out: at the end of the longest path to it, or in the
 * last column for a node without outflows. Undefined if the flows run in a circle.
 */
function layOut({ nodes, flows }: Graph): Map<string, number> | undefined {
  const outflows = Map.groupBy(flows.values(), ({ source }) => source);
  const inflows = new Map<string, number>();
  for (const { target } of flows.values()) {
    inflows.set(target, (inflows.get(target) ?? 0) + 1);
  }
  const depths = new Map<string, number>();
  const ready = [...nodes.keys()].filter((key) => !inflows.has(key));
  for (const key of ready) depths.set(key, 0);
  for (let i = 0; i < ready.length; i++) {
    const source = ready[i] ?? "";
    const depth = (depths.get(source) ?? 0) + 1;
    for (const { target } of outflows.get(source) ?? []) {
      depths.set(target, Math.max(depths.get(target) ?? 0, depth));
      const left = (inflows.get(target) ?? 0) - 1;
      inflows.set(target, left);
      if (left === 0) ready.push(target);
    }
  }
  if (ready.length < nodes.size) {
    return undefined;
  }
  const last = [...depths.values()].reduce((most, depth) => Math.max(most, depth), 0);
  for (const key of nodes.keys()) {
    if (!outflows.has(key)) depths.set(key, last);
  }
  return depths;
}

/** Sum up the smallest nodes of each column that has too many as "Other", in that column. */
function foldColumns(
  graph: Graph,
  depths: Map<string, number>,
  stage: (depth: number) => string,
): { graph: Graph; folded: number } {
  const { nodes, flows } = graph;
  const inflow = new Map<string, number>();
  const outflow = new Map<string, number>();
  for (const { source, target, value } of flows.values()) {
    outflow.set(source, addValues(outflow.get(source) ?? 0, value));
    inflow.set(target, addValues(inflow.get(target) ?? 0, value));
  }
  const columns = Map.groupBy(depths.keys(), (key) => depths.get(key) ?? 0);
  const explicit = [...nodes.values()].some((node) => node.depth !== undefined);
  const size = (key: string) => Math.max(inflow.get(key) ?? 0, outflow.get(key) ?? 0);
  const folded = new Map<string, string>();
  for (const [depth, keys] of columns) {
    if (keys.length <= MAX_COLUMN_NODES) continue;
    // A node named "Other" in the data is summed up too, rather than becoming a second one.
    const kept = new Set(
      keys
        .filter((key) => nodes.get(key)?.name !== "Other")
        .sort((a, b) => size(b) - size(a))
        .slice(0, MAX_COLUMN_NODES - 1),
    );
    const other = JSON.stringify([depth]);
    for (const key of keys) {
      if (!kept.has(key)) folded.set(key, other);
    }
    nodes.set(other, {
      name: "Other",
      distinct: `Other (${stage(depth)})`,
      ...(explicit ? { depth } : {}),
    });
  }
  if (folded.size === 0) {
    return { graph, folded: 0 };
  }
  const result: Graph = { nodes, flows: new Map() };
  for (const { source, target, value } of flows.values()) {
    addFlow(result, folded.get(source) ?? source, folded.get(target) ?? target, value);
  }
  return { graph: result, folded: folded.size };
}

/**
 * Build flows along each row's label path, or from its label to one target per value column. A
 * stage of the flows, being a column or a level of a path, has nodes of its own: the same answer
 * to two questions is two nodes, which ECharts tells apart by their ids.
 */
export function sankeyOption(reading: Reading): Record<string, unknown> {
  const { table, columns, names, rows, notes } = reading;
  const { separator } = columns;
  let graph: Graph = { nodes: new Map(), flows: new Map() };
  const node = (key: unknown[], name: string, distinct: string, depth: number): string => {
    const id = JSON.stringify(key);
    if (!graph.nodes.has(id)) graph.nodes.set(id, { name, distinct, depth });
    return id;
  };
  // What a column of nodes is called in their ids: its label column, if it has one.
  let stage = (depth: number): string => {
    const column = separator === undefined ? columns.labels[depth] : undefined;
    return column === undefined ? `column ${depth + 1}` : columnName(table, column);
  };
  let empty = 0;
  if (chained(columns)) {
    for (const { labels, values } of rows) {
      let source: string | undefined;
      labels.forEach((name, depth) => {
        // An empty label column skips its stage.
        if (name === "") return;
        // The same name under two parents, such as files in two directories, is two nodes.
        const path = separator === undefined ? undefined : labels.slice(0, depth + 1);
        const target =
          path === undefined
            ? node([depth, name], name, `${name} (${stage(depth)})`, depth)
            : node(path, name, path.join(separator), depth);
        if (source !== undefined) addFlow(graph, source, target, values[0] ?? 0);
        source = target;
      });
    }
  } else {
    for (const row of rows) {
      const name = label(row);
      row.values.forEach((value, column) => {
        if (value === null || value <= 0) {
          empty++;
          return;
        }
        const target = names[column] ?? "";
        const source = node([0, name], name, `${name} (${stage(0)})`, 0);
        addFlow(graph, source, node([1, target], target, target, 1), value);
      });
    }
  }
  if (empty > 0) {
    notes.push(`left out ${plural(empty, "flow")} without a positive value`);
  }
  if (graph.flows.size === 0) {
    const problem = chained(columns)
      ? "every row holds one level only"
      : `${quoteAll(names)} holds no positive value`;
    throw new Error(
      `A sankey chart needs flows between two nodes, but ${problem}. Give "labelColumn" as a ` +
        "source and a target column, or chart the values as a bar chart.",
    );
  }
  let depths = new Map([...graph.nodes].map(([key, { depth }]) => [key, depth ?? 0]));
  if (separator === undefined && columns.labels.length <= 2) {
    // Two columns can list the edges of a graph, whose names are its nodes, unless joining the
    // nodes of the same name would make flows run in a circle: from a plan back to itself, say.
    const joined = joinByName(graph);
    const joinedDepths = layOut(joined);
    if (joinedDepths !== undefined) {
      graph = joined;
      depths = joinedDepths;
      stage = (depth) => `column ${depth + 1}`;
    } else {
      const sides = chained(columns)
        ? `${JSON.stringify(stage(0))} and ${JSON.stringify(stage(1))}`
        : `${JSON.stringify(stage(0))} and the value columns`;
      notes.push(
        `drew the names in both ${sides} as separate nodes, since joined they would make flows ` +
          "run in a circle",
      );
    }
  }
  const { graph: drawn, folded } = foldColumns(graph, depths, stage);
  if (folded > 0) {
    notes.push(
      `kept the ${MAX_COLUMN_NODES - 1} largest nodes of each column and summed up the other ` +
        `${folded} as "Other"`,
    );
  }
  const { data, links } = nodesAndLinks(drawn);
  return {
    series: [
      {
        type: "sankey",
        ...(chained(columns) && names[0] ? { name: names[0] } : {}),
        // Hovering a node dims everything that does not flow through it.
        emphasis: { focus: "adjacency" },
        // ECharts labels a node by its id, unless told to use its name.
        ...(data.some((node) => node.id !== undefined) ? { label: { formatter: "{b}" } } : {}),
        data,
        links,
      },
    ],
  };
}

/** ECharts' nodes, by name unless another node has the same name, and the links between them. */
function nodesAndLinks({ nodes, flows }: Graph): {
  data: { id?: string; name: string; depth?: number }[];
  links: { source: string | undefined; target: string | undefined; value: number }[];
} {
  const keys = new Set<string>();
  for (const { source, target } of flows.values()) {
    keys.add(source);
    keys.add(target);
  }
  const counts = new Map<string, number>();
  for (const key of keys) {
    const name = nodes.get(key)?.name ?? "";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const taken = new Set([...counts].flatMap(([name, count]) => (count === 1 ? [name] : [])));
  const ids = new Map<string, string>();
  const data = [...keys].map((key) => {
    const { name, distinct, depth } = nodes.get(key) ?? { name: "", distinct: "" };
    let id = name;
    if ((counts.get(name) ?? 0) > 1) {
      id = distinct;
      for (let n = 2; taken.has(id); n++) id = `${distinct} ${n}`;
      taken.add(id);
    }
    ids.set(key, id);
    return { ...(id === name ? {} : { id }), name, ...(depth === undefined ? {} : { depth }) };
  });
  const links = [...flows.values()].map(({ source, target, value }) => ({
    source: ids.get(source),
    target: ids.get(target),
    value,
  }));
  return { data, links };
}
