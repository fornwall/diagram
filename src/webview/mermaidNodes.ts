// Finds the nodes and relationships in a drawing that Mermaid made, which the panel selects, marks
// and links: from the SVG, and from the diagram's database where the SVG leaves out what it shows.

import type { DiagramNode } from "../protocol";
import type { WebLink } from "./renderer";

/**
 * The diagram types whose items Mermaid draws without their data, and the parts of their
 * databases that findNodes reads it from.
 */
export const WITH_DATABASE = new Set([
  "pie",
  "gitGraph",
  "xychart",
  "flowchart-v2",
  "flowchart",
  "classDiagram",
  "stateDiagram",
  "er",
  "requirement",
  "sequence",
  "gantt",
  "sankey",
  "architecture",
]);

export interface DiagramDb {
  getData?(): {
    edges: {
      id: string;
      start: string;
      end: string;
      label?: string;
      thickness?: string;
      arrowTypeStart?: string;
      arrowTypeEnd?: string;
    }[];
  };
  getMessages?(): { id: string; from?: string; to?: string; message?: string }[];
  getSections?(): Map<string, number>;
  getCommitsArray?(): { id: string; message: string; seq: number; tags: string[] }[];
  getDirection?(): string;
  /** A Gantt chart's task links, by task id; a sankey diagram's flows, as an array. */
  getLinks?(): Map<string, unknown> | unknown[];
  /** A sequence diagram's actors, by id, with their labels and links by name. */
  getActors?(): Map<string, { description?: string; links?: Record<string, unknown> | null }>;
  /** An architecture diagram's edges, with whether they have an arrowhead into either end. */
  getEdges?(): {
    lhsId?: string;
    rhsId?: string;
    lhsInto?: boolean;
    rhsInto?: boolean;
    title?: string;
  }[];
  /** A sankey diagram's nodes and flows, in the order it draws them. */
  getGraph?(): {
    nodes: { id: string }[];
    links: { source: string; target: string; value: number }[];
  };
  getXYChartData?(): {
    plots: { type: "bar" | "line"; title: string; data: [string, number][] }[];
  };
}

/** The nodes of a drawing, and the elements that show them. */
export interface DrawnNodes {
  /** The node that each element shows. */
  byElement: ReadonlyMap<Element, DiagramNode>;
  /** The elements that show each node, by id: a Gantt task's bar and label, for one. */
  elements: ReadonlyMap<string, Element[]>;
  /** Each node once. */
  nodes: DiagramNode[];
  /** The links in the source from nodes, by node id. */
  links: ReadonlyMap<string, WebLink[]>;
}

export const NOTHING_DRAWN: DrawnNodes = {
  byElement: new Map(),
  elements: new Map(),
  nodes: [],
  links: new Map(),
};

/** The text of an element, with its lines (separate text nodes) separated by spaces. */
function textOf(element: Element): string {
  const parts: string[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    parts.push(walker.currentNode.nodeValue ?? "");
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * The name of a node or group: the title of a box that also shows a stereotype, class members,
 * entity attributes, a C4 type and description, requirement fields, kanban card metadata or
 * further state descriptions. Mermaid names a state by its first description (an alias is one),
 * and shows its id only when it has none.
 */
function nameOf(element: Element): string {
  // A state label that is not split in title and descriptions starts with an empty rect.
  const title = element.querySelector(
    ".label-group, .label.name, .cluster-label, .c4-name, .statediagram-state > .label > :first-child:not(rect)",
  );
  if (title) {
    return textOf(title);
  }
  // Requirement boxes and kanban cards draw each line as a label, the name first after any
  // "<<Requirement>>" or "<<Element>>" line.
  for (const line of element.querySelectorAll(".label")) {
    const text = textOf(line);
    if (text && !/^<<.*>>$/.test(text)) {
      return text;
    }
  }
  return textOf(element);
}

/**
 * Finds the nodes of the drawing, which Mermaid gave ids that start with the prefix, and makes them
 * buttons for the keyboard, one for each node.
 */
export function findNodes(
  svg: SVGSVGElement,
  idPrefix: string,
  db: DiagramDb | undefined,
): DrawnNodes {
  const byElement = new Map<Element, DiagramNode>();
  const focusable = new Set<string>();
  const add = (element: Element, node: DiagramNode) => {
    element.classList.add("diagram-node");
    element.setAttribute("data-diagram-id", node.id);
    element.setAttribute("aria-pressed", "false");
    if (node.relationship) element.classList.add("diagram-relationship");
    byElement.set(element, node);
    // One focusable element per node, although some are drawn as several.
    if (!focusable.has(node.id)) {
      focusable.add(node.id);
      element.setAttribute("tabindex", "-1");
      element.setAttribute("role", "button");
      element.setAttribute("aria-label", node.label);
    }
  };
  /** Adds the elements that show the nodes in order, when there is one for each node. */
  const addInOrder = (elements: NodeListOf<Element>, nodes: DiagramNode[]) => {
    if (elements.length === nodes.length) {
      for (const [i, element] of elements.entries()) {
        add(element, nodes[i] as DiagramNode);
      }
    }
  };
  const withoutPrefix = (id: string) => (id.startsWith(idPrefix) ? id.slice(idPrefix.length) : id);
  /** Ids for nodes that go by their names, numbering repeated names: "a", "a (2)", … */
  const named = new Set<string>();
  // The next number to try for each name, so that many equal names take linear time.
  const next = new Map<string, number>();
  const uniqueId = (name: string) => {
    let id = name;
    let n = next.get(name) ?? 2;
    while (named.has(id)) {
      id = `${name} (${n++})`;
    }
    next.set(name, n);
    named.add(id);
    return id;
  };

  // Nodes, icon and image shapes among them, and groups (subgraphs, composite states, kanban
  // columns, architecture services, …). Their element ids are the source ids, some decorated like
  // "flowchart-A-0". Mermaid makes up the ids of mind map nodes ("node_0"), notes ("note0",
  // "state-A----note-2") and subgraphs titled with spaces and no id ("subGraph0"), so those go by
  // their names.
  const nodeIds = new Map<string, string>();
  for (const element of svg.querySelectorAll(
    "g.node, g.rough-node, g.icon-shape, g.image-shape, g.cluster, g.statediagram-cluster, g.architecture-service",
  )) {
    const label = nameOf(element);
    if (!label) {
      continue; // Start and end states, forks and joins.
    }
    const domId = element.getAttribute("data-id") ?? withoutPrefix(element.id);
    const decorated = /^(?:flowchart|state|classId|entity)-(.+)-\d+$|^service-(.+)$/.exec(domId);
    const id = /^(?:node_\d+|note\d+|subGraph\d+|state-.+----note-\d+)?$/.test(domId)
      ? uniqueId(label)
      : (decorated?.[1] ?? decorated?.[2] ?? domId);
    nodeIds.set(domId, id);
    add(element, { id, label });
  }

  // Architecture groups: a box, followed by a group of its icon and title.
  for (const box of svg.querySelectorAll("g.architecture-groups > rect.node-bkg")) {
    const id = withoutPrefix(box.id).replace(/^group-/, "");
    const title = box.nextElementSibling?.matches("g") ? box.nextElementSibling : undefined;
    const node = { id, label: (title && textOf(title)) || id };
    add(box, node);
    if (title) add(title, node);
  }

  // Sankey nodes: a bar and a label each (two in the outlined style), in the order of the database.
  const sankeyNodes = (db?.getGraph?.().nodes ?? []).map(({ id }) => ({ id, label: id }));
  addInOrder(svg.querySelectorAll(":scope > g.nodes > g.node"), sankeyNodes);
  for (const label of [":not([class])", ".sankey-label-bg", ".sankey-label-fg"]) {
    addInOrder(svg.querySelectorAll(`:scope > g.node-labels > text${label}`), sankeyNodes);
  }

  // Footer copies retain the participant's name, even when several share a display label.
  const participants = new Map<string, DiagramNode>();
  for (const element of svg.querySelectorAll('[data-et="participant"]')) {
    const label = textOf(element);
    const node = { id: element.getAttribute("data-id") || label, label };
    participants.set(node.id, node);
    add(element, node);
  }
  for (const element of svg.querySelectorAll(".actor-bottom")) {
    const group = element.tagName === "g" ? element : element.parentElement;
    const node = participants.get(element.getAttribute("name") ?? "");
    if (group && node) {
      add(group, node);
    }
  }
  // An actor's menu of links, when sequence.forceMenus shows it, is numbered like its lifeline.
  for (const menu of svg.querySelectorAll('g.actorPopupMenu:not([display="none"])')) {
    const line = svg.querySelector(`line[id="${CSS.escape(menu.id.replace(/_popup$/, ""))}"]`);
    const node = participants.get(line?.getAttribute("data-id") ?? "");
    if (node) {
      add(menu, node);
    }
  }

  findRelationships(svg, idPrefix, db, nodeIds, byElement, add);

  // Gantt tasks: a bar and a label with ids derived from the task id.
  for (const bar of svg.querySelectorAll("rect.task")) {
    const text = document.getElementById(`${bar.id}-text`);
    if (text) {
      const node = { id: withoutPrefix(bar.id), label: textOf(text) };
      add(bar, node);
      add(text, node);
    }
  }

  // User journey tasks: groups of the task box, its people, and a line down to its score. The
  // name is in a text per line, which may also have an HTML label (in a switch) to stand in for.
  for (const line of svg.querySelectorAll("line.task-line")) {
    const group = line.parentElement;
    const label = group && Array.from(group.querySelectorAll("text.task"), textOf).join(" ");
    if (group && label) {
      add(group, { id: uniqueId(label), label });
    }
  }

  // Pie slices and their percentages, for the sections of at least 1% (see createPieArcs in
  // Mermaid), and legend entries, for all sections.
  const sections = Array.from(db?.getSections?.() ?? [], ([label, value]) => ({
    node: { id: label, label },
    value,
  }));
  const sum = sections.reduce((total, { value }) => total + value, 0);
  const slices = sections.filter(({ value }) => (value / sum) * 100 >= 1).map(({ node }) => node);
  addInOrder(svg.querySelectorAll("path.pieCircle"), slices);
  addInOrder(svg.querySelectorAll("text.slice"), slices);
  addInOrder(
    svg.querySelectorAll("g.legend"),
    sections.map(({ node }) => node),
  );

  // Git graph commits: one or more bullets each, with the commit id among their classes, in the
  // order of the database's commits (reversed from bottom to top), and a label with the id
  // except for merges and cherry-picks (or with showCommitLabel off). Mermaid generates ids like
  // "1-7754f83" at random in each parse, so those commits go by their sequence number, and are
  // named by the drawn id. Their tags follow in the same order, each commit's last first, as a
  // box, a hole and a text. Tags need not be unique.
  const commits = db?.getCommitsArray?.() ?? [];
  if (db?.getDirection?.() === "BT") {
    commits.reverse();
  }
  const bullets = new Map<string, Element[]>();
  for (const bullet of svg.querySelectorAll(".commit-bullets > *")) {
    const classes = bullet.getAttribute("class")?.split(" ") ?? [];
    const id = classes.filter((name) => !/^commit(?:\d+|-[a-z-]+\d*)?$/.test(name)).join(" ");
    const elements = bullets.get(id) ?? [];
    elements.push(bullet);
    bullets.set(id, elements);
  }
  const tagLabels = Array.from(svg.querySelectorAll("text.tag-label"));
  const tagCount = commits.reduce((count, { tags }) => count + tags.length, 0);
  const commitLabels = new Map(
    Array.from(svg.querySelectorAll("text.commit-label"), (label) => [textOf(label), label]),
  );
  if (bullets.size === commits.length && tagLabels.length === tagCount) {
    let tagIndex = 0;
    for (const [i, [drawnId, elements]] of [...bullets].entries()) {
      const { id, message, seq, tags } = commits[i] as (typeof commits)[number];
      const generated = /^\d+-[0-9a-f]{7}$/.test(id);
      const commitLabel = commitLabels.get(drawnId)?.parentElement;
      const node = {
        id: generated ? String(seq) : id,
        label:
          tags.join(", ") ||
          (generated ? message || (commitLabel ? drawnId : `commit ${seq}`) : id),
      };
      for (const element of elements) {
        add(element, node);
      }
      if (commitLabel) {
        add(commitLabel, node);
      }
      const tagEnd = tagIndex + tags.length;
      for (; tagIndex < tagEnd; tagIndex++) {
        const tag = tagLabels[tagIndex] as Element;
        const hole = tag.previousElementSibling;
        const background = hole?.previousElementSibling;
        add(tag, node);
        if (hole?.matches(".tag-hole") && background?.matches(".tag-label-bkg")) {
          add(hole, node);
          add(background, node);
        }
      }
    }
  }
  // Git graph branches, by their labels.
  for (const label of svg.querySelectorAll("g.branchLabel")) {
    const name = textOf(label);
    const node = { id: name, label: name };
    const background = label.previousElementSibling;
    if (background?.matches("rect.branchLabelBkg")) {
      add(background, node);
    }
    add(label, node);
  }

  // XY chart bars, in the order of their plot's data, and lines (Mermaid draws no points), named
  // like chart items.
  const plots = db?.getXYChartData?.().plots ?? [];
  for (const [i, { type, title, data }] of plots.entries()) {
    const series = title || `Series ${i + 1}`;
    if (type === "line") {
      const line = { id: uniqueId(series), label: series };
      for (const path of svg.querySelectorAll(`g.line-plot-${i} > path`)) {
        add(path, line);
      }
      continue;
    }
    const prefix = plots.length > 1 ? `${series}/` : "";
    const bars = data.map(([x, y]) => ({
      id: uniqueId(prefix + x),
      // A category without a value gets an invisible bar.
      label: y === undefined ? x : `${x}: ${y}`,
    }));
    addInOrder(svg.querySelectorAll(`g.bar-plot-${i} > rect`), bars);
  }

  // Timeline periods and events, and quadrant chart points.
  for (const element of svg.querySelectorAll("g.timeline-node, g.data-point")) {
    const label = textOf(element);
    add(element, { id: uniqueId(label), label });
  }

  const elements = new Map<string, Element[]>();
  const nodes = new Map<string, DiagramNode>();
  for (const [element, node] of byElement) {
    nodes.set(node.id, node);
    const shown = elements.get(node.id);
    if (shown) shown.push(element);
    else elements.set(node.id, [element]);
  }
  return { byElement, elements, nodes: [...nodes.values()], links: linksOf(svg, db, byElement) };
}

/**
 * Joins renderer metadata to DOM IDs; endpoint names are never inferred from generated IDs.
 * `nodeIds` gives the id of each node by the id Mermaid draws it with.
 */
function findRelationships(
  svg: SVGSVGElement,
  idPrefix: string,
  db: DiagramDb | undefined,
  nodeIds: ReadonlyMap<string, string>,
  found: ReadonlyMap<Element, DiagramNode>,
  add: (element: Element, node: DiagramNode) => void,
): void {
  const used = new Set(Array.from(found.values(), (node) => node.id));
  const names = new Map(Array.from(found.values(), (node) => [node.id, node.label]));
  const unique = (base: string) => {
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base} (${n})`;
    used.add(id);
    return id;
  };
  const plainText = (text: string) => {
    // Most messages are plain text and most edges have no label. Avoid constructing a
    // complete HTML document for each of them; entities and markup still use the parser.
    if (!/[<&]/.test(text)) return text.replace(/\s+/g, " ").trim();
    const doc = new DOMParser().parseFromString(text.replace(/<br\s*\/?\s*>/gi, " "), "text/html");
    return textOf(doc.body);
  };
  const addLine = (line: Element, node: DiagramNode) => {
    add(line, node);
    // A wide invisible stroke makes thin lines practical mouse targets without changing the drawing.
    const hit = line.cloneNode(false) as SVGElement;
    for (const name of hit.getAttributeNames()) {
      if (!["d", "x1", "x2", "y1", "y2", "transform"].includes(name)) hit.removeAttribute(name);
    }
    hit.classList.add("diagram-relationship-hit");
    hit.setAttribute("aria-hidden", "true");
    line.before(hit);
    add(hit, node);
  };
  const relation = (
    kind: "edge" | "message",
    id: string,
    source: string,
    target: string,
    text: string,
    start: boolean,
    end: boolean,
  ): DiagramNode => {
    if (start && !end) [source, target] = [target, source];
    const direction = start && end ? "both" : !start && !end ? "undirected" : "forward";
    const arrow = direction === "both" ? "↔" : direction === "undirected" ? "—" : "→";
    return {
      id: unique(`${kind}:${id}`),
      label: `${names.get(source) ?? source} ${arrow} ${names.get(target) ?? target}${text ? `: ${text}` : ""}`,
      relationship: { kind, source, target, direction },
    };
  };
  // Edges of flowcharts and class, state, ER and requirement diagrams, which Mermaid lays out
  // alike. Diamonds, lollipops, cardinalities and "contains" circles are not arrowheads.
  const arrowhead = (marker = "") =>
    /^(?:arrow_|extension$|dependency$|requirement_arrow$)/.test(marker);
  if (db?.getData) {
    const edges = db.getData().edges;
    const counts = new Map<string, number>();
    for (const edge of edges) counts.set(edge.id, (counts.get(edge.id) ?? 0) + 1);
    const labels = new Map(
      Array.from(svg.querySelectorAll(".edgeLabel .label[data-id]"), (element) => [
        element.getAttribute("data-id"),
        element,
      ]),
    );
    const lines = new Map(
      Array.from(svg.querySelectorAll('[data-et="edge"][data-id]'), (line) => [
        line.getAttribute("data-id"),
        line,
      ]),
    );
    for (const edge of edges) {
      const line = lines.get(edge.id);
      const source = nodeIds.get(edge.start) ?? edge.start;
      const target = nodeIds.get(edge.end) ?? edge.end;
      // Ambiguous duplicate renderer IDs cannot safely identify a relationship, and one with an
      // end that is not a node, like a state diagram's start, cannot be described.
      if (
        !line ||
        counts.get(edge.id) !== 1 ||
        edge.thickness === "invisible" ||
        !names.has(source) ||
        !names.has(target)
      )
        continue;
      const label = labels.get(edge.id);
      const node = relation(
        "edge",
        edge.id,
        source,
        target,
        label ? textOf(label) : plainText(edge.label ?? ""),
        arrowhead(edge.arrowTypeStart),
        arrowhead(edge.arrowTypeEnd),
      );
      addLine(line, node);
      if (label) add(label, node);
    }
  }
  // Sankey flows, in the order of the database.
  const flows = db?.getGraph?.().links ?? [];
  const bands = svg.querySelectorAll(":scope > g.links > g.link > path");
  if (bands.length === flows.length) {
    for (const [i, { source, target, value }] of flows.entries()) {
      const node = relation(
        "edge",
        `${source} → ${target}`,
        source,
        target,
        `${value}`,
        false,
        true,
      );
      add(bands[i] as Element, node);
    }
  }
  // Architecture edges, which Mermaid draws in a group of their line, arrowheads and title, with
  // an id from their ends, as for a flowchart edge without an id: one for each pair of ends.
  const architectureEdges = (db?.getEdges?.() ?? []).flatMap(({ lhsId, rhsId, ...edge }) =>
    lhsId === undefined || rhsId === undefined ? [] : [{ ...edge, lhsId, rhsId }],
  );
  const pairs = new Map<string, number>();
  for (const { lhsId, rhsId } of architectureEdges) {
    const id = `L_${lhsId}_${rhsId}_0`;
    pairs.set(id, (pairs.get(id) ?? 0) + 1);
  }
  for (const { lhsId, rhsId, lhsInto, rhsInto, title } of architectureEdges) {
    const id = `L_${lhsId}_${rhsId}_0`;
    const line = svg.querySelector(`path.edge[id="${CSS.escape(idPrefix + id)}"]`);
    // Junctions are no nodes to describe an edge by.
    if (!line || pairs.get(id) !== 1 || !names.has(lhsId) || !names.has(rhsId)) continue;
    const node = relation("edge", id, lhsId, rhsId, title ?? "", !!lhsInto, !!rhsInto);
    // The line first, to take the focus for the keyboard.
    const parts = Array.from(line.parentElement?.children ?? []).filter((part) => part !== line);
    addLine(line, node);
    for (const part of parts) add(part, node);
  }
  if (db?.getMessages) {
    const messages = new Map(db.getMessages().map((message) => [`i${message.id}`, message]));
    for (const line of svg.querySelectorAll('[data-et="message"][data-id]')) {
      const id = line.getAttribute("data-id") ?? "";
      const message = messages.get(id);
      if (
        !message?.from ||
        !message.to ||
        line.getAttribute("data-from") !== message.from ||
        line.getAttribute("data-to") !== message.to
      )
        continue;
      const node = relation(
        "message",
        id,
        message.from,
        message.to,
        plainText(message.message ?? ""),
        line.hasAttribute("marker-start"),
        line.hasAttribute("marker-end"),
      );
      // Mermaid emits the message's label immediately before its line (self messages are paths).
      let label = line.previousElementSibling;
      addLine(line, node);
      while (label?.matches(".messageText")) {
        add(label, node);
        label = label.previousElementSibling;
      }
    }
  }
}

/**
 * The links in the source from nodes: those that a click directive wraps in a link, those with a
 * link in their label, the first one if several, linked Gantt tasks, and sequence diagram actors
 * with links, which can have several.
 */
function linksOf(
  svg: SVGSVGElement,
  db: DiagramDb | undefined,
  found: ReadonlyMap<Element, DiagramNode>,
): Map<string, WebLink[]> {
  const links = new Map<string, WebLink[]>();
  const ids = new Set(Array.from(found.values(), (node) => node.id));
  const toLink = (url: unknown) =>
    typeof url === "string" && url.trim() ? { name: url.trim(), url: url.trim() } : undefined;
  for (const link of svg.querySelectorAll("a[data-href]")) {
    const element = link.querySelector(".diagram-node") ?? link.closest(".diagram-node");
    const node = element && found.get(element);
    const target = toLink(link.getAttribute("data-href"));
    if (node && !node.relationship && target && !links.has(node.id)) {
      links.set(node.id, [target]);
    }
  }
  // A Gantt chart draws none, but keeps them by task id. (A state diagram keeps objects there.)
  const taskLinks = db?.getLinks?.();
  for (const [id, url] of taskLinks instanceof Map ? taskLinks : []) {
    const target = toLink(url);
    if (target && ids.has(id)) links.set(id, [target]);
  }
  // An actor's links are drawn as a menu, which Mermaid hides unless sequence.forceMenus, and
  // opens with a script that the strict security level removes.
  for (const [id, actor] of db?.getActors?.() ?? []) {
    const targets = Object.entries(actor.links ?? {}).flatMap(([name, url]) => {
      const target = toLink(url);
      return target ? [{ ...target, name: name.trim() || target.url }] : [];
    });
    if (targets.length > 0 && ids.has(id)) links.set(id, targets);
  }
  return links;
}
