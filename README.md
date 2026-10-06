# @diagram

Interactive [Mermaid](https://mermaid.js.org/) diagrams and [Apache ECharts](https://echarts.apache.org/) charts beside VS Code chat. Select items, edit source and ask follow-up questions from the panel.

Requires VS Code 1.140 or later. Chat features need a chat provider, such as GitHub Copilot. Diagrams in Markdown files open and edit without chat.

## Get started

Ask `@diagram` to draw, optionally attaching files with `#file`:

- `@diagram sequence diagram of the OAuth login flow in #file:src/panel.ts`
- `@diagram add a retry path after the payment step`
- `@diagram bar chart of commits per author from git shortlog -sn HEAD`
- `@diagram treemap of du -ah src`
- `@diagram histogram of request latency in #file:requests.csv, one panel per service`
- `@diagram turn this whiteboard photo into a flowchart`, with an attached or pasted image (PNG, JPEG, GIF or WebP files, up to 3 MiB) for a model that accepts images. An image goes only with the request it is attached to.

Follow-ups change the current diagram. `/new` starts another, `/explain` discusses it without changing it, and `/show` reopens the panel. If a diagram fails to render, `@diagram` has the model fix it, up to two times.

## Use the panel

| Action | How |
| --- | --- |
| Select | Click a node, edge, sequence message or chart item; Ctrl/Cmd+click or Shift+click adds to the selection. If the item has a link, or the agent set a click prompt, a plain click opens the link or asks in chat instead. Clicking a treemap or sunburst item also zooms into it. |
| Keyboard | Tab to the drawing, move with the arrow keys (Home/End: first/last) and press Enter or Space to click. In charts, the arrow keys along the category axis follow a series and the others change series; pie slices go round, trees go to parent/child (←/→) and siblings (↑/↓), and scatter, graph and sankey items to the nearest one. |
| Highlight a path | Select two flowchart nodes in order (start, then destination), then **Highlight Path**. Selects a shortest path, including its edges. |
| Ask | **Send to chat** asks about your selection, addressed to the agent that drew the diagram. |
| Answer a pick | When an agent asks you to pick, click your answer (or several items, then **Done**). **Cancel** or Escape declines. |
| Edit | Show the source with the view buttons at the top right. **Apply** (Ctrl/Cmd+Enter) renders your edits; **Revert** discards them. Unapplied edits survive view changes and incoming diagrams. Errors show their line and column. |
| Resize | Drag the divider in split view, or focus it and use the arrow keys. Home/End set the limits; Enter or double-click resets it. |
| Chart Options | Use the gear in the editor title bar or **Diagram: Chart Options…** to change a chart made from data. |
| Refresh | Reload file or command data, keeping styling made in the JSON source. Manual changes to the data, structure or JavaScript of the source must be reverted or reset first. |
| Export | Use the editor title bar, the drawing's context menu or **Diagram: Export…** to save PNG, SVG or, for charts, an interactive offline HTML page. |
| Drag an image | Drag the picture handle into another app for PNG; hold Shift as you start for SVG. Images keep the theme and drop links; Mermaid images also drop the selection and marks. |
| Open links | Click an underlined node to open the file it links to, or the http, https or mailto URL of its Mermaid `click` directive, label link or sequence diagram actor `link`. An actor with several `links` offers a menu. VS Code asks before opening an untrusted website. |
| Zoom and pan | Mermaid: the zoom buttons (**100%** toggles between fit and actual size), Ctrl/Cmd with +, - and 0, Ctrl/Cmd+scroll and dragging. A new diagram fits the panel; a revision keeps the zoom. Charts fit the panel. |

Chart Options uses the loaded data without rerunning commands. After VS Code restarts, press **Refresh** to load file or command data again; charts of inline data stay configurable. **Reset styling** removes manual presentation changes, reloading data if needed. To discard source edits that Chart Options cannot keep, check **Replace manual source edits** first.

**Highlight Path** follows arrows, treats plain lines and double arrows as bidirectional, skips invisible links, and breaks ties in source order.

Diagrams follow your VS Code theme. Agents can mark items with notes, for example to walk you through a diagram.

## Edit Markdown diagrams

Click **Open in Diagram** above a `mermaid` or `echarts` code block, including blocks in block quotes and list items, or use **Diagram: Open Diagram at Cursor** from the Command Palette or the editor context menu. Set `diagram.codeLens.enabled` to `false` to hide **Open in Diagram**.

**Apply** renders your edits and writes them to the block, keeping its fences, block quote markers, indentation and the surrounding text. The file is changed but not saved, and the change can be undone. A diagram that fails to render is not written; your edits stay in the panel. If the block changed or cannot be found safely, reopen it.

**Write to** writes the diagram shown, such as one an agent drew in its place, asking first if an agent replaced it. Switching between Mermaid and ECharts detaches the diagram from its block.

## Tools for agents

Any chat agent can use these tools; `@diagram` includes them by default. Attach a `#` reference to have a tool called first. `/explain` allows only the state and workspace reading tools.

| Tool | Reference | Purpose |
| --- | --- | --- |
| `diagram_render` | `#diagram` | Render Mermaid or an ECharts option as JSON or JavaScript, including callbacks and custom series. Reports render errors. |
| `diagram_chart` | `#chart` | Chart inline data, a file or a command's output. Infers columns and dates, and reports how it read the data. |
| `diagram_getState` | `#diagramState` | Read the source, revision, edits, render error, selection, marks and the ids of selectable relationships. |
| `diagram_pickNodes` | `#diagramPick` | Ask a question and wait for the user to pick nodes, relationships or chart items. |
| `diagram_annotate` | `#diagramAnnotate` | Mark items with notes, a caption and fading, without redrawing. Omit marks to clear them. |
| `diagram_findFiles` | `#diagramFiles` | Find workspace files by glob, in all open folders. |
| `diagram_searchText` | `#diagramSearch` | Search workspace files for literal text; returns matching lines and their locations. |
| `diagram_readFile` | `#diagramRead` | Read a range of numbered lines from a workspace file, including unsaved edits. |
| `diagram_inspectData` | `#diagramData` | Show a table's columns, inferred types and up to 20 sample rows without charting it. |
| `diagram_updateChart` | `#diagramUpdate` | Change the current chart's settings using its loaded data, keeping supported styling. |

Workspace tools stay inside the open workspace folders.

`diagram_updateChart` keeps omitted settings; `null` clears one. With the revision from `diagram_getState`, it refuses to change a chart redrawn since. Manual source edits that it cannot keep block the update and leave the chart as it is.

`diagram_inspectData` without a source inspects the current chart's loaded data. A given source is read anew, rerunning a command.

Relationships are marked by the `edge:` or `message:` ids that `diagram_getState` lists. They tell parallel edges and repeated messages apart, and stay the same when the diagram is redrawn, but may change when its source does. Chart items that share a name, such as "Yes" in several stages of a sankey, are marked by the ids it lists for them.

Both rendering tools take a `clickPrompt`, such as `"Explain {label} in more detail"`, which a click on an item sends to chat. For Mermaid, `diagram_render` also takes code links, such as `{"parse": "src/parser.ts#L42", "check": "src/checker.ts#L10-L30"}`. A link takes priority over the click prompt.

## Data access and security

VS Code asks before running a command, reading a data file outside the workspace, or opening a linked file outside it. In an untrusted workspace, it also asks before the workspace tools and data-file reads, and before opening any linked file.

Commands need a trusted, nonvirtual workspace. They run with `/bin/sh` (`cmd.exe` on Windows) in the first workspace folder, or in your home directory if no folder is open. Relative paths resolve from the first workspace folder.

ECharts options with JavaScript code, such as callbacks or custom series, render only in a trusted workspace; plain object literals render anywhere. As such code could act as you in the panel, once the panel has run it, **Send to chat** and click prompts only fill in the chat input, and writing to a Markdown block, rerunning a chart's command and opening a web link ask first. After you decline once, the panel refuses such requests until it is closed.

## Chart data

`diagram_chart` reads:

- CSV (comma or semicolon) and TSV
- JSON (nested objects become dotted columns such as `cpu.user`) and JSON Lines
- Markdown tables, also within text, and other pipe tables such as `psql`, `mysql` and `sqlite3` output
- Whitespace-separated output such as `du`, `wc -l`, `ls -l`, `df`, `free`, `docker ps`, `kubectl top` and `git diff --stat`

Sizes such as `1.5K` or `2 MiB` become bytes, in powers of 1000 for commands run with `--si` or `df -H`.

It draws pie, doughnut, bar, horizontal bar, stacked bar, line, area, stacked area, scatter, histogram, treemap, sunburst, sankey, heatmap, radar, box plot, gauge and funnel charts. Bar, line, area and scatter charts put ISO dates (and `YYYY/MM/DD`) in a single label column on a time axis.

| Setting | Behavior |
| --- | --- |
| `labelColumn`, `valueColumns` | Choose columns by name, or omit to infer them. Several label columns are the levels of a treemap or sunburst, the stages of a sankey or the axes of a heatmap. A single label column of paths, such as `src/webview/main.ts`, gives them levels too. |
| `aggregate` | Combine rows with the same labels by `sum`, `mean`, `count`, `min`, `max` or `median`. Without it, repeated labels stay separate. |
| `sort`, `limit` | Sort by the first value column, then keep the first rows. Pie and doughnut charts sum the rest as "Other". |
| `filters` | Keep rows matching every predicate, before anything else. Example: `[{"column":"latency","op":"gte","value":100}]`. |
| `facetColumn` | Split a bar, line, area or scatter chart or a histogram into a panel per value, at most 12. Grouping, sorting and limits apply within each panel. |
| `facetColumns`, `facetScales` | Set 1–4 panels per row, and `"shared"` (default) or `"independent"` axis scales. |
| `bins` | Histogram bins, 1–200. Defaults to the square root of the number of values, rounded up, at most 50. |

A sankey with two label columns joins nodes of the same name, as in a list of graph edges, unless that would make flows run in a circle. With more, each stage has nodes of its own. A column with more than 30 nodes keeps the 29 largest and sums the rest as "Other".

A final total row that matches the sum of the rows above it is left out, as are parent rows of a hierarchy, such as the directory totals of `du -a`.

Filters compare parsed cells: cells that look like numbers are numbers. `eq` and `neq` compare value and type, and `null` matches empty cells. `lt`, `lte`, `gt` and `gte` take a number; `contains` matches text, case-sensitively. Compare in the input's units, such as bytes for sizes. Use at most 50 filters; `[]` clears them.

Histograms count one numeric value column; omit `labelColumn`, `aggregate`, `sort` and `limit`. A bin includes its lower bound, and only the last bin its upper bound. Faceted histograms share bin boundaries, even with independent scales.

## Limits

- Files and command output: 10 MiB. Commands time out after 60 seconds.
- Tables: 1,000,000 cells, including headers and empty cells. Treemaps, sunbursts and sankeys: 100 levels.
- Mermaid sources: 50,000 characters.
- Attachments to `@diagram`: 50,000 characters each, and less if the model's context requires it.
- Workspace tools: 1 MiB per file and 500 lines per read. A search scans at most 1,000 files and 16 MiB. Results are bounded and report truncation.
- A chart of a file or command with a very large option is not kept when VS Code restarts; press **Refresh** to draw it again.

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

CI tests and packages every branch push and pull request, building the latest commit of a push. Download `diagram-<commit SHA>.vsix` from the commit's **CI** artifacts, kept for 90 days. Packages contain minified bundles, without source maps, and the licenses of the bundled packages.
