// The handle between the source editor and the rendering in the split view.

/** Limits on the source editor's share of the split view. */
const MIN_FRACTION = 0.15;
const MAX_FRACTION = 0.85;
/** How much an arrow key moves the handle. */
const KEY_STEP = 0.05;
const DEFAULT_FRACTION = 0.4;

const percent = (fraction: number) => String(Math.round(fraction * 100));

/** Split position persisted across reloads. */
export interface Split {
  readonly fraction: number;
  /** Ignores invalid saved values and clamps valid fractions. */
  restore(value: unknown): void;
}

/**
 * Resizes the editor with dragging, arrow keys, Home/End, or Enter to reset. Narrow panels stack
 * the panes vertically. Calls onChange after each keyboard change or completed drag.
 */
export function enableSplitter(
  splitter: HTMLElement,
  panes: HTMLElement,
  editor: HTMLElement,
  onChange: () => void,
): Split {
  let fraction = DEFAULT_FRACTION;

  const stacked = () => getComputedStyle(panes).flexDirection === "column";
  const updateOrientation = () => {
    splitter.setAttribute("aria-orientation", stacked() ? "horizontal" : "vertical");
  };

  const setFraction = (value: number): void => {
    fraction = Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, value));
    editor.style.setProperty("--source-size", `${(fraction * 100).toFixed(2)}%`);
    splitter.setAttribute("aria-valuenow", percent(fraction));
    splitter.setAttribute("aria-valuetext", `Source editor ${percent(fraction)}%`);
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

  // Releasing the pointer, or the browser cancelling it, ends the capture, and with it the drag.
  splitter.addEventListener("lostpointercapture", () => {
    splitter.classList.remove("dragging");
    onChange();
  });

  splitter.addEventListener("keydown", (event) => {
    const position = { Home: MIN_FRACTION, End: MAX_FRACTION, Enter: DEFAULT_FRACTION }[event.key];
    if (position !== undefined) {
      event.preventDefault();
      setFraction(position);
      onChange();
      return;
    }
    const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
    if (step === undefined) {
      return;
    }
    event.preventDefault();
    // CSS minimum sizes can constrain the requested fraction. Start from the actual size so
    // the first keypress still moves the handle.
    const shown = stacked()
      ? editor.offsetHeight / panes.clientHeight
      : editor.offsetWidth / panes.clientWidth;
    setFraction((Math.abs(shown - fraction) > KEY_STEP / 2 ? shown : fraction) + step * KEY_STEP);
    onChange();
  });

  // Double-clicking the handle puts it back where it started, as it does with a VS Code sash.
  splitter.addEventListener("dblclick", () => {
    setFraction(DEFAULT_FRACTION);
    onChange();
  });

  splitter.setAttribute("aria-valuemin", percent(MIN_FRACTION));
  splitter.setAttribute("aria-valuemax", percent(MAX_FRACTION));
  updateOrientation();
  setFraction(fraction);
  // Crossing the responsive breakpoint changes the separator's orientation without a drag.
  new ResizeObserver(updateOrientation).observe(panes);
  return {
    get fraction() {
      return fraction;
    },
    restore(value) {
      if (typeof value === "number" && Number.isFinite(value)) setFraction(value);
    },
  };
}
