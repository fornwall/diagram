// ECharts is built on its own, as dist/echarts.js: a classic script that defines DiagramECharts,
// which the panel loads on its first chart and a saved chart's page inlines ahead of its own script,
// so that the extension ships the library once.

import type * as EChartsLibrary from "./echartsLibrary";

declare global {
  var DiagramECharts: typeof EChartsLibrary | undefined;
}

let loading: Promise<typeof EChartsLibrary> | undefined;

export function loadECharts(): Promise<typeof EChartsLibrary> {
  loading ??= new Promise((resolve, reject) => {
    if (globalThis.DiagramECharts) {
      resolve(globalThis.DiagramECharts);
      return;
    }
    // The page's script, beside which the library is built, carries the nonce the policy requires.
    const page = document.querySelector<HTMLScriptElement>("script[nonce][src]");
    if (!page) {
      reject(new Error("Cannot load ECharts: the page has no script to load it beside."));
      return;
    }
    const script = document.createElement("script");
    script.nonce = page.nonce;
    script.src = new URL("echarts.js", page.src).href;
    script.onload = () =>
      globalThis.DiagramECharts
        ? resolve(globalThis.DiagramECharts)
        : reject(new Error(`ECharts did not load from ${script.src}.`));
    script.onerror = () => reject(new Error(`Cannot load ECharts from ${script.src}.`));
    document.head.append(script);
  });
  return loading;
}
