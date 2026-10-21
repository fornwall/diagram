# Contributing

## Setup

Use Node.js 26 and VS Code 1.142 or later, matching the versions in CI and `package.json`.

```sh
npm ci
npm run compile
```

Open this folder in VS Code and press <kbd>F5</kbd> to launch an Extension Development Host. The launch task starts `npm run watch` to rebuild changes. Reload the development host to load extension changes; close and reopen the diagram panel to load webview changes.

Chat features need a chat provider in the development host. You can exercise the panel without one by opening a Markdown file with a `mermaid` or `echarts` block and clicking **Open in Diagram**.

## Checks and tests

`npm run compile` checks TypeScript, runs Biome and builds the extension and webview. `npm run format` applies formatting and safe lint fixes.

```sh
npm test
```

This builds the code and tests, downloads the VS Code version in `.vscode-test.mjs` if needed, and runs the suites in `src/test`. Tests include parsers and chart generation, extension behavior and rendering in real webviews. They do not need a chat account.

To run a subset, pass a test name or regular expression:

```sh
npm test -- --grep '^data '
```

On headless Linux, use a display large enough for the rendering tests:

```sh
xvfb-run -a --server-args="-screen 0 1920x1080x24" npm test
```

If tests hang when launched from VS Code's integrated terminal, run them from an external terminal. Inherited `ELECTRON_RUN_AS_NODE` or `VSCODE_*` environment variables can interfere with the test instance.

For a bug fix, include a small input that reproduces the failure and a regression test in the relevant suite. For panel changes, check the development host in light and dark themes and with keyboard navigation. Describe the changed behavior and the checks you ran in the pull request.

## Source map

| Area | Starting points |
| --- | --- |
| Extension registration and chat | `src/extension.ts`, `src/participant.ts`, `src/prompt.ts` |
| Tool schemas and implementations | `package.json`, `src/tools.ts`, `src/chartTools.ts`, `src/workspaceTools.ts` |
| Panel state and host/webview messages | `src/panel.ts`, `src/webviewChannel.ts`, `src/protocol.ts` |
| Data parsing and chart generation | `src/data.ts`, `src/dataSource.ts`, `src/charts.ts`, related `data*` and `chart*` modules |
| Rendering and panel controls | `src/webview/main.ts`, `src/webview/mermaidRenderer.ts`, `src/webview/echartsRenderer.ts` |
| Markdown integration | `src/markdownDiagrams.ts`, `src/documentDiagram.ts`, `src/fences.ts` |
| Tests and webview harness | `src/test`, `src/test/webviewHarness.ts` |
| Bundling and packaging | `esbuild.mjs`, `.vscodeignore`, `.github/workflows/ci.yml` |

The extension host runs in Node.js; the webview runs in a browser. They have separate TypeScript configurations and communicate through the messages in `src/protocol.ts`. Keep host APIs out of webview code.

## Packaging

```sh
npm run analyze      # production build with bundle sizes and contents
npm run vsix         # production build packaged as a .vsix
```

Install the package with **Extensions: Install from VSIX…**.

CI tests and packages every push and pull request, running the rendering tests against the minified production bundles. Download `diagram-chat-<commit SHA>.vsix` from the **CI** run's artifacts within 90 days. Packages contain minified bundles, without source maps, and the licenses of the bundled packages in `dist/THIRD_PARTY_NOTICES.txt`.

To publish a release, upload the `.vsix` as an update to the existing extension on each registry:

- [Visual Studio Marketplace](https://marketplace.visualstudio.com/manage/publishers/fornwall)
- [Open VSX](https://open-vsx.org/user-settings/extensions)
