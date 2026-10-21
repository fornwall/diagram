# Contributing

## Development

Use Node.js 26 and VS Code 1.142 or later.

```sh
git clone https://github.com/fornwall/diagram.git
cd diagram
npm ci
npm run compile
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with watch mode. Reload it after extension changes; reopen the diagram panel after webview changes. To try the panel without a chat provider, open a Markdown `mermaid` or `echarts` block with **Open in Diagram**.

## Checks and tests

```sh
npm run compile                 # type checks, lint, and build
npm run format                  # formatting and safe lint fixes
npm test                        # VS Code integration tests; no chat account needed
npm test -- --grep '^data '      # run a subset
```

On headless Linux:

```sh
xvfb-run -a --server-args="-screen 0 1920x1080x24" npm test
```

If tests hang in VS Code's terminal, try an external terminal. For bug fixes, add a regression test in `src/test`. Check panel changes in light and dark themes and with keyboard navigation. Include the checks you ran in your pull request.

The extension host lives in `src/`, the browser UI in `src/webview/`, and their shared messages in `src/protocol.ts`.

## Reporting bugs

Include extension and VS Code versions, reproduction steps, and expected behavior. Attach diagram source or sample data for rendering problems; include the model name and prompt for chat problems.

## Packaging and releases

`npm run vsix` builds a production VSIX; `npm run analyze` reports bundle sizes. Install a VSIX with **Extensions: Install from VSIX…**. CI tests the production bundles on every push and pull request and keeps the VSIX artifact for 90 days.

To publish the next patch release from a clean `main`:

```sh
npm version patch
git push origin main
git push origin "v$(node -p 'require("./package.json").version')"
```

`npm version patch` commits the version bump and creates the tag. Pushing a `vX.Y.Z` tag matching `package.json` publishes to Visual Studio Marketplace after CI passes. Use a new version for each release, without prerelease suffixes.

Upload the same VSIX to [Open VSX](https://open-vsx.org/user-settings/extensions) manually.
