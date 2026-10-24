import { annotationFrame } from "../annotations";
import type { Annotation, DiagramMark } from "../protocol";
import type { Renderer } from "./renderer";

const overlaps = (a: DOMRect, b: DOMRect) =>
  a.left < b.right + 4 && a.right > b.left - 4 && a.top < b.bottom + 4 && a.bottom > b.top - 4;

/** Plain-text explanations with callouts that never intercept drawing interactions. */
export class AnnotationView {
  private readonly panel = document.createElement("section");
  private readonly heading = document.createElement("div");
  private readonly caption = document.createElement("p");
  private readonly list = document.createElement("ol");
  private readonly controls = document.createElement("div");
  private readonly previous = document.createElement("button");
  private readonly next = document.createElement("button");
  private readonly layer = document.createElement("div");
  private annotation: Annotation = { marks: [], dim: false };
  private callouts: { mark: DiagramMark; element: HTMLDivElement; number: number }[] = [];
  private frame = 0;
  private focusPending = false;
  private readonly observer = new MutationObserver(() => this.schedule());

  constructor(
    private readonly canvas: HTMLElement,
    before: HTMLElement,
    private readonly renderer: () => Renderer | undefined,
    private readonly apply: (frame: Annotation) => void,
    private readonly stepChanged: (step: number) => void,
    private readonly reveal: () => void,
    private readonly restoreFocus: () => void,
  ) {
    this.panel.id = "explanation";
    this.panel.setAttribute("aria-label", "Diagram explanation");
    this.panel.hidden = true;
    this.heading.id = "explanation-heading";
    this.heading.setAttribute("role", "status");
    this.caption.id = "explanation-caption";
    this.caption.setAttribute("aria-live", "polite");
    this.list.id = "explanation-marks";
    this.previous.id = "explanation-previous";
    this.previous.textContent = "Previous";
    this.next.id = "explanation-next";
    this.next.textContent = "Next";
    this.controls.className = "actions";
    this.controls.append(this.previous, this.next);
    this.panel.append(this.heading, this.caption, this.list, this.controls);
    before.before(this.panel);
    this.layer.id = "explanation-callouts";
    this.layer.setAttribute("aria-hidden", "true");
    document.body.append(this.layer);
    this.previous.addEventListener("click", () => this.move(-1));
    this.next.addEventListener("click", () => this.move(1));
    canvas.addEventListener("scroll", () => this.schedule(), true);
    new ResizeObserver(() => this.schedule()).observe(canvas);
  }

  show(annotation: Annotation): void {
    const hadFocus = this.panel.contains(document.activeElement);
    this.annotation = annotation;
    this.update();
    if (
      hadFocus &&
      document.hasFocus() &&
      (this.panel.hidden || !this.panel.contains(document.activeElement))
    ) {
      this.restoreFocus();
    }
  }

  private move(direction: number): void {
    const step = (this.annotation.step ?? 0) + direction;
    if (!this.annotation.steps?.[step]) return;
    this.annotation = { ...this.annotation, step };
    this.update();
    this.stepChanged(step);
  }

  private update(): void {
    const frame = annotationFrame(this.annotation);
    this.apply(frame);
    const steps = this.annotation.steps;
    const step = this.annotation.step ?? 0;
    const marks = frame.marks.filter((mark) => mark.text !== undefined);
    // Observe drawing changes only while callouts need to follow them.
    this.observer.disconnect();
    if (marks.length > 0) {
      this.observer.observe(this.canvas, { childList: true, subtree: true, attributes: true });
    }
    this.panel.hidden = !steps && marks.length === 0;
    this.controls.hidden = !steps;
    this.heading.textContent = steps ? `Step ${step + 1} of ${steps.length}` : "Explanation";
    this.previous.setAttribute("aria-disabled", String(step === 0));
    this.next.setAttribute("aria-disabled", String(step === (steps?.length ?? 1) - 1));
    this.caption.textContent = "text" in frame ? frame.text : "";
    this.caption.hidden = !this.caption.textContent;
    this.list.replaceChildren();
    this.list.hidden = marks.length === 0;
    this.layer.replaceChildren();
    const labels = new Map(
      this.renderer()
        ?.drawnNodes?.()
        .map(({ id, label }) => [id, label]),
    );
    this.callouts = marks.map((mark, index) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.className = "link";
      button.textContent = labels.get(mark.id) ?? mark.id;
      button.title = `Show ${button.textContent}`;
      button.addEventListener("click", () => {
        this.reveal();
        this.focusItems([mark.id]);
      });
      item.append(button, document.createTextNode(`: ${mark.text}`));
      this.list.append(item);
      const element = document.createElement("div");
      element.className = `explanation-callout explanation-${mark.kind}`;
      element.dataset.itemId = mark.id;
      this.layer.append(element);
      return { mark, element, number: index + 1 };
    });
    this.focusPending = frame.focus === true;
    if (this.focusPending) this.reveal();
    this.schedule();
  }

  private schedule(): void {
    if (this.frame || (!this.focusPending && this.callouts.length === 0)) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.focusPending) {
        this.focusPending = false;
        this.focusItems(annotationFrame(this.annotation).marks.map(({ id }) => id));
      }
      this.layout();
    });
  }

  private focusItems(ids: readonly string[]): void {
    const renderer = this.renderer();
    const boxes = ids.flatMap((id) => renderer?.itemBounds?.(id) ?? []);
    if (boxes.length === 0) return;
    const scroller = renderer?.focusTarget ?? this.canvas;
    const view = scroller.getBoundingClientRect();
    const left = Math.min(...boxes.map((box) => box.left));
    const right = Math.max(...boxes.map((box) => box.right));
    const top = Math.min(...boxes.map((box) => box.top));
    const bottom = Math.max(...boxes.map((box) => box.bottom));
    scroller.scrollBy({
      left: (left + right - view.left - view.right) / 2,
      top: (top + bottom - view.top - view.bottom) / 2,
      behavior: "instant",
    });
  }

  private layout(): void {
    const renderer = this.renderer();
    const view = this.canvas.getBoundingClientRect();
    this.layer.hidden = !renderer || view.width === 0 || view.height === 0;
    if (this.layer.hidden) return;
    Object.assign(this.layer.style, {
      left: `${view.left}px`,
      top: `${view.top}px`,
      width: `${this.canvas.clientWidth}px`,
      height: `${this.canvas.clientHeight}px`,
    });
    const occupied: DOMRect[] = [];
    // Avoid covering other nodes when a diagram can enumerate them cheaply.
    const nodes = renderer?.drawnNodes?.();
    if (nodes && nodes.length <= 500) {
      for (const { id } of nodes) {
        const box = renderer?.itemBounds?.(id);
        if (box) occupied.push(box);
      }
    }
    for (const { mark, element, number } of this.callouts) {
      const box = renderer?.itemBounds?.(mark.id);
      element.hidden = !box || !overlaps(box, view);
      if (!box || element.hidden) continue;
      element.classList.remove("explanation-badge");
      element.textContent = `${number}. ${mark.text}`;
      element.style.maxWidth = `${Math.min(240, Math.max(40, view.width - 16))}px`;
      const { width, height } = element.getBoundingClientRect();
      const candidates = [
        new DOMRect(box.right + 8, box.top, width, height),
        new DOMRect(box.left, box.bottom + 8, width, height),
        new DOMRect(box.left, box.top - height - 8, width, height),
        new DOMRect(box.left - width - 8, box.top, width, height),
      ];
      let at = candidates.find(
        (candidate) =>
          candidate.left >= view.left + 4 &&
          candidate.right <= view.left + this.canvas.clientWidth - 4 &&
          candidate.top >= view.top + 4 &&
          candidate.bottom <= view.top + this.canvas.clientHeight - 4 &&
          !occupied.some((item) => overlaps(candidate, item)),
      );
      if (!at) {
        element.classList.add("explanation-badge");
        element.textContent = String(number);
        at = new DOMRect(
          Math.max(view.left, Math.min(view.right - 24, box.right - 8)),
          Math.max(view.top, Math.min(view.bottom - 24, box.top - 8)),
          24,
          24,
        );
      }
      element.style.left = `${at.left - view.left}px`;
      element.style.top = `${at.top - view.top}px`;
      occupied.push(at);
    }
  }
}
