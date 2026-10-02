// Handing the drawing out of the panel as an image: the rendering as standalone SVG markup, and a
// PNG rasterized from it. Used to drag a diagram into another application, where the panel's
// stylesheet, theme variables and click handlers are not available, so everything the image needs
// has to be inside it.

/** A rendering as an image, ready to leave the panel. */
export interface DiagramImage {
  /** Standalone SVG markup: no panel stylesheet, no CSS variables, no interaction attributes. */
  svg: string;
  /** The size the SVG draws at, in CSS pixels, which the PNG is a multiple of. */
  width: number;
  height: number;
}

/**
 * How much larger the PNG is than the drawing, so that it stays sharp where it is dropped. Two is
 * what a retina screen shows, and what documents and chat messages are usually read at.
 */
const PNG_SCALE = 2;

/**
 * The largest PNG to rasterize, per side. A diagram far longer than this is dropped as SVG anyway,
 * and a canvas of tens of thousands of pixels either fails to allocate or produces a file too
 * large to send anywhere.
 */
const MAX_PNG_SIDE = 8000;

/** Attributes that only make the rendering interactive in the panel, which an image does not need. */
const INTERACTION_ATTRIBUTES = ["tabindex", "role", "aria-pressed"];

/**
 * The rendering as standalone SVG markup, drawn on `background` so that it does not come out
 * transparent where it is dropped.
 *
 * The clone is cleaned of what only belongs in the panel: the keyboard and screen reader
 * attributes that make nodes activatable, and the tooltips that name where a node links to, which
 * would otherwise carry local file paths into an image the user shares.
 */
export function standaloneSvg(source: SVGSVGElement, background: string): DiagramImage {
  const svg = source.cloneNode(true) as SVGSVGElement;
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  // The panel sizes the rendering with CSS, which the image is read without.
  svg.removeAttribute("style");
  svg.removeAttribute("class");

  const box = source.viewBox.baseVal;
  const width = box?.width || source.getBoundingClientRect().width;
  const height = box?.height || source.getBoundingClientRect().height;
  if (!box?.width) {
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  }
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));

  for (const element of svg.querySelectorAll("[tabindex], [role], [aria-pressed]")) {
    for (const attribute of INTERACTION_ATTRIBUTES) {
      element.removeAttribute(attribute);
    }
  }
  // The tooltips that name where a node links to are the panel's own, and would carry local file
  // paths into an image the user shares. A tooltip the diagram itself asked for stays.
  for (const title of svg.querySelectorAll("title.diagram-link")) {
    title.remove();
  }

  const rect = svg.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("x", String(box?.x ?? 0));
  rect.setAttribute("y", String(box?.y ?? 0));
  rect.setAttribute("width", String(width));
  rect.setAttribute("height", String(height));
  rect.setAttribute("fill", background);
  svg.prepend(rect);

  return { svg: new XMLSerializer().serializeToString(svg), width, height };
}

/**
 * The markup as a data URL. Percent-encoded rather than base64, as the labels of a diagram may be
 * in any language and base64 in the browser only takes Latin-1.
 */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * The image rasterized as a PNG data URL, which is what most applications take when something is
 * dropped on them.
 *
 * Drawing SVG through an `img` element means the drawing is rendered in isolation, without the
 * page's stylesheet or any font it loaded: this works because the diagram's colors are written
 * into the markup and its font is one the system already has. It also means a diagram whose labels
 * are HTML in a `foreignObject` cannot be rasterized at all, which is why the renderers produce
 * markup without one.
 */
export async function pngDataUrl({ svg, width, height }: DiagramImage): Promise<string> {
  const scale = Math.min(PNG_SCALE, MAX_PNG_SIDE / Math.max(width, height, 1));
  const image = new Image();
  image.src = svgDataUrl(svg);
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("This browser did not provide a canvas to draw the image on.");
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}
