// A menu of the links that the source gives a node, such as a sequence diagram actor's.

import type { WebLink } from "./renderer";

/** Closes the menu shown, if any, moving the focus back to where it was if asked to. */
let closeShown: ((refocus: boolean) => void) | undefined;

/**
 * Closes the menu shown, if any, as the diagram is about to be drawn again: the focus goes back to
 * the node, which the drawing keeps it on.
 */
export function closeLinkMenu(): void {
  closeShown?.(true);
}

/**
 * Shows a menu of the links below the anchor, in the scrolling container so that it scrolls along,
 * and focuses its first entry. Choosing one calls open. Arrow keys, Home and End move between the
 * entries; Escape closes the menu, as does moving the focus out of it, by a click elsewhere or Tab.
 */
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
  const close = (refocus: boolean) => {
    if (closeShown !== close) return;
    closeShown = undefined;
    // Before removing the menu: removing its focused entry first leaves the focus on the body.
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
  const box = anchor.getBoundingClientRect();
  const outer = container.getBoundingClientRect();
  menu.style.left = `${box.left - outer.left + container.scrollLeft}px`;
  menu.style.top = `${box.bottom - outer.top + container.scrollTop + 2}px`;
  container.append(menu);
  closeShown = close;
  menu.scrollIntoView({ block: "nearest", inline: "nearest" });
  (menu.firstElementChild as HTMLElement | null)?.focus({ preventScroll: true });
}
