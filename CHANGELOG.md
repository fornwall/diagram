# Changelog

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
