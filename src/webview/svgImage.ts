// Self-contained SVG images of a drawing in the panel, to export or to drag into other
// applications.

import type { DiagramImage } from "./images";

export const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
/** The namespace of the targets of links that SVG draws, as Mermaid writes them. */
export const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

/** Where a link leads, as HTML or SVG writes it, if it has a target at all. */
export const hrefOf = (link: Element): string | null =>
  link.getAttribute("href") ?? link.getAttributeNS(XLINK_NAMESPACE, "href");

/** Attributes that only make the rendering interactive in the panel, which an image does not need. */
const INTERACTION_ATTRIBUTES = ["tabindex", "role", "aria-pressed", "data-diagram-id"];

/** What XML 1.0 does not allow in a document, not even as a character reference. */
const NOT_IN_XML = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

/** An HTML label but for a formula, whose text would be its TeX. */
const HTML_LABEL = "foreignObject:not(:has(math))";
const HTML_LABEL_WITH_FALLBACK = `switch > ${HTML_LABEL}`;

/** A computed color that paints nothing. */
const TRANSPARENT = /^rgba\([^)]*,\s*0\)$/;

/** The font properties that an HTML label's text keeps as SVG text. */
const FONT = ["font-family", "font-size", "font-style", "font-weight", "letter-spacing"];
/** Where the ascent and descent of fonts are measured. */
let fonts: CanvasRenderingContext2D | null | undefined;

/**
 * The text of an HTML label in the document as SVG text, a text element for each piece of a text
 * node on a line, where the browser lays it out: wrapped, aligned and styled as it shows it, on the
 * backgrounds that its HTML paints, such as an edge label's. Undefined if it shows none.
 */
function labelAsText(label: SVGForeignObjectElement): SVGGElement | undefined {
  fonts ??= document.createElement("canvas").getContext("2d");
  const toUser = label.getScreenCTM()?.inverse();
  if (!toUser || !fonts) return undefined;
  const measure = fonts;
  /**
   * Where a box in the document is in the label's units, which its font size is in: its left, its
   * middle and its size, along the lines of a label that the drawing turns, such as a vertical lane
   * title.
   */
  const place = ({ left, top, right, bottom }: DOMRect) => {
    const corners = [
      [left, top],
      [right, top],
      [left, bottom],
      [right, bottom],
    ].map(([x, y]) => new DOMPoint(x, y).matrixTransform(toUser));
    const xs = corners.map(({ x }) => x);
    const ys = corners.map(({ y }) => y);
    const [x, y] = [Math.min(...xs), Math.min(...ys)];
    const height = Math.max(...ys) - y;
    return { x, middle: y + height / 2, width: Math.max(...xs) - x, height };
  };
  const group = document.createElementNS(SVG_NAMESPACE, "g");
  for (const element of label.querySelectorAll("*")) {
    const color = getComputedStyle(element).backgroundColor;
    if (TRANSPARENT.test(color)) continue;
    // A box for each line of an element on several.
    for (const box of element.getClientRects()) {
      const { x, middle, width, height } = place(box);
      if (!width || !height) continue;
      const rect = document.createElementNS(SVG_NAMESPACE, "rect");
      for (const [name, value] of Object.entries({ x, y: middle - height / 2, width, height })) {
        rect.setAttribute(name, String(value));
      }
      rect.style.fill = color;
      group.append(rect);
    }
  }
  const backgrounds = group.childElementCount;
  const range = document.createRange();
  const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const style = getComputedStyle(node.parentElement as Element);
    let run: { text: string; x: number; middle: number } | undefined;
    const end = () => {
      if (!run) return;
      // The baseline, with the font's ascent and descent around the middle of the line.
      measure.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const { fontBoundingBoxAscent: ascent, fontBoundingBoxDescent: descent } =
        measure.measureText("");
      const element = document.createElementNS(SVG_NAMESPACE, "text");
      element.setAttribute("x", String(run.x));
      element.setAttribute("y", String(run.middle + (ascent - descent) / 2));
      for (const name of FONT) element.style.setProperty(name, style.getPropertyValue(name));
      element.style.fill = style.color;
      // From where the line starts, on its baseline, whatever the drawing's style sheet says of
      // the text of labels, such as a flowchart's, which centers it.
      element.style.textAnchor = "start";
      element.style.dominantBaseline = "auto";
      element.textContent = run.text.trimEnd();
      group.append(element);
      run = undefined;
    };
    for (let i = 0; i < node.length; ) {
      const char = String.fromCodePoint(node.data.codePointAt(i) as number);
      range.setStart(node, i);
      i += char.length;
      range.setEnd(node, i);
      const box = place(range.getBoundingClientRect());
      // Whitespace that the browser collapses has no width; a line starts with none.
      if (!box.width || (!run && !char.trim())) continue;
      if (run && Math.abs(box.middle - run.middle) > box.height / 2) end();
      run ??= { text: "", x: box.x, middle: box.middle };
      run.text += char;
      run.x = Math.min(run.x, box.x);
    }
    end();
  }
  return group.childElementCount > backgrounds ? group : undefined;
}

/**
 * A computed value as applications that read SVG 1.1 also know it: they may not read a
 * transparent color, which would paint black.
 */
function portable(property: string, value: string): string {
  return (property === "fill" || property === "stroke") && value === "rgba(0, 0, 0, 0)"
    ? "none"
    : value;
}

/**
 * A quoted url() of an element in the image, as a style attribute that CSSOM wrote holds it in
 * markup, which applications that read SVG 1.1 may not read: CSSOM quotes it whatever it is given.
 */
const QUOTED_URL = /url\(&quot;(#[^&()\s]+)&quot;\)/g;

/**
 * Writes what the drawing's style sheets give each element into its style attribute, and leaves
 * the sheets only the keyframes of its animations. Mermaid styles its drawings with rules such as
 * `#id .node rect`, which applications that read SVG without a browser engine may ignore, misread
 * or fail to parse, such as Illustrator, Figma, Office and older Inkscape: shapes come out black.
 * Every one of them reads a style attribute. The drawing must be in the document to be styled.
 *
 * The root keeps no style, as standaloneSvg drops it: its children are given what it passes on.
 */
export function inlineStyleSheets(svg: SVGSVGElement): void {
  // Style the drawing as it is drawn on its own, inheriting nothing from the panel, such as its
  // font, which Mermaid draws in too: its rule for the font would otherwise seem to change nothing.
  // Only its color stays, which standaloneSvg gives the image.
  const isolated = document.createElement("div");
  isolated.style.all = "initial";
  isolated.style.color = getComputedStyle(svg).color;
  svg.replaceWith(isolated);
  // Moving a style element parses its sheet anew: read the sheets where they now are.
  isolated.append(svg);
  try {
    const sheets = [...svg.querySelectorAll("style")].flatMap((style) => style.sheet ?? []);
    const rules = sheets.flatMap((sheet) => [...sheet.cssRules]);
    const declared = new Set<string>();
    const onRoot = new Set<string>();
    for (const rule of rules) {
      if (!(rule instanceof CSSStyleRule)) continue;
      // Custom properties are resolved where they are used.
      const names = [...rule.style].filter((name) => !name.startsWith("--"));
      for (const name of names) declared.add(name);
      if (svg.matches(rule.selectorText)) for (const name of names) onRoot.add(name);
    }
    const properties = [...declared];
    const elements = [
      ...svg.querySelectorAll<SVGElement | HTMLElement | MathMLElement>(":not(style, title, desc)"),
    ];
    const styled = elements.map((element) => {
      const style = getComputedStyle(element);
      return properties.map((name) => style.getPropertyValue(name));
    });
    for (const sheet of sheets) sheet.disabled = true;
    // In document order, so that each element inherits what its parent was given. What the root
    // passes on, such as Mermaid's font size, must not come from where the image is put instead.
    elements.forEach((element, index) => {
      const style = getComputedStyle(element);
      const child = element.parentNode === svg;
      properties.forEach((name, at) => {
        const value = styled[index]?.[at] ?? "";
        if (style.getPropertyValue(name) !== value || (child && onRoot.has(name))) {
          element.style.setProperty(name, portable(name, value));
        }
      });
    });
    // Keep the keyframes of animated edges.
    const animated = new Set(
      styled.flatMap((values) => values[properties.indexOf("animation-name")]?.split(", ") ?? []),
    );
    for (const style of svg.querySelectorAll("style")) {
      const kept = [...(style.sheet?.cssRules ?? [])].filter(
        (rule) => rule instanceof CSSKeyframesRule && animated.has(rule.name),
      );
      if (kept.length > 0) style.textContent = kept.map((rule) => rule.cssText).join("\n");
      else style.remove();
    }
  } finally {
    isolated.replaceWith(svg);
  }
}

/** A part of a drawing, in its units: CSS pixels of the drawing at 100%. */
export interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Clones the drawing with a background, without panel interaction attributes or link targets: all
 * of it, or the area of it given.
 */
export function standaloneSvg(
  source: SVGSVGElement,
  background: string,
  area?: Area,
): DiagramImage {
  const svg = source.cloneNode(true) as SVGSVGElement;
  svg.setAttribute("xmlns", SVG_NAMESPACE);
  svg.setAttribute("xmlns:xlink", XLINK_NAMESPACE);
  // The panel sizes the rendering with CSS, which the image is read without.
  svg.removeAttribute("style");
  svg.removeAttribute("class");
  // Mermaid leaves the color of some HTML labels, such as sequence diagram formulas, to the panel.
  svg.style.color = getComputedStyle(source).color;

  const { x, y, width, height } = area ?? drawingArea(source);
  svg.setAttribute("viewBox", `${x} ${y} ${width} ${height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));

  for (const element of svg.querySelectorAll(".diagram-relationship-hit")) element.remove();
  for (const name of INTERACTION_ATTRIBUTES) {
    for (const element of svg.querySelectorAll(`[${name}]`)) element.removeAttribute(name);
  }
  // An HTML label with a text fallback (Mermaid's user journeys): keep the text, which every
  // application that reads SVG draws, unless the label is a formula, of which the text is TeX.
  // Mermaid fills the text as it fills the box the label is in, so give it the label's color.
  const labels = source.querySelectorAll(HTML_LABEL_WITH_FALLBACK);
  svg.querySelectorAll(HTML_LABEL_WITH_FALLBACK).forEach((element, index) => {
    const text = element.parentElement?.querySelector(":scope > text");
    const shown = labels[index]?.querySelector("*:not(:has(*))");
    if (text instanceof SVGElement && shown) text.style.fill = getComputedStyle(shown).color;
    element.remove();
  });
  // Other HTML labels, which Mermaid draws for some diagrams whatever it is told, such as event
  // models: their text as SVG text, where it shows in the drawing.
  const html = `${HTML_LABEL}:not(switch > *)`;
  const shown = source.querySelectorAll<SVGForeignObjectElement>(html);
  svg.querySelectorAll(html).forEach((element, index) => {
    const label = shown[index];
    const text = label && labelAsText(label);
    if (!text) return;
    const transform = element.getAttribute("transform");
    if (transform) text.setAttribute("transform", transform);
    element.replaceWith(text);
  });
  // Formulas draw beyond the boxes that Mermaid sizes to their line boxes, as in the panel.
  for (const element of svg.querySelectorAll("foreignObject")) {
    element.setAttribute("overflow", "visible");
  }
  // Remove where links lead, from their targets and the panel's tooltips that name them, keeping
  // the diagram's own tooltips.
  for (const title of svg.querySelectorAll("title.diagram-link")) {
    title.remove();
  }
  for (const link of svg.querySelectorAll("a")) {
    for (const name of ["href", "xlink:href", "data-href", "target"]) link.removeAttribute(name);
  }

  const rect = svg.ownerDocument.createElementNS(SVG_NAMESPACE, "rect");
  rect.setAttribute("x", String(x));
  rect.setAttribute("y", String(y));
  rect.setAttribute("width", String(width));
  rect.setAttribute("height", String(height));
  rect.setAttribute("fill", background);
  svg.prepend(rect);

  // The serializer keeps characters that XML does not allow, such as control characters in labels,
  // for which strict parsers, and browsers drawing the SVG as an image, refuse all of it.
  const markup = new XMLSerializer()
    .serializeToString(svg)
    .replace(NOT_IN_XML, "")
    .replace(QUOTED_URL, "url($1)");
  return { svg: markup, width, height };
}

/** All of a drawing, in its units. */
export function drawingArea(svg: SVGSVGElement): Area {
  const box = svg.viewBox.baseVal;
  if (box?.width) return { x: box.x, y: box.y, width: box.width, height: box.height };
  // ECharts sets width and height without a viewBox. Its DOM bounds disappear in Source view,
  // but those intrinsic dimensions still describe the drawing.
  return {
    x: 0,
    y: 0,
    width: svg.width.baseVal.value || svg.getBoundingClientRect().width,
    height: svg.height.baseVal.value || svg.getBoundingClientRect().height,
  };
}

/** How far around the items that a model asks to see the image goes, to show what is next to them. */
const AREA_MARGIN = 40;

/** The area around the boxes, in the drawing's units, with a margin, within the drawing. */
export function areaAround(
  drawing: Area,
  boxes: readonly Area[],
  margin = AREA_MARGIN,
): Area | undefined {
  if (boxes.length === 0) return undefined;
  const left = Math.max(drawing.x, Math.min(...boxes.map((box) => box.x)) - margin);
  const top = Math.max(drawing.y, Math.min(...boxes.map((box) => box.y)) - margin);
  const right = Math.min(
    drawing.x + drawing.width,
    Math.max(...boxes.map((box) => box.x + box.width)) + margin,
  );
  const bottom = Math.min(
    drawing.y + drawing.height,
    Math.max(...boxes.map((box) => box.y + box.height)) + margin,
  );
  return right > left && bottom > top
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : undefined;
}

/**
 * The area of a drawing in the document grown to take in the SVG text that it cuts into, within
 * the drawing.
 */
export function withTextIn(svg: SVGSVGElement, drawing: Area, area: Area): Area {
  const boxes = [area];
  for (const text of svg.querySelectorAll("text")) {
    const box = boxOf(svg, text);
    if (
      box &&
      box.x < area.x + area.width &&
      box.x + box.width > area.x &&
      box.y < area.y + area.height &&
      box.y + box.height > area.y
    ) {
      boxes.push(box);
    }
  }
  return areaAround(drawing, boxes, 0) ?? area;
}

/** Where an element of a drawing in the document is drawn, in the drawing's units, if anywhere. */
export function boxOf(svg: SVGSVGElement, element: Element): Area | undefined {
  const toUser = svg.getScreenCTM()?.inverse();
  const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
  if (!toUser || (!width && !height)) return undefined;
  const start = new DOMPoint(left, top).matrixTransform(toUser);
  const end = new DOMPoint(right, bottom).matrixTransform(toUser);
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

/**
 * The font size of most of the text of a drawing, in the drawing's units: the median of those of
 * its SVG text, also in spans, and its HTML labels, as far as the drawing scales them.
 */
export function textSize(svg: SVGSVGElement): number | undefined {
  // Relative to the drawing's units, which the panel zooms. A drawing out of sight has no scale.
  const root = svg.getScreenCTM();
  const scaleOf = (element: Element | null) => {
    const matrix = element instanceof SVGGraphicsElement ? element.getScreenCTM() : null;
    return matrix && root ? Math.hypot(matrix.a, matrix.b) / Math.hypot(root.a, root.b) : 1;
  };
  const sizes: number[] = [];
  for (const element of svg.querySelectorAll("text, tspan, foreignObject *")) {
    // The elements with text of their own, rather than those that hold lines or words of it.
    const hasText = Array.from(element.childNodes).some(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
    );
    const size = Number.parseFloat(getComputedStyle(element).fontSize);
    if (!hasText || !(size > 0)) continue;
    sizes.push(size * scaleOf(element.closest("text, foreignObject")));
  }
  sizes.sort((a, b) => a - b);
  return sizes[Math.floor(sizes.length / 2)];
}
