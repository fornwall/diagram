import type { WebLink } from "./renderer";

let closeShown: ((refocus: boolean) => void) | undefined;
let shownIn: HTMLElement | undefined;

// Before drawing again, which keeps the focus on the node.
export function closeLinkMenu(container?: HTMLElement): void {
  if (container === undefined || container === shownIn) closeShown?.(true);
}

// In the scrolling container, so that it scrolls along.
export function showLinkMenu(
  container: HTMLElement,
  anchor: Element,
  label: string,
  links: readonly WebLink[],
  open: (url: string) => void,
): void {
  closeShown?.(false);
  const returnFocus = document.activeElement;
  const menu = document.createElement("div");
  menu.className = "link-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", label);
  // Resizing moves the centered anchor away; scrollbars leave the border box as it is.
  const { offsetWidth, offsetHeight } = container;
  const resized = new ResizeObserver(() => {
    if (container.offsetWidth !== offsetWidth || container.offsetHeight !== offsetHeight) {
      close(true);
    }
  });
  const close = (refocus: boolean) => {
    if (closeShown !== close) return;
    closeShown = undefined;
    resized.disconnect();
    // First: removing the focused entry leaves the focus on the body.
    if (refocus && (returnFocus instanceof HTMLElement || returnFocus instanceof SVGElement)) {
      returnFocus.focus({ preventScroll: true });
    }
    menu.remove();
  };
  for (const { name, url } of links) {
    const item = document.createElement("button");
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.tabIndex = -1;
    item.textContent = name;
    item.title = url;
    item.addEventListener("click", () => {
      close(true);
      open(url);
    });
    menu.append(item);
  }
  menu.addEventListener("keydown", (event) => {
    const items = Array.from(menu.children as HTMLCollectionOf<HTMLElement>);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = {
      ArrowDown: (at + 1) % items.length,
      ArrowUp: (at - 1 + items.length) % items.length,
      Home: 0,
      End: items.length - 1,
    }[event.key];
    if (next !== undefined) {
      event.preventDefault();
      items[next]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  });
  menu.addEventListener("focusout", (event) => {
    if (!(event.relatedTarget instanceof Node && menu.contains(event.relatedTarget))) close(false);
  });
  container.append(menu);
  closeShown = close;
  shownIn = container;
  resized.observe(container, { box: "border-box" });
  placeMenu(menu, container, anchor);
  menu.scrollIntoView({ block: "nearest", inline: "nearest" });
  (menu.firstElementChild as HTMLElement | null)?.focus({ preventScroll: true });
}

const MARGIN = 2;

// Within the visible container: a menu past its edges would scroll the drawing from under the
// pointer.
function placeMenu(menu: HTMLElement, container: HTMLElement, anchor: Element): void {
  const box = anchor.getBoundingClientRect();
  const outer = container.getBoundingClientRect();
  // In the container's scrolled content.
  const x = (clientX: number) => clientX - outer.left - container.clientLeft + container.scrollLeft;
  const y = (clientY: number) => clientY - outer.top - container.clientTop + container.scrollTop;
  // Measured at the start of the container, where nothing narrows the menu.
  menu.style.left = "0";
  menu.style.top = "0";
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const right = container.scrollLeft + container.clientWidth - MARGIN;
  const bottom = container.scrollTop + container.clientHeight - MARGIN;
  const left = Math.max(container.scrollLeft + MARGIN, Math.min(x(box.left), right - width));
  const below = y(box.bottom) + MARGIN;
  const above = y(box.top) - MARGIN - height;
  const top = below + height > bottom && above >= container.scrollTop + MARGIN ? above : below;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}
