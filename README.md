# @diagram

Interactive diagrams and charts for VS Code chat. Agents draw [Mermaid](https://mermaid.js.org/) diagrams and [Apache ECharts](https://echarts.apache.org/) 6 charts in a panel beside the chat, and you answer by selecting, clicking and editing what they drew.

Requires VS Code 1.140 or later, and chat set up with a language model, such as GitHub Copilot.

## Ask `@diagram`

Describe a diagram, optionally attaching files with `#file`:

- `@diagram sequence diagram of the OAuth login flow`
- `@diagram class diagram of #file:src/panel.ts`
- `@diagram add a retry path after the payment step` (changes the current diagram)

Or chart data, given inline, in a file or as a shell command's output:

- `@diagram render this as a pie chart: TypeScript 62%, CSS 20%, HTML 18%`
- `@diagram line chart of #file:benchmarks.csv`
- `@diagram bar chart of commits per author from git shortlog -sn HEAD`

Mermaid is used for structure and flow, ECharts for quantitative data, unless you ask for one. If a diagram fails to render, `@diagram` sends the error back to the model and retries. Commands:

- `/new`: start a new diagram instead of changing the current one
- `/explain`: explain the current diagram or the selected nodes, without changing it
- `/show`: show the diagram panel again

Chat can also route diagram and chart requests to `@diagram` without you mentioning it.

## Use the panel

- **Select** nodes or chart items, such as pie slices and bars, by clicking (Ctrl/Cmd+click or Shift+click for several). The agent sees the selection.
- **Send to chat**: type a request at the bottom of the panel. It mentions the selected nodes and goes to whoever drew the diagram: `@diagram`, or the agent that called a tool.
- **Edit source**: change the Mermaid source or the ECharts option by hand. The agent sees your edits and is told to keep them.
- **Refresh** a chart of a file or a command's output to load the data again.
- **Answer** an agent's question by clicking nodes, when it asks you to pick.
- Zoom diagrams with the toolbar or Ctrl/Cmd+scroll. Charts fit the panel.

Diagrams follow your VS Code color theme.

## Tools for other agents

Any agent, e.g. in agent mode, can use the panel through these tools. Attach one with `#`, also in an `@diagram` request, to have the model call it first:

| Tool | Reference | What it does |
| --- | --- | --- |
| `diagram_render` | `#diagram` | Renders Mermaid source, or an ECharts option as JSON, and reports the error if it does not render. |
| `diagram_chart` | `#chart` | Charts data given inline, in a file or as a command's output: pie, doughnut, bar, horizontal or stacked bar, line, area or scatter. Reads CSV, TSV, JSON, JSON Lines, Markdown tables and whitespace-separated columns (such as `du` or `wc -l` output), and tells the agent how it read them. |
| `diagram_getState` | `#diagramState` | Returns the current source, whether you edited it or it fails to render, and your selection. |
| `diagram_pickNodes` | `#diagramPick` | Asks you a question that you answer by clicking nodes, and waits for the answer. |

`diagram_render` and `diagram_chart` take an optional `clickPrompt`, such as `"Explain {label} in more detail"`: a click on a node then sends that request to chat right away, for diagrams you explore part by part. Ctrl/Cmd+click or Shift+click still selects.

VS Code asks you before a command runs, and before reading a file outside the workspace (or any file in an untrusted one). Commands only run in trusted workspaces.

## Development

```sh
npm install
npm run watch        # rebuild on change
npm run compile      # type-check, lint and build once
npm test             # run integration tests in a VS Code instance (xvfb-run -a npm test on headless Linux)
npm run vsix         # package a .vsix
```

Press <kbd>F5</kbd> to launch an Extension Development Host, then type `@diagram` in the chat view.
