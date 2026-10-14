import * as assert from "node:assert";
import type { Diagram } from "../panel";
import { afterTest } from "./afterTest";
import { within } from "./newPanel";
import { suitePage } from "./webviewHarness";

/** A timeline too wide for a panel 350 px wide, but not for the panel that the tests draw in. */
const TIMELINE = "timeline\n  2023 : Prototype\n  2024 : Beta\n  2025 : 1.0\n  2026 : 2.0";

/** An XY chart, which the panel lays out again at its width, of more labels than fit. */
const XY_CHART = (() => {
  const months = Array.from({ length: 30 }, (_, i) => `month-${i}`);
  return `xychart\n  x-axis [${months.join(", ")}]\n  bar [${months.map((_, i) => i).join(", ")}]`;
})();

/** An ECharts bar chart of more named categories than fit across a narrow panel. */
const BARS = JSON.stringify({
  xAxis: {
    type: "category",
    data: Array.from({ length: 30 }, (_, i) => `Department number ${i}`),
  },
  yAxis: { type: "value" },
  series: [{ type: "bar", data: Array.from({ length: 30 }, (_, i) => i + 1) }],
});

suite("Warnings of a drawing in the webview as the panel changes size", function () {
  this.timeout(60_000);

  const page = suitePage();
  const { evaluate } = page;
  const width = (css: string) => evaluate(`document.body.style.maxWidth = "${css}"`);
  setup(() => afterTest(() => width("")));

  /** The warnings that the extension has once they stay the same for a while. */
  const settled = async () => {
    for (;;) {
      const before = JSON.stringify(page.panel.warnings);
      await new Promise((resolve) => setTimeout(resolve, 600));
      if (JSON.stringify(page.panel.warnings) === before) return page.panel.warnings;
    }
  };

  /**
   * The warnings of the diagram drawn anew in a panel of the width, with no width for the full,
   * which the result of the tool call that drew it gives: those of the drawing as it stays. A chart
   * drawn while the footer of the diagram before it took room from it would be laid out again, and
   * checked again, once that went.
   */
  const drawnAt = async (diagram: Partial<Diagram>, css: string) => {
    await page.draw({ source: "flowchart LR\n  A --> B" });
    await width(css);
    await page.draw(diagram);
    const drawn = page.panel.warnings;
    assert.deepStrictEqual(await settled(), drawn, "The warnings stay those of the drawing.");
    return drawn;
  };

  for (const [name, diagram] of [
    ["a Mermaid diagram measured against the panel's width", { source: TIMELINE }],
    ["a Mermaid chart laid out at the panel's width", { source: XY_CHART }],
    ["an ECharts chart", { language: "echarts", source: BARS }],
  ] as const) {
    test(`tells the extension the warnings of ${name} drawn for a new width`, async () => {
      const narrow = await drawnAt(diagram, "350px");
      const wide = await drawnAt(diagram, "");
      assert.notDeepStrictEqual(narrow, wide, "The warnings differ with the width.");
      // As the user resizes the panel.
      await width("350px");
      assert.ok(
        await within(() => JSON.stringify(page.panel.warnings) === JSON.stringify(narrow)),
        `${JSON.stringify(page.panel.warnings)} for ${JSON.stringify(narrow)}`,
      );
      await width("");
      assert.ok(
        await within(() => JSON.stringify(page.panel.warnings) === JSON.stringify(wide)),
        `${JSON.stringify(page.panel.warnings)} for ${JSON.stringify(wide)}`,
      );
    });
  }
});
