# @diagram

Interactive [Mermaid](https://mermaid.js.org/) diagrams and [Apache ECharts](https://echarts.apache.org/) charts beside VS Code chat. Select items, edit source and ask follow-up questions from the panel.

Requires VS Code 1.140 or later. Chat features need a configured chat provider, such as GitHub Copilot. You can also open and edit diagrams in Markdown files without chat.

## Get started

Ask `@diagram` to draw, optionally attaching files with `#file`:

- `@diagram sequence diagram of the OAuth login flow in #file:src/panel.ts`
- `@diagram add a retry path after the payment step`
- `@diagram bar chart of commits per author from git shortlog -sn HEAD`
- `@diagram treemap of du -ah src`
- `@diagram histogram of request latency in #file:requests.csv, one panel per service`

Follow-ups change the current diagram. Use `/new` to start another, `/explain` to discuss it without changing it, and `/show` to reopen the panel.

## Use the panel

| Action | How |
| --- | --- |
| Select | Click a node, flowchart edge, sequence message or chart item. Ctrl/Cmd+click or Shift+click selects several. Tab then Enter/Space also selects diagram items; modifiers add to the selection. |
| Highlight a path | Select two flowchart nodes in order (start, then destination), then **Highlight Path**. Selects a shortest path, including its edges. |
| Ask | **Send to chat** includes your selection and replies to the agent that drew the diagram. |
| Edit | Use the top-right view buttons to show source. **Apply** (Ctrl/Cmd+Enter) renders edits; **Revert** discards them. Unapplied edits survive view changes and incoming diagrams. |
| Resize | Drag the divider in split view, or focus it and use arrow keys. Home/End set the limits; Enter or double-click resets it. |
| Chart Options | Use the toolbar gear or **Diagram: Chart Options…** to configure a chart generated from data. |
| Refresh | Reload file or command data, preserving JSON source styling. Manual changes to data, structure or JavaScript source must be reverted or reset first. |
| Export | Use the toolbar, drawing’s context menu or **Diagram: Export…**. Save PNG, SVG or an offline interactive HTML chart (ECharts only). |
| Drag an image | Drag the picture handle into another app for PNG; hold Shift for SVG. PNG failures fall back to SVG. Images keep the theme and omit code-link tooltips and paths. |
| Open code | Click an underlined node linked to a file. |
| Zoom and pan | Use the toolbar, Ctrl/Cmd+scroll and dragging. Charts fit the panel. |

Chart Options uses loaded data without rerunning commands. After reopening VS Code, use **Refresh** for file or command data; inline charts remain configurable. **Reset styling** removes manual presentation changes and reloads data if needed. To discard incompatible source edits, select **Replace manual source edits** first.

**Highlight Path** follows arrows, treats plain lines and double arrows as bidirectional, excludes invisible links, and breaks ties in source order.

Diagrams follow your VS Code theme. Agents can ask you to pick items and annotate them with notes during a walkthrough.

## Edit Markdown diagrams

Click **Open in Diagram** above a `mermaid` or `echarts` code block, or use **Diagram: Open Diagram at Cursor** from the Command Palette or editor context menu. Set `diagram.codeLens.enabled` to `false` to hide the inline actions.

**Apply** renders your edits and writes them to the original block, preserving fences, indentation and surrounding text. Failed renders leave the file unchanged and keep your edits in the panel. Writes can be undone in VS Code. If the block changed or cannot be identified safely, reopen it.

If an agent replaces the diagram, **Write to** applies its version after confirmation. Switching between Mermaid and ECharts detaches it from the original block.

## Tools for agents

Any chat agent can use these tools; `@diagram` includes them by default. Attach a `#` reference to request a tool first. `/explain` allows only state and workspace reading tools.

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
| `diagram_updateChart` | `#diagramUpdate` | Change chart settings using loaded data, preserving supported styling. |

Workspace tools stay inside open workspace folders. If results are truncated, narrow the glob or read another line range.

For `diagram_updateChart`, omitted settings are kept; `null` clears optional settings. Pass the revision from `diagram_getState` to reject stale edits. Unsupported manual source changes block updates and keep the chart intact.

`diagram_inspectData` returns columns and up to 20 sample rows. Omit the source to inspect loaded data; an explicit source is read anew, including rerunning commands.

Annotate relationships using exact `edge:` or `message:` IDs from `diagram_getState`. IDs distinguish parallel edges and repeated messages; they survive rerendering but may change after source edits.

Both rendering tools accept `clickPrompt`, such as `"Explain {label} in more detail"`, to send a chat request immediately on click. For Mermaid, `diagram_render` also accepts code links, e.g. `{"parse": "src/parser.ts#L42", "check": "src/checker.ts#L10-L30"}`. Links take priority over `clickPrompt`; picking and Ctrl/Cmd/Shift+click take priority over both.

## Chart data

`diagram_chart` reads CSV, TSV, JSON, JSON Lines, Markdown tables and whitespace-separated output such as `du` or `wc -l`. It supports pie, doughnut, bar, line, area, scatter, histogram, treemap, sunburst, sankey, heatmap, radar, box plot, gauge and funnel charts, including horizontal bars and stacked bars/areas. ISO dates become a time axis.

| Setting | Behavior |
| --- | --- |
| `labelColumn`, `valueColumns` | Choose columns by name, or omit to infer them. Multiple label columns define hierarchy levels, Sankey stages or heatmap axes. |
| `aggregate` | Group matching labels by `sum`, `mean`, `count`, `min`, `max` or `median`. |
| `sort`, `limit` | Sort by the first value column, then keep the requested number of rows. |
| `filters` | Keep rows matching every predicate before other transformations. Example: `[{"column":"latency","op":"gte","value":100}]`. |
| `facetColumn` | Split a Cartesian chart or histogram into at most 12 panels. Filtering happens first; grouping, sorting and limits apply within each panel. |
| `facetColumns`, `facetScales` | Set 1–4 panels per row and `"shared"` (default) or `"independent"` axis scales. |
| `bins` | Histogram bin count, 1–200. Defaults to the square root of sample count, rounded up and capped at 50. Constant data uses one bin. |

Filters compare parsed cells. `eq`/`neq` compare exact values and types (`null` matches missing cells); `lt`/`lte`/`gt`/`gte` require numbers; `contains` matches case-sensitive text. Numeric values use input units, such as bytes for sizes. Use `[]` to clear filters.

Histograms use one numeric value column; omit `labelColumn`, `aggregate`, `sort` and `limit`. Bins include their lower bound; only the last includes its upper bound. Faceted histograms share bin boundaries even with independent scales. The facet column is excluded from automatic label/value inference.

## Data access and limits

VS Code asks before running a command, reading a data file outside the workspace, or opening a linked file outside it. Workspace exploration and data-file reads in an untrusted workspace also require confirmation, as does opening any linked file there. Commands require a trusted, nonvirtual workspace.

Relative paths resolve from the first workspace folder. Commands run there with `/bin/sh` (`cmd.exe` on Windows), or in your home directory if no folder is open.

- Files and command output: 10 MiB; command timeout: 60 seconds.
- Workspace code reads: 1 MiB per file, at most 500 lines per read. Text search scans at most 1,000 files and 16 MiB per call; results and line previews are bounded and report truncation.
- Tables: 1,000,000 cells, including headers and empty cells.
- Treemap, sunburst and sankey: 100 hierarchy levels per row.

Summarize larger datasets before charting them.

## Development

Use Node.js 26, matching CI.

```sh
npm ci
npm run watch        # rebuild on change
npm run compile      # type-check, lint and build
npm test             # integration tests in VS Code; use xvfb-run -a npm test on headless Linux
npm run vsix         # package a .vsix
```

Press <kbd>F5</kbd> to launch an Extension Development Host. To install a package, use **Extensions: Install from VSIX…**.

CI tests and packages every branch push and pull request. Download `diagram-<commit SHA>.vsix` from the commit's **CI** artifacts, retained for 90 days. Packages contain minified bundles without source maps or development files. A push with multiple commits builds its latest commit.
