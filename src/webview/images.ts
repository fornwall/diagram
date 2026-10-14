// Images of the drawing as they leave the panel: SVG, which svgImage.ts makes, and PNG drawn
// from it.

import type { ImageView } from "../protocol";

/** A rendering as an image, ready to leave the panel. */
export interface DiagramImage {
  /** Standalone SVG markup: no panel stylesheet, no CSS variables, no interaction attributes. */
  svg: string;
  /** The size the SVG draws at, in CSS pixels, which the PNG is a multiple of. */
  width: number;
  height: number;
}

/** An image for a model, and what it shows, but for the scale, which the PNG of it decides. */
export interface ModelImage {
  image: DiagramImage;
  view: Omit<ImageView, "scale">;
}

/**
 * How many pixels high an image for a model draws most text, as far as its size allows: enough for
 * the model to read it, without the pixels of a larger image, which cost the model time and input.
 * The drawing is not drawn smaller than it is to get there.
 */
export const MODEL_TEXT_SIZE = 16;

const PNG_SCALE = 2;
const MAX_PNG_SIDE = 8000;
// Bound both dimensions and total pixels: an 8000² canvas alone occupies 256 MB.
const MAX_PNG_PIXELS = 16_000_000;

/** Percent encoding preserves Unicode labels without a Latin-1 base64 conversion. */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** The most pixels a PNG may have on either side and in all, and for each pixel of the drawing. */
export interface PngLimits {
  maxSide?: number | undefined;
  maxPixels?: number | undefined;
  maxScale?: number | undefined;
}

/** How many pixels of a PNG of the image within the limits make a pixel of the drawing. */
export function pngScale(
  { width, height }: Pick<DiagramImage, "width" | "height">,
  { maxSide = MAX_PNG_SIDE, maxPixels = MAX_PNG_PIXELS, maxScale = PNG_SCALE }: PngLimits = {},
): number {
  return Math.min(
    PNG_SCALE,
    maxScale,
    Math.min(maxSide, MAX_PNG_SIDE) / Math.max(width, height),
    Math.sqrt(Math.min(maxPixels, MAX_PNG_PIXELS) / width) / Math.sqrt(height),
  );
}

/** Rasterizes self-contained SVG, at most as large as the limits allow. */
export async function pngDataUrl(drawing: DiagramImage, limits?: PngLimits): Promise<string> {
  const { svg, width, height } = drawing;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("The drawing has no valid dimensions for a PNG.");
  }
  const scale = pngScale(drawing, limits);
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
