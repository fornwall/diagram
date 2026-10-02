import * as assert from "node:assert";
import { safeFileName } from "../protocol";
import { pngDataUrl } from "../webview/images";

suite("PNG export", () => {
  test("bounds both canvas dimensions and total pixel memory", async () => {
    const originalImage = Object.getOwnPropertyDescriptor(globalThis, "Image");
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => {} }),
      toDataURL: () => "data:image/png;base64,test",
    };
    Object.defineProperty(globalThis, "Image", {
      configurable: true,
      value: class {
        decode() {
          return Promise.resolve();
        }
      },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { createElement: () => canvas },
    });
    try {
      for (const [width, height, expectedWidth, expectedHeight] of [
        [320, 200, 640, 400],
        [8000, 8000, 4000, 4000],
        [10000, 100, 8000, 80],
        [7001, 7501, 3864, 4140],
        [1e160, 1e160, 4000, 4000],
      ] as const) {
        await pngDataUrl({ svg: "<svg/>", width, height });
        assert.deepStrictEqual([canvas.width, canvas.height], [expectedWidth, expectedHeight]);
        assert.ok(canvas.width * canvas.height <= 16_000_000);
      }
    } finally {
      for (const [key, descriptor] of [
        ["Image", originalImage],
        ["document", originalDocument],
      ] as const) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });

  test("rejects invalid dimensions before allocating an image", async () => {
    for (const dimension of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const [width, height] of [
        [dimension, 100],
        [100, dimension],
      ] as const) {
        await assert.rejects(
          pngDataUrl({ svg: "<svg/>", width, height }),
          /no valid dimensions for a PNG/,
        );
      }
    }
  });
});

suite("file names", () => {
  test("names a file after a title, without what file names cannot hold", () => {
    assert.strictEqual(safeFileName("Login flow", "diagram"), "Login flow");
    assert.strictEqual(safeFileName(' OAuth: "step 1/2"? ', "diagram"), "OAuth step 1 2");
    // Windows keeps neither trailing dots nor trailing spaces.
    assert.strictEqual(safeFileName("Release 2026.", "diagram"), "Release 2026");
    // Format characters are not kept either, invisible as they are.
    assert.strictEqual(safeFileName("a b\u200e", "diagram"), "a b");
    // A title of nothing usable falls back to what the caller names its files.
    assert.strictEqual(safeFileName("   ", "diagram"), "diagram");
    assert.strictEqual(safeFileName("...", "chart"), "chart");
    assert.ok(safeFileName("Long ".repeat(100), "diagram").length <= 80);
  });

  test("avoids Windows device names, including names with extensions", () => {
    for (const name of ["CON", "prn", "AUX", "NUL", "COM1", "LPT9", "COM¹", "LPT²", "COM³"]) {
      assert.strictEqual(safeFileName(name, "diagram"), `_${name}`);
      assert.strictEqual(safeFileName(`${name}.notes`, "diagram"), `_${name}.notes`);
    }
    assert.strictEqual(safeFileName("CON .notes", "diagram"), "_CON .notes");
    for (const name of ["Console", "COM10", "LPT0", "AUX chart"]) {
      assert.strictEqual(safeFileName(name, "diagram"), name);
    }
    assert.ok(safeFileName(`CON.${"a".repeat(100)}`, "diagram").length <= 80);
    for (const trailing of [".", " "]) {
      assert.strictEqual(
        safeFileName(`CON.${"a".repeat(74)}${trailing}x`, "diagram"),
        `_CON.${"a".repeat(74)}`,
      );
    }
  });
});
