import { rmSync } from "node:fs";
import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const analyze = process.argv.includes("--analyze");

/**
 * Prints errors and warnings with the location on the following line, as the problem matcher in
 * .vscode/tasks.json expects, and marks the start and end of each build when watching.
 * @type {import("esbuild").Plugin}
 */
const problemMatcherPlugin = {
  name: "esbuild-problem-matcher",
  setup(build) {
    build.onStart(() => {
      if (watch) console.log("[watch] build started");
    });
    build.onEnd(({ errors, warnings }) => {
      const messages = [
        ...errors.map((message) => ["✘ [ERROR]", message]),
        ...warnings.map((message) => ["▲ [WARNING]", message]),
      ];
      for (const [kind, { text, location }] of messages) {
        console.error(`${kind} ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column + 1}:`);
        }
      }
      if (watch) console.log("[watch] build finished");
    });
  },
};

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  metafile: analyze,
  logLevel: "silent",
  plugins: [problemMatcherPlugin],
};

// Chunk names are hashed, so start from scratch to not ship stale chunks.
rmSync("dist", { recursive: true, force: true });

const contexts = await Promise.all([
  esbuild.context({
    ...common,
    entryPoints: ["src/extension.ts"],
    format: "cjs",
    platform: "node",
    target: "node26",
    outfile: "dist/extension.js",
    external: ["vscode"],
  }),
  // An ES module, so that the renderers can load Mermaid and ECharts on demand as chunks.
  esbuild.context({
    ...common,
    entryPoints: { webview: "src/webview/main.ts" },
    format: "esm",
    splitting: true,
    outdir: "dist",
    chunkNames: "chunks/[name]-[hash]",
    platform: "browser",
    target: "chrome140",
  }),
  // The script of a saved chart's page, as one file with ECharts inlined, which src/savedChart.ts
  // embeds in the HTML the user saves. Always minified and without a source map, as it is shipped
  // inside those files, and for the browsers they may be opened in rather than for VS Code's.
  esbuild.context({
    ...common,
    entryPoints: { standalone: "src/webview/standalone.ts" },
    format: "iife",
    platform: "browser",
    target: ["chrome120", "firefox120", "safari17"],
    outdir: "dist",
    minify: true,
    sourcemap: false,
  }),
]);

if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  const results = await Promise.all(contexts.map((ctx) => ctx.rebuild().catch(() => undefined)));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
  if (results.includes(undefined)) process.exit(1);
  if (analyze) {
    for (const { metafile } of results) console.log(await esbuild.analyzeMetafile(metafile));
  }
}
