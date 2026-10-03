import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { captureChartPresentation } from "../chartPresentation";
import type { ChartSpec } from "../chartSpec";
import { buildChart } from "../charts";
import { type DataTable, parseTable } from "../data";
import type { DiagramPanel, DiagramState, RenderOutcome } from "../panel";
import type { FromWebview, ToWebview } from "../protocol";
import { newPanel } from "./newPanel";

interface Internals {
  renderVersion: number;
  chartTable: DataTable | undefined;
  post(message: ToWebview): void;
  onMessage(message: FromWebview): void;
  finishRender(id: number, outcome: RenderOutcome): void;
  applyEdit(source: string): Promise<void>;
  renderCurrent(): Promise<RenderOutcome>;
  refreshChart(): Promise<void>;
  applyChartOptions(
    message: Extract<FromWebview, { type: "applyChartOptions" | "resetChartStyling" }>,
  ): Promise<void>;
}

/** Exercise panel persistence and races without depending on the renderer's timing. */
function harness(values = new Map<string, unknown>()) {
  const panel = newPanel(values);
  const internals = panel as unknown as Internals;
  const sent: ToWebview[] = [];
  let closeOnRender = false;
  internals.post = (message) => {
    sent.push(message);
    if (message.type === "render") {
      queueMicrotask(() => {
        if (closeOnRender) panel.dispose();
        else internals.finishRender(message.requestId, { ok: true, diagramType: "bar" });
      });
    }
  };
  return {
    panel,
    internals,
    sent,
    values,
    closeNextRender: () => {
      closeOnRender = true;
    },
  };
}

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

suite("chart options lifecycle", function () {
  this.timeout(10_000);

  test("a ready webview receives open options before replaying a pending render", async () => {
    const { panel, internals, sent } = harness();
    try {
      const chart: ChartSpec = { type: "bar", data };
      const source = JSON.stringify(buildChart(chart, parseTable(data)).option);
      const rendering = panel.render(
        { language: "echarts", title: "Loading", source, chart },
        "tool",
      );
      panel.toggleChartOptions();
      // Initial messages were sent before the webview was ready; only its replay matters.
      sent.length = 0;
      internals.onMessage({ type: "ready" });
      const options = sent[0];
      assert.ok(options?.type === "chartOptions");
      assert.strictEqual(options.visible, true);
      assert.strictEqual(options.state?.controls.type, "bar");
      assert.strictEqual(options.state?.revision, internals.renderVersion);
      assert.strictEqual(sent[1]?.type, "render");
      assert.ok((await rendering).ok);
    } finally {
      panel.dispose();
    }
  });

  test("retained presentation edits remain manual after changing chart options", async () => {
    const { panel, internals, values } = harness();
    try {
      const source = await draw(panel, { type: "bar", data });
      const styled = JSON.parse(source);
      styled.backgroundColor = "#123456";
      await internals.applyEdit(JSON.stringify(styled));
      assert.strictEqual(panel.current?.editedByUser, true);
      await internals.applyChartOptions({
        type: "applyChartOptions",
        revision: internals.renderVersion,
        controls: { type: "horizontalBar", sort: "descending" },
        replaceSource: false,
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
    const { panel, internals, values, closeNextRender } = harness();
    try {
      const source = await draw(panel, { type: "bar", file });
      const previous = panel.current;
      // Simulate a restored external chart: Reset must load a new transient table before rendering.
      internals.chartTable = undefined;
      closeNextRender();
      await internals.applyChartOptions({
        type: "resetChartStyling",
        revision: internals.renderVersion,
        replaceSource: false,
      });
      assert.strictEqual(panel.current, previous);
      assert.strictEqual(internals.chartTable, undefined);
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
    const first = harness();
    let second: ReturnType<typeof harness> | undefined;
    try {
      const source = await draw(first.panel, chart, parseTable(inline));
      assert.ok(source.length > 1_000_000);
      assert.strictEqual((first.values.get("diagram.state") as DiagramState).source, source);
      first.panel.dispose();
      second = harness(first.values);
      second.panel.show();
      assert.ok((await second.internals.renderCurrent()).ok);
      assert.strictEqual(second.panel.current?.source, source);
      assert.ok(!second.sent.some((message) => message.type === "needsRefresh"));
      const rendered = second.sent.find((message) => message.type === "render");
      assert.ok(rendered?.type === "render");
      assert.strictEqual(rendered.refreshFrom, undefined);
      assert.strictEqual(second.internals.chartTable?.rows.length, 1);
    } finally {
      first.panel.dispose();
      second?.panel.dispose();
    }
  });

  test("closing during refresh restores persisted source and the previous table", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "diagram-refresh-rollback-"));
    const file = path.join(directory, "data.csv");
    fs.writeFileSync(file, "name,amount\na,900\nb,800");
    const { panel, internals, values, closeNextRender } = harness();
    try {
      const table = parseTable(data);
      const source = await draw(panel, { type: "bar", file }, table);
      const previous = panel.current;
      closeNextRender();
      await internals.refreshChart();
      assert.strictEqual(panel.current, previous);
      assert.strictEqual(internals.chartTable, table);
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
    const { panel, internals, sent, values } = harness(new Map([["diagram.state", initial]]));
    try {
      panel.show();
      assert.ok((await internals.renderCurrent()).ok);
      assert.strictEqual(internals.chartTable, undefined);
      await internals.applyChartOptions({
        type: "resetChartStyling",
        revision: internals.renderVersion,
        replaceSource: false,
      });
      assert.strictEqual(panel.current?.source, source);
      assert.ok(
        sent.some(
          (message) =>
            message.type === "chartOptionsError" && /explicit replacement/.test(message.message),
        ),
      );
      // The first reset was rejected before trying to read this still-missing file.
      fs.writeFileSync(file, "name,amount\na,41\nb,42");
      await internals.applyChartOptions({
        type: "resetChartStyling",
        revision: internals.renderVersion,
        replaceSource: true,
      });
      const expected = JSON.stringify(
        buildChart(chart, parseTable("name,amount\na,41\nb,42")).option,
        null,
        2,
      );
      assert.strictEqual(panel.current?.source, expected);
      assert.strictEqual(panel.current?.chartPresentation?.blocked, undefined);
      assert.strictEqual(panel.current?.editedByUser, false);
      assert.strictEqual((internals.chartTable as DataTable | undefined)?.rows[0]?.[1], 41);
      assert.strictEqual((values.get("diagram.state") as DiagramState).source, expected);
    } finally {
      panel.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
