// Inspect parsed source rows without guessing from chart labels or displayed values.

import { captureChartPresentation } from "./chartPresentation";
import type { ChartSpec } from "./chartSpec";
import { buildChart } from "./charts";
import { ChartTrace } from "./chartTrace";
import type { DataTable } from "./data";
import type { DiagramNode } from "./protocol";

export interface Contribution {
  id: string;
  rowCount: number;
}

export function chartContributors(
  spec: ChartSpec,
  table: DataTable,
  source: string,
  items: readonly DiagramNode[],
): { rows: number[]; items: Contribution[]; interpretation: string } {
  const { options: _options, ...generated } = spec;
  const trace = new ChartTrace(table);
  const built = buildChart(generated, table, trace);
  const verified = captureChartPresentation(source, captureChartPresentation(built.option));
  if (verified.blocked) {
    throw new Error(
      "Source rows cannot be mapped because the displayed chart changes the generated data or structure, or uses JavaScript. Inspect the raw data without ids/selection, or restore the generated chart first.",
    );
  }
  const rows = new Set<number>();
  const contributions = items.map(({ id, chart }) => {
    if (!chart) {
      throw new Error(`No source-row mapping is available for ${JSON.stringify(id)}.`);
    }
    const sources = trace.item(built.option, chart);
    if (sources === undefined) {
      throw new Error(
        `Source-row inspection is not supported for this ${spec.type} chart item. Inspect raw data without ids/selection.`,
      );
    }
    const unique = new Set(sources);
    for (const number of unique) rows.add(number);
    return { id, rowCount: unique.size };
  });
  return {
    rows: [...rows].sort((a, b) => a - b),
    items: contributions,
    interpretation: built.summary,
  };
}
