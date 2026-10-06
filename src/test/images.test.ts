import * as assert from "node:assert";
import { pngDataUrl } from "../webview/images";

suite("images", () => {
  test("bounds both canvas dimensions and total pixel memory", async () => {
    const originalImage = Object.getOwnPropertyDescriptor(globalThis, "Image");
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalReader = Object.getOwnPropertyDescriptor(globalThis, "FileReader");
    let encoded: Blob | null = new Blob(["png"], { type: "image/png" });
    let readError = false;
    let contextAvailable = true;
    let decodable = true;
    let imageSource = "";
    let encodedSize = [0, 0];
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => (contextAvailable ? { drawImage: () => {} } : null),
      toBlob: (callback: BlobCallback, type: string) => {
        assert.strictEqual(type, "image/png");
        encodedSize = [canvas.width, canvas.height];
        setImmediate(() => callback(encoded));
      },
    };
    Object.defineProperty(globalThis, "Image", {
      configurable: true,
      value: class {
        set src(value: string) {
          imageSource = value;
        }
        decode() {
          return decodable
            ? Promise.resolve()
            : Promise.reject(
                new DOMException("The source image cannot be decoded.", "EncodingError"),
              );
        }
      },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { createElement: () => canvas },
    });
    Object.defineProperty(globalThis, "FileReader", {
      configurable: true,
      value: class {
        result = "data:image/png;base64,test";
        error = new Error("PNG read failed");
        onload?: () => void;
        onerror?: () => void;
        readAsDataURL(blob: Blob) {
          assert.strictEqual(blob, encoded);
          assert.deepStrictEqual([canvas.width, canvas.height], [0, 0]);
          assert.strictEqual(imageSource, "");
          queueMicrotask(() => (readError ? this.onerror?.() : this.onload?.()));
        }
      },
    });
    try {
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
        assert.deepStrictEqual(encodedSize, [expectedWidth, expectedHeight]);
      }
      const image = { svg: "<svg/>", width: 100, height: 100 };
      readError = true;
      await assert.rejects(pngDataUrl(image), /PNG read failed/);
      for (encoded of [null, new Blob(["invalid"], { type: "image/jpeg" })]) {
        await assert.rejects(pngDataUrl(image), /could not create a PNG/);
        assert.deepStrictEqual([canvas.width, canvas.height], [0, 0]);
        assert.strictEqual(imageSource, "");
      }
      contextAvailable = false;
      await assert.rejects(pngDataUrl(image), /did not provide a canvas/);
      assert.deepStrictEqual([canvas.width, canvas.height], [0, 0]);
      assert.strictEqual(imageSource, "");
      decodable = false;
      await assert.rejects(pngDataUrl(image), /could not read the SVG image to draw the PNG from/);
      assert.strictEqual(imageSource, "");
    } finally {
      for (const [key, descriptor] of [
        ["Image", originalImage],
        ["document", originalDocument],
        ["FileReader", originalReader],
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
