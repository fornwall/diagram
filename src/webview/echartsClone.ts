// Copy mutable layout settings while sharing chart data, then compare layouts cheaply.

import { isPlainObject } from "../protocol";
import type { JsonObject } from "./echartsOption";

const needsCopy = (value: unknown) => Array.isArray(value) || isPlainObject(value);

/** Layout treats these payloads as immutable. Writers such as sankey styling copy them first. */
const DATA_KEYS = new Set(["data", "nodes", "links", "edges", "source"]);

/**
 * Copy settings that layout may change, preserving the source for subsequent resizes.
 * structuredClone cannot handle callbacks such as formatters and custom renderItem functions.
 *
 * Copy every object accepted by isPlainObject, matching the guards used by layout writers.
 * Share callbacks, data payloads and arrays of primitives; layout never mutates them in place.
 * This avoids allocating the whole dataset on every resize.
 */
export function cloneOption(option: JsonObject): JsonObject {
  const copy: JsonObject = {};
  // JavaScript options may inherit settings, so include enumerable prototype properties.
  for (const key in option) {
    const value = DATA_KEYS.has(key) ? option[key] : cloneValue(option[key]);
    if (key === "__proto__") {
      // JSON can contain an own __proto__ key. Assignment would invoke the prototype setter.
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

/** Copy a setting using the same sharing rules as {@link cloneOption}. */
export function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.some(needsCopy) ? value.map(cloneValue) : value;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  if (value instanceof Date) {
    // Dates may appear on time axes and must retain their value.
    return new Date(value.getTime());
  }
  // Keep typed data arrays intact instead of turning their indices into object properties.
  return ArrayBuffer.isView(value) ? value : cloneOption(value);
}

/**
 * Compare layouts of the same option. Shared data is checked by identity, leaving only the
 * settings to traverse. Equal layouts need a chart resize, not a fresh setOption call.
 */
export function sameLayout(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameLayout(item, b[index]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  // Distinct typed arrays and objects with different prototypes are not equivalent settings.
  if (ArrayBuffer.isView(a) || Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && sameLayout(a[key], b[key]))
  );
}
