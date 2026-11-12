import type { DiagramImage } from "./images";

export const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
export const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

export const hrefOf = (link: Element): string | null =>
  link.getAttribute("href") ?? link.getAttributeNS(XLINK_NAMESPACE, "href");

const INTERACTION_ATTRIBUTES = ["tabindex", "role", "aria-pressed", "data-diagram-id"];

// Not even as character references.
const NOT_IN_XML = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

// Not formulas, whose text is TeX.
const HTML_LABEL = "foreignObject:not(:has(math))";
const HTML_LABEL_WITH_FALLBACK = `switch > ${HTML_LABEL}`;

const TRANSPARENT = /^rgba\([^)]*,\s*0\)$/;

const FONT = ["font-family", "font-size", "font-style", "font-weight", "letter-spacing"];
let fonts: CanvasRenderingContext2D | null | undefined;

// Placed as the browser lays it out: a text element for each line of each text node.
function labelAsText(label: SVGForeignObjectElement): SVGGElement | undefined {
  fonts ??= document.createElement("canvas").getContext("2d");
  const toUser = label.getScreenCTM()?.inverse();
  if (!toUser || !fonts) return undefined;
  const measure = fonts;
  // In the label's units, along its lines, which the drawing may turn, as a vertical lane title.
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
      measure.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const { fontBoundingBoxAscent: ascent, fontBoundingBoxDescent: descent } =
        measure.measureText("");
      const element = document.createElementNS(SVG_NAMESPACE, "text");
      element.setAttribute("x", String(run.x));
      element.setAttribute("y", String(run.middle + (ascent - descent) / 2));
      for (const name of FONT) element.style.setProperty(name, style.getPropertyValue(name));
      element.style.fill = style.color;
      // Override the style sheet's centering, as of flowchart labels.
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
      // Collapsed whitespace has no width.
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

// SVG 1.1 readers may paint transparent colors black.
function portable(property: string, value: string): string {
  return (property === "fill" || property === "stroke") && value === "rgba(0, 0, 0, 0)"
    ? "none"
    : value;
}

// CSSOM always quotes url(), which SVG 1.1 readers may not read.
const QUOTED_URL = /url\(&quot;(#[^&()\s]+)&quot;\)/g;

// Mermaid's rules, such as `#id .node rect`, may be ignored by Illustrator, Figma, Office and older
// Inkscape, which draw shapes black, but all read style attributes. Keeps only the keyframes.
export function inlineStyleSheets(svg: SVGSVGElement): void {
  // Inherit nothing from the panel, such as its font, which would hide Mermaid's font rule.
  const isolated = document.createElement("div");
  isolated.style.all = "initial";
  isolated.style.color = getComputedStyle(svg).color;
  svg.replaceWith(isolated);
  // Moving a style element parses its sheet anew.
  isolated.append(svg);
  try {
    const sheets = [...svg.querySelectorAll("style")].flatMap((style) => style.sheet ?? []);
    const rules = sheets.flatMap((sheet) => [...sheet.cssRules]);
    const declared = new Set<string>();
    const onRoot = new Set<string>();
    for (const rule of rules) {
      if (!(rule instanceof CSSStyleRule)) continue;
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
    // In document order, so that each element inherits its parent's. standaloneSvg drops the
    // root's style, so its children get what it passes on, such as Mermaid's font size.
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

// CSS pixels of the drawing at 100%.
export interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function standaloneSvg(
  source: SVGSVGElement,
  background: string,
  area?: Area,
): DiagramImage {
  const svg = source.cloneNode(true) as SVGSVGElement;
  svg.setAttribute("xmlns", SVG_NAMESPACE);
  svg.setAttribute("xmlns:xlink", XLINK_NAMESPACE);
  svg.removeAttribute("style");
  svg.removeAttribute("class");
  // Mermaid leaves some HTML labels' color, as of sequence diagram formulas, to the panel.
  svg.style.color = getComputedStyle(source).color;

  const { x, y, width, height } = area ?? drawingArea(source);
  svg.setAttribute("viewBox", `${x} ${y} ${width} ${height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));

  for (const element of svg.querySelectorAll(".diagram-relationship-hit")) element.remove();
  for (const name of INTERACTION_ATTRIBUTES) {
    for (const element of svg.querySelectorAll(`[${name}]`)) element.removeAttribute(name);
  }
  // Keep the text fallback of HTML labels (user journeys), in the label's color, as Mermaid fills
  // it as the box.
  const labels = source.querySelectorAll(HTML_LABEL_WITH_FALLBACK);
  svg.querySelectorAll(HTML_LABEL_WITH_FALLBACK).forEach((element, index) => {
    const text = element.parentElement?.querySelector(":scope > text");
    const shown = labels[index]?.querySelector("*:not(:has(*))");
    if (text instanceof SVGElement && shown) text.style.fill = getComputedStyle(shown).color;
    element.remove();
  });
  // Mermaid draws HTML labels for some diagrams, such as event models, whatever it is told.
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
  // Formulas draw beyond the boxes that Mermaid sizes them.
  for (const element of svg.querySelectorAll("foreignObject")) {
    element.setAttribute("overflow", "visible");
  }
  // Remove link targets and the panel's tooltips naming them.
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

  // The serializer keeps characters XML disallows, for which strict parsers, and browsers drawing
  // the SVG as an image, refuse all of it.
  const markup = new XMLSerializer()
    .serializeToString(svg)
    .replace(NOT_IN_XML, "")
    .replace(QUOTED_URL, "url($1)");
  return { svg: markup, width, height };
}

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

const AREA_MARGIN = 40;

export function areaAround(
  drawing: Area,
  boxes: readonly Area[],
  margin = AREA_MARGIN,
): Area | undefined {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const box of boxes) {
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.width);
    bottom = Math.max(bottom, box.y + box.height);
  }
  left = Math.max(drawing.x, left - margin);
  top = Math.max(drawing.y, top - margin);
  right = Math.min(drawing.x + drawing.width, right + margin);
  bottom = Math.min(drawing.y + drawing.height, bottom + margin);
  return right > left && bottom > top
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : undefined;
}

// Grown to take in SVG text that it cuts into.
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

// The median font size, in the drawing's units.
export function textSize(svg: SVGSVGElement): number | undefined {
  // A drawing out of sight has no scale.
  const root = svg.getScreenCTM();
  const scaleOf = (element: Element | null) => {
    const matrix = element instanceof SVGGraphicsElement ? element.getScreenCTM() : null;
    return matrix && root ? Math.hypot(matrix.a, matrix.b) / Math.hypot(root.a, root.b) : 1;
  };
  const sizes: number[] = [];
  for (const element of svg.querySelectorAll("text, tspan, foreignObject *")) {
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
