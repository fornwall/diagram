# @diagram

A VS Code chat participant that gives agents an interactive Mermaid diagram UI, with two-way interaction: agents draw diagrams, and you can act on them in ways the agent sees.

## Development

```sh
npm install
npm run watch        # rebuild on change
npm run compile      # type-check, lint and build once
npm test             # run integration tests in a VS Code instance
npm run vsix         # package a .vsix
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host, then type `@diagram` in the chat view.

Tooling: TypeScript 7 (type-checking only), esbuild (bundling), Biome (linting and formatting).
