import { rmSync } from "node:fs";
import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const analyze = process.argv.includes("--analyze");

/** @type {import("esbuild").Plugin} */
const problemMatcherPlugin = {
  name: "esbuild-problem-matcher",
  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      }
      console.log("[watch] build finished");
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
    target: "node24",
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
