// Self-contained SVG and PNG images of the drawing, to export or to drag into other applications.

/** A rendering as an image, ready to leave the panel. */
export interface DiagramImage {
  /** Standalone SVG markup: no panel stylesheet, no CSS variables, no interaction attributes. */
  svg: string;
  /** The size the SVG draws at, in CSS pixels, which the PNG is a multiple of. */
  width: number;
  height: number;
}

const PNG_SCALE = 2;
const MAX_PNG_SIDE = 8000;
// Bound both dimensions and total pixels: an 8000² canvas alone occupies 256 MB.
const MAX_PNG_PIXELS = 16_000_000;

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
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
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

  const rect = svg.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "rect");
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

/** Percent encoding preserves Unicode labels without a Latin-1 base64 conversion. */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Rasterizes self-contained SVG. */
export async function pngDataUrl({ svg, width, height }: DiagramImage): Promise<string> {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("The drawing has no valid dimensions for a PNG. Try exporting it as SVG.");
  }
  const scale = Math.min(
    PNG_SCALE,
    MAX_PNG_SIDE / Math.max(width, height),
    Math.sqrt(MAX_PNG_PIXELS / width) / Math.sqrt(height),
  );
  const image = new Image();
  let canvas: HTMLCanvasElement | undefined;
  let blob: Blob | null;
  try {
    image.src = svgDataUrl(svg);
    // Its only error, an EncodingError, says that "the source image cannot be decoded".
    await image.decode().catch(() => {
      throw new Error("The browser could not read the SVG image to draw the PNG from.");
    });
    canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(width * scale));
    canvas.height = Math.max(1, Math.floor(height * scale));
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("This browser did not provide a canvas to draw the image on.");
    }
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    // Encoding a large PNG synchronously stalls clicks, typing and later renders.
    const drawing = canvas;
    blob = await new Promise<Blob | null>((resolve) => drawing.toBlob(resolve, "image/png"));
  } finally {
    // Release the decoded SVG and up to 64 MB of canvas pixels before reading the PNG.
    // Detached canvases otherwise keep their backing stores until browser GC catches up.
    image.src = "";
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
  if (blob?.type !== "image/png") {
    throw new Error("The browser could not create a PNG at this image size.");
  }
  const png = await withResolution(blob, scale);
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the PNG image."));
    reader.readAsDataURL(png);
  });
}

/** The end of the signature and the header chunk, which every PNG starts with. */
const PNG_HEADER_END = 33;

/**
 * Adds a pHYs chunk to a PNG that has none, saying that `scale` pixels make a CSS pixel, 1/96 of an
 * inch. Word processors, presentations and macOS Preview then show an image that is twice as
 * sharp as the drawing at the drawing's size instead of twice as large.
 */
async function withResolution(png: Blob, scale: number): Promise<Blob> {
  const bytes = new Uint8Array(await png.arrayBuffer());
  const type = (start: number) => String.fromCharCode(...bytes.subarray(start, start + 4));
  if (type(12) !== "IHDR") return png;
  // Chunks: a length, a type, the data and a CRC. pHYs is allowed once, before the image data.
  const lengths = new DataView(bytes.buffer);
  for (let at = 8; at + 8 <= bytes.length && type(at + 4) !== "IDAT"; ) {
    if (type(at + 4) === "pHYs") return png;
    at += 12 + lengths.getUint32(at);
  }
  const chunk = new Uint8Array(21);
  const view = new DataView(chunk.buffer);
  const pixelsPerMeter = Math.round((scale * 96) / 0.0254);
  view.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4);
  view.setUint32(8, pixelsPerMeter);
  view.setUint32(12, pixelsPerMeter);
  chunk[16] = 1; // The unit is the meter.
  view.setUint32(17, crc32(chunk.subarray(4, 17)));
  return new Blob([bytes.subarray(0, PNG_HEADER_END), chunk, bytes.subarray(PNG_HEADER_END)], {
    type: "image/png",
  });
}

/** The CRC-32 that ends a PNG chunk, computed over its type and data. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
