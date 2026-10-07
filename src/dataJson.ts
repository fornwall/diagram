// Reading JSON, JSON Lines or other streams of JSON values as records.

import type { Cell, Records } from "./data";
import { checkTableSize } from "./dataLimits";
import { errorClause, isPlainObject } from "./protocol";
import { quoteAll } from "./text";

function jsonCell(value: unknown): Cell {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function isScalar(value: unknown): boolean {
  return !isPlainObject(value) && !Array.isArray(value);
}

/** How many levels of nested objects become columns; deeper ones stay JSON text. */
const MAX_DEPTH = 10;

/**
 * The fields of an object, with those of nested objects under dotted names as pandas'
 * json_normalize gives them: {"cpu": {"user": 1}} has the field "cpu.user".
 */
function flatten(
  object: Record<string, unknown>,
  prefix = "",
  // Without a prototype, so that a "__proto__" field is set like any other.
  fields: Record<string, unknown> = Object.create(null),
  depth = 1,
): Record<string, unknown> {
  for (const [key, value] of Object.entries(object)) {
    if (isPlainObject(value) && Object.keys(value).length > 0 && depth < MAX_DEPTH) {
      flatten(value, `${prefix}${key}.`, fields, depth + 1);
    } else {
      fields[`${prefix}${key}`] ??= value;
    }
  }
  return fields;
}

function kind(value: unknown): string {
  return Array.isArray(value) ? "an array" : isPlainObject(value) ? "an object" : "a plain value";
}

function recordsFromJsonArray(array: unknown[]): Records {
  if (array.length === 0) {
    throw new Error("The JSON array is empty.");
  }
  if (array.every(isPlainObject)) {
    const objects = array.map((item) =>
      Object.values(item).some(isPlainObject) ? flatten(item) : item,
    );
    const names = new Set<string>();
    for (const item of objects) {
      for (const key of Object.keys(item)) {
        names.add(key);
      }
      checkTableSize(objects.length + 1, names.size);
    }
    const keys = [...names];
    return {
      records: [
        keys,
        ...objects.map((item) =>
          keys.map((key) => (Object.hasOwn(item, key) ? jsonCell(item[key]) : null)),
        ),
      ],
      header: true,
    };
  }
  if (array.every(Array.isArray)) {
    checkTableSize(
      array.length,
      array.reduce((width, row) => Math.max(width, row.length), 0),
    );
    return { records: array.map((row) => row.map(jsonCell)) };
  }
  if (array.every(isScalar)) {
    checkTableSize(array.length + 1, 1);
    return { records: [["value"], ...array.map((item) => [jsonCell(item)])], header: true };
  }
  const first = kind(array[0]);
  const other = array.findIndex((item) => kind(item) !== first);
  throw new Error(
    `The JSON array mixes kinds of items: item 1 is ${first}, but item ${other + 1} is ` +
      `${kind(array[other])}. Make every item an object, or every item an array.`,
  );
}

/** The names of the plain values that an API's answer holds beside its data, about the answer. */
const ENVELOPE_FIELDS = new Set(
  "status ok success code message msg error version apiversion kind".split(" "),
);

/** Notes that only the field `name` of an object was read, not the fields `beside` it. */
function readOnly(name: string, beside: string[]): string {
  return `Only ${JSON.stringify(name)} was read, not ${quoteAll(beside)} beside it.`;
}

/**
 * The object inside wrappers, as in {"data": {"repo": {...}}}, however deeply they nest. One of
 * them may also be an envelope, which holds it beside plain values: either about the answer, as
 * the Prometheus API's {"status": "success", "data": {...}}, or about a map of records, as npm ls
 * --json's {"name": "app", "dependencies": {"a": {...}}}. The note names what was left out.
 */
function unwrap(json: unknown): { value: unknown; note?: string } {
  let value = json;
  let note: string | undefined;
  while (isPlainObject(value)) {
    const entries = Object.entries(value);
    const objects = entries.filter(([, item]) => isPlainObject(item));
    const [name = "", inner] = objects[0] ?? [];
    if (objects.length !== 1 || !isPlainObject(inner)) break;
    if (entries.length > 1) {
      const records = Object.values(inner);
      const map = records.length > 0 && records.every(isPlainObject);
      const beside = entries.flatMap(([key]) => (key === name ? [] : [key]));
      if (
        note !== undefined ||
        entries.some(([, item]) => Array.isArray(item)) ||
        !(map || beside.every((key) => ENVELOPE_FIELDS.has(key.toLowerCase())))
      ) {
        break;
      }
      note = readOnly(name, beside);
      // A map of records is the data, however few records it has, rather than another wrapper.
      if (map) return { value: inner, note };
    }
    value = inner;
  }
  return note === undefined ? { value } : { value, note };
}

function recordsFromJson(value: unknown): Records {
  if (Array.isArray(value)) {
    return recordsFromJsonArray(value);
  }
  if (!isPlainObject(value)) {
    throw new Error(`The JSON is ${kind(value)}, not an array or object of rows.`);
  }
  const names = Object.keys(value);
  const columns = Object.values(value);
  if (names.length === 0) {
    throw new Error("The JSON object is empty.");
  }
  const length = Array.isArray(columns[0]) ? columns[0].length : 0;
  if (
    length > 0 &&
    columns.every(
      (item): item is unknown[] =>
        Array.isArray(item) && item.length === length && item.every(isScalar),
    )
  ) {
    // Columns: {"label": ["a", "b"], "count": [1, 2]}.
    checkTableSize(length + 1, names.length);
    return {
      records: [
        names,
        ...Array.from({ length }, (_, row) => columns.map((column) => jsonCell(column[row]))),
      ],
      header: true,
    };
  }
  // Rows wrapped in an object: {"items": [...], "errors": [], "count": 2}.
  const arrays = Object.entries(value).filter((entry): entry is [string, unknown[]] =>
    Array.isArray(entry[1]),
  );
  const nonEmpty = arrays.filter(([, array]) => array.length > 0);
  const [name = "", rows] =
    (arrays.length === 1 ? arrays[0] : nonEmpty.length === 1 ? nonEmpty[0] : undefined) ?? [];
  if (rows !== undefined) {
    const records = recordsFromJsonArray(rows);
    const beside = names.filter((key) => key !== name);
    return beside.length === 0 ? records : { ...records, note: readOnly(name, beside) };
  }
  if (columns.every(isScalar)) {
    checkTableSize(names.length + 1, 2);
    return {
      records: [["name", "value"], ...names.map((name, i) => [name, jsonCell(columns[i])])],
      header: true,
    };
  }
  if (columns.every(isPlainObject)) {
    const [keys = [], ...rows] = recordsFromJsonArray(columns).records;
    checkTableSize(rows.length + 1, keys.length + 1);
    const existing = new Set(keys.map((key) => String(key).trim()));
    let keyName = "name";
    for (let suffix = 1; existing.has(keyName); suffix++) {
      keyName = suffix === 1 ? "key" : `key (${suffix})`;
    }
    return {
      records: [[keyName, ...keys], ...rows.map((row, i) => [names[i] ?? null, ...row])],
      header: true,
    };
  }
  throw new Error(
    "The JSON object must map names to plain values, map names to objects, map column names to " +
      "equally long arrays, or hold one array of rows.",
  );
}

/** A JSON string up to its closing quote. */
const OPEN_STRING = String.raw`"[^"\\]*(?:\\[\s\S][^"\\]*)*`;

/**
 * NaN and Infinity, as Python's json module writes numbers that are not finite, though JSON has
 * no such values; strings are matched to be kept as they are.
 */
const NON_FINITE = new RegExp(String.raw`(${OPEN_STRING}")|-?\bInfinity\b|\bNaN\b`, "g");

/** Parses a JSON value, reading NaN and Infinity as null. */
function parseValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    // Only when they occur, as JSON Lines, also invalid as a whole, are parsed again by value.
    if (!text.includes("NaN") && !text.includes("Infinity")) throw error;
    const finite = text.replace(NON_FINITE, (_, string?: string) => string ?? "null");
    try {
      return JSON.parse(finite);
    } catch {
      throw error;
    }
  }
}

/**
 * A string, perhaps left open at the end, a bracket, or other text between them, such as "1",
 * "true" or ":".
 */
const JSON_TOKEN = new RegExp(String.raw`${OPEN_STRING}"?|[[{]|[\]}]|[^\s"[\]{}]+`, "g");

/**
 * Parses a stream of JSON values: JSON Lines, as jq -c and docker ps --format json print them, or
 * values over several lines, as jq prints them without -c. Returns undefined unless the first of
 * several values is valid.
 */
function parseJsonStream(text: string): unknown[] | undefined {
  const starts: number[] = [];
  const ends: number[] = [];
  let depth = 0;
  JSON_TOKEN.lastIndex = 0;
  for (let match = JSON_TOKEN.exec(text); match !== null; match = JSON_TOKEN.exec(text)) {
    if (depth === 0) starts.push(match.index);
    const token = match[0];
    if (token === "[" || token === "{") depth++;
    else if (token === "]" || token === "}") depth--;
    if (depth <= 0) {
      depth = 0;
      ends.push(JSON_TOKEN.lastIndex);
    }
  }
  if (starts.length < 2) return undefined;
  const values: unknown[] = [];
  for (const [i, start] of starts.entries()) {
    try {
      // A value left open at the end is parsed too, to report it.
      values.push(parseValue(text.slice(start, ends[i])));
    } catch (error) {
      if (i === 0) return undefined;
      const line = (text.slice(0, start).match(/\r\n?|\n/g)?.length ?? 0) + 1;
      // Leaves out V8's "(line 1 column 8)", which counts lines from the value's first.
      const message = errorClause(error).replace(/ \(line \d+ column \d+\)/, "");
      throw new Error(`The JSON value on line ${line} is not valid JSON: ${message}.`);
    }
  }
  return values;
}

export function parseJson(text: string): Records {
  let value: unknown;
  try {
    value = parseValue(text);
  } catch (error) {
    value = parseJsonStream(text);
    if (value === undefined) {
      throw new Error(`The data is not valid JSON: ${errorClause(error)}.`);
    }
  }
  const unwrapped = unwrap(value);
  const records = recordsFromJson(unwrapped.value);
  // The envelope's note comes first, as in {"status": "ok", "data": {"items": [...], "count": 2}}.
  const notes = [unwrapped.note, records.note].filter((note) => note !== undefined);
  return notes.length === 0 ? records : { ...records, note: notes.join(" ") };
}
