// Dragging the drawing out of the panel as an image, e.g. into a chat or a document.

import { errorMessage, safeFileName } from "../protocol";
import { type DiagramImage, pngDataUrl, svgDataUrl } from "./images";

interface Prepared {
  image?: DiagramImage;
  png?: string;
  preview?: HTMLImageElement;
  error?: string;
}

interface DragOutOptions {
  /** How to make an image of the drawing as shown, if it can be one. */
  imageMaker(): (() => Promise<DiagramImage>) | undefined;
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
  } catch {
    // Drag the SVG instead.
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
    const make = options.imageMaker();
    if (!make || (prepared && prepared.error === undefined)) return;
    const entry: Prepared = {};
    prepared = entry;
    options.enqueue(async () => {
      if (prepared !== entry) return;
      try {
        entry.image = await make();
        // Rasterizing needs neither Mermaid nor to hold up rendering. SVG is usable meanwhile.
        void rasterize(entry, entry.image);
      } catch (error) {
        entry.error = `Could not prepare the image: ${errorMessage(error)}`;
      }
    });
  };

  handle.addEventListener("pointerenter", () => {
    // Chart interactions and resizing can change its SVG without changing its source.
    forget();
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
    const { image, png, preview } = ready;
    const title = options.title();
    const name = safeFileName(title, "diagram");
    const svg = svgRequested || !png;
    if (!svgRequested && !png) {
      options.hint("PNG is not ready. Dragging the drawing as SVG instead.");
    }
    dataTransfer.effectAllowed = "copy";
    // A file the drop target downloads from the data URL. This is what an application that takes
    // dropped files, such as a chat window, reads; the type it asks for decides the rest.
    dataTransfer.setData(
      "DownloadURL",
      svg ? `image/svg+xml:${name}.svg:${svgDataUrl(image.svg)}` : `image/png:${name}.png:${png}`,
    );
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
