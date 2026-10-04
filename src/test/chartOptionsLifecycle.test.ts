import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { captureChartPresentation } from "../chartPresentation";
import type { ChartSpec } from "../chartSpec";
import { buildChart } from "../charts";
import { type DataTable, parseTable } from "../data";
import type { DiagramPanel, DiagramState } from "../panel";
import { type FakeWebview, newFakePanel, newPanel } from "./newPanel";

const data = "name,amount\na,1\nb,2";

async function draw(panel: DiagramPanel, spec: ChartSpec, table = parseTable(data)) {
  const source = JSON.stringify(buildChart(spec, table).option);
  assert.ok(
    (
      await panel.render(
        { language: "echarts", title: "Lifecycle", source, chart: spec },
        "tool",
        undefined,
        table,
      )
    ).ok,
  );
  return source;
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

/** Applies an edit of the source in the panel, as the webview's Apply does. */
function edit(webview: FakeWebview, source: string): Promise<void> {
  return webview.receive({ type: "sourceEdited", requestId: webview.render.requestId, source });
}

suite("chart options lifecycle", function () {
  this.timeout(10_000);

  test("a ready webview receives open options before replaying a pending render", async () => {
    const { panel, webview } = await newFakePanel();
    const { sent } = webview;
    webview.answer = undefined;
    try {
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
    } finally {
      panel.dispose();
    }
  });

  test("retained presentation edits remain manual after changing chart options", async () => {
    const values = new Map<string, unknown>();
    const { panel, webview } = await newFakePanel(values);
    try {
      const source = await draw(panel, { type: "bar", data });
      const styled = JSON.parse(source);
      styled.backgroundColor = "#123456";
      await edit(webview, JSON.stringify(styled));
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
    } finally {
      panel.dispose();
    }
  });

  test("closing during reset rendering restores persisted source and the previous table cache", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "diagram-options-rollback-"));
    const file = path.join(directory, "data.csv");
    fs.writeFileSync(file, "name,amount\na,900\nb,800");
    const values = new Map<string, unknown>();
    const first = await newFakePanel(values);
    const source = await draw(first.panel, { type: "bar", file });
    first.panel.dispose();
    // A restored chart of a file: Reset must load a new transient table before rendering.
    const { panel, webview } = await newFakePanel(values);
    try {
      const previous = panel.current;
      webview.nextRender(() => panel.dispose());
      await applyOptions(panel, webview, { type: "resetChartStyling" });
      assert.strictEqual(panel.current, previous);
      assert.strictEqual(panel.loadedChartData, undefined);
      assert.strictEqual((values.get("diagram.state") as DiagramState).source, source);
      const restored = newPanel(values);
      try {
        assert.strictEqual(restored.current?.source, source);
      } finally {
        restored.dispose();
      }
    } finally {
      panel.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("large inline chart source survives reload and renders without a hidden Refresh action", async () => {
    const inline = `name,amount\n${"x".repeat(1_000_001)},1`;
    const chart: ChartSpec = { type: "bar", data: inline };
    const values = new Map<string, unknown>();
    const first = await newFakePanel(values);
    let second: Awaited<ReturnType<typeof newFakePanel>> | undefined;
    try {
      const source = await draw(first.panel, chart, parseTable(inline));
      assert.ok(source.length > 1_000_000);
      assert.strictEqual((values.get("diagram.state") as DiagramState).source, source);
      first.panel.dispose();
      second = await newFakePanel(values);
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
    } finally {
      first.panel.dispose();
      second?.panel.dispose();
    }
  });

  test("closing during refresh restores persisted source and the previous table", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "diagram-refresh-rollback-"));
    const file = path.join(directory, "data.csv");
    fs.writeFileSync(file, "name,amount\na,900\nb,800");
    const values = new Map<string, unknown>();
    const { panel, webview } = await newFakePanel(values);
    try {
      const table = parseTable(data);
      const source = await draw(panel, { type: "bar", file }, table);
      const previous = panel.current;
      webview.nextRender(() => panel.dispose());
      await webview.receive({ type: "refresh" });
      assert.strictEqual(panel.current, previous);
      assert.strictEqual(panel.loadedChartData, table);
      assert.strictEqual((values.get("diagram.state") as DiagramState).source, source);
    } finally {
      panel.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a restored blocked external chart can explicitly reset and reload its data", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "diagram-options-recovery-"));
    const file = path.join(directory, "data.csv");
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
    try {
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
    } finally {
      panel.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
