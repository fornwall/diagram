// Bound the rectangular table, including empty cells introduced by ragged input.
export const MAX_CELLS = 1_000_000;

export class TableSizeError extends Error {}

export function checkTableSize(rows: number, columns: number): void {
  if (rows * columns > MAX_CELLS) {
    throw new TableSizeError(
      `The data expands to ${rows} rows × ${columns} columns, exceeding the 1,000,000 cell limit. ` +
        "Select fewer rows or columns, or summarize the data before charting it.",
    );
  }
}
