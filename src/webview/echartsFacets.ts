// Lays out the panels of a faceted chart, as diagram_chart makes them, for the size of the panel:
// rows too short to read go in more columns, and a chart too short for its facets scrolls.

import { facetBoxes } from "../chartFacetLayout";
import { asArray } from "../protocol";
import { BOX_KEYS, type Insets, type Size, styleOf } from "./echartsMeasure";
import { baseOption, type JsonObject } from "./echartsOption";

/** The least readable size of a row of facets, and of a facet, which more columns trade off. */
const MIN_FACET_HEIGHT = 150;

const MIN_FACET_WIDTH = 140;

/** The height of a facet's title above its grid, and the gaps between facets. */
const FACET_TITLE_HEIGHT = 26;

const FACET_ROW_GAP = 12;

const FACET_COLUMN_GAP = 24;

/** The size of facets below which the panel scrolls the chart, rather than crush them further. */
const MIN_SCROLLED_FACET_HEIGHT = 100;

const MIN_SCROLLED_FACET_WIDTH = 80;

interface Facet {
  grid: JsonObject;
  title: JsonObject;
}

const sameBox = (object: JsonObject, box: object, keys: string[]) =>
  keys.every((key) => object[key] === (box as JsonObject)[key]);

/**
 * The panels of a faceted chart, each a grid and the title of the same id, where chartFacets
 * places them, in as many columns, or undefined if the option places its grids otherwise, as a
 * user's options can.
 */
export function facetPanels(base: JsonObject): { facets: Facet[]; columns: number } | undefined {
  const grids = asArray(base.grid);
  if (grids.length < 2) return undefined;
  const titles = asArray(base.title);
  const columns = grids.filter((grid) => grid.top === grids[0]?.top).length;
  const boxes = facetBoxes(grids.length, columns);
  const facets: Facet[] = [];
  for (const [index, grid] of grids.entries()) {
    const title = grid.id === undefined ? undefined : titles.find(({ id }) => id === grid.id);
    const box = boxes[index];
    if (
      !title ||
      !box ||
      !sameBox(grid, box.grid, BOX_KEYS) ||
      !sameBox(title, box.title, ["left", "right", "top", "bottom"])
    ) {
      return undefined;
    }
    facets.push({ grid, title });
  }
  return { facets, columns };
}

/** The rows of facets in a number of columns, and their width, in the width there is for them. */
const facetGrid = (facets: Facet[], areaWidth: number) => ({
  rows: (columns: number) => Math.ceil(facets.length / columns),
  panelWidth: (columns: number) => (areaWidth - (columns - 1) * FACET_COLUMN_GAP) / columns,
});

/**
 * The least height at which a chart can be read, for the panel to scroll to when it is shorter,
 * or 0 for any height: a row of facets for every few of them, as narrow as they can be.
 */
export function minimumHeight(option: JsonObject, width: number): number {
  const base = baseOption(option);
  const panels = option.media === undefined ? facetPanels(base) : undefined;
  if (!panels) return 0;
  const { facets, columns } = panels;
  const { rows, panelWidth } = facetGrid(facets, width - 32);
  let least = rows(columns);
  for (let more = columns + 1; more <= facets.length; more++) {
    if (panelWidth(more) >= MIN_SCROLLED_FACET_WIDTH) least = Math.min(least, rows(more));
  }
  // The legend of several measures below the facets.
  const legend = asArray(base.legend).some(({ show }) => show !== false) ? 32 : 0;
  return least * MIN_SCROLLED_FACET_HEIGHT + 12 + legend;
}

/**
 * Lays out the panels of a faceted chart for its size in pixels, in the space left: the
 * percentages of the option would leave a short panel's plot hardly any of its height. Rows too
 * short to read go in more columns, unless that makes the panels too narrow instead. Returns the
 * size of a grid in pixels.
 */
export function layOutFacets(
  { facets, columns: placed }: { facets: Facet[]; columns: number },
  reserved: Insets,
  size: Size,
): { width: number; height: number } {
  const { width, height } = size;
  const top = reserved.top + 8;
  const left = reserved.left + 16;
  const areaWidth = width - left - reserved.right - 16;
  const areaHeight = height - top - reserved.bottom - 4;
  const { rows, panelWidth } = facetGrid(facets, areaWidth);
  // How near a number of columns comes to panels of the least readable size, at most 1.
  const fit = (columns: number) =>
    Math.min(
      1,
      areaHeight / rows(columns) / MIN_FACET_HEIGHT,
      panelWidth(columns) / MIN_FACET_WIDTH,
    );
  let columns = placed;
  for (let more = columns + 1; more <= facets.length; more++) {
    if (fit(more) > fit(columns)) columns = more;
  }
  const rowHeight = areaHeight / rows(columns);
  const gridWidth = Math.round(panelWidth(columns));
  const gridHeight = Math.max(20, Math.round(rowHeight - FACET_TITLE_HEIGHT - FACET_ROW_GAP));
  facets.forEach(({ grid, title }, index) => {
    const x = Math.round(left + (index % columns) * (panelWidth(columns) + FACET_COLUMN_GAP));
    const y = Math.round(top + Math.floor(index / columns) * rowHeight);
    // In percent of the size laid out for, which a chart resized without a new layout, as while
    // dragging the splitter, scales, rather than cut off panels or leave room beside them.
    const across = (pixels: number) => `${(pixels / width) * 100}%`;
    const down = (pixels: number) => `${(pixels / height) * 100}%`;
    Object.assign(title, { left: across(x), top: down(y) });
    Object.assign(grid, {
      left: across(x),
      top: down(y + FACET_TITLE_HEIGHT),
      width: across(gridWidth),
      height: down(gridHeight),
    });
  });
  shortenFacetTitles(facets, gridWidth - 16, size);
  return { width: gridWidth, height: gridHeight };
}

/**
 * Leaves out the facet column's name, as in "region = ", from the titles of facets when one of
 * them would not fit its panel: the values tell the panels apart, and the panel's header or the
 * chart's title usually names the column.
 */
function shortenFacetTitles(facets: Facet[], width: number, size: Size): void {
  const texts = facets.map(({ title }) => (typeof title.text === "string" ? title.text : ""));
  // In the theme's font of titles, but of chartFacets' size.
  const title = { ...size.themed, fontSize: 13, fontWeight: 600 };
  const font = size.font(styleOf(facets[0]?.title.textStyle), title);
  if (texts.every((text) => font.width(text) <= width)) return;
  const values = facets.map(({ grid }) => facetValue(grid.id));
  // chartFacets titles a facet "<column> = <value>", the value quoted when values would collide.
  const prefixes = texts.map((text, index) => {
    const value = values[index];
    if (value === undefined) return undefined;
    const label = value.value === null ? "(missing)" : String(value.value);
    const suffix = [label, JSON.stringify(value.value)].find(
      (each) => text.endsWith(each) && text.slice(0, -each.length).endsWith(" = "),
    );
    return suffix === undefined ? undefined : text.slice(0, -suffix.length);
  });
  const prefix = prefixes[0];
  if (prefix === undefined || prefixes.some((each) => each !== prefix)) return;
  facets.forEach(({ title }, index) => {
    title.text = texts[index]?.slice(prefix.length);
  });
}

/** The value of a facet, by the id that chartFacets gives its grid. */
function facetValue(id: unknown): { value: unknown } | undefined {
  if (typeof id !== "string" || !id.startsWith("facet:")) return undefined;
  try {
    return { value: JSON.parse(id.slice("facet:".length)) };
  } catch {
    return undefined;
  }
}
