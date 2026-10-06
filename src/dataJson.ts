// Reading JSON, or JSON Lines, as records.

import type { Cell, Records } from "./data";
import { checkTableSize } from "./dataLimits";
import { errorMessage, isPlainObject } from "./protocol";
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

/**
 * The object inside wrappers, as in {"data": {"repo": {...}}}, however deeply they nest. One of
 * them may also be an envelope, which holds it beside plain values: either about the answer, as
 * the Prometheus API's {"status": "success", "data": {...}}, or about a map of records, as npm ls
 * --json's {"name": "app", "dependencies": {"a": {...}}}. The note names what was left out.
 */
function unwrap(json: unknown): { value: unknown; note?: string } {
  let value = json;
  let note: string | undefined;
  for (;;) {
    if (!isPlainObject(value)) break;
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
      note = `Only ${JSON.stringify(name)} was read, not ${quoteAll(beside)} beside it.`;
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
  const arrays = columns.filter(Array.isArray);
  const nonEmpty = arrays.filter((array) => array.length > 0);
  const rows = arrays.length === 1 ? arrays[0] : nonEmpty.length === 1 ? nonEmpty[0] : undefined;
  if (rows !== undefined) {
    return recordsFromJsonArray(rows);
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

/**
 * Parses newline-delimited JSON, as printed by jq -c or docker ps --format json, or returns
 * undefined unless the first of several lines is a JSON value.
 */
function parseJsonLines(text: string): unknown[] | undefined {
  const lines = text.split(/\r\n?|\n/);
  if (lines.length < 2) {
    return undefined;
  }
  const values: unknown[] = [];
  for (const [i, line] of lines.entries()) {
    if (line.trim() === "") {
      continue;
    }
    try {
      values.push(JSON.parse(line));
    } catch (error) {
      if (values.length === 0) {
        return undefined;
      }
      // Leaves out V8's "(line 1 column 8)", which counts lines from this one.
      const message = errorMessage(error).replace(/ \(line \d+ column \d+\)/, "");
      throw new Error(`Line ${i + 1} of the JSON Lines is not valid JSON: ${message}.`);
    }
  }
  return values;
}

export function parseJson(text: string): Records {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    value = parseJsonLines(text);
    if (value === undefined) {
      throw new Error(`The data is not valid JSON: ${errorMessage(error)}.`);
    }
  }
  const unwrapped = unwrap(value);
  const records = recordsFromJson(unwrapped.value);
  return unwrapped.note === undefined ? records : { ...records, note: unwrapped.note };
}
