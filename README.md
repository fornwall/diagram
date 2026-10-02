# @diagram

Interactive [Mermaid](https://mermaid.js.org/) diagrams and [Apache ECharts](https://echarts.apache.org/) charts beside VS Code chat.

Ask an agent to draw, then select parts, edit source or send a follow-up from the panel.

You can also open `mermaid` and `echarts` blocks from Markdown files and apply edits back to the file.

Requires VS Code 1.140 or later with chat configured, for example through GitHub Copilot.

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

- **Select** nodes or chart items by clicking; use Ctrl/Cmd+click or Shift+click for several. The agent sees your selection.
- **Send to chat**: type a request at the bottom. It includes your selection and goes to `@diagram` or the agent that drew the diagram.
- **Edit source**: use the top-right icons to show the source beside the diagram or alone. Press **Apply** (Ctrl/Cmd+Enter) to render your edits. Switching views or receiving a new diagram preserves unapplied edits; **Revert** loads the current diagram. The agent is told to preserve applied edits.
- **Resize the source pane**: drag the divider in split view, or focus it with Tab and use the arrow keys. Home and End move it to its limits; Enter or a double-click restores its default size.
- **Refresh** reloads a chart's file or command output, replacing manual source edits.
- **Save** exports a chart as an HTML file containing its data, theme and chart library. It works offline in a browser.
- **Drag out as an image**: drag the top-right picture handle into another application for a PNG; hold Shift for SVG. If PNG conversion fails, export falls back to SVG. Images use the current theme and omit code-link tooltips and their file paths.
- **Open code** by clicking an underlined node linked to a file.
- **Answer a question** by clicking nodes when an agent asks you to pick.
- **Follow a walkthrough**: agents can mark nodes with notes, add a caption and fade the rest without moving the diagram. A new diagram clears the marks.
- **Zoom and pan** diagrams with the toolbar, Ctrl/Cmd+scroll and dragging. Charts fit the panel.

Diagrams follow your VS Code color theme.

### Edit a diagram in a Markdown file

Click **Open in Diagram** above a `mermaid` or `echarts` block, or choose **Open Diagram at Cursor** from the Markdown editor's context menu. The command is also available in the Command Palette as **Diagram: Open Diagram at Cursor**. The panel title names the file.

**Apply** renders your edits and writes them into the original block, preserving its fence, indentation and surrounding text. Failed renders leave the file unchanged and keep your edits in the panel. Writes can be undone in VS Code. If the block changed or cannot be identified safely, reopen it with **Open in Diagram**.

If an agent replaces the diagram, **Write to** applies its version after confirmation; rendering alone never changes the file. Switching between Mermaid and ECharts detaches the diagram from the original block.

Hide the **Open in Diagram** actions with `diagram.codeLens.enabled`.

## Tools for other agents

Any chat agent can use these tools. Attach one with `#` to have it called first, including in an `@diagram` request:

| Tool | Reference | What it does |
| --- | --- | --- |
| `diagram_render` | `#diagram` | Renders Mermaid or ECharts JSON/JavaScript, including callbacks and custom series. Supports Mermaid code links and reports render errors. |
| `diagram_chart` | `#chart` | Charts inline data, files or command output. Infers columns, supports grouping and date axes, and reports how it interpreted the data. |
| `diagram_getState` | `#diagramState` | Returns the current source, whether you edited it or it fails to render, and your selection. |
| `diagram_pickNodes` | `#diagramPick` | Asks a question and waits for you to answer by clicking nodes. |
| `diagram_annotate` | `#diagramAnnotate` | Marks current steps, problems, successes or points of interest, with optional notes, caption and fading. Replaces previous marks without redrawing. |

`diagram_chart` reads CSV, TSV, JSON, JSON Lines, Markdown tables and whitespace-separated output such as `du` or `wc -l`. It supports pie, doughnut, bar (vertical, horizontal or stacked), line, area (plain or stacked), scatter, treemap, sunburst, sankey, heatmap, radar, box plot, gauge and funnel charts. Grouping combines rows with the same labels by sum, mean, count, min, max or median; ISO dates become a time axis.

`diagram_render` and `diagram_chart` accept `clickPrompt`, such as `"Explain {label} in more detail"`. Clicking a node or item sends that request to chat immediately, with its label substituted. Ctrl/Cmd+click or Shift+click still selects.

`diagram_render` accepts `links` mapping Mermaid node ids to code, e.g. `{"parse": "src/parser.ts#L42", "check": "src/checker.ts#L10-L30", "cli": "src/cli.ts"}`. Clicking a linked node opens the file with those lines selected. Links take priority over `clickPrompt`; picking and Ctrl/Cmd/Shift+click take priority over both.

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

CI tests and packages every branch push and pull request. Download `diagram-<commit SHA>.vsix`
from the artifacts of the commit's **CI** run in GitHub Actions to install it.
Packages use the production build (minified bundles, without source maps or development files)
and are retained for 90 days. A push containing multiple commits builds the latest commit in that push.
