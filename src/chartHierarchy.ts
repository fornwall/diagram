// Charts of rows read as paths of levels: treemap and sunburst nest them, sankey flows along them.

import { chained } from "./chartColumns";
import { addValues, label, plural, type Reading, type Row } from "./chartRows";
import { quoteAll } from "./chartSpec";

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

/** A flow from one node to another, by name. */
interface Flow {
  source: string;
  target: string;
  value: number;
}

/** Locate a cycle, which ECharts rejects without saying which nodes form it. */
function findCycle(flows: Flow[]): string[] | undefined {
  const outgoing = new Map<string, string[]>();
  for (const { source, target } of flows) {
    const targets = outgoing.get(source);
    if (targets === undefined) {
      outgoing.set(source, [target]);
    } else {
      targets.push(target);
    }
  }
  const done = new Set<string>();
  for (const start of outgoing.keys()) {
    if (done.has(start)) {
      continue;
    }
    // The nodes of the path followed so far, and how many flows out of each it has followed.
    const path = [start];
    const followed = [0];
    const onPath = new Set([start]);
    while (path.length > 0) {
      const node = path.at(-1) ?? "";
      const targets = outgoing.get(node) ?? [];
      const next = followed.at(-1) ?? 0;
      if (next >= targets.length) {
        done.add(node);
        onPath.delete(node);
        path.pop();
        followed.pop();
        continue;
      }
      followed[followed.length - 1] = next + 1;
      const target = targets[next] ?? "";
      if (onPath.has(target)) {
        return [...path.slice(path.indexOf(target)), target];
      }
      if (!done.has(target)) {
        path.push(target);
        followed.push(0);
        onPath.add(target);
      }
    }
  }
  return undefined;
}

/** Build flows along each row's label path, or from its label to one target per value column. */
export function sankeyOption(reading: Reading): Record<string, unknown> {
  const { names, rows, notes } = reading;
  const targets = chained(reading.columns) ? undefined : names;
  const flows = new Map<string, Flow>();
  let empty = 0;
  const addFlow = (source: string, target: string, value: number | null): void => {
    if (value === null || value <= 0) {
      empty++;
      return;
    }
    const key = JSON.stringify([source, target]);
    const existing = flows.get(key);
    if (existing === undefined) {
      flows.set(key, { source, target, value });
    } else {
      existing.value = addValues(existing.value, value);
    }
  };
  for (const row of rows) {
    if (targets === undefined) {
      // Each row contributes its value to every step along its path.
      row.labels.slice(1).forEach((target, i) => {
        addFlow(row.labels[i] ?? "", target, row.values[0] ?? null);
      });
    } else {
      row.values.forEach((value, column) => {
        addFlow(label(row), targets[column] ?? "", value);
      });
    }
  }
  if (empty > 0) {
    notes.push(`left out ${plural(empty, "flow")} without a positive value`);
  }
  // ECharts lays out flows from left to right, and rejects a flow from a node to itself as a cycle.
  const drawn = [...flows.values()].filter((flow) => flow.source !== flow.target);
  const loops = flows.size - drawn.length;
  if (loops > 0) {
    notes.push(`left out ${plural(loops, "flow")} from a node to itself`);
  }
  if (drawn.length === 0) {
    const problem =
      loops > 0
        ? "every flow runs from a node to itself"
        : targets === undefined
          ? "every row holds one level only"
          : `${quoteAll(targets)} holds no positive value`;
    throw new Error(
      `A sankey chart needs flows between two nodes, but ${problem}. Give "labelColumn" as a ` +
        "source and a target column, or chart the values as a bar chart.",
    );
  }
  const cycle = findCycle(drawn);
  if (cycle !== undefined) {
    throw new Error(
      "A sankey chart shows flows in one direction, but these come back around: " +
        `${cycle.map((node) => JSON.stringify(node)).join(" -> ")}. Leave out the rows that flow ` +
        "back, or show the pairs as a heatmap.",
    );
  }
  const nodes = new Set<string>();
  for (const { source, target } of drawn) {
    nodes.add(source);
    nodes.add(target);
  }
  const name = names[0];
  return {
    series: [
      {
        type: "sankey",
        ...(targets === undefined && name ? { name } : {}),
        // Hovering a node dims everything that does not flow through it.
        emphasis: { focus: "adjacency" },
        data: [...nodes].map((name) => ({ name })),
        links: drawn,
      },
    ],
  };
}
