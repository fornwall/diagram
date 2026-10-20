// Wording shared by the messages for users and models.

import { isPlainObject } from "./protocol";

/** A name in camel case in words, e.g. "horizontal bar" for "horizontalBar". */
export function inWords(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
}

/** E.g. `"a", "b"`. */
export function quoteAll(values: readonly string[]): string {
  return values.map((value) => JSON.stringify(value)).join(", ");
}

/** E.g. "a, b or c": a list as the messages and README word it, without a serial comma. */
export function joinWords(words: readonly string[], conjunction: "and" | "or"): string {
  return words.length > 1
    ? `${words.slice(0, -1).join(", ")} ${conjunction} ${words.at(-1)}`
    : (words[0] ?? "");
}

/**
 * Text as quoted in a message: as JSON, shortened to `max` UTF-16 code units, without splitting a
 * character in two, which JSON would show as an escape such as \ud83d.
 */
export function quote(text: string, max = 40): string {
  return JSON.stringify(shorten(text, max));
}

/** Text shortened to `max` UTF-16 code units and an ellipsis, without splitting a character. */
export function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).replace(/[\uD800-\uDBFF]$/, "")}…` : text;
}

/**
 * The edit distance between two words: how many letters to add, remove or replace, or pairs of
 * them to swap, as in "titel".
 */
export function editDistance(a: string, b: string): number {
  let before: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      let least = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        least = Math.min(least, (before[j - 2] as number) + 1);
      }
      current[j] = least;
    }
    before = previous;
    previous = current;
  }
  return previous[b.length] as number;
}

/** A value as an error message names it: as JSON, unless too long to quote. */
export function brief(value: unknown): string {
  if (value === undefined) {
    return "missing";
  }
  if (typeof value === "string") {
    return quote(value);
  }
  const json = JSON.stringify(value);
  return json.length <= 40 ? json : Array.isArray(value) ? "an array" : "an object";
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Text as it reads in HTML, in an element or in an attribute's value in either quotes. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** The line and column of `offset` in `text`, counted from 1, as an editor counts them. */
export function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lineStart = Math.max(before.lastIndexOf("\n"), before.lastIndexOf("\r")) + 1;
  const line = (before.match(/\r\n?|\n/g)?.length ?? 0) + 1;
  return { line, column: offset - lineStart + 1 };
}

/** A count or limit as messages give it, e.g. "1,000,000". */
export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** E.g. "1 row" or "1,200 rows". */
export function plural(n: number, noun: string, nouns = `${noun}s`): string {
  return `${formatCount(n)} ${n === 1 ? noun : nouns}`;
}

/** A tool input's properties, without the nulls that some models send for those they leave out. */
export function givenProperties(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value != null));
}

/**
 * E.g. `Unknown property "colour"; the properties are "type", "title".`, or undefined if `input`
 * has only `known` properties. A model that sends an unknown property has likely misnamed it, so
 * the tools refuse such input, except that diagram_render draws and names it, as its source is
 * costly to send again.
 */
export function unknownProperties(input: object, known: readonly string[]): string | undefined {
  const unknown = Object.keys(input).filter((key) => !known.includes(key));
  if (unknown.length === 0) {
    return undefined;
  }
  const properties = unknown.length === 1 ? "property" : "properties";
  return `Unknown ${properties} ${quoteAll(unknown)}; the properties are ${quoteAll(known)}.`;
}

/**
 * A tool input's {@link givenProperties}.
 *
 * @throws Error if it is not an object or has properties other than `known`.
 */
export function toolInput(value: unknown, known: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error(`The input must be an object with the properties ${quoteAll(known)}.`);
  }
  const input = givenProperties(value);
  const unknown = unknownProperties(input, known);
  if (unknown !== undefined) {
    throw new Error(unknown);
  }
  return input;
}

export function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
