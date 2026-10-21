// The panel loads dist/echarts.js on its first chart. Exported HTML sets the same DiagramECharts
// global from a CDN module before starting the renderer.

import type * as EChartsLibrary from "./echartsLibrary";

declare global {
  var DiagramECharts: typeof EChartsLibrary | undefined;
}

let loading: Promise<typeof EChartsLibrary> | undefined;

/** Loads the library once, or again on the next call after it failed to load. */
export function loadECharts(): Promise<typeof EChartsLibrary> {
  loading ??= load().catch((error: unknown) => {
    loading = undefined;
    throw error;
  });
  return loading;
}

function load(): Promise<typeof EChartsLibrary> {
  return new Promise((resolve, reject) => {
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
    const fail = (message: string) => {
      // A script element runs at most once: the next try adds another.
      script.remove();
      reject(new Error(message));
    };
    script.onload = () =>
      globalThis.DiagramECharts
        ? resolve(globalThis.DiagramECharts)
        : fail(`ECharts did not load from ${script.src}.`);
    script.onerror = () => fail(`Cannot load ECharts from ${script.src}.`);
    document.head.append(script);
  });
}
