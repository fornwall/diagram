// Where the panels of a faceted chart go: in percent of the chart's size, as the option holds
// them, which the webview recognizes to lay the panels out again in pixels for the panel's size.

export interface FacetBox {
  grid: { left: string; top: string; width: string; height: string };
  title: { left: string; top: string };
}

/** The boxes of `count` panels in `columns` columns, and of their titles. */
export function facetBoxes(count: number, columns: number): FacetBox[] {
  const rows = Math.ceil(count / columns);
  // The heights, in percent of the chart's, of a row of panels and of a panel's title.
  const rowHeight = 87 / rows;
  const titleHeight = Math.min(7, 20 / rows);
  return Array.from({ length: count }, (_, i) => {
    const left = 2 + ((i % columns) * 96) / columns;
    const top = 3 + Math.floor(i / columns) * rowHeight;
    return {
      grid: {
        left: `${left}%`,
        top: `${top + titleHeight}%`,
        width: `${96 / columns - 4}%`,
        height: `${rowHeight - titleHeight - 4}%`,
      },
      title: { left: `${left}%`, top: `${top}%` },
    };
  });
}
