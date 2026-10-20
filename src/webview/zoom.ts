// Zoom controls for renderers with manual zoom support (currently Mermaid).

import type { Renderer } from "./renderer";

interface ZoomButtons {
  in: HTMLElement;
  out: HTMLElement;
  reset: HTMLElement;
}

const STEP = 1.25;

/**
 * Connects buttons and browser-style Cmd/Ctrl +, - and 0 shortcuts to the active renderer.
 */
export function enableZoom(buttons: ZoomButtons, shown: () => Renderer | undefined): void {
  const zoomIn = () => shown()?.zoomBy?.(STEP);
  const zoomOut = () => shown()?.zoomBy?.(1 / STEP);
  const zoomReset = () => shown()?.zoomReset?.();
  buttons.in.addEventListener("click", zoomIn);
  buttons.out.addEventListener("click", zoomOut);
  buttons.reset.addEventListener("click", zoomReset);

  const keys: Partial<Record<string, () => void>> = {
    "=": zoomIn,
    "+": zoomIn,
    "-": zoomOut,
    "0": zoomReset,
  };
  const isMac = navigator.userAgent.includes("Mac");
  // Expose the shortcuts to screen readers as well as in button titles.
  const primaryKey = isMac ? "Meta" : "Control";
  buttons.in.setAttribute("aria-keyshortcuts", `${primaryKey}+=`);
  buttons.out.setAttribute("aria-keyshortcuts", `${primaryKey}+-`);
  buttons.reset.setAttribute("aria-keyshortcuts", `${primaryKey}+0`);
  // Capture before VS Code's listener forwards the shortcut to the host window.
  window.addEventListener(
    "keydown",
    (event) => {
      const zoom = keys[event.key];
      const primary = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (zoom && primary && !event.altKey && shown()?.zoomBy) {
        event.preventDefault();
        event.stopPropagation();
        zoom();
      }
    },
    { capture: true },
  );
}
