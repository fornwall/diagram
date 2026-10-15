// Copies of a chart option for a layout to fill in, which share its data, and whether two such
// layouts are the same.

import { isPlainObject } from "../protocol";
import type { JsonObject } from "./echartsOption";

const needsCopy = (value: unknown) => Array.isArray(value) || isPlainObject(value);

/** The data of a chart, which a layout reads without changing: styling a sankey copies its nodes. */
const DATA_KEYS = new Set(["data", "nodes", "links", "edges", "source"]);

/**
 * Copies option settings, so that the layout can fill in what it needs while leaving the option
 * it was given untouched: the renderer keeps that one and lays it out again on a resize. Not
 * structuredClone, which throws on the functions of an option written as JavaScript, such as a
 * custom series' renderItem or a formatter.
 *
 * What isPlainObject accepts is copied, as every writer here reaches its targets through it, so
 * that no object the layout writes to is still the caller's. Functions and data payloads are
 * carried over by reference: copying every point, dataset row or hierarchy node would make each
 * resize allocate the whole dataset again. Other arrays are copied only when they hold objects or
 * arrays; none is written in place.
 */
export function cloneOption(option: JsonObject): JsonObject {
  const copy: JsonObject = {};
  // for...in rather than Object.entries, to copy what the option inherits as well: a series
  // written with a prototype of its own keeps its type and its styles that way.
  for (const key in option) {
    const value = DATA_KEYS.has(key) ? option[key] : cloneValue(option[key]);
    if (key === "__proto__") {
      // An own "__proto__" key, which JSON.parse does produce, has to be defined rather than
      // assigned: assigning it would reach the prototype setter and change the copy instead.
      Object.defineProperty(copy, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } else {
      copy[key] = value;
    }
  }
  return copy;
}

/** A copy of a value of an option, as {@link cloneOption} makes them. */
export function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.some(needsCopy) ? value.map(cloneValue) : value;
  }
  if (!isPlainObject(value)) {
    // A function or a primitive: never written to, and a function cannot be copied at all.
    return value;
  }
  if (value instanceof Date) {
    // A date is a value in the data of a time axis, not a record of properties to copy.
    return new Date(value.getTime());
  }
  // The data of a large chart can be a typed array, which copying properties would turn into an
  // object of its indices; the layout only reads data.
  return ArrayBuffer.isView(value) ? value : cloneOption(value);
}

/**
 * Whether two layouts of the same option are the same, as for many charts at another size: a
 * treemap, or axes whose labels fit either way. Their data is the option's own, which they share,
 * so this compares the settings around it.
 */
export function sameLayout(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameLayout(item, b[index]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  // Not typed arrays, which a layout carries over rather than copies, nor values of other classes.
  if (ArrayBuffer.isView(a) || Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && sameLayout(a[key], b[key]))
  );
}
