import * as assert from "node:assert";
import { contrast, LABEL_CONTRAST, labelColorOn, type Rgba, toCss } from "../webview/colors";
import { testColors } from "./themeColors";

const rgb = (r: number, g: number, b: number): Rgba => ({ r, g, b, a: 1 });
const black = rgb(0, 0, 0);
const white = rgb(255, 255, 255);
/** The text and the background of a light theme. */
const light = { foreground: rgb(59, 59, 59), background: white };
/** The color, in CSS, to label a color in, in the dark test theme unless given another. */
const labelOn = (color: Rgba, theme: Parameters<typeof labelColorOn>[1] = testColors) =>
  toCss(labelColorOn(color, theme));

suite("colors", () => {
  test("labels a light color in a dark theme in the theme's background", () => {
    assert.strictEqual(labelOn(rgb(119, 255, 119)), "#1f1f1f");
    // The light blue of a decision.
    assert.strictEqual(labelOn(rgb(207, 232, 255)), "#1f1f1f");
  });

  test("labels a dark color in a dark theme in the theme's text color", () => {
    assert.strictEqual(labelOn(rgb(0, 0, 128)), "#cccccc");
    assert.strictEqual(labelOn(rgb(0, 100, 0)), "#cccccc");
  });

  test("labels colors in a light theme", () => {
    assert.strictEqual(labelOn(rgb(119, 255, 119), light), "#3b3b3b");
    assert.strictEqual(labelOn(rgb(0, 0, 128), light), "#ffffff");
  });

  test("keeps the theme's text color where it is legible, though the background contrasts more", () => {
    // A mid grey, on which both the text and the background of a high contrast theme are legible.
    const grey = rgb(118, 118, 118);
    assert.ok(contrast(grey, white) >= LABEL_CONTRAST);
    assert.ok(contrast(grey, black) > contrast(grey, white));
    assert.strictEqual(labelOn(grey, { foreground: white, background: black }), "#ffffff");
  });

  test("labels in black or white where neither of the theme's colors is legible", () => {
    // A theme of mid grey text on a mid grey background.
    const muted = { foreground: rgb(120, 120, 120), background: rgb(100, 100, 100) };
    assert.strictEqual(labelOn(rgb(200, 200, 200), muted), "#000000");
    assert.strictEqual(labelOn(rgb(20, 20, 20), muted), "#ffffff");
    // On a mid grey, whichever reads better, if not as well as the theme's colors read elsewhere.
    const grey = rgb(128, 128, 128);
    assert.strictEqual(labelOn(grey), "#000000");
    assert.ok(contrast(grey, black) > contrast(grey, white));
  });
});
