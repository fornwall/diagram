# @diagram

Interactive [Mermaid](https://mermaid.js.org/) diagrams and [Apache ECharts](https://echarts.apache.org/) charts beside VS Code chat. Ask `@diagram` to draw, select items in the panel, edit the source and ask follow-up questions about what you selected.

Requires VS Code 1.142 or later. Chat features need a chat provider, such as GitHub Copilot. Diagrams in Markdown files open and edit without chat.

## Get started

Ask `@diagram` to draw, optionally attaching files with `#file` or images:

- `@diagram sequence diagram of the OAuth login flow in #file:src/auth.ts`
- `@diagram add a retry path after the payment step`
- `@diagram bar chart of commits per author from git shortlog -sn HEAD`
- `@diagram treemap of du -ah src`
- `@diagram histogram of request latency in #file:requests.csv, one panel per service`
- `@diagram turn this whiteboard photo into a flowchart`

Follow-ups change the current diagram. `/new` starts another, `/explain` discusses it without changing it, and `/show` reopens the panel. Render errors and layout problems go back to the model to fix.

## The panel

- **Select** nodes, edges, sequence messages or chart items by clicking; Ctrl/Cmd+click or Shift+click adds to the selection. Everything also works from the keyboard.
- **Ask**: type a question or change and press **Send to chat**. The request includes your selection.
- **Edit** the source in split view and press **Apply** (Ctrl/Cmd+Enter). The agent is told about your edits, so it keeps them.
- **Highlight Path** between two selected nodes of a flowchart or state diagram.
- **Find** text with Ctrl/Cmd+F, **zoom and pan** Mermaid diagrams, and open nodes linked to files or URLs.
- **Chart Options** (the gear in the title bar) reconfigures a chart made from data; **Refresh** reloads its file or command.
- **Export** PNG, SVG or an offline interactive HTML chart, or drag the picture handle into another app.

Diagrams follow your VS Code theme, high contrast included. Agents can mark items with notes, for example to walk you through a diagram, and can ask you to pick items as an answer.

## Diagrams in Markdown

Click **Open in Diagram** above a `mermaid` or `echarts` code block, or run **Diagram: Open Diagram at Cursor**. **Apply** renders your edits and writes them back to the block as an unsaved, undoable change, keeping the surrounding text. Changes made by an agent need your confirmation before they are written. Set `diagram.codeLens.enabled` to `false` to hide the links above blocks.

## Charts from data

`@diagram` can chart inline data, a file or a command's output. It reads CSV, TSV, JSON, JSON Lines, Markdown tables, database client output such as `psql` and `sqlite3`, and whitespace-separated output such as `du`, `ls -l`, `docker ps` or `kubectl`. It understands abbreviations such as `1.5K`, sizes such as `20 MiB` and durations such as `1h2m3s`.

Chart types: pie, doughnut, bar, stacked bar, line, area, scatter, histogram, treemap, sunburst, sankey, heatmap, radar, box plot, gauge and funnel. Charts can filter, aggregate, sort and limit rows, and split into a panel per value of a column. For anything else, the model can write an ECharts option directly.

## Tools for other agents

Any chat agent, not only `@diagram`, can use the extension's tools to render and edit diagrams, chart data, read the panel's selection, look at the drawing as an image, mark items and ask you to pick items. Reference them in chat with `#diagram`, `#diagramEdit`, `#chart`, `#diagramState`, `#diagramImage`, `#diagramPick` and others listed in the tools picker.

## Security

VS Code asks before running a command, reading a data file outside the workspace or opening an external link. Commands and ECharts options with JavaScript need a trusted workspace; in an untrusted workspace, reading workspace files also asks first. The panel loads no remote content.

## Limits

Data files and command output are limited to 10 MiB, commands to 60 seconds, tables to 1,000,000 cells and Mermaid sources to 50,000 characters. Summarize larger datasets before charting them.

## Feedback

Report issues and contribute on [GitHub](https://github.com/fornwall/diagram). See [CONTRIBUTING.md](CONTRIBUTING.md) to build and test the extension.
