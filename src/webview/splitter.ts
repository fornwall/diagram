// The source editor's share.
const MIN_FRACTION = 0.15;
const MAX_FRACTION = 0.85;
const KEY_STEP = 0.05;
const DEFAULT_FRACTION = 0.4;

const percent = (fraction: number) => String(Math.round(fraction * 100));

export interface Split {
  readonly fraction: number;
  restore(value: unknown): void;
}

// Narrow panels stack the panes vertically.
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

  // Also when the browser cancels the pointer.
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
    // From the actual size, which CSS minimums may constrain, so a keypress always moves it.
    const shown = stacked()
      ? editor.offsetHeight / panes.clientHeight
      : editor.offsetWidth / panes.clientWidth;
    setFraction((Math.abs(shown - fraction) > KEY_STEP / 2 ? shown : fraction) + step * KEY_STEP);
    onChange();
  });

  // As with a VS Code sash.
  splitter.addEventListener("dblclick", () => {
    setFraction(DEFAULT_FRACTION);
    onChange();
  });

  splitter.setAttribute("aria-valuemin", percent(MIN_FRACTION));
  splitter.setAttribute("aria-valuemax", percent(MAX_FRACTION));
  updateOrientation();
  setFraction(fraction);
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
