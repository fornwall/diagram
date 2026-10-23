# Tools for agents

These tools are available to ordinary chat agents and the bundled **Diagram** agent in VS Code. Enable them under **Chat: Open Customizations → Tools** (or **Configure Tools** in Local chat), or attach a `#` reference. The agent manages conversation context and tool calls; diagram state and selections are read through the tools. Tool descriptions include the API names below; Copilot may expose the shorter reference names as callable tools.

Complete input schemas are declared in [`package.json`](../package.json) under `contributes.languageModelTools`.

| Tool                  | Reference          | Purpose                                                                                                                                   |
| --------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `diagram_render`      | `#diagram`         | Render Mermaid or an ECharts option as JSON or JavaScript. Reports syntax errors and layout problems, with fixes where available.         |
| `diagram_edit`        | `#diagramEdit`     | Change the current diagram or chart with exact text replacements in its source, keeping the rest, its title, code links and click prompt. |
| `diagram_chart`       | `#chart`           | Chart inline data, a file or a command's output. Infers columns and dates, and reports how it read the data.                              |
| `diagram_getState`    | `#diagramState`    | Read context, source ranges, source search or pages of item ids and labels, with the revision. Includes errors, selection and marks.      |
| `diagram_getImage`    | `#diagramImage`    | View the drawing or selected items as an image to check layout. Requires a model that accepts images.                                     |
| `diagram_exportHtml`  | `#diagramExport`   | Save the current diagram or chart as a named HTML file with embedded source/data and a CDN renderer. Viewing requires internet access.    |
| `diagram_guide`       | `#diagramGuide`    | Read the `workflow` topic for tool selection and verification, or a diagram/chart topic for examples, syntax and layout tips.             |
| `diagram_pickNodes`   | `#diagramPick`     | Ask a question and wait for the user to pick nodes, relationships or chart items.                                                         |
| `diagram_annotate`    | `#diagramAnnotate` | Mark items and fade the rest, without redrawing. Omit marks to clear them.                                                                |
| `diagram_findFiles`   | `#diagramFiles`    | Find workspace files by glob, in all open folders.                                                                                        |
| `diagram_searchText`  | `#diagramSearch`   | Search workspace files for literal text; returns matching lines and their locations.                                                      |
| `diagram_readFile`    | `#diagramRead`     | Read a range of numbered lines from a workspace file, including unsaved edits.                                                            |
| `diagram_inspectData` | `#diagramData`     | Inspect exact column names, inferred types and up to 20 sample rows; page through wide tables or later rows without charting them.        |
| `diagram_updateChart` | `#diagramUpdate`   | Change the current chart's settings using its loaded data, keeping supported styling.                                                     |
| `diagram_style`       | `#diagramStyle`    | Set Mermaid item colors through `style` and `linkStyle` lines.                                                                            |

Workspace tools stay within open workspace folders. Find and search respect `files.exclude`, `search.exclude` and `search.useIgnoreFiles`, and always exclude `.git` and `node_modules`.

## An agent workflow

1. For a new diagram, choose Mermaid for structure or ECharts for quantitative data. Read an unfamiliar type's `diagram_guide` topic; `{"topic":"workflow"}` explains how to combine the tools. Ground code diagrams in files you have read.
2. Before a follow-up, read the current state: the user may have edited the source or selection. `diagram_getState` with `{"detail":"summary"}` reads selection, errors and metadata without repeating the source. To inspect a large source, use `{"detail":"source","startLine":1,"endLine":100}`; ranges include exact source lines and the revision. Continue at the next line reported by the tool. To locate a label or setting, use `{"detail":"search","query":"label"}` and copy exact text from the returned blocks into edits.
3. Use `diagram_edit` for exact replacements, `diagram_style` for requested Mermaid colors, or `diagram_updateChart` for generated chart settings. Pass the revision you read, including when replacing the drawing with `diagram_render` or `diagram_chart`. If it conflicts, reread the relevant state and reapply the intended change to that version. Await each drawing change and reuse its returned revision for the next change in that turn.
4. For tables, inspect uncertain columns and units with `diagram_inspectData`, then render with `diagram_chart`. Changing settings with `diagram_updateChart` reuses the data; inspecting or charting an explicit source reads it again and may rerun its command.
5. Check the render result for errors and warnings. For a dense diagram or chart, inspect `diagram_getImage` if the model supports images; crop with `ids` when text is too small. Fix and check again before reporting success. Use marks to explain items or `diagram_pickNodes` when the user needs to choose them.
6. When asked to save HTML, call `diagram_exportHtml` with a destination such as `{"file":"docs/architecture.html","revision":7}`. It exports the current source and data without rerunning commands. Viewing the file needs internet access for the pinned Mermaid or ECharts renderer.

`diagram_getState` defaults to full context and reduces detail when the caller's token budget is too small. Explicit source reads default to 200 lines and allow at most 500 per call; they return whole lines and continuation instructions when shortened. Summary and source reads are separate: line bounds imply `"source"` and cannot be combined with `"summary"` or `"full"`.

Source search is literal and case-sensitive; a `query` alone implies `"detail":"search"`. It returns each matching line once with two lines of context on each side, even if the query occurs several times on that line. Use `contextLines` (0–10) to adjust the excerpt, `maxMatches` (1–50, default 20) for page size, and the reported `startMatch` to continue with the same query. The query must be 1–1,000 characters on one line. Search cannot be combined with source line bounds. Results preserve whole source lines and their original indentation and line endings. Check each page's revision and restart if it changes.

For example, find an axis setting without reading a large chart's data:

```json
{ "query": "\"yAxis\"", "contextLines": 4, "maxMatches": 2 }
```

## Tool behavior

### Render, edit and update

`diagram_render` and `diagram_chart` accept `revision` to reject a stale replacement before checking links, loading files or running commands. They also preserve a newer drawing made while those operations run. Pass `newDiagram: true` when the user asks for a separate drawing: it detaches the current Markdown block and inherited export location, even with the same title and language. Keep the revision guard. These options apply only to that call and are not stored in chart settings.

Both rendering tools accept a `clickPrompt`, e.g. `"Explain {label} in more detail"`. Mermaid also accepts code links such as `{"parse": "src/parser.ts#L42"}`; missing workspace files are omitted. Links take priority over click prompts.

`diagram_edit` applies replacements in order, for example `{"edits": [{"oldText": "A --> B", "newText": "A --> C --> B"}]}`. Each `oldText` must occur exactly once unless `"replaceAll": true`. If any replacement cannot be applied, none is made; the result quotes nearby source to help correct it. Render errors leave the edited source in the panel for repair. `links` merges code links (`null` removes one); `revision` rejects stale edits. For generated charts, styling survives **Refresh** and `diagram_updateChart`; edits to data or structure are refused. Writing to Markdown requires confirmation.

`diagram_updateChart` keeps omitted settings unless the new chart type cannot use them; `null` clears a nullable setting. Pass the revision from `diagram_getState` to reject stale updates. Incompatible manual source edits block the update.

`diagram_style` accepts CSS colors, e.g. `{"styles": [{"id": "pay", "fill": "green"}]}`. It supports flowchart nodes, subgraphs and edges, classes, noncomposite states and ER entities. Name an edge by its ends, e.g. `"A --> B"`; `stroke` colors its line and `text` its label. Opaque fills get contrasting black or white text unless overridden; translucent fills use theme text. Omitted colors stay, `null` removes one, and `"clear": true` removes the item's style. Changes appear in source and exports; writing to Markdown requires confirmation. The panel background follows the VS Code theme.

### Inspect chart data

`diagram_inspectData` without a source inspects the current chart's loaded data and reports its revision; restart paging if that revision changes. A given source is read anew, rerunning a command on each call.

| Parameter     | Default | Meaning                                                               |
| ------------- | ------- | --------------------------------------------------------------------- |
| `startColumn` | 1       | First column to return, counted from 1.                               |
| `maxColumns`  | 60      | Columns per page, from 1 to 60.                                       |
| `startRow`    | 1       | First sample row, counted from 1 after the header.                    |
| `sampleRows`  | 5       | Sample rows per page, from 0 to 20. Use 0 to inspect only the schema. |

Use returned `nextColumn` or `nextRow` to continue, for example `{"startColumn":61,"maxColumns":20,"sampleRows":0}` for more schema, or `{"startRow":21,"sampleRows":20}` for later data. Column names are exact identifiers for chart settings; long sample strings and parser notes may be shortened.

The JSON report fits within 24,000 characters and the caller's token budget by returning fewer whole rows or columns, keeping valid JSON and accurate continuation positions. If even one column cannot fit the caller's budget, the tool returns a short diagnostic without partial JSON. If a single column name cannot fit, the error identifies its index so you can shorten the header or skip to later columns.

### Images and annotations

Find exact ids with `diagram_getState`, for example `{"detail":"items","query":"Cache","maxItems":10}`. This reads the live drawing and returns JSON with `revision`, `totalItems`, `matchedItems`, `startItem`, `items` and, when more remain, `nextItem`. Each item has its exact `id` and `label`; Mermaid relationships also include endpoints and direction. Use these ids directly for marks and image crops, including chart names qualified by series or position.

The optional query matches literal, case-sensitive text in ids, labels and relationship endpoints. Omit it to list all items. Continue with `startItem` set to `nextItem`, keeping the query; restart if the revision changes. Pages default to 50 items, allow at most 100, and shrink to whole records for the result budget. Oversized individual records return a diagnostic without shortened ids. Item lookup reopens a closed panel without reloading chart data. Chart results can include items hidden by legend or zoom; those may need revealing before an image crop can show them. Item paging cannot be combined with source ranges or source-search paging.

`diagram_getImage` returns a PNG in the panel's theme, without selection highlights or marks, reopening the panel if needed. Pass `ids` to crop around items. Images fit within 1568 pixels per side and 1.15 megapixels, targeting text about 16 pixels high. The result reports dimensions, scale, readability and panel zoom. Use this tool with a model that accepts image results.

`diagram_annotate` and `diagram_getImage` accept edges and sequence messages by endpoint ids, e.g. `"A --> B"`. Unicode and Mermaid arrows work too; bidirectional and undirected edges accept either order. Add a label to distinguish parallel edges: `"A --> B: Yes"`, `"A -->|Yes| B"` or `"A -- Yes --> B"`. If several items match, `diagram_getImage` shows all of them; `diagram_annotate` instead lists exact ids to use. `diagram_getState` supplies these ids and disambiguates chart items with duplicate names. Relationship ids survive redraws but may change when the source changes.

`diagram_annotate` reopens a closed panel before resolving item names. If a drawing is still rendering or changes while reopening, it leaves the marks unchanged and asks the agent to retry against the current state.

### HTML export

`diagram_exportHtml` accepts a `.html` or `.htm` destination, absolute or relative to the first workspace folder; the parent folder must exist. It asks for confirmation before writing; existing files are preserved unless `"overwrite":true`, and unsaved editor changes are always preserved. Pass `revision` to reject an export of a diagram that has changed. Source, data and theme are embedded in the file; renderer JavaScript loads from a CDN. The panel's **Export** command offers PNG, SVG and the same HTML export for diagrams and charts.
