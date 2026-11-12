const PAN_THRESHOLD = 3;
// As far as ECharts lets a click move on a chart.
const CLICK_TOLERANCE = 4;

interface Drag {
  pointerId: number;
  // Where it last panned.
  x: number;
  y: number;
  panning: boolean;
}

// Text stays selectable while the whole rendering fits.
export function enablePanning(canvas: HTMLElement): void {
  let drag: Drag | undefined;
  // The click that ends a pan must not change the selection.
  let panned = false;
  // A drag that selects text also ends in a click.
  let pressed: { x: number; y: number } | undefined;
  let cursorFrame = 0;

  const canPan = () =>
    canvas.scrollWidth > canvas.clientWidth || canvas.scrollHeight > canvas.clientHeight;

  const onScrollbar = (x: number, y: number) => {
    const box = canvas.getBoundingClientRect();
    return (
      x - box.left - canvas.clientLeft >= canvas.clientWidth ||
      y - box.top - canvas.clientTop >= canvas.clientHeight
    );
  };

  // Measures at most once per frame.
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
      pressed = undefined;
      // Menus and chart controls keep their native focus, text selection and dragging.
      if (
        event.target instanceof Element &&
        event.target.closest("button, input, textarea, select, [contenteditable], a[href]")
      ) {
        return;
      }
      pressed =
        event.pointerType === "mouse" && event.button === 0 && event.isPrimary
          ? { x: event.clientX, y: event.clientY }
          : undefined;
    }
    // Touch and pen scroll natively.
    if (
      drag ||
      event.pointerType === "touch" ||
      event.pointerType === "pen" ||
      event.button !== 0 ||
      !event.isPrimary ||
      !canPan() ||
      onScrollbar(event.clientX, event.clientY)
    ) {
      return;
    }
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panning: false };
    // Prevents text selection, and with it focusing, so focus as a click would.
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
      canvas.setPointerCapture(drag.pointerId);
      canvas.classList.add("panning");
    }
    // Clamped at the edges, so track the pointer rather than the scroll position.
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

  // Swallow the click that ends a pan or drag, unless it barely moved and selected nothing.
  // Canvas listeners added later lose it to this one, hence enablePanning before them.
  canvas.addEventListener(
    "click",
    (event) => {
      const moved =
        pressed === undefined
          ? 0
          : Math.max(Math.abs(event.clientX - pressed.x), Math.abs(event.clientY - pressed.y));
      const dragged =
        moved > CLICK_TOLERANCE ||
        (moved >= PAN_THRESHOLD && document.getSelection()?.isCollapsed === false);
      pressed = undefined;
      if ((panned || dragged) && event.detail !== 0) {
        panned = false;
        event.stopImmediatePropagation();
        event.preventDefault();
      }
    },
    { capture: true },
  );
}
