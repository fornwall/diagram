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

Follow-ups change the current diagram. `/new` starts another, `/explain` discusses it without changing it, and `/show` reopens the panel. The model receives render errors and layout warnings so it can attempt a repair.

## The panel

- **Select** nodes, edges, sequence messages or chart items by clicking; Ctrl/Cmd+click or Shift+click adds to the selection. For keyboard selection, Tab to the drawing, move with the arrow keys and press Enter or Space.
- **Ask**: type a question or change and press **Send to chat**. The request includes your selection.
- **Edit** the source in split view and press **Apply** (Ctrl/Cmd+Enter). Applied edits are included in the next chat request.
- Right-click for **Highlight Path** when two selected nodes have a path between them in a flowchart or state diagram, **Clear Selection** to remove selections and agent highlights, or **Help** for a brief guide.
- **Find** text with Ctrl/Cmd+F, **zoom and pan** Mermaid diagrams, and open nodes linked to files or URLs.
- **Chart Options** (the gear in the title bar) reconfigures a chart made from data; **Refresh** reloads its file or command.
- **Export** PNG, SVG or an offline interactive HTML chart, or drag the picture handle into another app.

Diagrams follow your VS Code theme, high contrast included. Agents can mark items, for example to walk you through a diagram, and can ask you to pick items as an answer.

## Diagrams in Markdown

Click **Open in Diagram** above a `mermaid` or `echarts` code block, or run **Diagram: Open Diagram at Cursor**. **Apply** renders your edits and writes them back to the block as an unsaved, undoable change, keeping the surrounding text. Changes made by an agent need your confirmation before they are written. Set `diagram.codeLens.enabled` to `false` to hide the links above blocks.

## Charts from data

`@diagram` can chart inline data, a file or a command's output. It reads CSV, TSV, JSON, JSON Lines, Markdown tables, database client output such as `psql` and `sqlite3`, and whitespace-separated output such as `du`, `ls -l`, `docker ps` or `kubectl`. It understands abbreviations such as `1.5K`, sizes such as `20 MiB` and durations such as `1h2m3s`.

Chart types: pie, doughnut, bar, stacked bar, line, area, scatter, histogram, treemap, sunburst, sankey, heatmap, radar, box plot, gauge and funnel. Charts can filter, aggregate, sort and limit rows, and split into a panel per value of a column. For anything else, the model can write an ECharts option directly.

## Tools for other agents

Any chat agent, not only `@diagram`, can use the extension's tools to render and edit diagrams, chart data, read the panel's selection, look at the drawing as an image, mark items and ask you to pick items. Reference them in chat with `#diagram`, `#diagramEdit`, `#chart`, `#diagramState`, `#diagramImage`, `#diagramPick` and others listed in the tools picker. See [the tools reference](docs/tools.md) for what each one does.

Agents can read `diagram_guide` with `{"topic":"workflow"}` for tool selection and verification. State reads support summaries, exact source ranges and literal source search, so agents can locate labels or chart settings and edit large drawings without repeating the whole source. Replacements and edits accept revision guards to preserve newer changes. Data inspection supports paging through columns and sample rows, with exact column names for chart settings. `#diagramExport` saves either Mermaid or ECharts to a named HTML file with embedded source/data and a CDN renderer; viewing it requires internet access.

## Security

VS Code asks before running a command, reading a data file outside the workspace, exporting HTML through a tool or opening an external link. Commands and ECharts options with JavaScript need a trusted workspace; in an untrusted workspace, reading workspace files also asks first. The panel loads no remote content; HTML files made by `diagram_exportHtml` load their renderer from a CDN when opened.

Chat requests send your prompt, attached content, diagram context and tool results to the model selected in VS Code. Opening and editing a Markdown diagram does not require a model.

## Limits

Data files and command output are limited to 10 MiB, commands to 60 seconds, tables to 1,000,000 cells and Mermaid sources to 50,000 characters. Summarize larger datasets before charting them.

See [the full reference](docs/reference.md) for everything the panel, Markdown editing and chart data support, and for all limits.

## Feedback

Report issues and contribute on [GitHub](https://github.com/fornwall/diagram). See [CONTRIBUTING.md](CONTRIBUTING.md) to build and test the extension.
