// Bounding the size of tables, so that too much data fails with advice, not by exhausting memory.

import { formatCount, plural } from "./text";

/** The most cells that a table may have, counting those that short rows leave empty. */
export const MAX_CELLS = 1_000_000;

export class TableSizeError extends Error {}

export function checkTableSize(rows: number, columns: number): void {
  if (rows * columns > MAX_CELLS) {
    throw new TableSizeError(
      `The data expands to ${plural(rows, "row")} × ${plural(columns, "column")}, counting any ` +
        `header row and empty cells, exceeding the ${formatCount(MAX_CELLS)} cell limit. ` +
        "Select fewer rows or columns, or summarize the data before charting it.",
    );
  }
}
