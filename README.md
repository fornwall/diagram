# @diagram

A VS Code chat participant that gives agents an interactive Mermaid diagram UI, with two-way interaction: agents draw diagrams, and you can act on them in ways the agent sees.

## Usage

### Directly: `@diagram` in chat

Ask `@diagram` to draw something, optionally attaching files with `#file`:

- `@diagram sequence diagram of the OAuth login flow`
- `@diagram class diagram of #file:src/panel.ts`
- `@diagram add a retry path after the payment step` (changes the current diagram)

The diagram opens in a panel beside the chat. If it fails to render, `@diagram` sends the error back to the model and retries. Commands:

- `/new`: start a new diagram instead of changing the current one
- `/explain`: explain the current diagram or the selected nodes, without changing it
- `/show`: show the diagram panel again

### Indirectly: from other agents

- **Auto-routing.** The participant declares `disambiguation` metadata, so chat can route diagram requests to `@diagram` without the user typing `@diagram`.
- **Tools.** Agents (e.g. in agent mode) can call two language model tools, which you can also attach with `#`:
  - `#diagram` (`diagram_render`): renders Mermaid source in the panel and reports back whether it rendered, or the syntax error if not.
  - `#diagramState` (`diagram_getState`): returns the current source, whether the user edited it by hand, whether it fails to render, and which nodes the user selected.

### Interacting with the diagram

In the panel you can:

- **Select nodes** by clicking (Ctrl/Cmd+click for several). The agent sees the selection.
- **Send to chat**: type a request at the bottom of the panel to send it to chat, mentioning the selected nodes. It goes to `@diagram` if `@diagram` drew the diagram, and to the agent otherwise.
- **Edit source**: change the Mermaid source by hand. The agent sees your edits and is told to keep them.
- Zoom with the toolbar buttons or Ctrl/Cmd+scroll.

## Development

```sh
npm install
npm run watch        # rebuild on change
npm run compile      # type-check, lint and build once
npm test             # run integration tests in a VS Code instance
npm run vsix         # package a .vsix
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host, then type `@diagram` in the chat view.

Tests need a display; on a headless Linux machine run them with `xvfb-run -a npm test`.

Tooling: TypeScript 7 (type-checking only), esbuild (bundling the extension and the webview, which embeds Mermaid), Biome (linting and formatting).
