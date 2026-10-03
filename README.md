# @diagram

Interactive [Mermaid](https://mermaid.js.org/) diagrams and [Apache ECharts](https://echarts.apache.org/) charts beside VS Code chat. Select parts, edit source and ask follow-up questions from the panel.

Requires VS Code 1.140 or later. Chat features need a configured chat provider, such as GitHub Copilot. You can also open and edit diagrams in Markdown files without chat.

## Get started

Ask `@diagram` to draw, optionally attaching files with `#file`:

- `@diagram sequence diagram of the OAuth login flow`
- `@diagram class diagram of #file:src/panel.ts`
- `@diagram find the authentication code and draw its request flow with links to the files`
- `@diagram add a retry path after the payment step`
- `@diagram line chart of #file:benchmarks.csv`
- `@diagram bar chart of commits per author from git shortlog -sn HEAD`
- `@diagram treemap of du -ah src`
- `@diagram histogram of request latency in #file:requests.csv, one panel per service`
- `@diagram line chart of #file:benchmarks.csv, one panel per implementation with shared scales`
- `@diagram show only successful requests taking at least 100 ms`

Follow-ups change the current diagram. The agent can find and read workspace code, inspect tabular data, ask you to select diagram items, and annotate a walkthrough. Use `/new` to start another, `/explain` to discuss the diagram or selection without changing it, and `/show` to reopen the panel. Failed renders are sent back to the model for repair.

## Use the panel

| Action | How |
| --- | --- |
| Select | Click a node, flowchart edge, sequence message or chart item. Ctrl/Cmd+click or Shift+click selects several. Tab then Enter/Space also selects diagram items; modifiers add to the selection. |
| Highlight a path | Select two flowchart nodes in order (start, then destination), then **Highlight Path**. Selects a shortest path following arrows, including its edges. Plain lines and double arrows can be followed both ways; invisible layout links are excluded. |
| Ask | Type in **Send to chat**. The request includes your selection and goes to `@diagram` or the agent that drew the diagram. |
| Edit | Use the top-right view buttons to show source. **Apply** (Ctrl/Cmd+Enter) renders edits; **Revert** discards them. Unapplied edits survive view changes and incoming diagrams. |
| Resize | Drag the divider in split view, or focus it and use arrow keys. Home/End set the limits; Enter or double-click resets it. |
| Chart Options | Use the gear in the editor toolbar or **Diagram: Chart Options…** to change chart type, columns, filters, facets, histogram bins, aggregation, sorting and row limit. Applies to charts generated from data. |
| Refresh | Reload a chart's file or command output, keeping JSON source styling such as axis labels, formatting, and series colors. Changes to data, structure, or JavaScript source are kept and must be reverted or explicitly reset before refreshing. |
| Export | Use **Export…** in the diagram tab’s toolbar, right-click the drawing, or run **Diagram: Export…** from the Command Palette. Choose PNG, SVG, or (for ECharts) interactive HTML, then a save location. HTML files work offline. |
| Drag an image | Drag the picture handle into another app for PNG; hold Shift for SVG. PNG failures fall back to SVG. Images keep the theme and omit code-link tooltips and paths. |
| Open code | Click an underlined node linked to a file. |
| Zoom and pan | Use the toolbar, Ctrl/Cmd+scroll and dragging. Charts fit the panel. |

Chart Options uses the data already loaded, so opening it or applying options does not rerun a command. After reopening VS Code, file and command charts need **Refresh** to reload their data. Inline charts remain configurable immediately. Use **Apply** to update the chart or **Close** (Escape) to dismiss the form. Unapplied source drafts are kept. **Reset styling** removes manual presentation changes; source edits that cannot be preserved require selecting **Replace manual source edits** first. Without loaded data, the reset action explicitly reloads it too.

Flowchart edges and sequence messages can be selected by their lines or labels, passed to chat, picked by agents, and annotated. Parallel edges and repeated messages have distinct IDs. **Highlight Path** breaks equal-length ties in source order and reports when no path exists. Relationship selection is currently limited to Mermaid flowcharts and sequence diagrams.

Diagrams follow your VS Code theme. Agents can also ask you to pick nodes, or mark them with notes and captions during a walkthrough.

## Edit Markdown diagrams

Click **Open in Diagram** above a `mermaid` or `echarts` code block. Alternatively, place the cursor inside a block and use **Diagram: Open Diagram at Cursor** from the Command Palette or editor context menu. Disable the inline actions with `diagram.codeLens.enabled`.

**Apply** renders your edits and writes them to the original block, preserving fences, indentation and surrounding text. Failed renders leave the file unchanged and keep your edits in the panel. Writes can be undone in VS Code. If the block changed or cannot be identified safely, reopen it.

If an agent replaces the diagram, **Write to** applies its version after confirmation. Switching between Mermaid and ECharts detaches it from the original block.

## Tools for agents

Any chat agent can use these tools. `@diagram` has them available by default; attaching a reference with `#` requests that it be called first. `/explain` makes only diagram-state and workspace-reading tools available, even if a tool that changes the diagram is attached.

| Tool | Reference | Purpose |
| --- | --- | --- |
| `diagram_render` | `#diagram` | Render Mermaid or ECharts JSON/JavaScript, including callbacks and custom series. Reports render errors. |
| `diagram_chart` | `#chart` | Chart inline data, files or command output. Infer columns, group rows and recognize date axes. Report how the data was interpreted. |
| `diagram_getState` | `#diagramState` | Read source, edits, errors, selection and selectable relationship IDs/endpoints. |
| `diagram_pickNodes` | `#diagramPick` | Ask a question and wait for nodes, relationships or chart items. |
| `diagram_annotate` | `#diagramAnnotate` | Mark nodes or relationships, with notes, caption and fading, without redrawing. Omit marks to clear them. |
| `diagram_findFiles` | `#diagramFiles` | Find workspace files by glob, across all open folders. |
| `diagram_searchText` | `#diagramSearch` | Search literal text in workspace files; return matching lines and locations. |
| `diagram_readFile` | `#diagramRead` | Read a numbered line range from a workspace file, including unsaved edits. |
| `diagram_inspectData` | `#diagramData` | Inspect a table's columns, inferred types and sample rows without rendering. |
| `diagram_updateChart` | `#diagramUpdate` | Change a generated chart's type, columns, grouping, sort or limit using loaded data, preserving supported styling. |

Workspace exploration returns bounded results and reports when files, lines or matches were omitted. Narrow the glob or read another line range to continue. Workspace tools only access files inside open workspace folders.

For follow-ups such as “show the top 10 as horizontal bars”, `diagram_updateChart` reuses the loaded table without rereading files or rerunning commands. Omitted settings are kept; `null` clears optional column, aggregation, sort, limit or scale settings. Updates can include the revision from `diagram_getState` to reject a stale edit. Unsupported manual source changes block the update and keep your chart intact. After reopening VS Code, use **Refresh** to reload file or command data first.

`diagram_inspectData` accepts the same data sources and formats as `diagram_chart`, with up to 20 sample rows. Omit the source to inspect the current chart's loaded data without reloading it. Inspection of an explicit source and subsequent charting load that source separately; inspecting a command does not cache its output for a later chart.

For relationship annotations, use the exact `edge:` or `message:` IDs listed by `diagram_getState`. IDs remain stable across rerendering, but generated IDs can change after editing the source.

`diagram_chart` reads CSV, TSV, JSON, JSON Lines, Markdown tables and whitespace-separated output such as `du` or `wc -l`. Supported charts: pie, doughnut, bar (vertical, horizontal or stacked), line, area (plain or stacked), scatter, histogram, treemap, sunburst, sankey, heatmap, radar, box plot, gauge and funnel. Group by sum, mean, count, min, max or median; ISO dates become a time axis.

Use `facetColumn` to draw one panel per distinct column value for bar, line, area, scatter or histogram charts, including horizontal and stacked variants. Up to 12 panels are supported; filter the data to narrow larger sets. Axis scales are shared by default; set `facetScales` to `"independent"` to fit each panel separately. `facetColumns` sets 1–4 panels per row. The facet column is excluded from automatic label/value selection. Grouping, sorting and row limits apply separately inside each panel.

Histograms count raw samples from one numeric column. Set `valueColumns` to select it and `bins` for 1–200 equal-width bins, or omit bins for an automatic count (square root of the sample count, rounded up and capped at 50). Constant data uses one bin. Intervals include their lower bound; only the final interval includes its upper bound. Faceted histograms share bin boundaries even with independent scales. Omit `labelColumn`, `aggregate`, `sort` and `limit` for histograms; use filters to choose samples and facets to compare groups.

`filters` keeps rows matching every predicate before faceting or other transformations. Each filter contains `column`, `op` and `value`, for example `{"column":"latency","op":"gte","value":100}`. Operators are `eq`, `neq`, `lt`, `lte`, `gt`, `gte` and `contains`. Equality compares parsed values and types exactly; `null` matches missing cells. Ordered comparisons require numbers; `contains` matches case-sensitive text. Numeric filter values use input units, such as bytes for sizes. Filters and all facet/bin settings can be changed through `diagram_updateChart` without rereading files or rerunning commands; use `null` to clear an optional setting, or `[]` to clear filters.

`diagram_render` and `diagram_chart` accept `clickPrompt`, such as `"Explain {label} in more detail"`. Clicking sends that request immediately with the item's label substituted.

For Mermaid, `diagram_render` accepts `links` from node ids to code locations, e.g. `{"parse": "src/parser.ts#L42", "check": "src/checker.ts#L10-L30"}`. Links take priority over `clickPrompt`; picking and Ctrl/Cmd/Shift+click take priority over both.

## Data access and limits

VS Code asks before running a command, reading a data file outside the workspace, or opening a linked file outside it. Workspace exploration and data-file reads in an untrusted workspace also require confirmation, as does opening any linked file there. Commands require a trusted, nonvirtual workspace.

Relative paths resolve from the first workspace folder. Commands run there with `/bin/sh` (`cmd.exe` on Windows), or in your home directory if no folder is open.

- Files and command output: 10 MiB; command timeout: 60 seconds.
- Workspace code reads: 1 MiB per file, at most 500 lines per read. Text search scans at most 1,000 files and 16 MiB per call; results and line previews are bounded and report truncation.
- Tables: 1,000,000 cells, including headers and empty cells.
- Treemap, sunburst and sankey: 100 hierarchy levels per row.

Summarize larger datasets before charting them.

## Development

```sh
npm install
npm run watch        # rebuild on change
npm run compile      # type-check, lint and build
npm test             # integration tests in VS Code; use xvfb-run -a npm test on headless Linux
npm run vsix         # package a .vsix
```

Press <kbd>F5</kbd> to launch an Extension Development Host. To install a package, use **Extensions: Install from VSIX…**.

CI tests and packages every branch push and pull request. Download `diagram-<commit SHA>.vsix` from the commit's **CI** artifacts, retained for 90 days. Packages contain minified bundles without source maps or development files. A push with multiple commits builds its latest commit.
