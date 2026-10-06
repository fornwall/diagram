// Finds the nodes and relationships in a drawing that Mermaid made, which the panel selects, marks
// and links: from the SVG, and from the diagram's database where the SVG leaves out what it shows.

import type { DiagramNode } from "../protocol";
import type { WebLink } from "./renderer";

/** The diagram types whose items Mermaid draws without their data, which their databases have. */
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
  "c4",
  "treemap",
  "packet",
  "radar",
  "treeView",
  "venn",
  "wardley",
  "cynefin",
]);

/** A packet field, or a piece of one, from its first bit to its last. */
interface PacketBlock {
  start: number;
  end: number;
  bits: number;
  label: string;
}

/** An item of a tree that Mermaid draws, below a root without a name. */
interface TreeItem {
  name: string;
  value?: number;
  children?: TreeItem[];
}

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
  /** A C4 diagram's relationships, in the order it draws them. */
  getRels?(): { from: string; to: string; label?: { text?: string } }[];
  /** A C4 diagram's boundaries in the boundary with the alias, the whole diagram being "global". */
  getBoundaries?(parent: string): { alias: string; label: { text: string } }[];
  /** A sankey diagram's nodes and flows, in the order it draws them. */
  getGraph?(): {
    nodes: { id: string }[];
    links: { source: string; target: string; value: number }[];
  };
  getXYChartData?(): {
    plots: { type: "bar" | "line"; title: string; data: [string, number][] }[];
  };
  /** A treemap's sections and leaves, or a tree view's folders and files. */
  getRoot?(): TreeItem;
  /** A packet diagram's fields, by row, a field that goes on in the next row in pieces. */
  getPacket?(): PacketBlock[][];
  /** A radar chart's axes and curves, in the order it draws them. */
  getAxes?(): { name: string; label: string }[];
  getCurves?(): { name: string; label: string }[];
  /** A Venn diagram's sets and their overlaps, and the texts in them, with their sets sorted. */
  getSubsetData?(): { sets: string[]; label?: string }[];
  getTextData?(): { sets: string[]; id: string; label?: string }[];
  /** A Wardley map's components and links, and the components of its pipelines. */
  getWardleyData?(): {
    nodes: { id: string; label: string }[];
    links: { source: string; target: string; label?: string }[];
    pipelines: { nodeId: string; componentIds: string[] }[];
  };
  /** A Cynefin diagram's transitions between domains. */
  getTransitions?(): { from: string; to: string; label?: string }[];
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

/** The text of a label written as HTML. */
function plainText(text: string): string {
  // Most labels are plain text: parse only those with entities or markup.
  if (!/[<&]/.test(text)) return text.replace(/\s+/g, " ").trim();
  const doc = new DOMParser().parseFromString(text.replace(/<br\s*\/?\s*>/gi, " "), "text/html");
  return textOf(doc.body);
}

/** Whether a line has an arrowhead at its start, and at its end. */
const arrowheads = (line: Element) =>
  [line.hasAttribute("marker-start"), line.hasAttribute("marker-end")] as const;

/** The nodes found in a drawing so far, and how each diagram type's finder adds more. */
class Finder {
  readonly byElement = new Map<Element, DiagramNode>();
  /** The label of each node and relationship, by id. */
  private readonly labels = new Map<string, string>();
  /** The ids that uniqueId gave out. */
  private readonly given = new Set<string>();
  /** The next number to try for each name, so that many equal names take linear time. */
  private readonly next = new Map<string, number>();

  constructor(
    readonly svg: SVGSVGElement,
    readonly idPrefix: string,
    readonly db: DiagramDb | undefined,
  ) {}

  all(selector: string): NodeListOf<Element> {
    return this.svg.querySelectorAll(selector);
  }

  has(id: string): boolean {
    return this.labels.has(id);
  }

  withoutPrefix(id: string): string {
    return id.startsWith(this.idPrefix) ? id.slice(this.idPrefix.length) : id;
  }

  /** Makes the element show the node, and a button for the keyboard if it is the node's first. */
  add(element: Element, node: DiagramNode): void {
    element.classList.add("diagram-node");
    element.setAttribute("data-diagram-id", node.id);
    element.setAttribute("aria-pressed", "false");
    if (node.relationship) element.classList.add("diagram-relationship");
    this.byElement.set(element, node);
    const first = !this.labels.has(node.id);
    this.labels.set(node.id, node.label);
    if (first) {
      element.setAttribute("tabindex", "-1");
      element.setAttribute("role", "button");
      element.setAttribute("aria-label", node.label);
    }
  }

  /** Adds the elements that match the selector to the nodes in order, if there is one for each. */
  inOrder(selector: string, nodes: readonly DiagramNode[]): void {
    const elements = this.all(selector);
    if (elements.length === nodes.length) {
      for (const [i, element] of elements.entries()) this.add(element, nodes[i] as DiagramNode);
    }
  }

  /** An id for a node that goes by its name, numbering repeated names: "a", "a (2)", … */
  uniqueId(name: string): string {
    let id = name;
    let n = this.next.get(name) ?? 2;
    while (this.given.has(id)) id = `${name} (${n++})`;
    this.next.set(name, n);
    this.given.add(id);
    return id;
  }

  /** A node that goes by its label, or by the name given. */
  named(label: string, name = label): DiagramNode {
    return { id: this.uniqueId(name), label };
  }

  /**
   * A relationship, which an arrowhead at its start alone points from the target to the source.
   * One without an id of its own goes by its ends.
   */
  relation(
    source: string,
    target: string,
    text: string,
    [start, end]: readonly [boolean, boolean],
    id = `${source} → ${target}`,
    kind: "edge" | "message" = "edge",
  ): DiagramNode {
    if (start && !end) [source, target] = [target, source];
    const direction = start && end ? "both" : !start && !end ? "undirected" : "forward";
    const arrow = direction === "both" ? "↔" : direction === "undirected" ? "—" : "→";
    let unique = `${kind}:${id}`;
    for (let n = 2; this.labels.has(unique); n++) unique = `${kind}:${id} (${n})`;
    const name = (node: string) => this.labels.get(node) ?? node;
    return {
      id: unique,
      label: `${name(source)} ${arrow} ${name(target)}${text ? `: ${text}` : ""}`,
      relationship: { kind, source, target, direction },
    };
  }

  /** Adds the line of a relationship, and a wide invisible copy that is easier to point at. */
  addLine(line: Element, node: DiagramNode): void {
    this.add(line, node);
    const hit = line.cloneNode(false) as SVGElement;
    for (const name of hit.getAttributeNames()) {
      if (!["d", "x1", "x2", "y1", "y2", "transform"].includes(name)) hit.removeAttribute(name);
    }
    hit.classList.add("diagram-relationship-hit");
    hit.setAttribute("aria-hidden", "true");
    line.before(hit);
    this.add(hit, node);
  }

  /** Adds the lines of links in order, with the labels, in order, of the links that have one. */
  addLines(
    lineSelector: string,
    labelSelector: string,
    links: { source: string; target: string; label?: string | undefined }[],
  ): void {
    const lines = this.all(lineSelector);
    const labels = this.all(labelSelector);
    if (lines.length !== links.length) return;
    let next = 0;
    for (const [i, { source, target, label }] of links.entries()) {
      const text = label ? labels[next++] : undefined;
      if (!this.has(source) || !this.has(target)) continue;
      const line = lines[i] as Element;
      const node = this.relation(source, target, label ?? "", arrowheads(line));
      this.addLine(line, node);
      if (text) this.add(text, node);
    }
  }
}

/**
 * Nodes, icon and image shapes among them, and groups (subgraphs, composite states, kanban
 * columns, architecture services, …). Their element ids are the source ids, some decorated like
 * "flowchart-A-0". Mermaid makes up the ids of mind map nodes ("node_0"), notes ("note0",
 * "state-A----note-2") and subgraphs titled with spaces and no id ("subGraph0"), so those go by
 * their names. Returns the id of each node by the id that Mermaid draws it with.
 */
function shapes(f: Finder): Map<string, string> {
  const nodeIds = new Map<string, string>();
  for (const element of f.all(
    "g.node, g.rough-node, g.icon-shape, g.image-shape, g.cluster, g.statediagram-cluster, g.architecture-service",
  )) {
    const domId = element.getAttribute("data-id") ?? f.withoutPrefix(element.id);
    // A block diagram group without a label goes by its id, unless Mermaid made one up for it.
    const group = element.querySelector(":scope > rect.composite") && !/^id-\w+-\d+$/.test(domId);
    const label = nameOf(element) || (group ? domId : "");
    // Start and end states, forks and joins, and groups without ids.
    if (!label) continue;
    const decorated = /^(?:flowchart|state|classId|entity)-(.+)-\d+$|^service-(.+)$/.exec(domId);
    const id = /^(?:node_\d+|note\d+|subGraph\d+|state-.+----note-\d+)?$/.test(domId)
      ? f.uniqueId(label)
      : (decorated?.[1] ?? decorated?.[2] ?? domId);
    nodeIds.set(domId, id);
    f.add(element, { id, label });
  }
  return nodeIds;
}

/**
 * The edges of flowcharts and class, state, ER and requirement diagrams, which Mermaid lays out
 * alike, joined to their lines by their ids in the database. `nodeIds` gives the id of each node
 * by the id that Mermaid draws it with.
 */
function shapeEdges(f: Finder, nodeIds: ReadonlyMap<string, string>): void {
  if (!f.db?.getData) return;
  const { edges } = f.db.getData();
  const counts = new Map<string, number>();
  for (const edge of edges) counts.set(edge.id, (counts.get(edge.id) ?? 0) + 1);
  const byId = (selector: string) =>
    new Map(Array.from(f.all(selector), (element) => [element.getAttribute("data-id"), element]));
  const labels = byId(".edgeLabel .label[data-id]");
  const lines = byId('[data-et="edge"][data-id]');
  // Diamonds, lollipops, cardinalities and "contains" circles are not arrowheads.
  const arrowhead = (marker = "") =>
    /^(?:arrow_|extension$|dependency$|requirement_arrow$)/.test(marker);
  for (const edge of edges) {
    const line = lines.get(edge.id);
    const source = nodeIds.get(edge.start) ?? edge.start;
    const target = nodeIds.get(edge.end) ?? edge.end;
    // An id that several edges share tells none of them apart, and an end that is not a node,
    // like a state diagram's start, cannot describe the edge.
    if (
      !line ||
      counts.get(edge.id) !== 1 ||
      edge.thickness === "invisible" ||
      !f.has(source) ||
      !f.has(target)
    )
      continue;
    const label = labels.get(edge.id);
    const text = label ? textOf(label) : plainText(edge.label ?? "");
    const arrows = [arrowhead(edge.arrowTypeStart), arrowhead(edge.arrowTypeEnd)] as const;
    const node = f.relation(source, target, text, arrows, edge.id);
    f.addLine(line, node);
    if (label) f.add(label, node);
  }
}

/**
 * C4 boundaries, groups of a box and its texts, which Mermaid draws without ids: inner ones before
 * outer ones, and none for the diagram as a whole. And relationships, one for each pair of ends,
 * in the order of the database: a line, with an arrowhead at either end, followed by the texts of
 * its label.
 */
function c4(f: Finder): void {
  const boundaries: DiagramNode[] = [];
  const addBoundaries = (parent: string) => {
    for (const { alias, label } of f.db?.getBoundaries?.(parent) ?? []) {
      addBoundaries(alias);
      if (alias !== "global") boundaries.push({ id: alias, label: label.text });
    }
  };
  addBoundaries("");
  f.inOrder(":scope > g:has(> rect:first-child)", boundaries);

  const rels = f.db?.getRels?.() ?? [];
  const lines = f.all(
    `:scope > g > :is(line, path):is([marker-end="url(#${f.idPrefix}arrowhead)"], [marker-start="url(#${f.idPrefix}arrowend)"])`,
  );
  if (lines.length !== rels.length) return;
  for (const [i, { from, to, label }] of rels.entries()) {
    // An end that was not found, such as a boundary drawn unlike above, cannot describe it.
    if (!f.has(from) || !f.has(to)) continue;
    const line = lines[i] as Element;
    const node = f.relation(from, to, label?.text ?? "", arrowheads(line));
    f.addLine(line, node);
    for (let text = line.nextElementSibling; text && !text.matches("line, path"); ) {
      f.add(text, node);
      text = text.nextElementSibling;
    }
  }
}

/**
 * Architecture groups: a box, followed by a group of its icon and title. And edges, which Mermaid
 * draws in a group of their line, arrowheads and title, with an id from their ends, as for a
 * flowchart edge without an id: one for each pair of ends.
 */
function architecture(f: Finder): void {
  for (const box of f.all("g.architecture-groups > rect.node-bkg")) {
    const id = f.withoutPrefix(box.id).replace(/^group-/, "");
    const title = box.nextElementSibling?.matches("g") ? box.nextElementSibling : undefined;
    const node = { id, label: (title && textOf(title)) || id };
    f.add(box, node);
    if (title) f.add(title, node);
  }

  const edges = (f.db?.getEdges?.() ?? []).flatMap(({ lhsId, rhsId, ...edge }) =>
    lhsId === undefined || rhsId === undefined ? [] : [{ ...edge, lhsId, rhsId }],
  );
  const pairs = new Map<string, number>();
  for (const { lhsId, rhsId } of edges) {
    const id = `L_${lhsId}_${rhsId}_0`;
    pairs.set(id, (pairs.get(id) ?? 0) + 1);
  }
  for (const { lhsId, rhsId, lhsInto, rhsInto, title } of edges) {
    const id = `L_${lhsId}_${rhsId}_0`;
    const line = f.svg.querySelector(`path.edge[id="${CSS.escape(f.idPrefix + id)}"]`);
    // Junctions are no nodes to describe an edge by.
    if (!line || pairs.get(id) !== 1 || !f.has(lhsId) || !f.has(rhsId)) continue;
    const node = f.relation(lhsId, rhsId, title ?? "", [!!lhsInto, !!rhsInto], id);
    // The line first, to take the focus for the keyboard.
    const parts = Array.from(line.parentElement?.children ?? []).filter((part) => part !== line);
    f.addLine(line, node);
    for (const part of parts) f.add(part, node);
  }
}

/**
 * Sankey nodes, a bar and a label each (two in the outlined style), and flows, in the order of the
 * database.
 */
function sankey(f: Finder): void {
  const graph = f.db?.getGraph?.();
  const nodes = (graph?.nodes ?? []).map(({ id }) => ({ id, label: id }));
  f.inOrder(":scope > g.nodes > g.node", nodes);
  for (const label of [":not([class])", ".sankey-label-bg", ".sankey-label-fg"]) {
    f.inOrder(`:scope > g.node-labels > text${label}`, nodes);
  }
  const flows = graph?.links ?? [];
  const bands = f.all(":scope > g.links > g.link > path");
  if (bands.length !== flows.length) return;
  for (const [i, { source, target, value }] of flows.entries()) {
    f.add(bands[i] as Element, f.relation(source, target, `${value}`, [false, true]));
  }
}

/**
 * Wardley map anchors and components, and the links between them but for those that Mermaid
 * leaves out: to components that are not there, and from a pipeline's components to the
 * pipeline. Both in the order of the database; the labels of links follow all lines.
 */
function wardley(f: Finder): void {
  const data = f.db?.getWardleyData?.();
  if (!data) return;
  f.inOrder(
    "g.wardley-node",
    data.nodes.map((node) => ({ id: node.id, label: node.label })),
  );
  const components = new Set(data.nodes.map(({ id }) => id));
  const pipelines = new Set(
    data.pipelines.flatMap(({ nodeId, componentIds }) =>
      componentIds.map((id) => `${id} → ${nodeId}`),
    ),
  );
  f.addLines(
    "g.wardley-links > line",
    "g.wardley-links > text",
    data.links.filter(
      ({ source, target }) =>
        components.has(source) && components.has(target) && !pipelines.has(`${source} → ${target}`),
    ),
  );
}

/**
 * Cynefin domains, by their names in the source: the four quadrants, then confusion in the middle,
 * each a background and a label. And transitions between domains: curves, each followed by its
 * label if it has one. The items in domains are found with timeline periods.
 */
function cynefin(f: Finder): void {
  const domains = Array.from(f.all("text.cynefinDomainLabel"), (title) => {
    const label = textOf(title);
    return f.named(label, label.toLowerCase());
  });
  f.inOrder("rect.cynefinDomain, path.cynefinConfusion", domains);
  f.inOrder("text.cynefinDomainLabel", domains);
  const transitions = (f.db?.getTransitions?.() ?? []).map(({ from, to, label }) => ({
    source: from,
    target: to,
    label,
  }));
  f.addLines("path.cynefinArrowLine", "text.cynefinArrowLabel", transitions);
}

/** Sequence diagram participants, with their footer copies and menus of links, and messages. */
function sequence(f: Finder): void {
  const participants = new Map<string, DiagramNode>();
  for (const element of f.all('[data-et="participant"]')) {
    const label = textOf(element);
    const node = { id: element.getAttribute("data-id") || label, label };
    participants.set(node.id, node);
    f.add(element, node);
  }
  // Footer copies retain the participant's name, even when several share a display label.
  for (const element of f.all(".actor-bottom")) {
    const group = element.tagName === "g" ? element : element.parentElement;
    const node = participants.get(element.getAttribute("name") ?? "");
    if (group && node) f.add(group, node);
  }
  // An actor's menu of links, when sequence.forceMenus shows it, is numbered like its lifeline.
  for (const menu of f.all('g.actorPopupMenu:not([display="none"])')) {
    const line = f.svg.querySelector(`line[id="${CSS.escape(menu.id.replace(/_popup$/, ""))}"]`);
    const node = participants.get(line?.getAttribute("data-id") ?? "");
    if (node) f.add(menu, node);
  }

  if (!f.db?.getMessages) return;
  const messages = new Map(f.db.getMessages().map((message) => [`i${message.id}`, message]));
  for (const line of f.all('[data-et="message"][data-id]')) {
    const id = line.getAttribute("data-id") ?? "";
    const message = messages.get(id);
    if (
      !message?.from ||
      !message.to ||
      line.getAttribute("data-from") !== message.from ||
      line.getAttribute("data-to") !== message.to
    )
      continue;
    const text = plainText(message.message ?? "");
    const node = f.relation(message.from, message.to, text, arrowheads(line), id, "message");
    // Mermaid emits the message's label immediately before its line (self messages are paths).
    let label = line.previousElementSibling;
    f.addLine(line, node);
    while (label?.matches(".messageText")) {
      f.add(label, node);
      label = label.previousElementSibling;
    }
  }
}

/** Gantt tasks: a bar and a label with ids derived from the task id. */
function gantt(f: Finder): void {
  for (const bar of f.all("rect.task")) {
    const text = document.getElementById(`${bar.id}-text`);
    if (!text) continue;
    const node = { id: f.withoutPrefix(bar.id), label: textOf(text) };
    f.add(bar, node);
    f.add(text, node);
  }
}

/**
 * User journey tasks: groups of the task box, its people, and a line down to its score. The name
 * is in a text per line, which may also have an HTML label (in a switch) to stand in for.
 */
function journey(f: Finder): void {
  for (const line of f.all("line.task-line")) {
    const group = line.parentElement;
    const label = group && Array.from(group.querySelectorAll("text.task"), textOf).join(" ");
    if (group && label) f.add(group, f.named(label));
  }
}

/**
 * Pie slices and their percentages, for the sections of at least 1% (see createPieArcs in
 * Mermaid), and legend entries, for all sections.
 */
function pie(f: Finder): void {
  const sections = Array.from(f.db?.getSections?.() ?? [], ([label, value]) => ({
    node: { id: label, label },
    value,
  }));
  const sum = sections.reduce((total, { value }) => total + value, 0);
  const slices = sections.filter(({ value }) => (value / sum) * 100 >= 1).map(({ node }) => node);
  f.inOrder("path.pieCircle", slices);
  f.inOrder("text.slice", slices);
  f.inOrder(
    "g.legend",
    sections.map((section) => section.node),
  );
}

/**
 * Git graph commits: one or more bullets each, with the commit id among their classes, in the
 * order of the database's commits (reversed from bottom to top), and a label with the id except
 * for merges and cherry-picks (or with showCommitLabel off). Mermaid generates ids like
 * "1-7754f83" at random in each parse, so those commits go by their sequence number, and are named
 * by the drawn id. Their tags follow in the same order, each commit's last first, as a box, a hole
 * and a text. Tags need not be unique. And branches, by their labels.
 */
function gitGraph(f: Finder): void {
  const commits = f.db?.getCommitsArray?.() ?? [];
  if (f.db?.getDirection?.() === "BT") commits.reverse();
  const bullets = new Map<string, Element[]>();
  for (const bullet of f.all(".commit-bullets > *")) {
    const classes = bullet.getAttribute("class")?.split(" ") ?? [];
    const id = classes.filter((name) => !/^commit(?:\d+|-[a-z-]+\d*)?$/.test(name)).join(" ");
    const elements = bullets.get(id) ?? [];
    elements.push(bullet);
    bullets.set(id, elements);
  }
  const tagLabels = Array.from(f.all("text.tag-label"));
  const tagCount = commits.reduce((count, { tags }) => count + tags.length, 0);
  const commitLabels = new Map(
    Array.from(f.all("text.commit-label"), (label) => [textOf(label), label]),
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
      for (const element of elements) f.add(element, node);
      if (commitLabel) f.add(commitLabel, node);
      const tagEnd = tagIndex + tags.length;
      for (; tagIndex < tagEnd; tagIndex++) {
        const tag = tagLabels[tagIndex] as Element;
        const hole = tag.previousElementSibling;
        const background = hole?.previousElementSibling;
        f.add(tag, node);
        if (hole?.matches(".tag-hole") && background?.matches(".tag-label-bkg")) {
          f.add(hole, node);
          f.add(background, node);
        }
      }
    }
  }
  for (const label of f.all("g.branchLabel")) {
    const name = textOf(label);
    const node = { id: name, label: name };
    const background = label.previousElementSibling;
    if (background?.matches("rect.branchLabelBkg")) f.add(background, node);
    f.add(label, node);
  }
}

/**
 * XY chart bars, in the order of their plot's data, and lines (Mermaid draws no points), named
 * like chart items.
 */
function xyChart(f: Finder): void {
  const plots = f.db?.getXYChartData?.().plots ?? [];
  for (const [i, { type, title, data }] of plots.entries()) {
    const series = title || `Series ${i + 1}`;
    if (type === "line") {
      const line = f.named(series);
      for (const path of f.all(`g.line-plot-${i} > path`)) f.add(path, line);
      continue;
    }
    const prefix = plots.length > 1 ? `${series}/` : "";
    // A category without a value gets an invisible bar.
    const bars = data.map(([x, y]) => f.named(y === undefined ? x : `${x}: ${y}`, prefix + x));
    f.inOrder(`g.bar-plot-${i} > rect`, bars);
  }
}

/**
 * Timeline periods and events, quadrant chart points, the problems and causes of Ishikawa
 * diagrams, and the items of Cynefin domains, but for the count of those left out: by their texts.
 */
function textItems(f: Finder): void {
  for (const element of f.all(
    "g.timeline-node, g.data-point, g.ishikawa-head-group, g.ishikawa-label-group, g.ishikawa-sub-group, g.cynefin-items > g:has(> rect.cynefinItem)",
  )) {
    f.add(element, f.named(textOf(element)));
  }
}

/** Railroad diagram rules, by their names, which Mermaid draws followed by " =". */
function railroad(f: Finder): void {
  for (const rule of f.all("g.railroad-rule")) {
    const name = rule.querySelector(".railroad-rule-name");
    const label = name && textOf(name).replace(/ =$/, "");
    if (label) f.add(rule, f.named(label));
  }
}

/**
 * Packet fields, by their labels: a box, its label and its bit numbers each, in the order of the
 * database. A field that goes on in the next row is in pieces of the same label, which Mermaid
 * counts a bit short (their bits are their end less their start), and whole fields not. So two
 * fields of the same label that both go on in the next row, the second at the start of a row,
 * look like one.
 */
function packet(f: Finder): void {
  const rows = f.db?.getPacket?.() ?? [];
  const boxes = f.all("rect.packetBlock");
  if (boxes.length !== rows.flat().length) return;
  const isPiece = ({ start, end, bits }: PacketBlock) => bits === end - start;
  let field: DiagramNode | undefined;
  let last: PacketBlock | undefined;
  let i = 0;
  for (const row of rows) {
    for (const [column, block] of row.entries()) {
      const goesOn =
        column === 0 && last && isPiece(last) && isPiece(block) && last.label === block.label;
      if (!field || !goesOn) field = f.named(block.label);
      last = block;
      const box = boxes[i++] as Element;
      f.add(box, field);
      for (let text = box.nextElementSibling; text?.matches("text"); ) {
        f.add(text, field);
        text = text.nextElementSibling;
      }
    }
  }
}

/**
 * Radar chart axes and curves, which go by their names in the source, not their labels: the curves
 * with their legend entries, which Mermaid numbers in the order of the database.
 */
function radar(f: Finder): void {
  const axes = (f.db?.getAxes?.() ?? []).map(({ name, label }) => f.named(label, name));
  f.inOrder("text.radarAxisLabel", axes);
  for (const [i, { name, label }] of (f.db?.getCurves?.() ?? []).entries()) {
    const curve = f.named(label, name);
    for (const element of f.all(`.radarCurve-${i}, g:has(> .radarLegendBox-${i})`)) {
      f.add(element, curve);
    }
  }
}

/**
 * Venn diagram sets and the overlaps in the source, which go by their sets, as in "A,B", and are
 * drawn with them joined by "_". Mermaid draws other overlaps too, and the texts in the order of
 * the first text in each area.
 */
function venn(f: Finder): void {
  const areas = new Map(
    (f.db?.getSubsetData?.() ?? []).map(({ sets, label }) => [
      sets.join("_"),
      f.named(label ?? sets.join(" ∩ "), sets.join(",")),
    ]),
  );
  for (const area of f.all("g.venn-area")) {
    const node = areas.get(area.getAttribute("data-venn-sets") ?? "");
    if (node) f.add(area, node);
  }
  const texts = Map.groupBy(f.db?.getTextData?.() ?? [], ({ sets }) => sets.join(","));
  f.inOrder(
    "foreignObject.venn-text-node-fo",
    [...texts.values()].flat().map(({ id, label }) => f.named(label ?? id, id)),
  );
}

/** The items of a tree in the order of the source, which go by their paths, as chart items do. */
function treeNodes(f: Finder, root: TreeItem): Map<TreeItem, DiagramNode> {
  const nodes = new Map<TreeItem, DiagramNode>();
  const visit = (item: TreeItem, path: string) => {
    for (const child of item.children ?? []) {
      const node = f.named(child.name, path + child.name);
      nodes.set(child, node);
      visit(child, `${node.id}/`);
    }
  };
  visit(root, "");
  return nodes;
}

/** Tree view items, which Mermaid draws in the order of the source, after a root of its own. */
function treeView(f: Finder): void {
  const tree = f.svg.querySelector("g.tree-view") ? f.db?.getRoot?.() : undefined;
  if (tree) f.inOrder("g.tree-view > g ~ g", [...treeNodes(f, tree).values()]);
}

/**
 * Treemap sections and leaves, whose titles Mermaid may cut short. d3 lays them out with each
 * section's items by their total values, largest first, and Mermaid draws the sections breadth
 * first, after the hidden root, and then the leaves depth first.
 */
function treemap(f: Finder): void {
  const root = f.svg.querySelector(".treemapContainer") ? f.db?.getRoot?.() : undefined;
  if (!root) return;
  const nodes = treeNodes(f, root);
  const totals = new Map<TreeItem, number>();
  const sum = (item: TreeItem): number => {
    const total = (item.children ?? []).reduce(
      (value, child) => value + sum(child),
      item.value ?? 0,
    );
    totals.set(item, total);
    return total;
  };
  sum(root);
  const children = (item: TreeItem) =>
    (item.children ?? []).toSorted((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0));
  const isSection = (item: TreeItem) => !!item.children?.length;
  const sections = children(root).filter(isSection);
  for (let i = 0; i < sections.length; i++) {
    sections.push(...children(sections[i] as TreeItem).filter(isSection));
  }
  const leaves: TreeItem[] = [];
  const addLeaves = (item: TreeItem): void => {
    for (const child of children(item)) {
      if (isSection(child)) addLeaves(child);
      else leaves.push(child);
    }
  };
  addLeaves(root);
  const node = (item: TreeItem) => nodes.get(item) as DiagramNode;
  f.inOrder("g.treemapSection ~ g.treemapSection", sections.map(node));
  f.inOrder("g.treemapLeafGroup", leaves.map(node));
}

/**
 * Finds the nodes and relationships of the drawing, which Mermaid gave ids that start with the
 * prefix, and makes them buttons for the keyboard, one for each node.
 */
export function findNodes(
  svg: SVGSVGElement,
  idPrefix: string,
  db: DiagramDb | undefined,
): DrawnNodes {
  const f = new Finder(svg, idPrefix, db);
  shapeEdges(f, shapes(f));
  for (const find of [
    c4,
    architecture,
    sankey,
    wardley,
    cynefin,
    sequence,
    gantt,
    journey,
    pie,
    gitGraph,
    xyChart,
    textItems,
    railroad,
    packet,
    radar,
    venn,
    treeView,
    treemap,
  ]) {
    find(f);
  }

  const elements = new Map<string, Element[]>();
  const nodes = new Map<string, DiagramNode>();
  for (const [element, node] of f.byElement) {
    nodes.set(node.id, node);
    const shown = elements.get(node.id);
    if (shown) shown.push(element);
    else elements.set(node.id, [element]);
  }
  return { byElement: f.byElement, elements, nodes: [...nodes.values()], links: linksOf(f) };
}

/**
 * The links in the source from nodes: those that a click directive wraps in a link, those with a
 * link in their label, the first one if several, linked Gantt tasks, and sequence diagram actors
 * with links, which can have several.
 */
function linksOf(f: Finder): Map<string, WebLink[]> {
  const links = new Map<string, WebLink[]>();
  const toLink = (url: unknown) =>
    typeof url === "string" && url.trim() ? { name: url.trim(), url: url.trim() } : undefined;
  for (const link of f.all("a[data-href]")) {
    const element = link.querySelector(".diagram-node") ?? link.closest(".diagram-node");
    const node = element && f.byElement.get(element);
    const target = toLink(link.getAttribute("data-href"));
    if (node && !node.relationship && target && !links.has(node.id)) {
      links.set(node.id, [target]);
    }
  }
  // A Gantt chart draws none, but keeps them by task id. (A state diagram keeps objects there.)
  const taskLinks = f.db?.getLinks?.();
  for (const [id, url] of taskLinks instanceof Map ? taskLinks : []) {
    const target = toLink(url);
    if (target && f.has(id)) links.set(id, [target]);
  }
  // An actor's links are drawn as a menu, which Mermaid hides unless sequence.forceMenus, and
  // opens with a script that the strict security level removes.
  for (const [id, actor] of f.db?.getActors?.() ?? []) {
    const targets = Object.entries(actor.links ?? {}).flatMap(([name, url]) => {
      const target = toLink(url);
      return target ? [{ ...target, name: name.trim() || target.url }] : [];
    });
    if (targets.length > 0 && f.has(id)) links.set(id, targets);
  }
  return links;
}
