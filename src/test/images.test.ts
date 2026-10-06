import * as assert from "node:assert";
import { pngDataUrl } from "../webview/images";
import { replace } from "./afterTest";

/**
 * Stands in for the browser that pngDataUrl draws in, until the test ends, failing where the
 * returned state says. Reading the PNG checks that the canvas and the image were released first.
 */
function fakeBrowser() {
  const browser = {
    encoded: new Blob(["png"], { type: "image/png" }) as Blob | null,
    readError: false,
    contextAvailable: true,
    decodable: true,
    imageSource: "",
    encodedSize: [0, 0],
    canvas: { width: 0, height: 0 },
  };
  const canvas = Object.assign(browser.canvas, {
    getContext: () => (browser.contextAvailable ? { drawImage: () => {} } : null),
    toBlob: (callback: BlobCallback, type: string) => {
      assert.strictEqual(type, "image/png");
      browser.encodedSize = [canvas.width, canvas.height];
      setImmediate(() => callback(browser.encoded));
    },
  });
  const globals = globalThis as Record<string, unknown>;
  replace(
    globals,
    "Image",
    class {
      set src(value: string) {
        browser.imageSource = value;
      }
      decode() {
        return browser.decodable
          ? Promise.resolve()
          : Promise.reject(
              new DOMException("The source image cannot be decoded.", "EncodingError"),
            );
      }
    },
  );
  replace(globals, "document", { createElement: () => canvas });
  replace(
    globals,
    "FileReader",
    class {
      result = "data:image/png;base64,test";
      error = new Error("PNG read failed");
      onload?: () => void;
      onerror?: () => void;
      readAsDataURL(blob: Blob) {
        assert.strictEqual(blob, browser.encoded);
        assert.deepStrictEqual([canvas.width, canvas.height], [0, 0]);
        assert.strictEqual(browser.imageSource, "");
        queueMicrotask(() => (browser.readError ? this.onerror?.() : this.onload?.()));
      }
    },
  );
  return browser;
}

suite("images", () => {
  test("draws a PNG at twice the size, within 8000 pixels a side and 16 million in all", async () => {
    const browser = fakeBrowser();
    for (const [width, height, expectedWidth, expectedHeight] of [
      [320, 200, 640, 400],
      [8000, 8000, 4000, 4000],
      [10000, 100, 8000, 80],
      [7001, 7501, 3864, 4140],
      [1e160, 1e160, 4000, 4000],
    ] as const) {
      assert.strictEqual(
        await pngDataUrl({ svg: "<svg/>", width, height }),
        "data:image/png;base64,test",
      );
      assert.deepStrictEqual(browser.encodedSize, [expectedWidth, expectedHeight]);
    }
  });

  test("says why a PNG could not be made, without keeping the canvas or the image", async () => {
    const browser = fakeBrowser();
    const image = { svg: "<svg/>", width: 100, height: 100 };
    const released = () => {
      assert.deepStrictEqual([browser.canvas.width, browser.canvas.height], [0, 0]);
      assert.strictEqual(browser.imageSource, "");
    };
    browser.readError = true;
    await assert.rejects(pngDataUrl(image), /PNG read failed/);
    for (browser.encoded of [null, new Blob(["invalid"], { type: "image/jpeg" })]) {
      await assert.rejects(pngDataUrl(image), /could not create a PNG/);
      released();
    }
    browser.contextAvailable = false;
    await assert.rejects(pngDataUrl(image), /did not provide a canvas/);
    released();
    browser.decodable = false;
    await assert.rejects(pngDataUrl(image), /could not read the SVG image to draw the PNG from/);
    released();
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
