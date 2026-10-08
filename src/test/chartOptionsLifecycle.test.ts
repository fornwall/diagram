import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { captureChartPresentation } from "../chartPresentation";
import type { ChartSpec } from "../chartSpec";
import { buildChart } from "../charts";
import { type DataTable, parseTable } from "../data";
import type { DiagramPanel, DiagramState } from "../panel";
import { afterTest, recordMessages, suiteTempDir } from "./afterTest";
import { type FakeWebview, newFakePanel, newPanel } from "./newPanel";

const data = "name,amount\na,1\nb,2";

async function draw(panel: DiagramPanel, spec: ChartSpec, table = parseTable(data)) {
  const source = JSON.stringify(buildChart(spec, table).option);
  assert.ok(
    (
      await panel.render(
        { language: "echarts", title: "Lifecycle", source, chart: spec },
        "tool",
        table,
      )
    ).ok,
  );
  return source;
}

/** Agrees to read a data file outside the workspace again, returning the questions asked. */
function agreeToRead(): string[] {
  return recordMessages("showWarningMessage", () => "Read");
}

/** Changes the chart options in the panel, as the webview's Chart Options form does. */
function applyOptions(
  panel: DiagramPanel,
  webview: FakeWebview,
  change:
    | { type: "applyChartOptions"; controls: Record<string, unknown>; replaceSource?: boolean }
    | { type: "resetChartStyling"; replaceSource?: boolean },
): Promise<void> {
  return webview.receive({ replaceSource: false, ...change, revision: panel.revision });
}

suite("chart options lifecycle", function () {
  this.timeout(10_000);

  const dir = suiteTempDir("diagram-options-");

  test("a ready webview receives open options before replaying a pending render", async () => {
    const { panel, webview } = await newFakePanel();
    const { sent } = webview;
    webview.answer = undefined;
    const chart: ChartSpec = { type: "bar", data };
    const source = JSON.stringify(buildChart(chart, parseTable(data)).option);
    const rendering = panel.render(
      { language: "echarts", title: "Loading", source, chart },
      "tool",
    );
    panel.toggleChartOptions();
    // The webview reloads before it answers; only its replay matters.
    sent.length = 0;
    await webview.receive({ type: "ready" });
    const options = sent[0];
    assert.ok(options?.type === "chartOptions");
    assert.strictEqual(options.visible, true);
    assert.strictEqual(options.state?.controls.type, "bar");
    assert.strictEqual(options.state?.revision, panel.revision);
    assert.strictEqual(sent[1]?.type, "render");
    await webview.finishRender();
    assert.ok((await rendering).ok);
  });

  test("Chart Options toggles the options of a shown panel, and shows them in a hidden one", async () => {
    const { panel, webview } = await newFakePanel();
    const visible = () => {
      const options = webview.sent.findLast((message) => message.type === "chartOptions");
      return options?.visible;
    };
    await draw(panel, { type: "bar", data });
    panel.toggleChartOptions();
    assert.strictEqual(visible(), true);
    panel.toggleChartOptions();
    assert.strictEqual(visible(), false);
    panel.toggleChartOptions();
    (webview.panel as { visible: boolean }).visible = false;
    panel.toggleChartOptions();
    assert.strictEqual(visible(), true);
  });

  test("chart options report a stale form, and keep the chart when the new one fails", async () => {
    const { panel, webview } = await newFakePanel();
    const errors = () =>
      webview.sent.flatMap((message) =>
        message.type === "chartOptionsError" ? [message.message] : [],
      );
    const source = await draw(panel, { type: "bar", data });
    const shown = panel.current;
    await webview.receive({
      type: "applyChartOptions",
      revision: panel.revision - 1,
      controls: { type: "line" },
      replaceSource: false,
    });
    assert.deepStrictEqual(errors(), ["The chart changed. Reopen Chart Options and try again."]);
    assert.strictEqual(panel.current, shown);

    webview.failNextRender("Bad.");
    await applyOptions(panel, webview, { type: "applyChartOptions", controls: { type: "line" } });
    assert.deepStrictEqual(errors().slice(1), [
      "Could not apply the chart options: Bad. The previous chart is kept.",
    ]);
    assert.strictEqual(panel.current?.chart?.type, "bar");
    assert.strictEqual(webview.render.source, source);
  });

  test("retained presentation edits remain manual after changing chart options", async () => {
    const values = new Map<string, unknown>();
    const { panel, webview } = await newFakePanel(values);
    const source = await draw(panel, { type: "bar", data });
    const styled = JSON.parse(source);
    styled.backgroundColor = "#123456";
    await webview.edit(JSON.stringify(styled));
    assert.strictEqual(panel.current?.editedByUser, true);
    await applyOptions(panel, webview, {
      type: "applyChartOptions",
      controls: { type: "horizontalBar", sort: "descending" },
    });
    assert.strictEqual(panel.current?.chart?.type, "horizontalBar");
    assert.strictEqual(JSON.parse(panel.current?.source ?? "").backgroundColor, "#123456");
    assert.ok(panel.current?.chartPresentation?.edits.length);
    assert.strictEqual(panel.current?.editedByUser, true);
    assert.strictEqual((values.get("diagram.state") as DiagramState).editedByUser, true);
    // Which a chat reply must not draw over.
    assert.strictEqual(panel.userChangeCount, 2);
  });

  test("closing during reset rendering restores persisted source and the previous table cache", async () => {
    const file = path.join(dir, "reset.csv");
    fs.writeFileSync(file, "name,amount\na,900\nb,800");
    const values = new Map<string, unknown>();
    const first = await newFakePanel(values);
    const source = await draw(first.panel, { type: "bar", file });
    first.panel.dispose();
    // A restored chart of a file: Reset must load a new transient table before rendering.
    const { panel, webview } = await newFakePanel(values);
    const previous = panel.current;
    agreeToRead();
    webview.nextRender(() => panel.dispose());
    await applyOptions(panel, webview, { type: "resetChartStyling" });
    assert.strictEqual(panel.current, previous);
    assert.strictEqual(panel.loadedChartData, undefined);
    assert.strictEqual((values.get("diagram.state") as DiagramState).source, source);
    const restored = newPanel(values);
    afterTest(() => restored.dispose());
    assert.strictEqual(restored.current?.source, source);
  });

  test("large inline chart source survives reload and renders without a hidden Refresh action", async () => {
    const inline = `name,amount\n${"x".repeat(1_000_001)},1`;
    const chart: ChartSpec = { type: "bar", data: inline };
    const values = new Map<string, unknown>();
    const first = await newFakePanel(values);
    const source = await draw(first.panel, chart, parseTable(inline));
    assert.ok(source.length > 1_000_000);
    assert.strictEqual((values.get("diagram.state") as DiagramState).source, source);
    first.panel.dispose();
    const second = await newFakePanel(values);
    const { sent } = second.webview;
    assert.strictEqual(second.panel.current?.source, source);
    assert.ok(!sent.some((message) => message.type === "needsRefresh"));
    assert.strictEqual(second.webview.render.source, source);
    assert.strictEqual(second.webview.render.refreshFrom, undefined);
    // Hidden controls need no table, so the source is drawn without parsing the data.
    assert.ok(
      sent
        .filter((message) => message.type === "chartOptions")
        .every((message) => message.state === undefined),
    );
    second.panel.toggleChartOptions();
    const options = sent.at(-1);
    assert.ok(options?.type === "chartOptions" && options.visible);
    assert.strictEqual(options.state?.rowCount, 1);
  });

  test("closing during refresh restores persisted source and the previous table", async () => {
    const file = path.join(dir, "refresh.csv");
    fs.writeFileSync(file, "name,amount\na,900\nb,800");
    const values = new Map<string, unknown>();
    const { panel, webview } = await newFakePanel(values);
    const table = parseTable(data);
    const source = await draw(panel, { type: "bar", file }, table);
    const previous = panel.current;
    const asked = agreeToRead();
    webview.nextRender(() => panel.dispose());
    await webview.receive({ type: "refresh" });
    assert.deepStrictEqual(asked, ["Read the chart's data file again?"]);
    assert.strictEqual(panel.userChangeCount, 1);
    assert.strictEqual(panel.current, previous);
    assert.strictEqual(panel.loadedChartData, table);
    assert.strictEqual((values.get("diagram.state") as DiagramState).source, source);
  });

  test("a restored blocked external chart can explicitly reset and reload its data", async () => {
    const file = path.join(dir, "recovery.csv");
    const chart: ChartSpec = { type: "bar", file };
    const source = JSON.stringify(buildChart(chart, parseTable(data)).option);
    const initial: DiagramState = {
      language: "echarts",
      title: "Restored manual chart",
      chart,
      source,
      origin: "tool",
      editedByUser: true,
      chartPresentation: {
        ...captureChartPresentation(source),
        blocked: "Manual data edits cannot be regenerated without explicit replacement.",
      },
    };
    const values = new Map<string, unknown>([["diagram.state", initial]]);
    const { panel, webview } = await newFakePanel(values);
    const { sent } = webview;
    assert.strictEqual(panel.loadedChartData, undefined);
    await applyOptions(panel, webview, { type: "resetChartStyling" });
    assert.strictEqual(panel.current?.source, source);
    assert.ok(
      sent.some(
        (message) =>
          message.type === "chartOptionsError" && /explicit replacement/.test(message.message),
      ),
    );
    // The first reset was rejected before trying to read this still-missing file.
    fs.writeFileSync(file, "name,amount\na,41\nb,42");
    agreeToRead();
    await applyOptions(panel, webview, { type: "resetChartStyling", replaceSource: true });
    const expected = JSON.stringify(
      buildChart(chart, parseTable("name,amount\na,41\nb,42")).option,
      null,
      2,
    );
    assert.strictEqual(panel.current?.source, expected);
    assert.strictEqual(panel.current?.chartPresentation?.blocked, undefined);
    assert.strictEqual(panel.current?.editedByUser, false);
    // Narrowed to undefined by the assertion above, which the reset changed.
    assert.strictEqual((panel.loadedChartData as DataTable | undefined)?.rows[0]?.[1], 41);
    assert.strictEqual((values.get("diagram.state") as DiagramState).source, expected);
  });
});
