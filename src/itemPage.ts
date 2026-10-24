// Page through rendered item identities without copying a chart's entire dataset.

import type { DiagramNode, ItemPage, ItemQuery } from "./protocol";

export function collectItemPage(
  each: (visit: (node: DiagramNode) => void) => void,
  { query, startItem, maxItems, itemIds }: ItemQuery,
): ItemPage {
  const items: DiagramNode[] = [];
  const wanted = itemIds === undefined ? undefined : new Set(itemIds);
  let totalItems = 0;
  let matchedItems = 0;
  let length = 0;
  let full = false;
  each((node) => {
    totalItems++;
    if (wanted && !wanted.has(node.id)) return;
    if (
      query !== undefined &&
      !node.id.includes(query) &&
      !node.label.includes(query) &&
      !node.relationship?.source.includes(query) &&
      !node.relationship?.target.includes(query)
    ) {
      return;
    }
    matchedItems++;
    if (matchedItems < startItem || items.length >= maxItems || full) return;
    length += JSON.stringify(node).length;
    // Leave room for the page metadata; never shorten an id or skip an oversized item.
    if (length > 20_000) {
      full = true;
      return;
    }
    items.push(node);
  });
  const nextItem = startItem + items.length;
  return {
    totalItems,
    matchedItems,
    startItem,
    items,
    ...(nextItem <= matchedItems ? { nextItem } : {}),
  };
}
