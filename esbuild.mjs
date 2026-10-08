import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const analyze = process.argv.includes("--analyze");

/** The builds running, of the four below, which start and finish independently. */
let building = 0;

/**
 * Prints errors and warnings with the location on the following line, as the problem matcher in
 * .vscode/tasks.json expects, and marks when watching the start of the first build and the end of
 * the last one, so that the extension launches only once all the files are written.
 * @type {import("esbuild").Plugin}
 */
const problemMatcherPlugin = {
  name: "esbuild-problem-matcher",
  setup(build) {
    build.onStart(() => {
      if (watch && building++ === 0) console.log("[watch] build started");
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
      if (watch && --building === 0) console.log("[watch] build finished");
    });
  },
};

/**
 * Starts each script with the licenses of the packages it includes, as a saved chart's page carries
 * them without the notices file.
 * @type {import("esbuild").Plugin}
 */
const noticesPlugin = {
  name: "notices",
  setup(build) {
    build.onEnd(({ metafile }) => {
      for (const [file, output] of Object.entries(metafile?.outputs ?? {})) {
        const notices = thirdPartyNotices([{ outputs: { [file]: output } }], "This script");
        const comment = notices && `/*!\n${notices.replaceAll("*/", "* /")}*/\n`;
        const script = readFileSync(file, "utf8");
        // A rebuild when watching may leave a file it would write the same as it was.
        if (comment && !script.startsWith(comment)) writeFileSync(file, comment + script);
      }
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
  // Replaced by the full notices that noticesPlugin puts first.
  legalComments: "none",
  plugins: [noticesPlugin, problemMatcherPlugin],
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
  writeFileSync(
    "dist/THIRD_PARTY_NOTICES.txt",
    thirdPartyNotices(
      results.map((r) => r.metafile),
      "@diagram",
    ),
  );
}

/**
 * The license and notice files of the packages that the bundles include code from, as their
 * licenses ask to be distributed with it, or nothing if there are none. Minifying drops most of
 * the comments that carry them.
 */
function thirdPartyNotices(metafiles, includer) {
  const packages = new Set();
  const sources = new Set();
  for (const { outputs } of metafiles) {
    for (const { inputs } of Object.values(outputs)) {
      for (const [path, { bytesInOutput }] of Object.entries(inputs)) {
        const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(path);
        if (match && bytesInOutput > 0) {
          packages.add(match[1]);
          sources.add(path);
        }
      }
    }
  }
  // roughjs's bundle has its dependencies built in, without naming them.
  for (const path of sources) {
    const match = /^(.*node_modules\/)roughjs\/bundled\//.exec(path);
    if (!match) continue;
    const dir = `${match[1]}roughjs`;
    const { dependencies } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    for (const name of Object.keys(dependencies)) {
      const nested = join(dir, "node_modules", name);
      packages.add(statSync(nested, { throwIfNoEntry: false }) ? nested : match[1] + name);
    }
  }
  // Packages with the same license text, such as most d3 modules, share one copy of it.
  const namesByText = new Map();
  const add = (text, name) => namesByText.set(text, (namesByText.get(text) ?? new Set()).add(name));
  const installed = new Set();
  for (const dir of packages) {
    const { name, version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    installed.add(name);
    const files = readdirSync(dir)
      .filter((file) => /^(licen[cs]e|notice)(-[\w-]+)?(\.(md|txt))?$/i.test(file))
      .map((file) => join(dir, file));
    // ECharts adds the licenses of code it includes from elsewhere.
    const others = join(dir, "licenses");
    if (statSync(others, { throwIfNoEntry: false })?.isDirectory()) {
      files.push(...readdirSync(others).map((file) => join(others, file)));
    }
    if (files.length === 0) throw new Error(`${name} has no license file to include`);
    // Sorted, as directories list their files in no particular order.
    const text = files
      .sort()
      .map((file) => readFileSync(file, "utf8").trim())
      .join("\n\n");
    add(text, `${name} ${version}`);
  }
  // Some packages ship other packages built into their files, such as @mermaid-js/parser with
  // langium, and those are not installed. Their bundler names them in a comment above each of
  // their modules, and licenses/ holds their license files.
  const bundled =
    /^\/\/ \S*?node_modules\/(?:\.pnpm\/(?:@[^/+]+\+)?[^/@]+@([^_/]+)[^/]*\/node_modules\/)?((?:@[^/]+\/)?[^/]+)\//gm;
  for (const path of sources) {
    for (const [, version, name] of readFileSync(path, "utf8").matchAll(bundled)) {
      if (installed.has(name)) continue;
      const file = join("licenses", `${name}.txt`);
      if (!statSync(file, { throwIfNoEntry: false })) {
        throw new Error(`${path} includes ${name}, which has no license file in licenses/`);
      }
      add(readFileSync(file, "utf8").trim(), version ? `${name} ${version}` : name);
    }
    // elkjs's bundle has GWT's runtime and Guava compiled in from Java, and web-worker's browser
    // stub, all by Google under the Apache License 2.0, without a comment that names them.
    if (path.endsWith("/elkjs/lib/elk.bundled.js")) {
      const text = readFileSync("licenses/elkjs-google.txt", "utf8").trim();
      for (const name of ["GWT", "Guava", "web-worker"]) add(text, `${name}, in elkjs`);
    }
  }
  const sections = [...namesByText]
    .map(([text, names]) => `${[...names].sort().join("\n")}\n\n${text}`)
    .sort();
  if (sections.length === 0) return "";
  return `${includer} includes the following third-party software.\n\n${sections.join(`\n\n${"=".repeat(78)}\n\n`)}\n`;
}
