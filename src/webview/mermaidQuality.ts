// Tells a model, which cannot see the drawing, where a Mermaid diagram reads badly in the panel:
// measured on the drawing, and only when it is a problem.

import { formatCount, joinWords, quote } from "../text";
import { diagramHeader } from "./mermaidLayout";
import type { DiagramDb } from "./mermaidNodes";

/** Fitting a tall diagram to the panel height never shrinks it below this; it scrolls instead. */
const MIN_HEIGHT_FIT = 0.6;
/**
 * Fitting a wide diagram to the panel width never shows most of its text smaller than this many
 * pixels, where it could not be read without zooming in; it scrolls sideways instead.
 */
export const MIN_FIT_TEXT = 9;
/**
 * A drawing that the panel shows more than this many times as wide as itself, which the user
 * scrolls sideways across, is too wide for it.
 */
const MAX_SCROLL = 2;
/**
 * The width that a narrow panel beside the chat has for a drawing, which a drawing is measured for
 * while the panel's size is not known.
 */
const NARROW_ROOM = 500;
/** Widening the panel more than this many times over is no remedy: changing the diagram is. */
const MAX_WIDENING = 1.5;
/** More nodes or edges than this make a graph hard to follow in one diagram. */
const MAX_NODES = 50;
const MAX_EDGES = 80;
/** Of a flowchart with fewer edges, nodes without any may well be meant to stand alone. */
const MIN_EDGES_FOR_LONE_NODES = 2;
/** How many examples a warning names at most. */
const EXAMPLES = 3;

/** The diagram types that Mermaid draws from getData as graphs of nodes and edges. */
const GRAPHS = /^(?:flowchart|stateDiagram|classDiagram|er$|requirement$)/;
const FLOWCHART = /^flowchart/;
/** The diagrams with a direction statement, in diagrams other than flowcharts. */
const DIRECTION_STATEMENT = /^(?:stateDiagram|classDiagram|er$|requirement$)/;

/** What the warnings about a drawing go by, besides the drawing. */
export interface DrawingFacts {
  /** The diagram type that Mermaid detected. */
  type: string;
  source: string;
  db: DiagramDb | undefined;
}

/** What tells how wide a drawing is for a panel of any width. */
export interface DrawingWidth {
  type: string;
  /** The drawing's size at actual size. */
  width: number;
  height: number;
  /** The size of most of the drawing's text, at actual size. */
  textSize: number | undefined;
  /** How to lay the diagram out the other way, if its type has another direction. */
  turned: string | undefined;
}

/** The width of a laid out drawing, which the panel measures against its own width. */
export function drawingWidth(
  svg: SVGSVGElement,
  facts: DrawingFacts,
  textSize: number | undefined,
): DrawingWidth {
  const { width, height } = svg.viewBox.baseVal;
  return { type: facts.type, width, height, textSize, turned: otherDirection(facts) };
}

/**
 * The zoom that fits a drawing of the natural size to the room of the panel: to its width, but
 * not so far that most of its text, of the given size, is too small to read, and to its height
 * within reason. The drawing scrolls where it is larger.
 */
export function fittingZoom(
  natural: { width: number; height: number },
  room: { width: number; height: number },
  textSize: number | undefined,
): number {
  const readable = textSize ? MIN_FIT_TEXT / textSize : 0;
  return Math.min(
    1,
    Math.max(room.width / natural.width, readable),
    Math.max(room.height / natural.height, MIN_HEIGHT_FIT),
  );
}

/**
 * Warnings about how the drawing reads: too wide for the panel to show without scrolling far, more nodes
 * than read well, flowchart nodes linked to nothing, labels drawn over each other, and Gantt tasks
 * placed after or until tasks that the chart does not have. The drawing must be laid out, as it is
 * in the layout container, where it is measured.
 */
export function readabilityWarnings(svg: SVGSVGElement, facts: DrawingFacts): string[] {
  return [
    tooLarge(facts),
    loneNodes(facts),
    overlappingLabels(svg),
    labelsOverNodes(svg),
    unknownTasks(facts),
    markedEnd(facts),
  ].filter((warning) => warning !== undefined);
}

/** The letters of the ends of flowchart links that end in a circle or a cross. */
const END_MARKS: Record<string, string> = { arrow_circle: "o", arrow_cross: "x" };

/**
 * A flowchart link written without a space before a node whose id starts with "o" or "x", which
 * Mermaid takes for a link that ends in a circle or cross at the rest of the id: "A---oB" links
 * A to B, not to oB. Only when the diagram has a node of the whole id, which the link was meant
 * for, as a link meant to end in a circle has none.
 */
function markedEnd({ type, source, db }: DrawingFacts): string | undefined {
  if (!FLOWCHART.test(type)) return undefined;
  const { nodes = [], edges = [] } = db?.getData?.() ?? {};
  const ids = new Set(nodes.map(({ id }) => id));
  for (const { end, arrowTypeEnd = "" } of edges) {
    const mark = END_MARKS[arrowTypeEnd];
    const meant = `${mark}${end}`;
    if (!mark || !ids.has(meant)) continue;
    const written = new RegExp(`([-=.]{2,})${RegExp.escape(meant)}(?![\\w-])`).exec(source);
    if (!written) continue;
    const line = source.slice(0, written.index).split("\n").length;
    const statement = source.split("\n")[line - 1]?.trim() ?? "";
    // Two dashes or equals signs make a link only with the end mark: three without it.
    const arrow =
      written[1] === "--" || written[1] === "==" ? `${written[1]}${written[1][0]}` : written[1];
    const fixed = statement.replace(written[0], ` ${arrow} ${meant}`).replace(/\s+/g, " ");
    return `The link on line ${line} ends in a ${mark === "o" ? "circle" : "cross"} at node ${JSON.stringify(end)}, as "${written[1]}${mark}" takes the "${mark}" of ${JSON.stringify(meant)}: put spaces around the link, as in ${fixed}.`;
  }
  return undefined;
}

/**
 * The first Gantt task that starts after, or ends at, a task id that no task has, which Mermaid
 * leaves out, and places the task from or to today if it names no other; or that names an id with
 * a character that Mermaid stops reading the ids there at, such as the "." of "after d.1".
 */
function unknownTasks({ type, db }: DrawingFacts): string | undefined {
  if (type !== "gantt") return undefined;
  const tasks = db?.getTasks?.() ?? [];
  const ids = new Set(tasks.map(({ id }) => id));
  /** The ids that Mermaid reads after the keyword, and where it stops reading short of the end. */
  const references = (text: string | undefined, keyword: string) => {
    const given = text?.trim() ?? "";
    const read = new RegExp(`^${keyword}\\s+([\\w -]+)`).exec(given);
    const named = read?.[1]?.split(" ").filter(Boolean) ?? [];
    const rest = read ? given.slice(read[0].length) : "";
    // The word that it stops in, as "d.1", and the character, as ".".
    const word =
      rest && `${read?.[1]?.endsWith(" ") ? "" : (named.at(-1) ?? "")}${rest.split(/\s/)[0]}`;
    return { given, named, cut: word ? { word, at: rest[0] ?? "" } : undefined };
  };
  const missing = tasks.flatMap((task) =>
    (
      [
        ["after", task.raw?.startTime?.startData, "starts", "from"],
        ["until", task.raw?.endTime?.data, "ends", "to"],
      ] as const
    ).flatMap(([keyword, text, does, from]) => {
      const { given, named, cut } = references(text, keyword);
      const unknown = named.filter((id) => !ids.has(id));
      return unknown.length > 0 || cut
        ? [{ task, keyword, does, from, given, named, unknown, cut }]
        : [];
    }),
  );
  const [first] = missing;
  if (!first) return undefined;
  const { task, keyword, does, from, given, named, unknown, cut } = first;
  const more = missing.length > 1 ? ` (and ${formatCount(missing.length - 1)} more)` : "";
  const name = quote(task.task?.trim() ?? "", 40);
  if (cut) {
    return `Task ${name} ${does} with ${JSON.stringify(given)}${more}, which Mermaid reads only up to the ${JSON.stringify(cut.at)}, as "${keyword} ${named.join(" ")}": ids there take only letters, digits, "_" and "-". Give the task an id such as ${JSON.stringify(cut.word.replace(/[^\w-]/g, "_"))} instead of ${JSON.stringify(cut.word)}.`;
  }
  const which = joinWords(
    unknown.map((id) => JSON.stringify(id)),
    "or",
  );
  const placed =
    unknown.length === named.length
      ? `so Mermaid draws it ${from} today`
      : `and Mermaid leaves ${unknown.length > 1 ? "them" : "it"} out`;
  // Ids that the source gives, rather than those that Mermaid makes up for the others, and that
  // "after" and "until" can name.
  const example = tasks.find(
    ({ id }) => id && id !== task.id && !/^task\d+$/.test(id) && /^[\w-]+$/.test(id),
  )?.id;
  return `Task ${name} ${does} with "${keyword} ${named.join(" ")}", but no task has the id ${which}${more}, ${placed}: give the id of a task${example ? `, such as ${JSON.stringify(example)}` : ""}, or a date.`;
}

/** The elements that hold the text of labels: SVG text, and HTML in foreign objects. */
function labels(svg: SVGSVGElement): Element[] {
  return Array.from(svg.querySelectorAll("text, foreignObject")).filter(
    (label) =>
      !(label.matches("text") && label.closest("foreignObject")) && label.textContent?.trim(),
  );
}

/** How to lay the diagram out the other way, across rather than down or the reverse. */
function otherDirection({ type, source, db }: DrawingFacts): string | undefined {
  const header = /^(flowchart|graph)(?:[^\S\n]+(TB|TD|BT|RL|LR))?\b/.exec(
    diagramHeader(source).typeLine ?? "",
  );
  const direction = (header?.[2] ?? db?.getDirection?.() ?? "TB").toUpperCase();
  const other = direction === "LR" || direction === "RL" ? "TB" : "LR";
  if (FLOWCHART.test(type) && header) {
    return `change "${header[0]}" to "${header[1]} ${other}"`;
  }
  return DIRECTION_STATEMENT.test(type) ? `lay it out with "direction ${other}"` : undefined;
}

/** What makes a drawing of the type narrower, besides another direction. */
const NARROWER: Record<string, string> = {
  sequence: "shorten its messages and show fewer participants",
  packet:
    'show fewer bits per row, with "packet: {bitsPerRow: 16}" under "config" in the front matter',
};

/**
 * A drawing that the panel, or a narrow panel if the panel's size is not known, shows much wider
 * than itself, at the zoom that fits it to the panel, which leaves its text legible but where its
 * height asks for less, so that the user scrolls sideways across it.
 */
export function tooWide(
  drawing: DrawingWidth,
  panel: {
    /** The room that the panel has for the drawing, a side 0 if it is not known, as while hidden. */
    roomWidth: number;
    roomHeight: number;
    /** The width of the whole panel. */
    width: number;
  },
): string | undefined {
  const { width, height, textSize: size, type, turned } = drawing;
  const known = panel.roomWidth > 0;
  const room = {
    width: known ? panel.roomWidth : NARROW_ROOM,
    height: known && panel.roomHeight > 0 ? panel.roomHeight : Number.POSITIVE_INFINITY,
  };
  /** How many times as wide as the room a drawing of the size is shown. */
  const across = (drawn: { width: number; height: number }) =>
    (drawn.width * fittingZoom(drawn, room, size)) / room.width;
  if (!(width > 0 && height > 0 && size) || across({ width, height }) <= MAX_SCROLL) {
    return undefined;
  }
  const zoom = fittingZoom({ width, height }, room, size);
  const remedies: string[] = [];
  const narrower = NARROWER[type];
  if (narrower) remedies.push(narrower);
  // The other direction lays the drawing out across its height, roughly.
  if (turned && across({ width: height, height: width }) <= MAX_SCROLL) remedies.push(turned);
  // A drawing a little too wide fits a somewhat wider panel, whose room for the drawing grows at
  // least in proportion, as the split view shares it. There, the zoom that fits it is as far as
  // fitting the height or its text leaves it.
  const least = fittingZoom({ width, height }, { width: 0, height: room.height }, size);
  const wider = (panel.width * width * least) / MAX_SCROLL / room.width;
  if (known && wider <= panel.width * MAX_WIDENING) {
    remedies.push(`widen the panel to at least ${formatCount(Math.ceil(wider / 10) * 10)} px`);
  }
  // A packet is split into rows already.
  if (type !== "packet") remedies.push("split it into several diagrams");
  const where = `${known ? "the panel's" : "a narrow panel's"} ${formatCount(Math.round(room.width))} px`;
  const part = Math.max(1, Math.round((100 * room.width) / (width * zoom)));
  return (
    `Too wide: ${where} show the ${formatCount(Math.round(width))} px wide drawing at ${Math.round(zoom * 100)}%, ` +
    `where its ${round(size)} px text is ${round(size * zoom)} px, and only ${part}% of its width at a time; ` +
    `the user scrolls sideways for the rest. ${capitalize(joinWords(remedies, "or"))}.`
  );
}

/** A size as a message gives it: to a pixel, or to a tenth of one below 10. */
const round = (size: number) => String(size >= 10 ? Math.round(size) : Math.round(size * 10) / 10);

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** A graph of more nodes or edges than read well in one diagram. */
function tooLarge({ type, db }: DrawingFacts): string | undefined {
  if (!GRAPHS.test(type)) return undefined;
  const { nodes = [], edges = [] } = db?.getData?.() ?? {};
  const count = nodes.filter((node) => !node.isGroup).length;
  if (count <= MAX_NODES && edges.length <= MAX_EDGES) return undefined;
  return `Hard to follow: ${formatCount(count)} nodes and ${formatCount(edges.length)} edges, where about ${MAX_NODES} nodes or ${MAX_EDGES} edges read well in one diagram. Split it into several diagrams.`;
}

/**
 * The nodes of a flowchart that no edge leads to or from, outside of subgraphs, where nodes often
 * stand alone: usually a node declared under one id and linked under another.
 */
function loneNodes({ type, db }: DrawingFacts): string | undefined {
  if (!FLOWCHART.test(type)) return undefined;
  const { nodes = [], edges = [] } = db?.getData?.() ?? {};
  if (edges.length < MIN_EDGES_FOR_LONE_NODES) return undefined;
  const linked = new Set(edges.flatMap(({ start, end }) => [start, end]));
  const lone = nodes.filter((node) => !node.isGroup && !node.parentId && !linked.has(node.id));
  if (lone.length === 0) return undefined;
  const named = lone
    .slice(0, EXAMPLES)
    .map(({ id, label }) =>
      label && label !== id ? `${JSON.stringify(id)} (${quote(label, 30)})` : JSON.stringify(id),
    );
  const list =
    lone.length > EXAMPLES
      ? `${named.join(", ")} and ${formatCount(lone.length - EXAMPLES)} more`
      : joinWords(named, "and");
  return lone.length === 1
    ? `Node ${list} is linked to no other node: link it, or check that its id is the one its edges use.`
    : `Nodes ${list} are linked to no other node: link them, or check that their ids are the ones their edges use.`;
}

/** Whether an element or one of its ancestors in the drawing hides it. */
function hidden(element: Element, svg: SVGSVGElement): boolean {
  for (let at: Element | null = element; at && at !== svg; at = at.parentElement) {
    const style = (at as SVGElement | HTMLElement).style;
    if (
      at.getAttribute("visibility") === "hidden" ||
      at.getAttribute("display") === "none" ||
      style?.visibility === "hidden" ||
      style?.display === "none"
    ) {
      return true;
    }
  }
  return false;
}

/** Whether the element is drawn turned, as the slanted labels of some axes are. */
function turned(element: Element): boolean {
  const matrix = (element as SVGGraphicsElement).getCTM?.();
  return !!matrix && (Math.abs(matrix.b) > 1e-6 || Math.abs(matrix.c) > 1e-6);
}

/**
 * Where the text of a label is drawn. A foreign object can be much larger than the HTML text in it,
 * as those of a Venn diagram's items are: take the text alone.
 */
function textBox(label: Element): DOMRect {
  if (!label.matches("foreignObject")) return label.getBoundingClientRect();
  const range = document.createRange();
  const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
  let [left, top, right, bottom] = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  while (walker.nextNode()) {
    if (!walker.currentNode.nodeValue?.trim()) continue;
    range.selectNodeContents(walker.currentNode);
    const box = range.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    left = Math.min(left, box.left);
    top = Math.min(top, box.top);
    right = Math.max(right, box.right);
    bottom = Math.max(bottom, box.bottom);
  }
  return left < right ? new DOMRect(left, top, right - left, bottom - top) : new DOMRect();
}

/**
 * Labels drawn over each other: by a quarter of the smaller one, over half of its height, which
 * lines of text stacked closely, whose boxes take in the space between lines, do not.
 */
function overlappingLabels(svg: SVGSVGElement): string | undefined {
  const boxes = labels(svg)
    .filter((label) => !hidden(label, svg) && !turned(label))
    .map((label) => ({ label, box: textBox(label) }))
    .filter(({ box }) => box.width > 0 && box.height > 0)
    .sort((a, b) => a.box.left - b.box.left);
  const pairs: [Element, Element][] = [];
  for (const [i, { label, box: a }] of boxes.entries()) {
    for (let j = i + 1; j < boxes.length; j++) {
      const { label: other, box: b } = boxes[j] as (typeof boxes)[number];
      if (b.left >= a.right) break;
      const width = Math.min(a.right, b.right) - b.left;
      const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      const smaller = a.width * a.height < b.width * b.height ? a : b;
      if (
        height > smaller.height / 2 &&
        width * height > (smaller.width * smaller.height) / 4 &&
        !label.contains(other) &&
        !other.contains(label)
      ) {
        pairs.push([label, other]);
      }
    }
  }
  const [first] = pairs;
  if (!first) return undefined;
  const text = (label: Element) => quote((label.textContent ?? "").replace(/\s+/g, " ").trim(), 30);
  const count = pairs.length > 1 ? ` (${formatCount(pairs.length)} pairs)` : "";
  return `Labels overlap, such as ${text(first[0])} and ${text(first[1])}${count}: shorten them, or draw fewer or more widely spaced items.`;
}

/**
 * The labels of links drawn over nodes, as Mermaid draws those of links between blocks that it
 * puts side by side: by a quarter of the label, over half of its height. Not over groups of nodes,
 * such as a block diagram's composite blocks, which hold the links between their nodes.
 */
function labelsOverNodes(svg: SVGSVGElement): string | undefined {
  const drawn = Array.from(svg.querySelectorAll("g.node"), (node) => ({
    node,
    box: node.getBoundingClientRect(),
  }));
  const holds = (outer: DOMRect, inner: DOMRect) =>
    inner.left >= outer.left &&
    inner.right <= outer.right &&
    inner.top >= outer.top &&
    inner.bottom <= outer.bottom;
  const nodes = drawn.filter(
    ({ node, box }) => !drawn.some((other) => other.node !== node && holds(box, other.box)),
  );
  const over: [Element, Element][] = [];
  for (const edge of svg.querySelectorAll("g.edgeLabel")) {
    const label = edge.querySelector("foreignObject, text");
    if (!label?.textContent?.trim() || hidden(label, svg)) continue;
    const a = textBox(label);
    for (const { node, box: b } of nodes) {
      const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (width > 0 && height > a.height / 2 && width * height > (a.width * a.height) / 4) {
        over.push([label, node]);
      }
    }
  }
  const [first] = over;
  if (!first) return undefined;
  const text = (element: Element) =>
    quote((element.textContent ?? "").replace(/\s+/g, " ").trim(), 30);
  const count = over.length > 1 ? ` (${formatCount(over.length)} pairs)` : "";
  return `Labels of links lie over nodes, such as ${text(first[0])} over ${text(first[1])}${count}: leave room between the nodes they link, as a space block does between blocks, or shorten the labels.`;
}
