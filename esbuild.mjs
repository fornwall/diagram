import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  metafile: true,
  logLevel: "silent",
  plugins: [problemMatcherPlugin],
};

/**
 * ECharts as a classic script that defines a global (see src/webview/echartsLoader.ts), and the
 * script of a saved chart's page, which src/savedChart.ts both inlines into the HTML the user saves.
 * Always minified and without a source map, as they are shipped inside those files, and for the
 * browsers they may be opened in rather than for VS Code's.
 */
const savedPage = {
  ...common,
  format: "iife",
  platform: "browser",
  target: ["chrome120", "firefox120", "safari17"],
  outdir: "dist",
  minify: true,
  sourcemap: false,
};

// Chunk names are hashed, so start from scratch to not ship stale chunks.
rmSync("dist", { recursive: true, force: true });

// The targets are the runtimes of VS Code 1.140, the oldest that engines in package.json allows.
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
  // An ES module, so that Mermaid and its diagrams load on demand as chunks.
  esbuild.context({
    ...common,
    entryPoints: { webview: "src/webview/main.ts" },
    format: "esm",
    splitting: true,
    outdir: "dist",
    chunkNames: "chunks/[name]-[hash]",
    platform: "browser",
    target: "chrome150",
  }),
  esbuild.context({
    ...savedPage,
    entryPoints: { echarts: "src/webview/echartsLibrary.ts" },
    globalName: "DiagramECharts",
    // Saved charts carry ECharts without the notices file, so name its licenses here.
    banner: {
      js: "/*! Apache ECharts, Copyright 2017-2026 The Apache Software Foundation, Apache-2.0 License. ZRender, Copyright (c) 2017, Baidu Inc., BSD-3-Clause License. */",
    },
  }),
  esbuild.context({ ...savedPage, entryPoints: { standalone: "src/webview/standalone.ts" } }),
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
  writeFileSync("dist/THIRD_PARTY_NOTICES.txt", thirdPartyNotices(results.map((r) => r.metafile)));
}

/**
 * The license and notice files of the packages that the bundles include code from, as their
 * licenses ask to be distributed with it. Minifying drops most of the comments that carry them.
 */
function thirdPartyNotices(metafiles) {
  const packages = new Set();
  for (const { outputs } of metafiles) {
    for (const { inputs } of Object.values(outputs)) {
      for (const [path, { bytesInOutput }] of Object.entries(inputs)) {
        const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(path);
        if (match && bytesInOutput > 0) packages.add(match[1]);
      }
    }
  }
  const sections = new Map();
  for (const dir of packages) {
    const { name, version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const files = readdirSync(dir)
      .filter((file) => /^(licen[cs]e|notice)(-[\w-]+)?(\.(md|txt))?$/i.test(file))
      .map((file) => join(dir, file));
    // ECharts adds the licenses of code it includes from elsewhere.
    const others = join(dir, "licenses");
    if (statSync(others, { throwIfNoEntry: false })?.isDirectory()) {
      files.push(...readdirSync(others).map((file) => join(others, file)));
    }
    if (files.length === 0) throw new Error(`${name} has no license file to include`);
    const texts = files.map((file) => readFileSync(file, "utf8").trim());
    sections.set(`${name} ${version}`, texts.join("\n\n"));
  }
  const text = [...sections].sort().map((section) => section.join("\n\n"));
  return `@diagram includes the following third-party software.\n\n${text.join(`\n\n${"=".repeat(78)}\n\n`)}\n`;
}
