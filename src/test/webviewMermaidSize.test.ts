import * as assert from "node:assert";
import { RELAYOUT_DELAY } from "../webview/mermaidRenderer";
import { afterTest } from "./afterTest";
import { suitePage } from "./webviewHarness";

const XY_CHART = "xychart\n  x-axis [Jan, Feb, Mar]\n  bar [10, 20, 30]";

suite("Mermaid charts sized for the panel in the webview", function () {
  this.timeout(30_000);

  const page = suitePage();
  const { evaluate, draw } = page;
  const width = (css: string) => evaluate(`document.body.style.maxWidth = "${css}"`);
  setup(() => afterTest(() => width("")));
  const drawnWidth = async (source: string) => {
    await draw({ source });
    return evaluate(`document.querySelector("#diagram svg").viewBox.baseVal.width`);
  };

  test("sizes a chart for the panel whatever its title and comments say of width", async () => {
    await width("400px");
    const sized = await drawnWidth(XY_CHART);
    assert.ok(Number(sized) < 700, `${sized}`);
    assert.strictEqual(
      await drawnWidth(
        `---\ntitle: Revenue by width of shelf\n---\n%% height: in euros\n${XY_CHART}`,
      ),
      sized,
    );
  });

  test("keeps the size that a chart's configuration gives it, also Mermaid's own", async () => {
    await width("400px");
    assert.ok(Number(await drawnWidth(XY_CHART)) < 700);
    assert.strictEqual(
      await drawnWidth(`---\nconfig:\n  xyChart: {width: 700}\n---\n${XY_CHART}`),
      700,
    );
  });

  test("keeps the size that a chart's configuration gives it, and draws it anew for no resize", async () => {
    for (const settings of [
      "---\nconfig:\n  xyChart:\n    width: 900\n    height: 500\n---\n",
      '%%{init: {"xyChart": {"width": 900, "height": 500}}}%%\n',
    ]) {
      await width("");
      assert.strictEqual(await drawnWidth(`${settings}${XY_CHART}`), 900, settings);
      await evaluate(`document.querySelector("#diagram svg").dataset.test = "kept"`);
      await width("400px");
      await new Promise((resolve) => setTimeout(resolve, RELAYOUT_DELAY + 500));
      assert.strictEqual(
        await evaluate(`document.querySelector("#diagram svg").dataset.test`),
        "kept",
        settings,
      );
    }
  });
});
