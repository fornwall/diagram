import * as assert from "node:assert";
import * as vscode from "vscode";
import { SAVED_CHART, type SavedChart, safeFileName } from "../protocol";
import { savedChartHtml } from "../savedChart";
import { testColors } from "./themeColors";

const pie = '{"series":[{"type":"pie","data":[{"name":"Dogs","value":386}]}]}';

function chart(overrides: Partial<SavedChart> = {}): SavedChart {
  return { title: "Commits per author", source: pie, colors: testColors, ...overrides };
}

function build(overrides: Partial<SavedChart> = {}): Promise<string> {
  const extension = vscode.extensions.getExtension("fornwall.diagram");
  assert.ok(extension);
  return savedChartHtml(chart(overrides), extension.extensionUri);
}

suite("savedChart", () => {
  test("names the file after the title, without what file names cannot hold", () => {
    assert.strictEqual(safeFileName("Commits per author", "chart"), "Commits per author");
    assert.strictEqual(safeFileName(' Disk usage of /tmp/*? "x" ', "chart"), "Disk usage of tmp x");
    assert.strictEqual(safeFileName("Sales 2026.", "chart"), "Sales 2026");
    assert.strictEqual(safeFileName("  ", "chart"), "chart");
    assert.ok(safeFileName("Long ".repeat(100), "chart").length <= 80);
  });

  test("truncating a title preserves valid Unicode file names", () => {
    const prefix = "a".repeat(79);
    const name = safeFileName(`${prefix}📊 Results`, "chart");
    assert.strictEqual(name, prefix);
    assert.doesNotThrow(() => encodeURIComponent(name));
    assert.strictEqual(safeFileName("📊".repeat(50), "chart"), "📊".repeat(40));
  });

  test("writes a page that draws the chart with everything it needs inlined", async () => {
    const html = await build();
    assert.ok(html.startsWith("<!DOCTYPE html>"));
    assert.ok(html.includes("<title>Commits per author</title>"));
    assert.ok(html.includes("<h1>Commits per author</h1>"));
    // The chart and the colors it was drawn in, for the script to render.
    assert.ok(html.includes(JSON.stringify(pie)));
    assert.ok(html.includes('"fontFamily":"sans-serif"'));
    // The page background, in the theme the chart was saved in.
    assert.ok(html.includes("background: #1f1f1f;"));
    // Nothing is loaded from outside: both scripts are inline, the markup links nothing, and the
    // content security policy allows no source anyway.
    const scripts = html.match(/<script[^>]*>/g) ?? [];
    assert.deepStrictEqual(
      scripts.map((tag) => tag.replace(/nonce="[^"]+"/, "nonce")),
      ["<script nonce>", "<script nonce>"],
    );
    assert.ok(!/\s(?:src|href)=/.test(html.slice(0, html.indexOf("<script"))));
    assert.ok(html.includes("default-src 'none'"));
    assert.ok(html.length > 500_000, `only ${html.length} bytes, without the chart script?`);
  });

  test("leaves out the heading when the chart has no title", async () => {
    const html = await build({ title: " " });
    assert.ok(!html.includes("<h1>"));
    assert.ok(html.includes("<title>Chart</title>"));
  });

  test("preserves international font names without allowing CSS or HTML injection", async () => {
    const fontFamily = '"游ゴシック", "微軟正黑體", sans-serif';
    const html = await build({ colors: { ...testColors, fontFamily } });
    assert.ok(html.includes(`font-family: ${fontFamily};`));

    const unsafe = await build({
      colors: { ...testColors, fontFamily: "</style><script>alert(1)</script>;color:red" },
    });
    const styles = unsafe.slice(unsafe.indexOf("<style>"), unsafe.indexOf("</style>"));
    assert.ok(!styles.includes("<script>"));
    assert.ok(!styles.includes(";color:"));
  });

  test("keeps titles and labels from breaking out of the page", async () => {
    const html = await build({
      title: "</script><img src=x onerror=alert(1)>",
      source: '{"series":[{"type":"pie","data":[{"name":"</script><script>","value":1}]}]}',
    });
    // The title is shown as text.
    assert.ok(html.includes("&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;"));
    assert.ok(!html.includes("<img src=x"));
    // The chart is embedded whole, but without a "<" to end its script element or start a
    // comment with.
    const line = html.split("\n").find((each) => each.includes(`window.${SAVED_CHART} =`)) ?? "";
    const data = line.slice(line.indexOf("{"), line.lastIndexOf("}") + 1);
    assert.ok(!data.includes("<"), data.slice(0, 120));
    assert.strictEqual(JSON.parse(data).title, "</script><img src=x onerror=alert(1)>");
  });
});
