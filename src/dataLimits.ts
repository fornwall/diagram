// Bounding the size of tables, so that too much data fails with advice, not by exhausting memory.

import { formatCount, plural } from "./text";

/** The most cells that a table may have, counting those that short rows leave empty. */
export const MAX_CELLS = 1_000_000;

export class TableSizeError extends Error {}

/** A function, as formatting the first number loads locale data, which activation need not wait for. */
const limit = () => `the ${formatCount(MAX_CELLS)} cell limit`;

export function checkTableSize(rows: number, columns: number): void {
  if (rows * columns > MAX_CELLS) {
    throw new TableSizeError(
      `The data expands to ${plural(rows, "row")} × ${plural(columns, "column")}, counting any ` +
        `header row and empty cells, exceeding ${limit()}. ` +
        "Select fewer rows or columns, or summarize the data before charting it.",
    );
  }
}

/** Refuses so many rows that they are too many before their columns are counted. */
export function checkRowCount(rows: number): void {
  if (rows > MAX_CELLS) {
    throw new TableSizeError(
      `The data has ${plural(rows, "row")}, counting any header row, exceeding ${limit()} even ` +
        "with one column. Select fewer rows, or summarize the data before charting it.",
    );
  }
}

/**
 * Refuses a row of so many cells that it is too wide by itself, before the other rows are read.
 * Rows may be split only up to just over the limit, so `cells` may be fewer than the row has.
 */
export function checkRowWidth(cells: number): void {
  if (cells > MAX_CELLS) {
    throw new TableSizeError(
      `A row of the data has more than ${formatCount(MAX_CELLS)} cells, exceeding ${limit()} by ` +
        "itself. Select fewer columns, or summarize the data before charting it.",
    );
  }
}
