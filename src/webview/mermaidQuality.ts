// Tells a model, which cannot see the drawing, where a Mermaid diagram reads badly in the panel:
// measured on the drawing, and only when it is a problem.

import { formatCount, joinWords, quote } from "../text";
import { diagramHeader } from "./mermaidLayout";
import type { DiagramDb } from "./mermaidNodes";

/** Text smaller than this many CSS pixels on screen is too small to read. */
const MIN_TEXT = 5;
/**
 * The width that a narrow panel beside the chat has for a drawing, which text is measured at while
 * the panel's size is not known.
 */
const NARROW_ROOM = 500;
/**
 * Fitting a drawing to the panel never shrinks it below this for its height (see the renderer's
 * MIN_HEIGHT_FIT): below this, it shrinks to fit the width alone.
 */
const HEIGHT_FIT = 0.6;
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
  /**
   * The width that the panel has for the drawing, in CSS pixels, or 0 if it is not known, as while
   * the panel is hidden.
   */
  roomWidth: number;
  /** The width of the whole panel. */
  panelWidth: number;
}

/**
 * Warnings about how the drawing reads: text too small to read when fit to the panel, more nodes
 * than read well, flowchart nodes linked to nothing, labels drawn over each other, and Gantt tasks
 * placed after or until tasks that the chart does not have. The drawing must be laid out, as it is
 * in the layout container, where it is measured.
 */
export function readabilityWarnings(svg: SVGSVGElement, facts: DrawingFacts): string[] {
  return [
    tooSmall(svg, facts),
    tooLarge(facts),
    loneNodes(facts),
    overlappingLabels(svg),
    unknownTasks(facts),
  ].filter((warning) => warning !== undefined);
}

/**
 * The first Gantt task that starts after, or ends at, a task id that no task has, which Mermaid
 * leaves out, and places the task from or to today if it names no other.
 */
function unknownTasks({ type, db }: DrawingFacts): string | undefined {
  if (type !== "gantt") return undefined;
  const tasks = db?.getTasks?.() ?? [];
  const ids = new Set(tasks.map(({ id }) => id));
  const references = (text: string | undefined, keyword: string) =>
    new RegExp(`^${keyword}\\s+([\\w -]+)`)
      .exec(text?.trim() ?? "")?.[1]
      ?.split(" ")
      .filter(Boolean) ?? [];
  const missing = tasks.flatMap((task) =>
    (
      [
        ["after", task.raw?.startTime?.startData, "starts", "from"],
        ["until", task.raw?.endTime?.data, "ends", "to"],
      ] as const
    ).flatMap(([keyword, text, does, from]) => {
      const named = references(text, keyword);
      const unknown = named.filter((id) => !ids.has(id));
      return unknown.length > 0 ? [{ task, keyword, does, from, named, unknown }] : [];
    }),
  );
  const [first] = missing;
  if (!first) return undefined;
  const { task, keyword, does, from, named, unknown } = first;
  const which = joinWords(
    unknown.map((id) => JSON.stringify(id)),
    "or",
  );
  const placed =
    unknown.length === named.length
      ? `so Mermaid draws it ${from} today`
      : `and Mermaid leaves ${unknown.length > 1 ? "them" : "it"} out`;
  // Ids that the source gives, rather than those that Mermaid makes up for the others.
  const example = tasks.find(({ id }) => id && id !== task.id && !/^task\d+$/.test(id))?.id;
  const more = missing.length > 1 ? ` (and ${formatCount(missing.length - 1)} more)` : "";
  return `Task ${quote(task.task?.trim() ?? "", 40)} ${does} with "${keyword} ${named.join(" ")}", but no task has the id ${which}${more}, ${placed}: give the id of a task${example ? `, such as ${JSON.stringify(example)}` : ""}, or a date.`;
}

/** The elements that hold the text of labels: SVG text, and HTML in foreign objects. */
function labels(svg: SVGSVGElement): Element[] {
  return Array.from(svg.querySelectorAll("text, foreignObject")).filter(
    (label) =>
      !(label.matches("text") && label.closest("foreignObject")) && label.textContent?.trim(),
  );
}

/** The font size, in the drawing's units, of most of its text: the median of its labels' sizes. */
function textSize(svg: SVGSVGElement): number | undefined {
  const sizes: number[] = [];
  for (const label of labels(svg)) {
    // The elements whose own text shows, as the size of an HTML label's text is that of its span.
    const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
    const holders = new Set<Element>();
    while (walker.nextNode()) {
      const { currentNode } = walker;
      if (currentNode.nodeValue?.trim() && currentNode.parentElement) {
        holders.add(currentNode.parentElement);
      }
    }
    for (const holder of holders) {
      const size = Number.parseFloat(getComputedStyle(holder).fontSize);
      if (size > 0) sizes.push(size);
    }
  }
  sizes.sort((a, b) => a - b);
  return sizes[Math.floor(sizes.length / 2)];
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
 * Text that fitting the drawing to the panel's width, or to that of a narrow panel if the panel's is
 * not known, shows too small to read. A drawing is fit to the width alone below HEIGHT_FIT, where
 * text of any size that Mermaid draws by default reads.
 */
function tooSmall(svg: SVGSVGElement, facts: DrawingFacts): string | undefined {
  const { width, height } = svg.viewBox.baseVal;
  const known = facts.roomWidth > 0;
  const room = known ? facts.roomWidth : NARROW_ROOM;
  const fit = room / width;
  if (!(width > 0 && fit < HEIGHT_FIT)) return undefined;
  const size = textSize(svg);
  if (size === undefined || size * fit >= MIN_TEXT) return undefined;
  const remedies: string[] = [];
  const narrower = NARROWER[facts.type];
  if (narrower) remedies.push(narrower);
  // The other direction lays the drawing out across its height, roughly, which helps if that
  // makes it narrow enough to read.
  const turned = otherDirection(facts);
  if (turned && size * (room / height) >= MIN_TEXT) remedies.push(turned);
  // A drawing a little too wide reads in a somewhat wider panel, whose room for the drawing grows
  // at least in proportion, as the split view shares it.
  const panel = facts.panelWidth;
  const wider = (panel * width * MIN_TEXT) / size / room;
  if (known && wider <= panel * MAX_WIDENING) {
    remedies.push(`widen the panel to at least ${formatCount(Math.ceil(wider / 10) * 10)} px`);
  }
  // A packet is split into rows already.
  if (facts.type !== "packet") remedies.push("split it into several diagrams");
  const fits = known ? "the panel's" : "a narrow panel's";
  return (
    `Too small to read: the ${formatCount(Math.round(width))} px wide drawing fits ${fits} ${formatCount(Math.round(room))} px width ` +
    `at ${Math.round(fit * 100)}%, which shows its ${round(size)} px text at ${round(size * fit)} px. ` +
    `${capitalize(joinWords(remedies, "or"))}.`
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
