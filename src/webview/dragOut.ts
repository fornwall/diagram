// Dragging the drawing out of the panel as an image, e.g. into a chat or a document.

import { errorMessage, safeFileName } from "../protocol";
import { type DiagramImage, pngDataUrl, svgDataUrl } from "./images";
import type { Renderer } from "./renderer";

/** Chromium does not load a URL longer than this, which the file to drop is downloaded from. */
const MAX_URL_LENGTH = 2 * 1024 * 1024;

interface Prepared {
  image?: DiagramImage;
  png?: string;
  /** Why there is no PNG, once rasterizing failed. */
  pngError?: string;
  preview?: HTMLImageElement;
  error?: string;
}

interface DragOutOptions {
  /** What draws the drawing shown, if any. */
  drawing(): Renderer | undefined;
  /** The background to draw the image on. */
  background(): string;
  /** Runs a task in the render queue: Mermaid rendering and images both configure Mermaid. */
  enqueue(task: () => Promise<void>): void;
  /** The title, which names the file. */
  title(): string;
  hint(text: string): void;
}

async function rasterize(entry: Prepared, image: DiagramImage): Promise<void> {
  try {
    entry.png = await pngDataUrl(image);
    const preview = new Image();
    preview.src = entry.png;
    await preview.decode();
    entry.preview = preview;
  } catch (error) {
    // Drag the SVG instead, or the PNG without a preview.
    if (!entry.png) entry.pngError = errorMessage(error);
  }
}

/**
 * Lets the handle be dragged out as a PNG file, or as SVG with Shift held. A drag cannot wait, so
 * the image is prepared as the pointer enters the handle. Returns a function to call whenever the
 * drawing changes, as that makes a prepared image stale.
 */
export function enableDragOut(handle: HTMLElement, options: DragOutOptions): () => void {
  let prepared: Prepared | undefined;
  let svgRequested = false;

  const forget = () => {
    prepared = undefined;
  };

  /** Prepares an image, unless one is ready or on its way. */
  const prepare = () => {
    const drawing = options.drawing();
    if (!drawing || (prepared && prepared.error === undefined)) return;
    const entry: Prepared = {};
    prepared = entry;
    options.enqueue(async () => {
      if (prepared !== entry) return;
      try {
        entry.image = await drawing.toImage(options.background());
        // Rasterizing needs neither Mermaid nor to hold up rendering. SVG is usable meanwhile.
        void rasterize(entry, entry.image);
      } catch (error) {
        entry.error = `Could not prepare the image: ${errorMessage(error)}`;
      }
    });
  };

  handle.addEventListener("pointerenter", () => {
    // Take a chart again, which its interactions and resizing change in place. Keep any other
    // image until the drawing or theme changes: a large Mermaid diagram takes a while to draw.
    if (options.drawing()?.changesInPlace) forget();
    prepare();
  });
  handle.addEventListener("pointerdown", (event) => {
    svgRequested = event.shiftKey;
    prepare();
  });

  handle.addEventListener("dragstart", (event) => {
    const { dataTransfer } = event;
    const ready = prepared;
    if (!ready?.image || !dataTransfer) {
      event.preventDefault();
      options.hint(ready?.error ?? "Preparing the image — start the drag again in a moment.");
      prepare();
      return;
    }
    const { image, png, pngError, preview } = ready;
    const title = options.title();
    // What the drawing is, such as a chart, names the file when it has no title.
    const name = safeFileName(title, options.drawing()?.noun ?? "diagram");
    const svg = svgDataUrl(image.svg);
    // A file the drop target downloads from the data URL. This is what an application that takes
    // dropped files, such as a chat window, reads; the type it asks for decides the rest.
    let file: string | undefined;
    if (!svgRequested && png && png.length <= MAX_URL_LENGTH) {
      file = `image/png:${name}.png:${png}`;
    } else if (svg.length <= MAX_URL_LENGTH) {
      file = `image/svg+xml:${name}.svg:${svg}`;
      if (!svgRequested) {
        options.hint(
          png
            ? "The PNG is too large to drop as a file. Dragging the drawing as SVG instead."
            : pngError
              ? `Dragging the drawing as SVG, as the PNG failed: ${pngError}`
              : "The PNG is not ready yet. Dragging the drawing as SVG instead.",
        );
      }
    } else {
      options.hint("The image is too large to drop as a file. Use Export to save it instead.");
    }
    dataTransfer.effectAllowed = "copy";
    if (file) dataTransfer.setData("DownloadURL", file);
    // For a target that takes rich text instead of a file, and one that prefers vector over pixels.
    if (png) {
      const element = document.createElement("img");
      element.src = png;
      element.alt = title || name;
      dataTransfer.setData("text/html", element.outerHTML);
    }
    dataTransfer.setData("image/svg+xml", image.svg);
    try {
      if (preview) dataTransfer.setDragImage(preview, 12, 12);
    } catch {
      // Not every build accepts an image that is not in the page; the default outline will do.
    }
  });

  return forget;
}
