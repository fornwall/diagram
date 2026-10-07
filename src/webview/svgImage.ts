// Self-contained SVG images of a drawing in the panel, to export or to drag into other
// applications.

import type { DiagramImage } from "./images";

export const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
/** The namespace of the targets of links that SVG draws, as Mermaid writes them. */
export const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

/** Attributes that only make the rendering interactive in the panel, which an image does not need. */
const INTERACTION_ATTRIBUTES = ["tabindex", "role", "aria-pressed", "data-diagram-id"];

/** What XML 1.0 does not allow in a document, not even as a character reference. */
const NOT_IN_XML = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

const HTML_LABEL_WITH_FALLBACK = "switch > foreignObject:not(:has(math))";

/**
 * A computed value as applications that read SVG 1.1 also know it: they may not read a quoted
 * url() or a transparent color, which would paint black.
 */
function portable(property: string, value: string): string {
  if ((property === "fill" || property === "stroke") && value === "rgba(0, 0, 0, 0)") return "none";
  return value.replace(/url\("(#[\w-]+)"\)/g, "url($1)");
}

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

/** Clones the drawing with a background, without panel interaction attributes or link targets. */
export function standaloneSvg(source: SVGSVGElement, background: string): DiagramImage {
  const svg = source.cloneNode(true) as SVGSVGElement;
  svg.setAttribute("xmlns", SVG_NAMESPACE);
  svg.setAttribute("xmlns:xlink", XLINK_NAMESPACE);
  // The panel sizes the rendering with CSS, which the image is read without.
  svg.removeAttribute("style");
  svg.removeAttribute("class");
  // Mermaid leaves the color of some HTML labels, such as sequence diagram formulas, to the panel.
  svg.style.color = getComputedStyle(source).color;

  const box = source.viewBox.baseVal;
  // ECharts sets width and height without a viewBox. Its DOM bounds disappear in Source view,
  // but those intrinsic dimensions still describe the drawing.
  const width = box?.width || source.width.baseVal.value || source.getBoundingClientRect().width;
  const height =
    box?.height || source.height.baseVal.value || source.getBoundingClientRect().height;
  if (!box?.width) {
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  }
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
  rect.setAttribute("x", String(box?.x ?? 0));
  rect.setAttribute("y", String(box?.y ?? 0));
  rect.setAttribute("width", String(width));
  rect.setAttribute("height", String(height));
  rect.setAttribute("fill", background);
  svg.prepend(rect);

  // The serializer keeps characters that XML does not allow, such as control characters in labels,
  // for which strict parsers, and browsers drawing the SVG as an image, refuse all of it.
  const markup = new XMLSerializer().serializeToString(svg).replace(NOT_IN_XML, "");
  return { svg: markup, width, height };
}
