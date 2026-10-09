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
| Select | Click an item, such as a node, edge, sequence message or chart item; Ctrl/Cmd+click or Shift+click adds to the selection. If the item has a link, or the agent set a click prompt, a plain click opens the link or asks in chat instead. Clicking a treemap or sunburst item also zooms into it. |
| Keyboard | Tab to the drawing, move with the arrow keys (Home/End: first/last) and press Enter or Space to click; with Ctrl/Cmd or Shift, to add to the selection. Escape closes a menu of links and Chart Options. In charts, the arrow keys along the category axis follow a series and the others change series; pie slices go round, trees go to parent/child (←/→) and siblings (↑/↓), and scatter, graph and sankey items to the nearest one. Enter also expands or collapses a tree node and zooms in on or drills down into a treemap or sunburst node, as a click does; Backspace goes back up. H hides the focused series or pie slice, as a click on its legend entry does; Shift+H shows them all again. |
| Highlight a path | Select two nodes of a flowchart, swimlane, agent flow or state diagram in order (start, then destination), then **Highlight Path**. Selects a shortest path, including its edges. |
| Ask | **Send to chat** asks about your selection, addressed to the agent that drew the diagram. |
| Answer a pick | When an agent asks you to pick, click your answer (or several items, then **Done**). **Cancel** or Escape declines. |
| Edit | Show the source with the view buttons at the top right. **Apply** (Ctrl/Cmd+Enter) renders your edits; **Revert** discards them. Unapplied edits survive view changes and incoming diagrams. Errors show their line and column. |
| Find | Ctrl/Cmd+F finds text in the drawing and the source. |
| Resize | Drag the divider in split view, or focus it and use the arrow keys. Home/End set the limits; Enter or double-click resets it. |
| Chart Options | Use the gear in the editor title bar or **Diagram: Chart Options…** to change a chart made from data. Enter in a field applies the options. |
| Refresh | Reload file or command data, keeping styling made in the JSON source. Manual changes to the data, structure or JavaScript of the source must be reverted or reset first. |
| Export | Use the editor title bar, the drawing's context menu or **Diagram: Export…** to save PNG, SVG or, for charts, an interactive offline HTML page. |
| Drag an image | Drag the picture handle into another app for PNG; hold Shift as you start for SVG. A drawing too large for PNG drops as SVG. |
| Open links | Click an underlined node to open the file it links to, or the http, https or mailto URL of its Mermaid `click` directive, label link or sequence diagram actor `link`. An actor with several `links` offers a menu. VS Code asks before opening an untrusted website. |
| Zoom and pan | Mermaid: the zoom buttons (**100%** toggles between fit and actual size), Ctrl/Cmd with +, - and 0, Ctrl/Cmd+scroll, pinching on a trackpad and dragging. A new diagram fits the panel; a revision keeps the zoom. Charts fit the panel. |

Images keep the theme and drop links; Mermaid images also drop the selection and marks. A PNG has up to twice the drawing's resolution and records it, so documents show it at the drawing's size. Mermaid SVGs put their styles on each element, as apps such as Figma and Office need.

Chart Options uses the loaded data without rerunning commands. After VS Code restarts, press **Refresh** to load file or command data again; charts of inline data stay configurable. **Reset styling** removes manual presentation changes, reloading data if needed. To discard source edits that Chart Options cannot keep, check **Replace manual source edits** first.

**Highlight Path** follows arrows, treats plain lines and double arrows as bidirectional, skips invisible links, and breaks ties in source order.

Diagrams follow your VS Code theme. Agents can mark items with notes, for example to walk you through a diagram.

Charts leave out the toolbox's chart type switch, box zoom and brush, as laying the chart out again on a resize would undo them, and show its data view read-only.

## Edit Markdown diagrams

Click **Open in Diagram** above a `mermaid` or `echarts` code block, in any case, or a `::: mermaid` container as in Azure DevOps wikis, including blocks in block quotes and list items, or use **Diagram: Open Diagram at Cursor** from the Command Palette or the editor context menu. As in VS Code's Markdown preview, a code block is Mermaid if its language contains a word of the `markdown-mermaid.languages` setting, such as `mermaid`. Set `diagram.codeLens.enabled` to `false` to hide **Open in Diagram**.

**Apply** renders your edits and writes them to the block, keeping its fences, block quote markers, indentation and the surrounding text. The file is changed but not saved, and the change can be undone. A diagram that fails to render is not written; your edits stay in the panel. If the block changed or cannot be found safely, reopen it.

**Write to** writes the diagram shown, such as one an agent drew in its place, asking first if an agent replaced it. Switching between Mermaid and ECharts detaches the diagram from its block.

## Tools for agents

Any chat agent can use these tools; `@diagram` includes them by default, unless its model cannot call tools. Attach a `#` reference to have a tool called first. `/explain` allows only the state and workspace reading tools, and says which attached tools it leaves out.

| Tool | Reference | Purpose |
| --- | --- | --- |
| `diagram_render` | `#diagram` | Render Mermaid or an ECharts option as JSON or JavaScript, including callbacks, custom series and timelines. Reports render errors. |
| `diagram_chart` | `#chart` | Chart inline data, a file or a command's output. Infers columns and dates, and reports how it read the data. |
| `diagram_getState` | `#diagramState` | Read the source, revision, edits, render error, selection, marks and the ids of selectable relationships. |
| `diagram_getImage` | `#diagramImage` | Look at the drawing as an image, to check its layout, for a model that accepts images. |
| `diagram_pickNodes` | `#diagramPick` | Ask a question and wait for the user to pick nodes, relationships or chart items. |
| `diagram_annotate` | `#diagramAnnotate` | Mark items with notes, a caption and fading, without redrawing. Omit marks to clear them. |
| `diagram_findFiles` | `#diagramFiles` | Find workspace files by glob, in all open folders. |
| `diagram_searchText` | `#diagramSearch` | Search workspace files for literal text; returns matching lines and their locations. |
| `diagram_readFile` | `#diagramRead` | Read a range of numbered lines from a workspace file, including unsaved edits. |
| `diagram_inspectData` | `#diagramData` | Show a table's columns, inferred types and up to 20 sample rows without charting it. |
| `diagram_updateChart` | `#diagramUpdate` | Change the current chart's settings using its loaded data, keeping supported styling. |

Workspace tools stay inside the open workspace folders. Finding and searching leave out `.git`, `node_modules`, the files that `files.exclude` and `search.exclude` exclude and, as `search.useIgnoreFiles` sets, those that `.gitignore` files ignore.

`diagram_updateChart` keeps omitted settings; `null` clears one. With the revision that `diagram_getState` or the drawing tools report, it refuses to change a chart changed since; the panel reloading is no change. Manual source edits that it cannot keep block the update.

`diagram_inspectData` without a source inspects the current chart's loaded data. A given source is read anew, rerunning a command.

`diagram_getImage` gives a PNG of at most 1024 pixels a side: a chart as laid out for the panel, a Mermaid diagram in full. `@diagram` leaves it out for a model that says it does not accept images.

Relationships are marked by the `edge:` or `message:` ids that `diagram_getState` lists. They tell parallel edges and repeated messages apart, and stay the same when the diagram is redrawn, but may change when its source does. Chart items that share a name, such as "Yes" in several stages of a sankey, are marked by the ids it lists for them.

Both rendering tools take a `clickPrompt`, such as `"Explain {label} in more detail"`, which a click on an item sends to chat. For Mermaid, `diagram_render` also takes code links, such as `{"parse": "src/parser.ts#L42", "check": "src/checker.ts#L10-L30"}`, and leaves out links to missing workspace files. A link takes priority over the click prompt.

## Data access and security

VS Code asks before running a command, reading a data file outside the workspace (also each time **Refresh** reads it again), or opening a linked file outside it. In an untrusted workspace, it also asks before the workspace tools and data-file reads, and before opening any linked file.

Commands need a trusted, nonvirtual workspace. They run with `/bin/sh` (`cmd.exe` on Windows) in the first workspace folder, or in your home directory if no folder is open. Relative paths resolve from the first workspace folder.

ECharts options with JavaScript code, such as callbacks or custom series, render only in a trusted workspace; plain object literals render anywhere. As such code could act as you in the panel, once the panel has run it, **Send to chat** and click prompts only fill in the chat input, and writing to a Markdown block, rerunning a chart's command and opening a web link ask first. After you decline once, the panel refuses such requests until it is closed.

The panel loads images only from `data:` URLs, so a Mermaid image shape must embed its image.

## Chart data

`diagram_chart` reads:

- CSV (comma, semicolon or the delimiter of an Excel `sep=` line) and TSV
- JSON (nested objects become dotted columns such as `cpu.user`), JSON Lines and other streams of JSON values, as `jq` prints them
- Markdown tables, also within text, and tables drawn with pipes or box-drawing characters, such as `psql`, `mysql`, `sqlite3`, DuckDB and Polars output
- Whitespace-separated output such as `du`, `wc -l`, `ls -l`, `df`, `free`, `docker ps`, `kubectl`, `git diff --stat`, `go test -bench`, `top -b`, `cloc`, `tasklist`, PowerShell tables and pandas data frames

Terminal colors are ignored. When DuckDB, Polars or pandas shorten a result, only the rows and columns shown are read.

Abbreviations such as `1.5K` and `$1.2B` are thousands and billions, but in a column of sizes, such as `du -h` output or a column named `Size`, `1.5K` is 1536 bytes. Units such as `MiB` and `kB` always give bytes; bare units are powers of 1000 for commands run with `--si` or `df -H`. Durations such as `812ms` and `1h2m3s` become seconds, as do `45m` and `1:02:03` in a column named for durations, such as `Elapsed`. A unit in a header, as in `Size (KB)`, `Latency (ms)` or, in a column named for durations, `Elapsed (s)`, applies to the plain numbers below it. Charts show sizes and durations in the unit that suits the largest value.

It draws pie, doughnut, bar, horizontal bar, stacked bar, line, area, stacked area, scatter, histogram, treemap, sunburst, sankey, heatmap, radar, box plot, gauge and funnel charts. Bar, line, area and scatter charts put ISO dates and times (and `YYYY/MM/DD`, also with a time) of the first label column on a time axis.

| Setting | Behavior |
| --- | --- |
| `labelColumn`, `valueColumns` | Choose columns by name, or omit to infer them. Given a second label column, bar, line and area charts draw a series per label of it from one value column, as for rows such as `month,region,sales`. Several label columns are the levels of a treemap or sunburst, the stages of a sankey or the axes of a heatmap; a single label column of paths, such as `src/webview/main.ts`, gives them levels too. |
| `aggregate` | Combine rows with the same labels by `sum`, `mean`, `count`, `min`, `max` or `median`. Without it, repeated labels stay separate. |
| `sort`, `limit` | Sort by the first value column, or by the total of each stack or of each label of a series per label, then keep the first rows. Pie and doughnut charts sum the rest as "Other"; a series per label takes no `limit`. A time axis draws the rows in time order. |
| `filters` | Keep rows matching every predicate, before anything else. Example: `[{"column":"latency","op":"gte","value":100}]`. |
| `facetColumn` | Split a bar, line, area or scatter chart or a histogram into a panel per value, at most 12. Grouping, sorting and limits apply within each panel. |
| `facetColumns`, `facetScales` | Set 1–4 panels per row, more when the panels would take over 4 rows, and `"shared"` (default) or `"independent"` axis scales. |
| `bins` | Histogram bins of equal width, 1–200. By default, about √n bins, at most 50, of a round width: 1, 2 or 5 × 10ⁿ, and at least 1 for whole numbers. |

A sankey with two label columns joins nodes of the same name, as in a list of graph edges, unless that would make flows run in a circle. With more, each stage has nodes of its own. A column with more than 30 nodes keeps the 29 largest and sums the rest as "Other".

The axes of a heatmap, and the categories that facets share, list numbers, dates and weekdays in order, unless `sort` orders the rows. Other labels keep the order they first appear in.

A final total row that matches the sum of the rows above it is left out, as are parent rows of a hierarchy, such as the directory totals of `du -a`.

Filters compare parsed cells: cells that look like numbers are numbers. `eq` and `neq` compare value and type, and `null` matches empty cells. `lt`, `lte`, `gt` and `gte` take a number; `contains` matches text, case-sensitively. Compare sizes in bytes and durations in seconds. Use at most 50 filters; `[]` clears them.

Histograms count one numeric value column; omit `labelColumn`, `aggregate`, `sort` and `limit`. A bin includes its lower bound, and only the last bin its upper bound. Faceted histograms share bin boundaries, even with independent scales.

## Limits

- Files and command output: 10 MiB. Commands time out after 60 seconds.
- Tables: 1,000,000 cells, including headers and empty cells. Treemaps, sunbursts and sankeys: 100 levels.
- Charts that draw each item as a shape of its own: 1,000 slices, stages or shapes for pie, doughnut, funnel and radar charts, 10,000 boxes or nodes for box plots and sunbursts, and 100,000 cells for heatmaps.
- Bar, line and area charts: 50 series, by value column or by label of a second label column.
- Mermaid sources: 50,000 characters.
- Attachments to `@diagram`: 50,000 characters each, and less if the model's context requires it.
- Workspace tools: reads of files up to 16 MiB, 500 lines at a time. A search skips files over 1 MiB and scans at most 1,000 files and 16 MiB. Results are bounded and report truncation.
- A chart of a file or command with a very large option is not kept when VS Code restarts; press **Refresh** to draw it again.
- When VS Code restarts, a diagram that the panel did not finish drawing within 15 seconds is not drawn again, in case it hangs the panel; edit and apply it, or have it rendered again.

Summarize larger datasets before charting them.

## Development

Use Node.js 26, matching CI.

```sh
npm ci
npm run watch        # rebuild on change
npm run compile      # type-check, lint and build
npm test             # integration tests in VS Code; use xvfb-run -a npm test on headless Linux
npm run analyze      # production build, listing what each bundle contains and its size
npm run vsix         # package a .vsix
```

Press <kbd>F5</kbd> to launch an Extension Development Host. To install a package, use **Extensions: Install from VSIX…**.

CI tests and packages every push and pull request: download `diagram-<commit SHA>.vsix` from the **CI** run's artifacts within 90 days. Packages contain minified bundles, without source maps, and the licenses of the bundled packages in `dist/THIRD_PARTY_NOTICES.txt`.
