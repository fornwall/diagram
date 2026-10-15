// The zoom buttons and keys, for a renderer that does not fit the panel by itself (Mermaid; charts
// fit the panel).

import type { Renderer } from "./renderer";

interface ZoomButtons {
  in: HTMLElement;
  out: HTMLElement;
  reset: HTMLElement;
}

const STEP = 1.25;

/**
 * Zooms the drawing that `shown` gives, if any, by the buttons, and by Cmd (macOS) or Ctrl with +,
 * - and 0, as in browsers, while the panel has the focus.
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
  // The keys, which the buttons' titles name too, for screen readers to name with the buttons.
  const primaryKey = isMac ? "Meta" : "Control";
  buttons.in.setAttribute("aria-keyshortcuts", `${primaryKey}+=`);
  buttons.out.setAttribute("aria-keyshortcuts", `${primaryKey}+-`);
  buttons.reset.setAttribute("aria-keyshortcuts", `${primaryKey}+0`);
  // VS Code sees every key the page does, so the event stops in the capture phase, before VS
  // Code's listener on the window passes it on to zoom the window or focus the side bar as well.
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
