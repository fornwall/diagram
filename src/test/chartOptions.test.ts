import * as assert from "node:assert";
import { withChartControls } from "../chartOptions";
import type { ChartSpec } from "../chartSpec";
import { isFromWebview } from "../protocol";

suite("chart options", () => {
  const spec: ChartSpec = {
    type: "bar",
    command: "print-data",
    format: "tsv",
    title: "Sales",
    sort: "descending",
    limit: 4,
    max: 100,
    options: { legend: { show: false } },
  };
  test("replaces controls together while preserving data and presentation", () => {
    const result = withChartControls(spec, {
      type: "sankey",
      labelColumn: ["target", "source"],
      valueColumns: ["amount"],
      aggregate: "sum",
    });
    assert.deepStrictEqual(result, {
      type: "sankey",
      command: "print-data",
      format: "tsv",
      title: "Sales",
      max: 100,
      options: spec.options,
      labelColumn: ["target", "source"],
      valueColumns: ["amount"],
      aggregate: "sum",
    });
    assert.strictEqual(spec.limit, 4);
  });
  test("rejects replacement data sources, arbitrary options and invalid controls", () => {
    for (const extra of [
      { command: "run-something" },
      { options: {} },
      { limit: 0 },
      { type: "bogus" },
      { valueColumns: [] },
    ]) {
      assert.throws(() => withChartControls(spec, { type: "pie", ...extra }));
    }
  });
  test("validates options revision and explicit source replacement before handling messages", () => {
    const valid = {
      type: "applyChartOptions",
      revision: 1,
      controls: { type: "bar" },
      replaceSource: false,
    };
    assert.ok(isFromWebview(valid));
    assert.ok(!isFromWebview({ ...valid, revision: "1" }));
    assert.ok(!isFromWebview({ ...valid, controls: [] }));
    assert.ok(!isFromWebview({ ...valid, replaceSource: "true" }));
  });
});
