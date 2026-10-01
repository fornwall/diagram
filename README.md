# @diagram

A VS Code chat participant that gives agents an interactive diagram and chart UI, with two-way interaction: agents draw diagrams and charts, and you can act on them in ways the agent sees.

Diagrams are drawn with [Mermaid](https://mermaid.js.org/) and charts with [Apache ECharts](https://echarts.apache.org/) 6, both embedded in the extension. The model picks whichever fits: Mermaid for structure and flow, ECharts for quantitative data. You can also ask for one explicitly, or give Mermaid source yourself.

## Usage

### Directly: `@diagram` in chat

Ask `@diagram` to draw something, optionally attaching files with `#file`:

- `@diagram sequence diagram of the OAuth login flow`
- `@diagram class diagram of #file:src/panel.ts`
- `@diagram add a retry path after the payment step` (changes the current diagram)

Or to render data as a chart, with the data inline, in a file, or as the output of a shell command:

- `@diagram render this as a pie chart: TypeScript 62%, CSS 20%, HTML 18%`
- `@diagram line chart of #file:benchmarks.csv`
- `@diagram pie chart of the disk usage per folder` (runs e.g. `du -s *` once you confirm it)
- `@diagram bar chart of commits per author from git shortlog -sn HEAD`

The diagram opens in a panel beside the chat. If it fails to render, `@diagram` sends the error back to the model and retries. Commands:

- `/new`: start a new diagram instead of changing the current one
- `/explain`: explain the current diagram or the selected nodes, without changing it
- `/show`: show the diagram panel again

### Indirectly: from other agents

- **Auto-routing.** The participant declares `disambiguation` metadata, so chat can route diagram requests to `@diagram` without the user typing `@diagram`.
- **Tools.** Agents (e.g. in agent mode) can call two language model tools, which you can also attach with `#`:
  - `#diagram` (`diagram_render`): renders Mermaid source, or an ECharts option written as JSON (`language: "echarts"`), in the panel and reports back whether it rendered, or the error if not.
  - `#chart` (`diagram_chart`): renders data as a pie, doughnut, bar, horizontal bar, stacked bar, line, area or scatter chart. The data is given inline, as a file, or as a shell command whose output is charted; VS Code asks you to confirm the command first, and commands only run in trusted workspaces; reading a file outside the workspace also needs your confirmation. CSV, TSV, JSON and whitespace-separated columns (such as the output of `du`, `wc -l` or `git shortlog -sn`) are recognized, with header detection and size suffixes like `12K`. Optional `labelColumn`, `valueColumns`, `sort`, `limit` (the rest of a pie becomes "Other"; a trailing total row, as printed by `wc -l`, is left out) and `options` (merged into the ECharts option) fine-tune the chart. The agent is told how the data was read.
  - `#diagramState` (`diagram_getState`): returns the current source, whether the user edited it by hand, whether it fails to render, and which nodes the user selected.
  - `#diagramPick` (`diagram_pickNodes`): asks the user a question that they answer by clicking nodes, e.g. "Which part would you like to learn more about?", and waits for the answer. The question is shown above the diagram; with `multiple`, the user picks several nodes and presses **Done**. The user can also press **Cancel** or Escape.

  `diagram_render` also takes an optional `clickPrompt`, such as `"Explain {label} in more detail"`. A single click on a node then sends that request to chat right away, for diagrams the user explores part by part.

  `@diagram` itself writes Mermaid and ECharts code blocks, and calls `diagram_chart` to chart files and command output.

### Interacting with the diagram

In the panel you can:

- **Select nodes**, or chart items such as pie slices and bars, by clicking (Ctrl/Cmd+click for several). The agent sees the selection. In a diagram with a click prompt, a plain click asks about the node instead, and Ctrl/Cmd+click selects.
- **Answer an agent's question** by clicking nodes when it asks you to pick.
- **Send to chat**: type a request at the bottom of the panel to send it to chat, mentioning the selected nodes. It goes to `@diagram` if `@diagram` drew the diagram, and to the agent otherwise.
- **Edit source**: change the Mermaid source or the ECharts option by hand. The agent sees your edits and is told to keep them.
- **Refresh** a chart of a file or a command's output, to load the data again.
- Zoom diagrams with the toolbar buttons or Ctrl/Cmd+scroll. Charts fill the panel and adapt their layout to its size.

Diagrams and charts follow your VS Code color theme, light, dark or high contrast, on the editor background.

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

Tooling: TypeScript 7 (type-checking only), esbuild (bundling the extension and the webview, which embeds Mermaid and ECharts), Biome (linting and formatting).
