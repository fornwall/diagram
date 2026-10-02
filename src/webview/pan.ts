// Drag-to-pan for the scrolling canvas: a rendering larger than the panel follows the pointer.

/** How far the pointer moves before a drag pans instead of clicking a node. */
const PAN_THRESHOLD = 3;

/** The drag in progress, from the pointer that went down on a canvas that can be panned. */
interface Drag {
  pointerId: number;
  /** Where the pointer was when it last panned, in client coordinates. */
  x: number;
  y: number;
  /** Whether it moved far enough to pan, rather than being a click that has not ended yet. */
  panning: boolean;
}

/**
 * Lets the user drag the canvas to scroll what does not fit in the panel, and shows a grab cursor
 * while there is something to pan to. Text stays selectable while the whole rendering fits.
 */
export function enablePanning(canvas: HTMLElement): void {
  let drag: Drag | undefined;
  /** Whether the drag panned, in which case the click that ends it must not change the selection. */
  let panned = false;
  let cursorFrame = 0;

  const canPan = () =>
    canvas.scrollWidth > canvas.clientWidth || canvas.scrollHeight > canvas.clientHeight;

  /** Shows whether dragging would pan, measuring the canvas at most once per frame. */
  const showCursor = () => {
    if (cursorFrame) {
      return;
    }
    cursorFrame = requestAnimationFrame(() => {
      cursorFrame = 0;
      canvas.classList.toggle("pannable", canPan());
    });
  };
  new ResizeObserver(showCursor).observe(canvas);

  const stopDrag = (event?: PointerEvent) => {
    if (!drag || (event && event.pointerId !== drag.pointerId)) {
      return;
    }
    const { pointerId } = drag;
    drag = undefined;
    panned = event?.type === "pointerup" && panned;
    if (canvas.hasPointerCapture(pointerId)) {
      canvas.releasePointerCapture(pointerId);
    }
    canvas.classList.remove("panning");
  };

  canvas.addEventListener("pointerdown", (event) => {
    showCursor();
    if (!drag) {
      // A new gesture must not inherit a pan whose click landed outside the canvas.
      panned = false;
    }
    // Touch and pen contacts scroll the canvas by themselves, and only a primary button drags.
    if (
      drag ||
      event.pointerType === "touch" ||
      event.pointerType === "pen" ||
      event.button !== 0 ||
      !event.isPrimary ||
      !canPan()
    ) {
      return;
    }
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panning: false };
    // A drag pans the rendering, so it must not select the text it passes over. That also leaves
    // the focus where it was, so move it to the node under the pointer as a click would.
    event.preventDefault();
    const target = event.target instanceof Element ? event.target.closest("[tabindex]") : null;
    if (target instanceof HTMLElement || target instanceof SVGElement) {
      target.focus();
    }
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!drag) {
      showCursor();
      return;
    }
    if (event.pointerId !== drag.pointerId) {
      return;
    }
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.panning) {
      if (Math.abs(dx) < PAN_THRESHOLD && Math.abs(dy) < PAN_THRESHOLD) {
        return;
      }
      drag.panning = true;
      panned = true;
      // Keep following the pointer when it leaves the canvas, e.g. over the panel's footer.
      canvas.setPointerCapture(drag.pointerId);
      canvas.classList.add("panning");
    }
    // Scrolling is clamped at the edges, so track the pointer from where it last panned.
    canvas.scrollLeft -= dx;
    canvas.scrollTop -= dy;
    drag.x = event.clientX;
    drag.y = event.clientY;
  });

  // A release can happen outside the canvas before movement starts pointer capture.
  window.addEventListener("pointerup", stopDrag, true);
  window.addEventListener("pointercancel", stopDrag, true);
  canvas.addEventListener("lostpointercapture", stopDrag);
  window.addEventListener("blur", () => stopDrag());

  // The click that ends a pan reaches the canvas and its nodes: swallow it before they see it.
  // Listeners on the canvas itself only lose it to this one if they are added later, hence
  // enablePanning before them.
  canvas.addEventListener(
    "click",
    (event) => {
      if (panned && event.detail !== 0) {
        panned = false;
        event.stopImmediatePropagation();
        event.preventDefault();
      }
    },
    { capture: true },
  );
}
