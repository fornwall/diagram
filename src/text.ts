// Wording shared by the messages for users and models.

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
 * has only `known` properties. Unknown properties are refused rather than ignored, as a model
 * that sends one has likely misnamed it.
 */
export function unknownProperties(input: object, known: readonly string[]): string | undefined {
  const unknown = Object.keys(input).filter((key) => !known.includes(key));
  if (unknown.length === 0) {
    return undefined;
  }
  const properties = unknown.length === 1 ? "property" : "properties";
  return `Unknown ${properties} ${quoteAll(unknown)}; the properties are ${quoteAll(known)}.`;
}
