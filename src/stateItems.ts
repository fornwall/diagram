// Fit complete item records to a tool result, preserving ids and continuation positions.

import type { ItemPage } from "./protocol";
import { fitWholeRecords } from "./toolContracts";

export async function itemPageText(
  page: ItemPage,
  revision: number,
  fits: (text: string) => Promise<boolean>,
): Promise<string> {
  const { items, startItem, matchedItems } = page;
  const response = (count: number) => {
    const nextItem = startItem + count;
    return JSON.stringify({
      revision,
      totalItems: page.totalItems,
      matchedItems,
      startItem,
      items: items.slice(0, count),
      nextItem: nextItem <= matchedItems ? nextItem : undefined,
      note:
        matchedItems === 0
          ? "No matching items."
          : startItem > matchedItems
            ? `startItem is past the end; use 1 through ${matchedItems}.`
            : undefined,
    });
  };
  const result = await fitWholeRecords(items.length ? 1 : 0, items.length, response, fits);
  // An empty page before the end means even its first item exceeded the transport limit.
  if (result !== undefined && (items.length > 0 || startItem > matchedItems)) return result;
  const reason =
    startItem > matchedItems
      ? "Item metadata does not fit the result budget. Use a larger budget."
      : items.length === 0
        ? `Item ${startItem} exceeds the 20,000-character page limit. Shorten its id or label, or skip it with startItem:${startItem + 1}.`
        : `Item ${startItem} does not fit the result budget. Use a larger budget, or skip it with startItem:${startItem + 1}. No item was returned.`;
  const message = `Revision: ${revision}. ${reason}`;
  return (await fits(message)) ? message : "Item lookup needs a larger tool result budget.";
}
