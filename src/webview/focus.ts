// Keeps the keyboard focus on the page's content, where VS Code or a control that goes would leave
// it on the body, from where Tab starts over at the top of the panel.

/**
 * Gives the focus back to what had it when VS Code focuses the panel, and moves it to the content,
 * by `focusContent`, when what had it is gone. The drawing in the canvas, which gets replaced,
 * gives the focus back to its own items as it is drawn.
 */
export function keepFocusInContent(canvas: HTMLElement, focusContent: () => void): void {
  // VS Code focuses a panel by taking the focus out of the page and giving it back to the page
  // alone, a while later, which leaves nothing in it focused (see WebviewElement._doFocus): give
  // the focus back to what had it, such as the drawing that a pick revealing the panel just
  // focused.
  let lastFocused: HTMLElement | SVGElement | undefined;
  document.addEventListener("focusin", ({ target }) => {
    if (target instanceof HTMLElement || target instanceof SVGElement) lastFocused = target;
  });
  window.addEventListener("focus", () => {
    if (document.activeElement !== document.body || !lastFocused) return;
    lastFocused.focus({ preventScroll: true });
    // What had the focus may have gone while the page had none, e.g. Clear for a new diagram.
    if (document.activeElement === document.body) focusContent();
  });

  // A control that goes, or is hidden or disabled, while it has the focus, such as Clear or the
  // zoom buttons when another diagram comes, leaves the focus on the body: move it to the content
  // instead, unless something else took it meanwhile.
  document.addEventListener("focusout", ({ target, relatedTarget }) => {
    if (relatedTarget || !(target instanceof HTMLElement) || canvas.contains(target)) return;
    queueMicrotask(() => {
      const gone = !target.isConnected || !target.checkVisibility() || target.matches(":disabled");
      if (gone && document.activeElement === document.body && document.hasFocus()) focusContent();
    });
  });
}
