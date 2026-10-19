# Contributing

Use Node.js 26, matching CI.

```sh
npm ci
npm run watch        # rebuild on change
npm run compile      # type-check, lint and build
npm run format       # apply Biome's formatting and safe fixes
npm test             # integration tests in VS Code; use xvfb-run -a npm test on headless Linux
npm run analyze      # production build, listing what each bundle contains and its size
npm run vsix         # package a .vsix
```

Press <kbd>F5</kbd> to launch an Extension Development Host. To install a package, use **Extensions: Install from VSIX…**.

`npm test` hangs when run from VS Code's integrated terminal, as the terminal sets `ELECTRON_RUN_AS_NODE`. Run it from another terminal, or with `ELECTRON_RUN_AS_NODE` and the `VSCODE_*` variables unset.

CI tests and packages every push and pull request: download `diagram-chat-<commit SHA>.vsix` from the **CI** run's artifacts within 90 days. Packages contain minified bundles, without source maps, and the licenses of the bundled packages in `dist/THIRD_PARTY_NOTICES.txt`.
