// Validate diagram_style input.

import { sourceColor } from "./cssColors";
import { isPlainObject } from "./protocol";
import { brief, givenProperties, quoteAll, unknownProperties } from "./text";

/** As declared in package.json, but a model may not follow the schema exactly. */
export interface StyleInput {
  styles?: {
    id: string;
    fill?: string | null;
    stroke?: string | null;
    text?: string | null;
    clear?: boolean;
  }[];
  revision?: number;
}

/**
 * What to change of one item, its colors as written into the source. An omitted color is kept,
 * null removes it, and "auto" text is black or white, whichever reads better on the fill.
 */
export interface StyleRequest {
  id: string;
  fill?: string | null;
  stroke?: string | null;
  text?: string | null;
  /** Removes the item's style line, including the properties that this tool does not set. */
  clear?: true;
  /**
   * A flowchart edge's number in linkStyle lines, which the request is for, by the id or name that
   * it gives the edge.
   */
  link?: number;
}

export interface StyleChange {
  styles: StyleRequest[];
  revision?: number;
}

export const AUTO_TEXT = "auto";

const INPUT_KEYS = ["styles", "revision"] as const satisfies readonly (keyof StyleInput)[];
const STYLE_KEYS = ["id", "fill", "stroke", "text", "clear"] as const;
const COLOR_KEYS = ["fill", "stroke", "text"] as const;

const MAX_STYLES = 50;
/** Longer than any color worth writing, e.g. "hsla(120deg 100% 25% / 0.5)". */
const MAX_COLOR_LENGTH = 64;

const EXAMPLE = '{"styles": [{"id": "pay", "fill": "green"}]}';
const COLOR_EXAMPLES = '"green", "#2e7d32", "rgb(46 125 50)" or "hsl(123 46% 34%)"';

/** Rejects malformed input with a list of problems, giving colors as written to the source. */
export function validateStyleInput(value: unknown): StyleChange {
  if (!isPlainObject(value)) {
    throw new Error(`The styles must be given as an object, e.g. ${EXAMPLE}.`);
  }
  // Some models send null for the properties they leave out.
  const input = givenProperties(value);
  const problems: string[] = [];
  const unknown = unknownProperties(input, INPUT_KEYS);
  if (unknown !== undefined) {
    problems.push(unknown);
  }

  const styles: StyleRequest[] = [];
  // One style, as a model may send it without an array.
  if (isPlainObject(input.styles)) input.styles = [input.styles];
  if (!Array.isArray(input.styles) || input.styles.length === 0) {
    problems.push(`"styles" must be a non-empty array of objects, e.g. ${EXAMPLE}.`);
  } else if (input.styles.length > MAX_STYLES) {
    problems.push(`"styles" has ${input.styles.length} items, more than ${MAX_STYLES}.`);
  } else {
    const seen = new Set<string>();
    for (const [index, given] of input.styles.entries()) {
      const style = parseStyle(given, seen);
      if (typeof style === "string") {
        problems.push(`Style ${index + 1}: ${style}`);
      } else {
        styles.push(style);
      }
    }
  }

  const { revision } = input;
  if (
    revision !== undefined &&
    (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)
  ) {
    problems.push('"revision" must be a nonnegative integer from diagram_getState.');
  }

  if (problems.length > 0) {
    throw new Error(`Invalid styles:\n- ${problems.join("\n- ")}`);
  }
  return revision === undefined ? { styles } : { styles, revision: revision as number };
}

function parseStyle(value: unknown, seen: Set<string>): StyleRequest | string {
  if (!isPlainObject(value)) {
    return 'A style must be an object, e.g. {"id": "pay", "fill": "green"}.';
  }
  // Null colors remove them, so only a null "clear" or "id" counts as left out.
  const unknown = unknownProperties(value, STYLE_KEYS);
  if (unknown !== undefined) {
    return unknown;
  }
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!id) {
    return '"id" must be the id of an item of the diagram, as a non-empty string.';
  }
  if (seen.has(id)) {
    return `${JSON.stringify(id)} is styled twice; give each item one entry.`;
  }
  seen.add(id);

  const clear = value.clear ?? false;
  if (typeof clear !== "boolean") {
    return '"clear" must be true or false.';
  }
  const given = COLOR_KEYS.filter((key) => value[key] !== undefined);
  if (clear) {
    const set = given.filter((key) => value[key] !== null);
    return set.length > 0
      ? `"clear" removes the whole style of ${JSON.stringify(id)}; leave out ${quoteAll(set)} or "clear".`
      : { id, clear: true };
  }
  if (given.length === 0) {
    return `Give "fill", "stroke" or "text" for ${JSON.stringify(id)}, null to remove one, or "clear": true to remove its style.`;
  }

  const style: StyleRequest = { id };
  for (const key of given) {
    const color = value[key];
    if (color === null) {
      style[key] = null;
    } else if (
      key === "text" &&
      typeof color === "string" &&
      color.trim().toLowerCase() === AUTO_TEXT
    ) {
      style.text = AUTO_TEXT;
    } else {
      const written =
        typeof color === "string" && color.length <= MAX_COLOR_LENGTH
          ? sourceColor(color)
          : undefined;
      if (written === undefined) {
        return (
          `"${key}" must be a CSS color such as ${COLOR_EXAMPLES}` +
          `${key === "text" ? ', or "auto"' : ""}, or null to remove it; ${brief(color)} is not one.`
        );
      }
      style[key] = written;
    }
  }
  // The text color is chosen for the fill, unless given. A removed fill takes it along.
  if (style.text === undefined && style.fill !== undefined) {
    style.text = style.fill === null ? null : AUTO_TEXT;
  }
  return style;
}
