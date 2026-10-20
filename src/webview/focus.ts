// Recover focus after VS Code refocuses the webview or a focused control disappears.

/**
 * Restore the last focused element when possible, otherwise focus the content. Renderers handle
 * focus within the canvas themselves because they replace its elements when drawing.
 */
export function keepFocusInContent(canvas: HTMLElement, focusContent: () => void): void {
  // VS Code briefly blurs the webview before focusing its body (WebviewElement._doFocus).
  let lastFocused: HTMLElement | SVGElement | undefined;
  document.addEventListener("focusin", ({ target }) => {
    if (target instanceof HTMLElement || target instanceof SVGElement) lastFocused = target;
  });
  window.addEventListener("focus", () => {
    if (document.activeElement !== document.body || !lastFocused) return;
    lastFocused.focus({ preventScroll: true });
    // The element may have disappeared while the page was blurred.
    if (document.activeElement === document.body) focusContent();
  });

  // Wait for DOM updates before deciding whether a control disappeared. Do not steal focus
  // from another element or another part of VS Code.
  document.addEventListener("focusout", ({ target, relatedTarget }) => {
    if (relatedTarget || !(target instanceof HTMLElement) || canvas.contains(target)) return;
    queueMicrotask(() => {
      const gone = !target.isConnected || !target.checkVisibility() || target.matches(":disabled");
      if (gone && document.activeElement === document.body && document.hasFocus()) focusContent();
    });
  });
}
