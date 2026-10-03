// The handle between the source editor and the rendering in the split view.

/** Keeps both panes of the split view usable, as a fraction of the panel. */
const MIN_FRACTION = 0.15;
const MAX_FRACTION = 0.85;
/** How much an arrow key moves the handle. */
const KEY_STEP = 0.05;
const DEFAULT_FRACTION = 0.4;

/**
 * Lets the user drag, or arrow-key, the handle to give the source editor more or less of the panel,
 * as the `--source-size` of the panes. A narrow panel stacks the panes, so the handle moves along
 * whichever axis they are laid out on.
 */
export function enableSplitter(splitter: HTMLElement, panes: HTMLElement): void {
  let fraction = DEFAULT_FRACTION;

  /** Whether the panes are stacked, which is the case in a narrow panel. */
  const stacked = () => getComputedStyle(panes).flexDirection === "column";
  const updateOrientation = () => {
    splitter.setAttribute("aria-orientation", stacked() ? "horizontal" : "vertical");
  };

  const setFraction = (value: number): void => {
    fraction = Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, value));
    panes.style.setProperty("--source-size", `${(fraction * 100).toFixed(2)}%`);
    splitter.setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
    splitter.setAttribute("aria-valuetext", `Source editor ${Math.round(fraction * 100)}%`);
  };

  splitter.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !event.isPrimary) {
      return;
    }
    // Dragging the handle resizes the panes instead of selecting the text beside it.
    event.preventDefault();
    splitter.setPointerCapture(event.pointerId);
    splitter.classList.add("dragging");
    splitter.focus();
  });

  splitter.addEventListener("pointermove", (event) => {
    if (!splitter.hasPointerCapture(event.pointerId)) {
      return;
    }
    const box = panes.getBoundingClientRect();
    setFraction(
      stacked() ? (event.clientY - box.top) / box.height : (event.clientX - box.left) / box.width,
    );
  });

  const stopDrag = (event: PointerEvent) => {
    if (splitter.hasPointerCapture(event.pointerId)) {
      splitter.releasePointerCapture(event.pointerId);
    }
    splitter.classList.remove("dragging");
  };
  splitter.addEventListener("pointerup", stopDrag);
  splitter.addEventListener("pointercancel", stopDrag);
  splitter.addEventListener("lostpointercapture", () => splitter.classList.remove("dragging"));

  splitter.addEventListener("keydown", (event) => {
    const position = { Home: MIN_FRACTION, End: MAX_FRACTION, Enter: DEFAULT_FRACTION }[event.key];
    if (position !== undefined) {
      event.preventDefault();
      setFraction(position);
      return;
    }
    const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
    if (step === undefined) {
      return;
    }
    event.preventDefault();
    setFraction(fraction + step * KEY_STEP);
  });

  // Double-clicking the handle puts it back where it started, as it does with a VS Code sash.
  splitter.addEventListener("dblclick", () => setFraction(DEFAULT_FRACTION));

  updateOrientation();
  setFraction(fraction);
  // Crossing the responsive breakpoint changes the separator's orientation without a drag.
  new ResizeObserver(updateOrientation).observe(panes);
}
