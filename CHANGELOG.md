# Changelog

## Unreleased

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
