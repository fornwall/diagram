# @diagram

Interactive diagrams and charts for VS Code chat. Agents draw [Mermaid](https://mermaid.js.org/) diagrams and [Apache ECharts](https://echarts.apache.org/) 6 charts in a panel beside the chat, and you answer by selecting, clicking and editing what they drew.

The `mermaid` and `echarts` code blocks already written in your Markdown files open in the same panel, and the edits you apply there go back into the file.

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
- `@diagram treemap of du -ah src`
- `@diagram sankey of #file:budget.csv` (a source column, a target column and the amounts)
- `@diagram commits per author from git log --format=%an` (one row per commit, counted)

Mermaid is used for structure and flow, ECharts for quantitative data. You can request either explicitly. If a diagram fails to render, `@diagram` sends the error back to the model and retries. Commands:

- `/new`: start a new diagram instead of changing the current one
- `/explain`: explain the current diagram or the selected nodes, without changing it
- `/show`: show the diagram panel again

Chat can also route diagram and chart requests to `@diagram` without you mentioning it.

## Use the panel

- **Select** nodes or chart items, such as pie slices and bars, by clicking (Ctrl/Cmd+click or Shift+click for several). The agent sees the selection.
- **Send to chat**: type a request at the bottom of the panel. It mentions the selected nodes and goes to whoever drew the diagram: `@diagram`, or the agent that called a tool.
- **Edit source**: the icons at the top right switch between the diagram, the diagram beside its source, and the source alone. Change the Mermaid source or the ECharts option by hand and press Apply (Ctrl/Cmd+Enter). The agent sees your edits and is told to keep them.
- **Open a diagram from a Markdown file**: the *Open in Diagram* action above every `mermaid` and `echarts` code block, or the **Diagram: Open Diagram at Cursor** command, shows it in the panel, whose title then names the file. Apply writes your edits back into that code block, keeping its fence, its indentation and the rest of the file, as an edit you can undo in the editor. Nothing else writes to the file: a diagram an agent draws into it is written only when you press **Write to** the file in the panel, and you are asked first. Turn the action off with the `diagram.codeLens.enabled` setting.
- **Refresh** a chart of a file or a command's output to load the data again.
- **Save** a chart as a self-contained HTML file: the chart, the colors it is drawn in and the chart library in one file, which opens in any browser and loads nothing.
- **Drag out as an image**: drag the picture handle at the top right into another application, such as a chat message or a document, to drop the drawing there as a PNG, or as an SVG while you hold Shift. The image is drawn in the colors you see, and leaves out the tooltips that say where a node links to, so that it carries no paths from your machine.
- **Open the code** a node stands for by clicking it, when the agent linked the node to a file. Such nodes are underlined.
- **Answer** an agent's question by clicking nodes, when it asks you to pick.
- **Follow a walkthrough**: an agent can mark nodes of the diagram it already drew — the step you are on, something wrong, a path that works — each with a short note and a line above the diagram, and fade the rest. The diagram itself stays where it is; a new one clears the marks.
- Zoom diagrams with the toolbar or Ctrl/Cmd+scroll, and drag a diagram that is larger than the panel to move around in it. Charts fit the panel.

Diagrams follow your VS Code color theme.

## Tools for other agents

Any agent, e.g. in agent mode, can use the panel through these tools. Attach one with `#`, also in an `@diagram` request, to have the model call it first:

| Tool | Reference | What it does |
| --- | --- | --- |
| `diagram_render` | `#diagram` | Renders Mermaid source, or an ECharts option written as JSON or as JavaScript, which may use functions where ECharts takes callbacks, as `custom` series do. Mermaid nodes can link to places in the code. Reports the error if it does not render. |
| `diagram_chart` | `#chart` | Charts data given inline, in a file or as a command's output: pie, doughnut, bar, horizontal or stacked bar, line, area, stacked area, scatter, treemap, sunburst, sankey, heatmap, radar, box plot, gauge and funnel. Reads CSV, TSV, JSON, JSON Lines, Markdown tables and whitespace-separated columns (such as `du` or `wc -l` output), works out which column labels, nests, flows into or measures what, and tells the agent how it read them. Can group the rows that share a label (summing, averaging or counting them) and draws a column of ISO dates on a time axis. |
| `diagram_getState` | `#diagramState` | Returns the current source, whether you edited it or it fails to render, and your selection. |
| `diagram_pickNodes` | `#diagramPick` | Asks you a question that you answer by clicking nodes, and waits for the answer. |
| `diagram_annotate` | `#diagramAnnotate` | Marks nodes of the diagram already shown — as the step being explained, a problem, something that works, or a plain pointer — with a note each, a line above the diagram and the rest faded, without drawing it again. Each call replaces the marks before it. |

`diagram_render` and `diagram_chart` take an optional `clickPrompt`, such as `"Explain {label} in more detail"`: a click on a node then sends that request to chat right away, for diagrams you explore part by part. Ctrl/Cmd+click or Shift+click still selects.

`diagram_render` also takes `links`, which map Mermaid node ids to places in the code, such as `{"parse": "src/parser.ts#L42", "check": "src/checker.ts#L10-L30", "cli": "src/cli.ts"}`: a click on such a node opens the file there, with the lines selected. Links win over `clickPrompt`, while picking and Ctrl/Cmd/Shift+click still come first.

VS Code asks you before a command runs, before reading a file outside the workspace, and before opening a linked file outside it (or any file in an untrusted workspace). Commands only run in trusted workspaces.

Relative file paths resolve from the first workspace folder. Commands run there using `/bin/sh` (`cmd.exe` on Windows), or in your home directory if no folder is open. Files and command output are limited to 10 MiB; commands time out after 60 seconds. Tables are limited to 1,000,000 cells, including headers and empty cells. Summarize larger datasets before charting them.

## Development

```sh
npm install
npm run watch        # rebuild on change
npm run compile      # type-check, lint and build once
npm test             # run integration tests in a VS Code instance (xvfb-run -a npm test on headless Linux)
npm run vsix         # package a .vsix
```

Press <kbd>F5</kbd> to launch an Extension Development Host, then type `@diagram` in the chat view.

To install the packaged extension, run **Extensions: Install from VSIX…** from the Command Palette and choose the generated `.vsix` file.
