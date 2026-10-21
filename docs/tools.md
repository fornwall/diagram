# Tools for agents

Any chat agent can use these tools. `@diagram` includes them when its model supports tool calls; attach a `#` reference to call that tool first. `/explain` permits only tools that read the diagram, workspace or guide.

| Tool | Reference | Purpose |
| --- | --- | --- |
| `diagram_render` | `#diagram` | Render Mermaid or an ECharts option as JSON or JavaScript. Reports syntax errors and layout problems, with fixes where available. |
| `diagram_edit` | `#diagramEdit` | Change the current diagram or chart with exact text replacements in its source, keeping the rest, its title, code links and click prompt. |
| `diagram_chart` | `#chart` | Chart inline data, a file or a command's output. Infers columns and dates, and reports how it read the data. |
| `diagram_getState` | `#diagramState` | Read full context, a summary without source, or an exact range of source lines, with the revision. Includes errors, selection, marks and relationship ids. |
| `diagram_getImage` | `#diagramImage` | View the drawing or selected items as an image to check layout. Requires a model that accepts images. |
| `diagram_exportHtml` | `#diagramExport` | Save the current diagram or chart as a named HTML file with embedded source/data and a CDN renderer. Viewing requires internet access. |
| `diagram_guide` | `#diagramGuide` | Read the `workflow` topic for tool selection and verification, or a diagram/chart topic for examples, syntax and layout tips. |
| `diagram_pickNodes` | `#diagramPick` | Ask a question and wait for the user to pick nodes, relationships or chart items. |
| `diagram_annotate` | `#diagramAnnotate` | Mark items and fade the rest, without redrawing. Omit marks to clear them. |
| `diagram_findFiles` | `#diagramFiles` | Find workspace files by glob, in all open folders. |
| `diagram_searchText` | `#diagramSearch` | Search workspace files for literal text; returns matching lines and their locations. |
| `diagram_readFile` | `#diagramRead` | Read a range of numbered lines from a workspace file, including unsaved edits. |
| `diagram_inspectData` | `#diagramData` | Inspect exact column names, inferred types and up to 20 sample rows; page through wide tables or later rows without charting them. |
| `diagram_updateChart` | `#diagramUpdate` | Change the current chart's settings using its loaded data, keeping supported styling. |
| `diagram_style` | `#diagramStyle` | Set Mermaid item colors through `style` and `linkStyle` lines. |

Workspace tools stay within open workspace folders. Find and search respect `files.exclude`, `search.exclude` and `search.useIgnoreFiles`, and always exclude `.git` and `node_modules`.

## An agent workflow

1. For a new diagram, choose Mermaid for structure or ECharts for quantitative data. Read an unfamiliar type's `diagram_guide` topic; `{"topic":"workflow"}` explains how to combine the tools. Ground code diagrams in files you have read.
2. For changes, use the current context if available. `diagram_getState` with `{"detail":"summary"}` reads selection, errors and metadata without repeating the source. To inspect a large source, use `{"detail":"source","startLine":1,"endLine":100}`; ranges include exact source lines and the revision. Continue at the next line reported by the tool.
3. Use `diagram_edit` for exact replacements, `diagram_style` for requested Mermaid colors, or `diagram_updateChart` for generated chart settings. Pass the revision you read, including when replacing the drawing with `diagram_render` or `diagram_chart`. If it conflicts, reread the relevant state and reapply the intended change to that version. Await each drawing change before the next.
4. For tables, inspect uncertain columns and units with `diagram_inspectData`, then render with `diagram_chart`. Changing settings with `diagram_updateChart` reuses the data; inspecting or charting an explicit source reads it again and may rerun its command.
5. Check the render result for errors and warnings. For a dense diagram or chart, inspect `diagram_getImage` if the model supports images; crop with `ids` when text is too small. Fix and check again before reporting success. Use marks to explain items or `diagram_pickNodes` when the user needs to choose them.
6. When asked to save HTML, call `diagram_exportHtml` with a destination such as `{"file":"docs/architecture.html","revision":7}`. It exports the current source and data without rerunning commands. Viewing the file needs internet access for the pinned Mermaid or ECharts renderer.

`diagram_getState` defaults to full context and reduces detail when the caller's token budget is too small. Explicit source reads default to 200 lines and allow at most 500 per call; they return whole lines and continuation instructions when shortened. Summary and source reads are separate: line bounds imply `"source"` and cannot be combined with `"summary"` or `"full"`.

## Tool behavior

`diagram_render` and `diagram_chart` accept `revision` to reject a stale replacement before checking links, loading files or running commands. They also preserve a newer drawing made while those operations run. The revision is an invocation guard and is not stored in a chart's settings.

`diagram_exportHtml` accepts a `.html` or `.htm` destination, absolute or relative to the first workspace folder; the parent folder must exist. It asks for confirmation before writing; existing files are preserved unless `"overwrite":true`, and unsaved editor changes are always preserved. Pass `revision` to reject an export of a diagram that has changed. Source, data and theme are embedded in the file; renderer JavaScript loads from a CDN. The panel's **Export** command continues to offer PNG, SVG and offline ECharts HTML.

`diagram_edit` applies replacements in order, for example `{"edits": [{"oldText": "A --> B", "newText": "A --> C --> B"}]}`. Each `oldText` must occur exactly once unless `"replaceAll": true`. If any replacement cannot be applied, none is made; the result quotes nearby source to help correct it. Render errors leave the edited source in the panel for repair. `links` merges code links (`null` removes one); `revision` rejects stale edits. For generated charts, styling survives **Refresh** and `diagram_updateChart`; edits to data or structure are refused. Writing to Markdown requires confirmation.

`diagram_updateChart` keeps omitted settings unless the new chart type cannot use them; `null` clears a nullable setting. Pass the revision from `diagram_getState` to reject stale updates. Incompatible manual source edits block the update.

`diagram_inspectData` without a source inspects the current chart's loaded data and reports its revision; restart paging if that revision changes. A given source is read anew, rerunning a command on each call. It returns up to 60 columns and 5 sample rows by default. `startColumn` and `startRow` are 1-based positions in the parsed table, excluding the header; `maxColumns` (1–60) and `sampleRows` (0–20) control the page size. Use returned `nextColumn` or `nextRow` to continue, for example `{"startColumn":61,"maxColumns":20,"sampleRows":0}` for more schema, or `{"startRow":21,"sampleRows":20}` for later data. Column names are exact identifiers for chart settings; long sample strings and parser notes may be shortened. The JSON report fits within 24,000 characters by returning fewer whole rows or columns. If a single column name cannot fit, the error identifies its index so you can shorten the header or skip to later columns.

`diagram_style` accepts CSS colors, e.g. `{"styles": [{"id": "pay", "fill": "green"}]}`. It supports flowchart nodes, subgraphs and edges, classes, noncomposite states and ER entities. Name an edge by its ends, e.g. `"A --> B"`; `stroke` colors its line and `text` its label. Opaque fills get contrasting black or white text unless overridden; translucent fills use theme text. Omitted colors stay, `null` removes one, and `"clear": true` removes the item's style. Changes appear in source and exports; writing to Markdown requires confirmation. The panel background follows the VS Code theme.

`diagram_getImage` returns a PNG in the panel's theme, without selection highlights or marks, reopening the panel if needed. Pass `ids` to crop around items. Images fit within 1568 pixels per side and 1.15 megapixels, targeting text about 16 pixels high. The result reports dimensions, scale, readability and panel zoom. `@diagram` omits this tool for models that do not accept images.

`diagram_annotate` and `diagram_getImage` accept edges and sequence messages by endpoint ids, e.g. `"A --> B"`. Unicode and Mermaid arrows work too; bidirectional and undirected edges accept either order. Add a label to distinguish parallel edges: `"A --> B: Yes"`, `"A -->|Yes| B"` or `"A -- Yes --> B"`. If several items match, `diagram_getImage` shows all of them; `diagram_annotate` instead lists exact ids to use. `diagram_getState` supplies these ids and disambiguates chart items with duplicate names. Relationship ids survive redraws but may change when the source changes.

Both rendering tools accept a `clickPrompt`, e.g. `"Explain {label} in more detail"`. Mermaid also accepts code links such as `{"parse": "src/parser.ts#L42"}`; missing workspace files are omitted. Links take priority over click prompts.
