// Reading JSON, or JSON Lines, as records.

import type { Cell, Records } from "./data";
import { errorMessage, isPlainObject } from "./protocol";

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

function recordsFromJsonArray(array: unknown[]): Records {
  if (array.length === 0) {
    throw new Error("The JSON array is empty.");
  }
  if (array.every(isPlainObject)) {
    const keys = [...new Set(array.flatMap((item) => Object.keys(item)))];
    return {
      records: [keys, ...array.map((item) => keys.map((key) => jsonCell(item[key])))],
      header: true,
    };
  }
  if (array.every(Array.isArray)) {
    return { records: array.map((row) => row.map(jsonCell)) };
  }
  if (array.every(isScalar)) {
    return { records: [["value"], ...array.map((item) => [jsonCell(item)])], header: true };
  }
  throw new Error("The JSON array mixes objects, arrays and plain values.");
}

function recordsFromJson(value: unknown): Records {
  if (Array.isArray(value)) {
    return recordsFromJsonArray(value);
  }
  if (!isPlainObject(value)) {
    throw new Error("The JSON is neither an array nor an object.");
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
    return {
      records: [["name", "value"], ...names.map((name, i) => [name, jsonCell(columns[i])])],
      header: true,
    };
  }
  if (columns.every(isPlainObject)) {
    const [keys = [], ...rows] = recordsFromJsonArray(columns).records;
    return {
      records: [
        [keys.includes("name") ? "key" : "name", ...keys],
        ...rows.map((row, i) => [names[i] ?? null, ...row]),
      ],
      header: true,
    };
  }
  throw new Error(
    "The JSON object must map names to numbers, map names to objects, map column names to " +
      "equally long arrays, or hold one array of rows.",
  );
}

/**
 * Parses newline-delimited JSON, as printed by jq -c or docker ps --format json, or returns
 * undefined unless the first of several lines is a JSON value.
 */
function parseJsonLines(text: string): unknown[] | undefined {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length < 2) {
    return undefined;
  }
  const values: unknown[] = [];
  for (const [i, line] of lines.entries()) {
    try {
      values.push(JSON.parse(line));
    } catch (error) {
      if (i === 0) {
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
  return recordsFromJson(value);
}
