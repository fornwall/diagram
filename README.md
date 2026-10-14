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
- `@diagram turn this whiteboard photo into a flowchart`

Follow-ups change the current diagram. `/new` starts another, `/explain` discusses it without changing it, and `/show` reopens the panel. Render errors and warnings go back to the model for repair.

Attach or paste PNG, JPEG, GIF or WebP images up to 3 MiB when using a model that accepts images. Images are sent only with the request they are attached to.

## Use the panel

| Action | How |
| --- | --- |
| Select | Click a node, edge, sequence message or chart item. Ctrl/Cmd+click or Shift+click toggles it in the selection. A plain click follows an item's link or click prompt, if set, and zooms into treemap and sunburst items. |
| Keyboard | Tab to the drawing; arrows move, Home/End move to first/last, and Enter/Space clicks. Ctrl/Cmd or Shift toggles selection. H hides the focused series or pie slice; Shift+H restores all. Escape closes menus, Chart Options and the data view. |
| Highlight a path | Select a start and destination, then **Highlight Path** in a flowchart, swimlane, agent flow or state diagram. It selects a shortest path, follows arrows, traverses plain lines and double arrows both ways, skips invisible links and breaks ties by source order. |
| Ask | Type a question or change and press **Send to chat**. The request includes your selection and goes to `@diagram`, or to chat without a mention if another agent drew the diagram. |
| Answer a pick | When an agent asks you to pick, click your answer (or several items, then **Done**). **Cancel** or Escape declines. |
| Edit | Show source with the view buttons. **Apply** (Ctrl/Cmd+Enter) renders edits; **Revert** discards them. Drafts survive view changes and incoming diagrams. Errors link to their source location. Inferred titles follow your edits. Agents are told what you applied since they drew the diagram, to keep it. |
| Find | Ctrl/Cmd+F finds text in the drawing and the source. |
| Resize | Drag the divider in split view, or focus it and use the arrow keys. Home/End set the limits; Enter or double-click resets it. |
| Chart Options | Use the title bar gear or **Diagram: Chart Options…** to configure a chart made from data. Enter applies. |
| Refresh | Reload file or command data, keeping JSON styling. Revert or reset manual changes to data, structure or JavaScript first. |
| Export | Use the editor title bar, drawing's context menu or **Diagram: Export…** to save PNG, SVG or an offline interactive HTML chart. Exports default to the Markdown file's folder when writable, or the subfolder you last exported to. |
| Drag an image | Drag the picture handle into another app for PNG; hold Shift as you start for SVG. A drawing too large for PNG drops as SVG. |
| Open links | Click an underlined node to open its linked file or http, https or mailto URL. Sequence actors with several links offer a menu. VS Code asks before opening an untrusted website. |
| Zoom and pan | For Mermaid, use the zoom buttons, Ctrl/Cmd with +, - or 0, Ctrl/Cmd+scroll, trackpad pinching or dragging. The percentage toggles fit/actual size. New diagrams fit the panel; revisions keep your zoom. Charts resize to fit. |

Images keep the theme and omit links. Mermaid images also omit selection and marks. PNGs use up to twice the drawing's resolution, with size metadata for documents. Mermaid SVGs use inline styles for apps such as Figma and Office.

Chart Options reuses loaded data. After a restart, press **Refresh** to reload file or command data; inline data stays available. **Reset styling** removes manual styling and reloads data if needed. **Replace manual source edits with the generated chart** discards incompatible edits.

In charts, arrows follow categories and series. Trees use ←/→ for parent/child and ↑/↓ for siblings; scatter, graph and sankey charts move to the nearest item. Enter expands tree nodes or zooms into treemaps and sunbursts; Backspace goes up a treemap or sunburst.

Diagrams follow your VS Code theme. Agents can mark items with notes, for example to walk you through a diagram.

Charts have a read-only data view. Toolbox chart-type switching, box zoom and brush are disabled because resizing would undo them. Short panels hide the visual map, zoom slider, subtitle and title as needed; wheel zoom and dragging remain available.

## Edit Markdown diagrams

Click **Open in Diagram** above a `mermaid` or `echarts` block, or run **Diagram: Open Diagram at Cursor**. Language names are case-insensitive; Azure DevOps `::: mermaid` containers, block quotes and list items are supported. Mermaid language aliases follow `markdown-mermaid.languages`. Set `diagram.codeLens.enabled` to `false` to hide the links above blocks.

**Apply** renders edits and updates the block, preserving fences, indentation, quote markers and surrounding text, also after the file is renamed in VS Code. Changes are undoable and remain unsaved. If rendering fails or the block has changed, the file stays untouched. Copy your edits from the warning or reopen the block.

**Write to** writes the displayed diagram to its Markdown block. Agent changes require confirmation before either action writes them. `/new` and switching between Mermaid and ECharts detach the panel from the block. Read-only files, including Git revisions, can be viewed and edited in the panel without writing back.

## Tools for agents

Any chat agent can use these tools; `@diagram` includes them by default, unless its model cannot call tools. Attach a `#` reference to have `@diagram` call that tool first. `/explain` allows only the tools that read the diagram's state and image, the workspace and the guide, and says which attached tools it leaves out.

| Tool | Reference | Purpose |
| --- | --- | --- |
| `diagram_render` | `#diagram` | Render Mermaid or an ECharts option as JSON or JavaScript, including callbacks, custom series and timelines. Reports render errors. |
| `diagram_edit` | `#diagramEdit` | Change the current diagram or chart with exact text replacements in its source, keeping the rest, its title, code links and click prompt. |
| `diagram_chart` | `#chart` | Chart inline data, a file or a command's output. Infers columns and dates, and reports how it read the data. |
| `diagram_getState` | `#diagramState` | Read the source, revision, edits, render error, selection, marks and the ids of selectable relationships. |
| `diagram_getImage` | `#diagramImage` | Look at the drawing as an image, to check its layout, for a model that accepts images. |
| `diagram_guide` | `#diagramGuide` | Look up a Mermaid diagram type or ECharts chart kind: an example that renders, the syntax rules models get wrong and layout tips. |
| `diagram_pickNodes` | `#diagramPick` | Ask a question and wait for the user to pick nodes, relationships or chart items. |
| `diagram_annotate` | `#diagramAnnotate` | Mark items with notes, a caption and fading, without redrawing. Omit marks to clear them. |
| `diagram_findFiles` | `#diagramFiles` | Find workspace files by glob, in all open folders. |
| `diagram_searchText` | `#diagramSearch` | Search workspace files for literal text; returns matching lines and their locations. |
| `diagram_readFile` | `#diagramRead` | Read a range of numbered lines from a workspace file, including unsaved edits. |
| `diagram_inspectData` | `#diagramData` | Show a table's columns, inferred types and up to 20 sample rows without charting it. |
| `diagram_updateChart` | `#diagramUpdate` | Change the current chart's settings using its loaded data, keeping supported styling. |
| `diagram_style` | `#diagramStyle` | Set the fill, border and text colors of the nodes, subgraphs, classes, states and ER entities of a Mermaid diagram by editing their `style` lines. |

Workspace tools stay within open workspace folders. Find and search respect `files.exclude`, `search.exclude` and `search.useIgnoreFiles`, and always exclude `.git` and `node_modules`.

`diagram_edit` takes replacements such as `{"edits": [{"oldText": "A --> B", "newText": "A --> C --> B"}]}`, made in order. Each `oldText` must occur exactly once, unless `"replaceAll": true`; if any edit does not apply, none is made, and the result quotes the closest lines of the source. The result names the nodes added and removed, or the render error with the lines around it; an edit that fails to render stays shown, for the next edit to fix, as a failed `diagram_render` does. `links` adds or changes code links (`null` removes one) and keeps the others. Pass `revision` to reject stale edits. On a chart from `diagram_chart`, styling edits survive **Refresh** and `diagram_updateChart`, and changes to its data or structure are refused. Writing an edit to Markdown requires confirmation.

`diagram_updateChart` keeps omitted settings unless the new chart type cannot use them; `null` clears a setting. Pass the revision from `diagram_getState` to reject stale updates. Incompatible manual source edits block the update.

`diagram_inspectData` without a source inspects the current chart's loaded data. A given source is read anew, rerunning a command.

`diagram_style` accepts CSS colors, e.g. `{"styles": [{"id": "pay", "fill": "green"}]}`, for flowchart nodes and subgraphs, classes, noncomposite states and ER entities. Opaque fills get contrasting black or white text unless you specify `text`; translucent fills use theme text. Omitted colors stay, `null` removes one, and `"clear": true` removes the item's style. Changes appear in source and exports; writing them to Markdown requires confirmation. The panel background follows the VS Code theme.

`diagram_getImage` gives a PNG of at most 1024 pixels a side: a chart as laid out for the panel, a Mermaid diagram in full. `@diagram` leaves it out for a model that says it does not accept images.

Use the `edge:` and `message:` ids from `diagram_getState` to distinguish parallel edges and repeated messages. These ids survive redraws but may change with the source. The tool also supplies ids for chart items with duplicate names.

Both rendering tools accept a `clickPrompt`, e.g. `"Explain {label} in more detail"`. Mermaid also accepts code links such as `{"parse": "src/parser.ts#L42"}`; missing workspace files are omitted. Links take priority over click prompts.

## Data access and security

VS Code asks before running a command, reading a data file outside the workspace (including on **Refresh**), or opening an external file link. In an untrusted workspace, workspace reads and all file links also require confirmation.

Commands need a trusted, nonvirtual workspace. They run with `/bin/sh` (`cmd.exe` on Windows) in the first workspace folder, or in your home directory if no folder is open. Relative paths resolve from the first workspace folder.

ECharts callbacks and other JavaScript require a trusted workspace; plain object literals work anywhere. Once a panel runs JavaScript, **Send to chat** and click prompts fill the chat input without submitting it. Writing to Markdown, rerunning a command and opening a web link require confirmation. Declining blocks such requests until the panel closes.

The panel loads images only from `data:` URLs, so a Mermaid image shape must embed its image.

## Chart data

`diagram_chart` reads:

- CSV (comma, semicolon or the delimiter of an Excel `sep=` line) and TSV
- JSON (nested objects become dotted columns such as `cpu.user`), JSON Lines and other streams of JSON values, as `jq` prints them
- Markdown tables, also within text, and tables drawn with pipes or box-drawing characters, such as `psql`, `mysql`, `sqlite3`, DuckDB, Polars and `git diff --stat` output
- Whitespace-separated output such as `du`, `wc -l`, `ls -l`, `df`, `free`, `docker ps`, `kubectl`, `go test -bench`, `top -b`, `cloc`, `tasklist`, PowerShell tables and pandas data frames

Terminal colors are ignored. In auto format, shortened DuckDB, Polars or pandas results include only the rows and columns shown. Use `format: "csv"` or `"tsv"` to keep literal ellipsis rows and columns. Quoted multiline fields keep their contents.

Abbreviations such as `1.5K` and `$1.2B` mean thousands and billions. In size columns, such as `du -h` output or a column named `Size`, `1.5K` means 1536 bytes. Units such as `MiB` and `kB` always mean bytes; bare units use powers of 1000 for commands run with `--si` or `df -H`.

Durations such as `812ms`, `-250ms` and `1h2m3s` become seconds. In duration columns such as `Elapsed`, so do `45m` and `1:02:03`. Header units such as `Size (KB)`, `Latency (ms)` or `Elapsed (s)` apply to plain numbers below them. Charts display sizes and durations in the unit that suits the largest value.

It draws pie, doughnut, bar, horizontal bar, stacked bar, line, area, stacked area, scatter, histogram, treemap, sunburst, sankey, heatmap, radar, box plot, gauge and funnel charts. Bar, line, area and scatter charts put ISO dates and times (and `YYYY/MM/DD`, also with a time) of the first label column on a time axis.

| Setting | Behavior |
| --- | --- |
| `labelColumn`, `valueColumns` | Choose columns by name, or omit to infer them. Given a second label column, bar, line and area charts draw a series per label of it from one value column, as for rows such as `month,region,sales`. Several label columns are the levels of a treemap or sunburst, the stages of a sankey or the axes of a heatmap; a single label column of paths, such as `src/webview/main.ts`, gives a treemap, sunburst or sankey levels too. |
| `aggregate` | Combine rows with the same labels by `sum`, `mean`, `count`, `min`, `max` or `median`. Without it, repeated labels stay separate, except that a series per label, a heatmap, a treemap, a sunburst and a sankey add up their rows. |
| `sort`, `limit` | Sort by the first value column, or by the total of each stack or of each label of a series per label, then keep the first rows. Pie and doughnut charts sum the rest as "Other"; a series per label takes no `limit`. A time axis draws the rows in time order. |
| `filters` | Keep rows matching every predicate, before anything else. Example: `[{"column":"latency","op":"gte","value":100}]`. |
| `facetColumn` | Split a bar, line, area or scatter chart or a histogram into a panel per value, at most 12. Grouping, sorting and limits apply within each panel. |
| `facetColumns`, `facetScales` | Set 1–4 panels per row, more when the panels would take over 4 rows or be too short to read at the height of the view, and `"shared"` (default) or `"independent"` axis scales. A view too short for the panels scrolls them. |
| `bins` | Histogram bins of equal width, 1–200. By default, about √n bins, at most 50, of a round width: 1, 2 or 5 × 10ⁿ, and at least 1 for whole numbers. |

With two label columns, a sankey joins same-named nodes unless that creates a cycle. With more columns, each stage has separate nodes. Stages with over 30 nodes combine all but the largest 29 as "Other".

Heatmap axes and shared facet categories sort numbers, dates and weekdays naturally, unless `sort` orders rows by value. Other labels keep their input order. Facet panels follow the same ordering, with missing values last.

A final row labeled `Total` or `Sum` that matches the sum of the rows above it is left out, as are parent rows of a treemap, sunburst or sankey, such as the directory totals of `du -a`.

Filters compare parsed cells: numeric-looking cells become numbers. `eq`/`neq` compare value and type; `null` matches missing cells. Numeric comparisons take numbers; `contains` is case-sensitive. Use bytes for sizes and seconds for durations. At most 50 filters are allowed; `[]` clears them.

Histograms count one numeric value column; omit `labelColumn`, `aggregate`, `sort` and `limit`. A bin includes its lower bound, and only the last bin its upper bound. Faceted histograms share bin boundaries, even with independent scales.

## Limits

- Files and command output: 10 MiB. Commands time out after 60 seconds.
- Tables: 1,000,000 cells, including headers and empty cells. Treemaps, sunbursts and sankeys: 100 levels.
- Pie, doughnut, funnel and radar charts: 1,000 items. Box plots and sunbursts: 10,000. Heatmaps: 100,000 cells.
- Bar, line and area charts: 50 series.
- Mermaid sources: 50,000 characters.
- Attachments to `@diagram`: 50,000 characters each, and less if the model's context requires it.
- Tool use by `@diagram`: 15 rounds of calls and 45 calls per request. Near the limit, the model is told to draw with what it has.
- Workspace tools: reads of files up to 16 MiB, 500 lines at a time. A search skips files over 1 MiB and scans at most 1,000 files and 16 MiB. Results are capped at 40,000 characters and say what they leave out.
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
