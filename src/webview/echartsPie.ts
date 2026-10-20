// Fits a pie into the space left for it, with its labels around it where they fit: on lines from
// the edge of the chart, cut short where a word of a name is wider than the room beside the pie.

import { asArray, isPlainObject } from "../protocol";
import {
  BOX_KEYS,
  has,
  type Insets,
  MAX_READ_CATEGORIES,
  pixels,
  type Size,
  styleOf,
  WORDS,
} from "./echartsMeasure";
import type { JsonObject } from "./echartsOption";

/** Fits a single pie into the space left, with labels around it when they fit. */
export function layOutPie(
  base: JsonObject,
  series: JsonObject[],
  reserved: Insets,
  size: Size,
): void {
  const pies = series.filter((s) => s.type === "pie");
  const pie = pies.length === 1 ? pies[0] : undefined;
  if (!pie || has(pie, [...BOX_KEYS, "center"])) {
    return;
  }
  // ECharts 6 lays out pies in a box; the radius percentage is relative to the box.
  Object.assign(pie, {
    left: reserved.left + 8,
    right: reserved.right + 8,
    top: reserved.top + 8,
    bottom: reserved.bottom + 8,
  });
  const boxWidth = size.width - reserved.left - reserved.right - 16;
  const boxHeight = size.height - reserved.top - reserved.bottom - 16;
  let label = styleOf(pie.label);
  const hasLegend = asArray(base.legend).some((l) => l.show !== false);
  if (
    !labelsSet(pie) &&
    hasLegend &&
    (boxHeight < 220 || !pieLabelsFit(pie, boxWidth, boxHeight, size))
  ) {
    // Too small for labels around the pie: the legend and tooltip name the slices.
    label = hidePieLabels(pie);
  }
  const outsideLabels =
    label.show !== false &&
    !["inside", "inner", "center"].includes(String(label.position ?? "outside"));
  // A radius of the option's own stays as it is, as of a doughnut.
  const chosen = pie.radius === undefined;
  if (chosen) {
    // In a wide box, the labels fit beside the pie, which can then take more of the height.
    const ratio = boxWidth / Math.max(1, boxHeight);
    const radius = !outsideLabels
      ? 90
      : ratio >= 1.6
        ? 76
        : ratio >= 1.2
          ? 68
          : ratio >= 0.9
            ? 58
            : 50;
    pie.radius = `${radius}%`;
  }
  const line = styleOf(pie.labelLine);
  const outer = outerRadius(pie.radius, Math.min(boxWidth, boxHeight) / 2);
  // ECharts' parts of a label line.
  const [length, length2] = [line.length ?? 15, line.length2 ?? 30];
  const labels = pieLabels(pie, size);
  if (
    !outsideLabels ||
    (label.alignTo ?? "edge") !== "edge" ||
    outer === undefined ||
    typeof length !== "number" ||
    typeof length2 !== "number" ||
    labels === undefined ||
    // Beside the pie: after the line, the gap to the label, and ECharts' margin to the edge.
    labels.every(
      ({ across, whole }) => across * (outer + length) + length2 + 5 + 10 + whole <= boxWidth / 2,
    )
  ) {
    return;
  }
  // Labels that do not fit beside the pie on one line go onto several, from the edge of the box
  // in to their line, and a pie of the panel's radius leaves the room for them.
  label.alignTo ??= "edge";
  label.edgeDistance ??= 8;
  const lines = label.width === undefined && label.overflow === undefined;
  if (lines) label.overflow = "break";
  pie.label = label;
  // The second part of a line is drawn out to its label at the edge anyway.
  line.length2 ??= 0;
  pie.labelLine = line;
  const most = labeledRadius(labels, boxWidth, length);
  const half = Math.min(boxWidth, boxHeight) / 2;
  if (chosen && outer > most) {
    pie.radius = scaleRadius(pie.radius, Math.max(most, MIN_LABELED_PIE * half) / outer);
  }
  // A word of a name wider than the room beside the pie, as of the option's radius, is cut short
  // rather than broken within it, which ECharts does to a word longer than a line, and the rest of
  // the label, as the share it tells, goes onto lines after it; a label of no name to cut short, or
  // beside too little room for its share, is cut short whole. The tooltip tells it whole.
  const radius = outerRadius(pie.radius, half) ?? outer;
  const edge = typeof label.edgeDistance === "number" ? label.edgeDistance : 8;
  // The room beside each slice whose label has a word wider than it.
  const rooms = labels.map(({ across, word }) => {
    const room = boxWidth / 2 - edge - 5 - across * (radius + length);
    return room < word ? room : undefined;
  });
  if (lines && Array.isArray(pie.data) && rooms.some((room) => room !== undefined)) {
    const { template, values } = labelTemplate(label);
    const width = labelWidth(label, size);
    pie.data = pie.data.map((item: unknown, index) => {
      const room = rooms[index];
      if (room === undefined) return item;
      const own: JsonObject = isPlainObject(item) ? item : { value: item };
      const itemLabel = styleOf(own.label);
      // A word as much of it as fits, with its ellipsis and the punctuation after it, as the ":"
      // of "{b}: {d}%". The ellipsis is of dots, which ECharts measures as wide as the browser
      // draws them: it breaks a line again where those differ, and "…" it takes for a wide one.
      const cut = (word: string) => {
        if (width(`${word}:`) <= room) return word;
        let kept = word.length - 1;
        while (kept > 0 && width(`${word.slice(0, kept)}...:`) > room) kept--;
        return kept > 0 ? `${word.slice(0, kept)}...` : undefined;
      };
      const name = own.name;
      const words = typeof name === "string" ? (name.match(WORDS) ?? []).map(cut) : [];
      const formatter =
        typeof name === "string" &&
        // Of a template, rather than a function of the option's own, which formats it.
        (label.formatter === undefined || typeof label.formatter === "string") &&
        template.includes("{b}") &&
        // Not of the markup of a template, which ECharts would read in the name.
        !/[{}]/.test(name) &&
        words.every((word) => word !== undefined) &&
        // Nor beside a value that the room is too narrow for, as "25.74%".
        room >= (values > 0 ? width(SHARE) : 0)
          ? template.replaceAll("{b}", () => words.join(""))
          : undefined;
      return {
        ...own,
        // Keep the width used to shorten words. ECharts otherwise narrows wrapped labels to
        // their drawn width, which can split the ellipsis when it measures characters again.
        label: formatter
          ? { formatter, width: room, ...itemLabel }
          : { overflow: "truncate", ellipsis: "…", ...itemLabel },
      };
    });
  }
}

/**
 * The template that labels the slices of a pie, by default their names, and how many values it
 * tells besides, as the "{d}" of "{b}: {d}%".
 */
function labelTemplate(label: JsonObject): { template: string; values: number } {
  const template = typeof label.formatter === "string" ? label.formatter : "{b}";
  return { template, values: template.match(/\{(?!b\})[^{}|]*\}/g)?.length ?? 0 };
}

/** A value as wide as most that a label tells, as "25.74%". */
const SHARE = "00.00%";

/**
 * The width of a text in the font of the names of a pie's labels: of the rich text style that
 * their template sets them in, as the "name" of "{name|{b}}", over the label's own, as ECharts
 * makes a name's font, as its size or weight, and else the chart's.
 */
function labelWidth(label: JsonObject, size: Size): (text: string) => number {
  const { template } = labelTemplate(label);
  const name = /\{(\w+)\|[^{}]*\{b\}/.exec(template)?.[1];
  const rich = isPlainObject(label.rich) && name !== undefined ? label.rich[name] : undefined;
  return size.font(...(isPlainObject(rich) ? [rich, label] : [label])).breakWidth;
}

/** Hides the labels of a pie's slices and their lines. Returns the label settings. */
export function hidePieLabels(pie: JsonObject): JsonObject {
  const label = { ...styleOf(pie.label), show: false };
  pie.label = label;
  pie.labelLine = { ...styleOf(pie.labelLine), show: false };
  return label;
}

/**
 * Whether the option sets how to label the slices of a pie, as with a template that tells their
 * shares: then it labels them, as long as it shows them, for want of room as well.
 */
export const labelsSet = (pie: JsonObject) =>
  isPlainObject(pie.label) && Object.keys(pie.label).length > 0;

/** The least radius of a pie with labels beside it, as a share of the radius it could have. */
const MIN_LABELED_PIE = 0.4;

/** The label of a slice of a pie, as wide as some pixels. */
interface PieLabel {
  /** How far across the pie the slice's middle is from its center, from 0 at the top to 1. */
  across: number;
  /** The width of the label on one line. */
  whole: number;
  /** The least width it goes onto three lines of, at least that of its longest word. */
  least: number;
  /** The width of its longest word. */
  word: number;
}

/**
 * The labels of a pie's slices, as ECharts places them: around the pie from its top, clockwise,
 * unless told otherwise. Undefined for more slices than the layout reads, which have no room for
 * labels; none for the slices of a dataset.
 */
function pieLabels(pie: JsonObject, size: Size): PieLabel[] | undefined {
  const data: unknown[] = Array.isArray(pie.data) ? pie.data : [];
  if (data.length > MAX_READ_CATEGORIES) return undefined;
  const label = styleOf(pie.label);
  const width = labelWidth(label, size);
  // ECharts labels a slice by its name, and a template adds its text and its values, each about
  // as wide as "25.74".
  const { template, values } = labelTemplate(label);
  const named = template.includes("{b}");
  const value = (item: unknown) => {
    const number = Number(isPlainObject(item) ? item.value : item);
    return Number.isFinite(number) && number > 0 ? number : 0;
  };
  const total = data.reduce((sum: number, item) => sum + value(item), 0);
  const start = typeof pie.startAngle === "number" ? pie.startAngle : 90;
  const turn = pie.clockwise === false ? 1 : -1;
  let before = 0;
  return data.map((item) => {
    const share = total > 0 ? value(item) / total : 1 / data.length;
    const middle = ((start + turn * 360 * (before + share / 2)) * Math.PI) / 180;
    before += share;
    const name = named ? String((isPlainObject(item) ? item.name : undefined) ?? "") : "";
    // With the punctuation after it, as the ":" of "{b}: {d}%".
    const word = Math.max(
      values > 0 ? width(SHARE) : 0,
      ...(name.match(WORDS) ?? []).map((part) => width(`${part}:`)),
    );
    const whole = width(
      template.replace(/\{[^{}|]*\}/g, (field) => (field === "{b}" ? name : SHARE.slice(0, -1))),
    );
    return {
      across: Math.abs(Math.cos(middle)),
      whole,
      least: Math.max(word, Math.ceil(whole / 3)),
      word,
    };
  });
}

/**
 * The most radius of a pie in a box whose labels go from the edge of the box in to their lines,
 * of a first part of a length, each as wide as the least it goes onto lines of.
 */
function labeledRadius(labels: PieLabel[], boxWidth: number, length: number): number {
  // The gap from the line to the label, the label's distance from the edge, and a margin.
  const room = boxWidth / 2 - 5 - 8 - 4;
  return Math.min(
    boxWidth / 2,
    ...labels.map(({ across, least }) =>
      across > 0.01 ? (room - least) / across - length : boxWidth / 2,
    ),
  );
}

/** Whether a pie's labels fit beside it in a box, on lines from its edge, if need be. */
export function pieLabelsFit(
  pie: JsonObject,
  boxWidth: number,
  boxHeight: number,
  size: Size,
): boolean {
  const labels = pieLabels(pie, size);
  const line = styleOf(pie.labelLine);
  const half = Math.min(boxWidth, boxHeight) / 2;
  // Beside the radius that the option gives, or else as small as the panel makes a pie.
  const radius = pie.radius === undefined ? MIN_LABELED_PIE * half : outerRadius(pie.radius, half);
  return (
    labels !== undefined &&
    radius !== undefined &&
    labeledRadius(labels, boxWidth, typeof line.length === "number" ? line.length : 15) >= radius
  );
}

/** The outer radius in pixels of a pie, of a box of a size half that, if it can tell. */
function outerRadius(radius: unknown, half: number): number | undefined {
  return pixels(Array.isArray(radius) ? radius[radius.length - 1] : radius, half);
}

/** A pie's radius, inner and outer, scaled by a factor, as percentages or pixels. */
function scaleRadius(radius: unknown, factor: number): unknown {
  const scale = (value: unknown) =>
    typeof value === "number"
      ? Math.round(value * factor)
      : typeof value === "string" && value.endsWith("%")
        ? `${Math.round(Number.parseFloat(value) * factor)}%`
        : value;
  return Array.isArray(radius) ? radius.map(scale) : scale(radius);
}
