// Self-contained SVG and PNG exports for dragging into other applications.

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
const INTERACTION_ATTRIBUTES = ["tabindex", "role", "aria-pressed"];

/** Clones the drawing with a background and removes panel interaction attributes and file paths. */
export function standaloneSvg(source: SVGSVGElement, background: string): DiagramImage {
  const svg = source.cloneNode(true) as SVGSVGElement;
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  // The panel sizes the rendering with CSS, which the image is read without.
  svg.removeAttribute("style");
  svg.removeAttribute("class");

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

  for (const element of svg.querySelectorAll("[tabindex], [role], [aria-pressed]")) {
    for (const attribute of INTERACTION_ATTRIBUTES) {
      element.removeAttribute(attribute);
    }
  }
  // Remove local file paths, keeping tooltips supplied by the diagram itself.
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

/** Percent encoding preserves Unicode labels without a Latin-1 base64 conversion. */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Rasterizes self-contained SVG. The renderers must omit HTML foreignObject labels. */
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
  image.src = svgDataUrl(svg);
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(width * scale));
  canvas.height = Math.max(1, Math.floor(height * scale));
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("This browser did not provide a canvas to draw the image on.");
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const png = canvas.toDataURL("image/png");
  if (!png.startsWith("data:image/png")) {
    throw new Error("The browser could not create a PNG at this image size.");
  }
  return png;
}
