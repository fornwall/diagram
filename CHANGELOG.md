# Changelog

## Unreleased

- Six tools instead of twenty: render (now also from a file), edit, get state, get image, annotate and guide. Agents use their own tools to read files and run commands, and draw charts as ECharts options.
- Removed the data-to-chart pipeline, Chart Options, Refresh, HTML export, drag-out, Highlight Path, picks, walkthroughs, drafts, checkpoints, evidence and graph tools.
- The Diagram agent may use any tool.
- Charts are drawn as their option says, without the panel re-laying them out.

## 0.11.0

- Requires VS Code 1.145 or later. Mermaid 12.3 adds BPMN shapes and flowchart step animations. Images show steps at rest, and invalid steps are reported.

Diagrams

- A diagram with a theme color that Mermaid cannot read no longer breaks every later diagram. The error names the color and its line.
- A theme chosen by a directive after the type line is legible in dark themes.
- Items with formulas are named by their TeX source. A click on a sequence message's formula selects the message.
- Clearer hints for quadrant points outside 0–1 and for parser errors that named internal tokens.
- Tooltips no longer stay over the next drawing or match Find while hidden. Drafts no longer close an open link menu or shrink a chart in the Source view, and Gantt drafts find their tasks.

Charts

- A click selects only that item, not every item of its name, such as a heatmap column. Selections survive agent edits that keep the items, the toolbox's restore and a series' `selectedMode: "single"`.
- Theme rivers focus, mark and select the right layer. Sunburst Home and End follow the order the chart shows.
- Colors set by sankey, pie and funnel series are kept. Labels of mark lines and max pins are no longer cut off.
- Marks stay highlighted after hovering the legend or axis pointer, and undimmed marks blur nothing. The axis pointer leaves with the keyboard focus.
- Switching to or from a horizontal bar chart keeps options and styling on their axes. Faceted charts keep their panel titles and positions when options set a title or grid.
- Box plots name groups without numbers, gauges with a negative `max` scale sensibly, and an empty title restores the default.

Data

- Reads more command output: psql titled tables, footers and empty edge values, sqlite3, pandas frames and series, R tibbles, hyperfine, docker system df, AWS CLI tables and sizes, kubectl ages in years, CPU times of ps and top, PostgreSQL sizes and `tput` colors.
- Markdown table rows are labelled by their link text. A column of only missing markers is described as such.
- Charting an open file uses its unsaved changes. Oversized whitespace output is refused sooner, using less memory.

Agents

- Row inspection works on charts whose options only change axes or add mark lines, and is refused when options replace series data.
- Edits refuse text that overlaps itself. Refusals of stale revisions name the current one, and batch errors name their operation.
- Clearer messages for evidence, walkthroughs, closed panels, future revisions and oversized checkpoint comparisons. Drafts report readability warnings and keep their own title.

Panel and export

- Exported HTML has current browsers check its CDN renderer, renders HTML labels and formulas, and keeps a diagram's own theme.
- Markdown cells of a renamed notebook stay bound, and exports suggest the notebook's folder. Write to names a renamed file after a reload.
- After the user declines a request from a panel that ran chart code, the panel says why it asks no more.

## 0.10.0

- Agents can query graph relationships, edit simple flowcharts by item id, and inspect rows contributing to chart selections.
- Callouts and walkthroughs explain diagrams with optional viewport focus.
- Named checkpoints preserve alternatives; revision diffs show intervening changes. Drafts can render and check constraints before applying.
- Evidence attachments track item identities and cited-range freshness; checkpoint comparisons report changed labels.
- Agents can search and page through exact item ids and labels for highlights and image crops, including repeated chart names and parallel edges.
- Inspected datasets can be reused for paging and charting; hierarchy and Sankey selections trace contributing rows.
- Drafts share editing checks and preview source edits, structural batches and chart settings. Flowchart tools add and remove nodes and edges.
- State summaries report tool capabilities; annotations and image crops accept revision guards.
- Large image crops avoid argument-limit failures and use less temporary memory.
- Absolute paths with `.` or `..` resolve correctly in virtual workspaces. Workspace tool results respect small token budgets.
- Sparse charts and shared facet grids respect the million-cell limit before allocating expanded data.
- Draft previews follow theme changes. Ordinary rendering avoids unused callout observers, and typo hints skip impossible matches.
- Graph queries reject incomplete results; structural edits preserve carriage-return line endings and reject malformed arrows.

## 0.0.9

Diagrams

- Shift+click adds a node to the selection without highlighting the text between the clicks.
- A click on an edge's label, a message's text or a participant's footer focuses it for the keyboard. Arrow keys held with Alt, Ctrl or Meta are left to VS Code.
- Nodes, participants, subgraphs and notes are listed in the order of the source. A tall sequence diagram starts at the top.
- Sankey flows stay legible on dark backgrounds.
- Clearer errors and hints for ZenUML, edges at diamond blocks, and mistakes in requirement, radar, Cynefin, railroad, Wardley, agent flow and event model diagrams. A warning names nodes that only a `style` line adds. A link's label over a node is reported once.

Charts

- Items on a time axis and heatmap cells go by their time, or column and row, in selections, marks and tooltips.
- Time axes tick no closer than their days or months, and tooltips are headed by the time as the axis labels it.
- Heatmaps of hundreds of rows keep their height. Their smallest cells stay visible in high contrast themes.
- Value axes of headerless data state their unit. Chart settings are read in any case. Row-number columns, arrays cut short by `head`, and UTF-8 files with replacement characters are read correctly.
- Keyboard focus starts at the first item of a new chart. A refused chart update says which revision to pass next.

Panel

- Link buttons stay readable in forced colors. A chart's Write to button and stale note say "chart".
