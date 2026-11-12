# Contributing

Use Node.js 26 and VS Code 1.145 or later.

```sh
npm ci
npm run compile   # type check, lint and build
npm run format    # format and apply safe lint fixes
npm test          # VS Code integration tests
```

Press <kbd>F5</kbd> to launch an Extension Development Host. The extension host is in `src/`, the webview in `src/webview/`, and the messages between them in `src/protocol.ts`.

## Releases

```sh
npm version patch
git push origin main "v$(node -p 'require("./package.json").version')"
```

Pushing a `vX.Y.Z` tag publishes to the Visual Studio Marketplace and Open VSX after CI passes.
