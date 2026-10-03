import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ChartSpec } from "../chartSpec";
import { buildChart } from "../charts";
import { InspectDataTool, inspectTable, UpdateChartTool, updatedChartSpec } from "../chartTools";
import { type DataTable, parseTable } from "../data";
import type { DiagramPanel, DiagramState, RenderOutcome } from "../panel";
import type { ToWebview } from "../protocol";
import { newPanel } from "./newPanel";

interface Internals {
  post(message: ToWebview): void;
  finishRender(id: number, outcome: RenderOutcome): void;
  applyEdit(source: string): Promise<void>;
  chartTable: DataTable | undefined;
}

const data = "name,amount\na,1\nb,2\nc,3";
const token = new vscode.CancellationTokenSource().token;

function text(result: vscode.LanguageModelToolResult): string {
  return result.content
    .filter((part) => part instanceof vscode.LanguageModelTextPart)
    .map((part) => part.value)
    .join("\n");
}

function harness() {
  const values = new Map<string, unknown>();
  const panel = newPanel(values);
  const internals = panel as unknown as Internals;
  let next: ((message: Extract<ToWebview, { type: "render" }>) => void) | undefined;
  internals.post = (message) => {
    if (message.type !== "render") return;
    const handler = next;
    next = undefined;
    queueMicrotask(() =>
      handler
        ? handler(message)
        : internals.finishRender(message.requestId, { ok: true, diagramType: "bar" }),
    );
  };
  return {
    panel,
    internals,
    values,
    nextRender: (handler: NonNullable<typeof next>) => {
      next = handler;
    },
  };
}

async function draw(panel: DiagramPanel, spec: ChartSpec = { type: "bar", data }) {
  const table = parseTable(data);
  const source = JSON.stringify(buildChart(spec, table).option);
  assert.ok(
    (
      await panel.render(
        { language: "echarts", title: "Chart", source, chart: spec },
        "tool",
        undefined,
        table,
      )
    ).ok,
  );
  return source;
}

suite("chart agent tools", function () {
  this.timeout(10_000);

  test("analysis updates reuse the full cached table and retain the prior chart on invalid filters", async () => {
    const { panel, internals, values } = harness();
    const samples = "service,latency\na,1\na,2\nb,10\nb,20";
    const table = parseTable(samples);
    const chart: ChartSpec = { type: "bar", command: "must-not-run", valueColumns: ["latency"] };
    try {
      assert.ok(
        (
          await panel.render(
            {
              language: "echarts",
              title: "Samples",
              chart,
              source: JSON.stringify(buildChart(chart, table).option),
            },
            "tool",
            undefined,
            table,
          )
        ).ok,
      );
      assert.ok(
        (
          await panel.updateChart(
            {
              type: "histogram",
              bins: 2,
              facetColumn: "service",
              filters: [{ column: "latency", op: "gte", value: 2 }],
            },
            token,
          )
        ).ok,
      );
      assert.strictEqual(internals.chartTable, table);
      assert.strictEqual(panel.current?.chart?.facetColumn, "service");
      assert.deepStrictEqual((values.get("diagram.state") as DiagramState).chart?.filters, [
        { column: "latency", op: "gte", value: 2 },
      ]);
      const filtered = panel.current;
      await assert.rejects(
        panel.updateChart(
          {
            filters: [{ column: "latency", op: "gt", value: 1000 }],
          },
          token,
        ),
        /No rows match/,
      );
      assert.strictEqual(panel.current, filtered);
      assert.ok((await panel.updateChart({ filters: null, facetColumn: null }, token)).ok);
      const option = JSON.parse(panel.current?.source ?? "");
      assert.strictEqual(
        option.series[0].data.reduce(
          (total: number, bin: { value: number }) => total + bin.value,
          0,
        ),
        4,
      );
      assert.strictEqual(internals.chartTable, table);
    } finally {
      panel.dispose();
    }
  });

  test("partial settings preserve source and styling, and null clears settings", () => {
    const spec: ChartSpec = {
      type: "bar",
      data,
      options: { backgroundColor: "red" },
      limit: 1,
      sort: "ascending",
    };
    const updated = updatedChartSpec(spec, { type: "horizontalBar", sort: null, limit: null });
    assert.strictEqual(updated.type, "horizontalBar");
    assert.strictEqual(updated.data, data);
    assert.deepStrictEqual(updated.options, spec.options);
    assert.ok(!Object.hasOwn(updated, "limit"));
    assert.ok(!Object.hasOwn(updated, "sort"));
    for (const input of [
      {},
      { revision: 1 },
      { data: "x" },
      { options: {} },
      { type: null },
      { title: null },
      { revision: -1, limit: 2 },
      { limit: 0 },
    ]) {
      assert.throws(() => updatedChartSpec(spec, input));
    }
  });

  test("inspection reports inferred schema, nulls and bounded samples", () => {
    const table = parseTable("name,amount\na,1\nb,NULL\nc,3");
    const report = JSON.parse(inspectTable(table, 2));
    assert.strictEqual(report.rowCount, 3);
    assert.strictEqual(report.header, true);
    assert.strictEqual(report.columns[1].numeric, true);
    assert.strictEqual(report.columns[1].nullCount, 1);
    assert.deepStrictEqual(report.sample, [
      ["a", 1],
      ["b", null],
    ]);
    assert.strictEqual(report.sampleRowsOmitted, 1);
    const wide = {
      columns: Array.from({ length: 100 }, () => ({ name: "\u0000".repeat(1000), numeric: false })),
      rows: Array.from({ length: 20 }, () => Array(100).fill("x".repeat(1000))),
      header: true,
    };
    const bounded = inspectTable(wide, 20);
    assert.ok(bounded.length <= 24_000);
    assert.ok(JSON.parse(bounded).truncated);
  });

  test("inspection reads inline and loaded data without replacing the current chart", async () => {
    const { panel } = harness();
    try {
      await draw(panel);
      const before = panel.current;
      const tool = new InspectDataTool(panel);
      const inline = text(
        await tool.invoke(
          { input: { data, sampleRows: 0 }, toolInvocationToken: undefined },
          token,
        ),
      );
      assert.match(inline, /"rowCount":3/);
      assert.match(inline, /"sample":\[\]/);
      const cached = text(await tool.invoke({ input: {}, toolInvocationToken: undefined }, token));
      assert.match(cached, /"rowCount":3/);
      assert.strictEqual(panel.current, before);
      for (const input of [{ sampleRows: 21 }, { data, file: "x" }, { type: "bar", data }]) {
        assert.match(
          text(await tool.invoke({ input, toolInvocationToken: undefined }, token)),
          /could not be inspected/,
        );
      }
    } finally {
      panel.dispose();
    }
  });

  test("inspection confirms external files and commands, and reads a file without rendering", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "diagram-inspect-"));
    const file = path.join(directory, "data.csv");
    fs.writeFileSync(file, data);
    const { panel } = harness();
    try {
      const tool = new InspectDataTool(panel);
      assert.ok(tool.prepareInvocation({ input: { file } }).confirmationMessages);
      assert.ok(tool.prepareInvocation({ input: { command: "printf data" } }).confirmationMessages);
      assert.ok(!tool.prepareInvocation({ input: { data } }).confirmationMessages);
      assert.match(
        text(await tool.invoke({ input: { file }, toolInvocationToken: undefined }, token)),
        /"rowCount":3/,
      );
      assert.strictEqual(panel.current, undefined);
    } finally {
      panel.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("updates retain manual styling and loaded command data and support adoption", async () => {
    const { panel, internals } = harness();
    try {
      const source = await draw(panel, { type: "bar", command: "this-command-must-never-run" });
      const styled = JSON.parse(source);
      styled.backgroundColor = "#123456";
      await internals.applyEdit(JSON.stringify(styled));
      const request = { requestId: "chart-update" } as never;
      const result = await new UpdateChartTool(panel).invoke(
        {
          input: { type: "horizontalBar", sort: "descending", limit: 2, revision: panel.revision },
          toolInvocationToken: request,
        },
        token,
      );
      assert.match(text(result), /Updated/);
      assert.strictEqual(panel.current?.chart?.type, "horizontalBar");
      assert.strictEqual(panel.current?.chart?.limit, 2);
      assert.strictEqual(panel.loadedChartData?.rows.length, 3);
      assert.strictEqual(JSON.parse(panel.current?.source ?? "").backgroundColor, "#123456");
      assert.ok(panel.current?.editedByUser);
      assert.ok(panel.adopt(request));
      assert.match(panel.describeForModel() ?? "", new RegExp(`Revision: ${panel.revision}`));
    } finally {
      panel.dispose();
    }
  });

  test("updates reject stale revisions, missing caches and unsupported manual data edits", async () => {
    const { panel, internals } = harness();
    try {
      const source = await draw(panel, { type: "bar", command: "never-run" });
      const before = panel.current;
      await assert.rejects(
        panel.updateChart({ limit: 2, revision: panel.revision - 1 }, token),
        /chart changed/,
      );
      assert.strictEqual(panel.current, before);
      internals.chartTable = undefined;
      await assert.rejects(panel.updateChart({ limit: 2 }, token), /not loaded/);
      internals.chartTable = parseTable(data);
      const edited = JSON.parse(source);
      edited.series[0].data[0] = 999;
      await internals.applyEdit(JSON.stringify(edited));
      const manual = panel.current;
      await assert.rejects(panel.updateChart({ limit: 2 }, token), /source|data|edit/i);
      assert.strictEqual(panel.current, manual);
    } finally {
      panel.dispose();
    }
  });

  test("render failure restores the prior chart and persisted state", async () => {
    const { panel, internals, nextRender, values } = harness();
    try {
      await draw(panel);
      const before = panel.current;
      nextRender((message) =>
        internals.finishRender(message.requestId, {
          ok: false,
          kind: "invalid",
          error: "bad renderer",
        }),
      );
      const result = await panel.updateChart({ limit: 2 }, token);
      assert.ok(!result.ok);
      assert.match(result.error, /previous chart is kept/);
      assert.deepStrictEqual(panel.current, before);
      assert.deepStrictEqual(values.get("diagram.state"), before);
    } finally {
      panel.dispose();
    }
  });

  test("closing the panel during an update restores persisted state", async () => {
    const { panel, nextRender, values } = harness();
    try {
      await draw(panel);
      const before = panel.current;
      nextRender(() => panel.dispose());
      assert.ok(!(await panel.updateChart({ limit: 2 }, token)).ok);
      assert.deepStrictEqual((values.get("diagram.state") as DiagramState).source, before?.source);
      assert.deepStrictEqual(panel.current, before);
    } finally {
      panel.dispose();
    }
  });

  test("cancellation while rendering restores the chart, and pre-cancellation makes no changes", async () => {
    const { panel, nextRender } = harness();
    const cancellation = new vscode.CancellationTokenSource();
    try {
      await draw(panel);
      const before = panel.current;
      nextRender(() => cancellation.cancel());
      await assert.rejects(
        panel.updateChart({ limit: 2 }, cancellation.token),
        vscode.CancellationError,
      );
      assert.deepStrictEqual(panel.current, before);
      await assert.rejects(
        panel.updateChart({ limit: 1 }, cancellation.token),
        vscode.CancellationError,
      );
      await assert.rejects(
        new InspectDataTool(panel).invoke(
          { input: { data }, toolInvocationToken: undefined },
          cancellation.token,
        ),
        vscode.CancellationError,
      );
      assert.deepStrictEqual(panel.current, before);
    } finally {
      cancellation.dispose();
      panel.dispose();
    }
  });

  test("a superseding render wins over an in-flight chart update", async () => {
    const { panel, nextRender } = harness();
    let replacement: Promise<RenderOutcome> | undefined;
    try {
      await draw(panel);
      nextRender(() => {
        replacement = panel.render(
          { language: "mermaid", title: "New", source: "flowchart TD\nA-->B" },
          "tool",
        );
      });
      assert.ok(!(await panel.updateChart({ limit: 2 }, token)).ok);
      assert.ok((await replacement)?.ok);
      assert.strictEqual(panel.current?.title, "New");
      assert.strictEqual(panel.current?.chart, undefined);
    } finally {
      panel.dispose();
    }
  });

  test("cancellation does not wait for an unresponsive rollback renderer", async () => {
    const { panel, nextRender } = harness();
    const cancellation = new vscode.CancellationTokenSource();
    let timer: NodeJS.Timeout | undefined;
    try {
      await draw(panel);
      const before = panel.current;
      nextRender(() => {
        nextRender(() => {
          /* Simulate an unresponsive webview during restoration. */
        });
        cancellation.cancel();
      });
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Cancellation waited for the renderer")), 1000);
      });
      await assert.rejects(
        Promise.race([panel.updateChart({ limit: 2 }, cancellation.token), timeout]),
        vscode.CancellationError,
      );
      assert.deepStrictEqual(panel.current, before);
    } finally {
      clearTimeout(timer);
      cancellation.dispose();
      panel.dispose();
    }
  });

  test("cancelling a superseded update does not restore the older chart", async () => {
    const { panel, nextRender } = harness();
    const cancellation = new vscode.CancellationTokenSource();
    let replacement: Promise<RenderOutcome> | undefined;
    try {
      await draw(panel);
      nextRender(() => {
        replacement = panel.render(
          { language: "mermaid", title: "Replacement", source: "flowchart TD\nA-->B" },
          "tool",
        );
        cancellation.cancel();
      });
      await assert.rejects(
        panel.updateChart({ limit: 2 }, cancellation.token),
        vscode.CancellationError,
      );
      assert.ok((await replacement)?.ok);
      assert.strictEqual(panel.current?.title, "Replacement");
    } finally {
      cancellation.dispose();
      panel.dispose();
    }
  });
});
