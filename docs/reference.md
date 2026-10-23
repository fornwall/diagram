# Reference

The details of using Diagram. See the [README](../README.md) for an overview and [tools.md](tools.md) for the tools that agents use.

## Chat

Use the Diagram tools in ordinary agent chat, or select **Diagram** from the agent dropdown for a focused session. Ask to change the current diagram, start a separate one, or explain it without changes. **Diagram: Show Panel** reopens the panel. Render errors and warnings go back to the agent so it can attempt a repair while keeping the requested content. You may still need to resize the panel.

Attach files or images through VS Code chat. Attachment formats and limits depend on the chat provider and selected model.

## The panel

| Action                          | How                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Select                          | Click a node, edge, sequence message or chart item. Ctrl/Cmd+click or Shift+click toggles it in the selection. A plain click follows an item's link or click prompt, if set, and zooms into treemap and sunburst items.                                                                                                                                                                                                                        |
| Keyboard                        | Tab to the drawing; arrows move, Home/End move to first/last, and Enter/Space clicks. Ctrl/Cmd or Shift toggles selection. H hides the focused series or pie slice; Shift+H restores all. Escape closes menus, Chart Options and the data view.                                                                                                                                                                                                |
| Highlight a path                | Select a start and destination, then right-click and choose **Highlight Path** in a flowchart, swimlane, agent flow or state diagram. Available when a path connects the two nodes. It selects a shortest path, follows arrows, traverses plain lines and double arrows both ways, skips invisible links and breaks ties by source order.                                                                                                      |
| Clear selections and highlights | Right-click and choose **Clear Selection** to remove selected items, agent highlights and dimming.                                                                                                                                                                                                                                                                                                                                             |
| Help                            | Right-click and choose **Help** for a brief guide to the extension.                                                                                                                                                                                                                                                                                                                                                                            |
| Ask                             | Type a question or change and press **Send to chat**. The request includes your selection and opens chat without changing the selected agent. Selection stays available to the diagram state tool until you change or clear it.                                                                                                                                                                                                                |
| Answer a pick                   | When an agent asks you to pick, click your answer (or several items, then **Done**). **Cancel** or Escape declines.                                                                                                                                                                                                                                                                                                                            |
| Edit                            | Show source with the view buttons. **Apply** (Ctrl/Cmd+Enter) renders edits; **Revert** discards them. Drafts survive view changes and incoming diagrams. Errors link to their source location. Inferred titles follow your edits. Agents read applied edits through the diagram state tool.                                                                                                                                                   |
| Find                            | Ctrl/Cmd+F finds text in the drawing and the source.                                                                                                                                                                                                                                                                                                                                                                                           |
| Resize                          | Drag the divider in split view, or focus it and use the arrow keys. Home/End set the limits; Enter or double-click resets it.                                                                                                                                                                                                                                                                                                                  |
| Chart Options                   | Use the title bar gear or **Diagram: Chart Options…** to configure a chart made from data. Enter applies.                                                                                                                                                                                                                                                                                                                                      |
| Refresh                         | Reload file or command data, keeping JSON styling. Revert or reset manual changes to data, structure or JavaScript first.                                                                                                                                                                                                                                                                                                                      |
| Export                          | Use the editor title bar, drawing's context menu or **Diagram: Export…** to save PNG, SVG or an HTML page for a diagram or chart. HTML embeds the source, data and theme, using the same exporter as `diagram_exportHtml`; viewing requires internet access to load the renderer. Exports default to the Markdown file's folder when writable, or the subfolder you last exported to.                                                          |
| Drag an image                   | Drag the picture handle into another app for PNG; hold Shift as you start for SVG. A drawing too large for PNG drops as SVG.                                                                                                                                                                                                                                                                                                                   |
| Open links                      | Click an underlined node to open its linked file or http, https or mailto URL. Sequence actors with several links offer a menu. VS Code asks before opening an untrusted website.                                                                                                                                                                                                                                                              |
| Zoom and pan                    | For Mermaid, use the zoom buttons, Ctrl/Cmd with +, - or 0, Ctrl/Cmd+scroll, trackpad pinching or dragging. The percentage toggles fit/actual size. New diagrams fit the panel, but not so small that their text stops reading: wider ones scroll sideways, starting at their first node. Revisions keep your zoom. Charts, and Mermaid Gantt, XY, quadrant, radar, sankey, packet, Venn and Cynefin diagrams that set no size, resize to fit. |

Images keep the theme and omit links. Mermaid images also omit selection and marks. PNGs use up to twice the drawing's resolution, with size metadata for documents. Mermaid SVGs use inline styles for apps such as Figma and Office.

Chart Options reuses loaded data. After a restart, press **Refresh** to reload file or command data; inline data stays available. **Reset styling** removes manual styling and reloads data if needed. **Replace manual source edits with the generated chart** discards incompatible edits.

In charts, arrows follow categories and series. Trees use ←/→ for parent/child and ↑/↓ for siblings; scatter, graph and sankey charts move to the nearest item. Enter expands tree nodes or zooms into treemaps and sunbursts; Backspace goes up a treemap or sunburst.

Diagrams follow your VS Code theme, high contrast themes included; a Mermaid diagram that sets its own `theme` keeps it, and its `themeVariables` recolor the panel's theme. Agents can mark items, for example to walk you through a diagram.

Charts have a read-only data view. Toolbox chart-type switching, box zoom and brush are disabled because resizing would undo them. Short panels hide the visual map, zoom slider, subtitle and title as needed; wheel zoom and dragging remain available.

## Diagrams in Markdown

Click **Open in Diagram** above a `mermaid` or `echarts` block, or run **Diagram: Open Diagram at Cursor**. Language names are case-insensitive; Azure DevOps `::: mermaid` containers, block quotes and list items are supported. Mermaid language aliases follow `markdown-mermaid.languages`. Set `diagram.codeLens.enabled` to `false` to hide the links above blocks.

**Apply** renders edits and updates the block, preserving fences, indentation, quote markers and surrounding text, also after the file is renamed in VS Code. Changes are undoable and remain unsaved, in a background tab that VS Code opens if no editor shows the file. If rendering fails or the block has changed, the file stays untouched. Copy your edits from the warning or reopen the block.

**Write to** writes the displayed diagram to its Markdown block. Agent changes require confirmation before either action writes them. Starting a separate diagram with the tools’ `newDiagram` option, or switching between Mermaid and ECharts, detaches the panel from the block. Read-only files, including Git revisions, can be viewed and edited in the panel without writing back.

## Chart data

`diagram_chart` reads:
- CSV (comma, semicolon or the delimiter of an Excel `sep=` line) and TSV
- JSON (nested objects become dotted columns such as `cpu.user`), JSON Lines and other streams of JSON values, as `jq` prints them
- Markdown tables, also within text, and tables drawn with pipes or box-drawing characters, such as `psql`, `mysql`, `sqlite3`, DuckDB, Polars and `git diff --stat` output
- Whitespace-separated output such as `du`, `wc -l`, `ls -l`, `df`, `free`, `docker ps`, `kubectl`, `go test -bench`, `top -b`, `cloc`, `tasklist`, PowerShell tables and pandas data frames

Terminal colors are ignored. In auto format, shortened DuckDB, Polars or pandas results include only the rows and columns shown. Use `format: "csv"` or `"tsv"` to keep literal ellipsis rows and columns. Quoted multiline fields keep their contents.

Quote large JSON IDs, e.g. `{"id":"9007199254740993"}`. Unquoted integers outside ±9,007,199,254,740,991 may be rounded.

Abbreviations such as `1.5K` and `$1.2B` mean thousands and billions. In size columns, such as `du -h` output or a column named `Size`, `1.5K` means 1536 bytes. Units such as `MiB` and `kB` always mean bytes; bare units use powers of 1000 for commands run with `--si` or `df -H`.

Durations such as `812ms`, `-250ms` and `1h2m3s` become seconds. In duration columns such as `Elapsed`, so do `45m` and `1:02:03`. Header units such as `Size (KB)`, `Latency (ms)` or `Elapsed (s)` apply to plain numbers below them. Charts display sizes and durations in the unit that suits the largest value.

It draws pie, doughnut, bar, horizontal bar, stacked bar, line, area, stacked area, scatter, histogram, treemap, sunburst, sankey, heatmap, radar, box plot, gauge and funnel charts. Bar, line, area and scatter charts put ISO dates and times (and `YYYY/MM/DD`, also with a time) of the first label column on a time axis.

| Setting                       | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `labelColumn`, `valueColumns` | Choose columns by name, or omit to infer them. Given a second label column, bar, line and area charts draw a series per label of it from one value column, as for rows such as `month,region,sales`. Several label columns are the levels of a treemap or sunburst, the stages of a sankey or the axes of a heatmap; a single label column of paths, such as `src/webview/main.ts`, gives a treemap, sunburst or sankey levels too. |
| `aggregate`                   | Combine rows with the same labels by `sum`, `mean`, `count`, `min`, `max` or `median`. Without it, repeated labels stay separate, except that a series per label, a heatmap, a treemap, a sunburst and a sankey add up their rows.                                                                                                                                                                                                  |
| `sort`, `limit`               | Sort by the first value column, or by the total of each stack or of each label of a series per label, then keep the first rows. Pie and doughnut charts sum the rest as "Other"; a series per label takes no `limit`. A time axis draws the rows in time order; a box plot orders its boxes by median.                                                                                                                              |
| `filters`                     | Keep rows matching every predicate, before anything else. Example: `[{"column":"latency","op":"gte","value":100}]`.                                                                                                                                                                                                                                                                                                                 |
| `facetColumn`                 | Split a bar, line, area or scatter chart or a histogram into a panel per value, at most 12. Grouping, sorting and limits apply within each panel.                                                                                                                                                                                                                                                                                   |
| `facetColumns`, `facetScales` | Set 1–4 panels per row, more when the panels would take over 4 rows or be too short to read at the height of the view, and `"shared"` (default) or `"independent"` axis scales. A view too short for the panels scrolls them.                                                                                                                                                                                                       |
| `bins`                        | Histogram bins of equal width, 1–200. By default, about √n bins, at most 50, of a round width: 1, 2 or 5 × 10ⁿ, and at least 1 for whole numbers.                                                                                                                                                                                                                                                                                   |

With two label columns, a sankey joins same-named nodes unless that creates a cycle. With more columns, each stage has separate nodes. Stages with over 30 nodes combine all but the largest 29 as "Other".

Heatmap axes and shared facet categories sort numbers, dates and weekdays naturally, unless `sort` orders rows by value. Other labels keep their input order. Facet panels follow the same ordering, with missing values last.

A final row labeled `Total` or `Sum` that matches the sum of the rows above it is left out, as are parent rows of a treemap, sunburst or sankey, such as the directory totals of `du -a`.

Filters compare parsed cells: numeric-looking cells become numbers. `eq`/`neq` compare value and type; `null` matches missing cells. Numeric comparisons take numbers; `contains` is case-sensitive. Use bytes for sizes and seconds for durations. At most 50 filters are allowed; `[]` clears them.

Histograms count one numeric value column; omit `labelColumn`, `aggregate`, `sort` and `limit`. A bin includes its lower bound, and only the last bin its upper bound. Faceted histograms share bin boundaries, even with independent scales.

## Data access and security

VS Code asks before running a command, reading a data file outside the workspace (including on **Refresh**), or opening an external file link. In an untrusted workspace, workspace reads and all file links also require confirmation.

Commands need a trusted, nonvirtual workspace. They run with `/bin/sh` (`cmd.exe` on Windows) in the first workspace folder, or in your home directory if no folder is open. Relative paths resolve from the first workspace folder.

ECharts callbacks and other JavaScript require a trusted workspace; plain object literals work anywhere. An option pasted from the ECharts examples, with `option = {…}` and `myChart.setOption(option)` around it, works as is. Once a panel runs JavaScript, **Send to chat** and click prompts fill the chat input without submitting it. Writing to Markdown, rerunning a command and opening a web link require confirmation. Declining blocks such requests until the panel closes.

The panel loads images only from `data:` URLs, so a Mermaid image shape must embed its image.

## Limits

- Files and command output: 10 MiB. Commands time out after 60 seconds.
- Tables: 1,000,000 cells, including headers and empty cells. Treemaps, sunbursts and sankeys: 100 levels.
- Pie, doughnut, funnel and radar charts: 1,000 items. Box plots and sunbursts: 10,000. Heatmaps: 100,000 cells.
- Bar, line and area charts: 50 series.
- Mermaid sources: 50,000 characters.
- Workspace tools: reads of files up to 16 MiB, 500 lines at a time. A search skips files over 1 MiB and scans at most 1,000 files and 16 MiB. Results are capped at 40,000 characters and say what they leave out.
- A chart of a file or command with a very large option is not kept when VS Code restarts; press **Refresh** to draw it again.
- When VS Code restarts, a diagram that the panel did not finish drawing within 15 seconds is not drawn again, in case it hangs the panel; edit and apply it, or have it rendered again.

Summarize larger datasets before charting them.
