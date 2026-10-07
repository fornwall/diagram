// Wording shared by the messages for users and models.

import { isPlainObject } from "./protocol";

/** E.g. `"a", "b"`. */
export function quoteAll(values: readonly string[]): string {
  return values.map((value) => JSON.stringify(value)).join(", ");
}

/** Text as quoted in a message: as JSON, shortened to `max` characters. */
export function quote(text: string, max = 40): string {
  return JSON.stringify(text.length > max ? `${text.slice(0, max)}…` : text);
}

/** E.g. "1 row" or "3 rows". */
export function plural(count: number, noun: string, nouns = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : nouns}`;
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
