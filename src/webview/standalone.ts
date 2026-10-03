// The script of a saved chart's page: draws the chart with the panel's chart renderer, in the
// colors it was saved in and laid out for the browser window instead of the panel. Built as one
// file, which src/savedChart.ts inlines into the HTML it writes.

import { errorMessage, SAVED_CHART, type SavedChart } from "../protocol";
import { EChartsRenderer } from "./echartsRenderer";

const saved = (window as unknown as Record<string, SavedChart | undefined>)[SAVED_CHART];
const canvas = document.getElementById("canvas");
const errorElement = document.getElementById("error");

function fail(message: string): void {
  if (errorElement) {
    errorElement.textContent = message;
    errorElement.hidden = false;
  }
}

if (!saved || !canvas) {
  fail("This file is missing its chart.");
} else {
  // A saved chart has nowhere to send clicks; ECharts still highlights what the reader clicks.
  const renderer = new EChartsRenderer(
    () => {},
    canvas,
    () => saved.colors,
  );
  // The title is shown above the chart, so a chart title repeating it is left out, as in the panel.
  renderer.render(saved.source, saved.title).catch((error: unknown) => {
    fail(`This chart failed to render: ${errorMessage(error)}`);
  });
}
