# Tools for agents

These tools are available to ordinary chat agents and the bundled **Diagram** agent in VS Code. Enable them under **Chat: Open Customizations → Tools** (or **Configure Tools** in Local chat), or attach a `#` reference. The agent manages conversation context and tool calls; diagram state and selections are read through the tools. Tool descriptions include the API names below; Copilot may expose the shorter reference names as callable tools.

Complete input schemas are declared in [`package.json`](../package.json) under `contributes.languageModelTools`.

| Tool                    | Reference            | Purpose                                                                                                                                   |
| ----------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `diagram_render`        | `#diagram`           | Render Mermaid or an ECharts option as JSON or JavaScript. Reports syntax errors and layout problems, with fixes where available.         |
| `diagram_edit`          | `#diagramEdit`       | Change the current diagram or chart with exact text replacements in its source, keeping the rest, its title, code links and click prompt. |
| `diagram_chart`         | `#chart`             | Chart inline data, a file, command output or an inspected dataset. Infers columns and dates, and reports how it read the data.            |
| `diagram_getState`      | `#diagramState`      | Read context, source ranges, source search or pages of item ids and labels, with the revision. Includes errors, selection and marks.      |
| `diagram_getImage`      | `#diagramImage`      | View the drawing or selected items as an image to check layout. Requires a model that accepts images.                                     |
| `diagram_exportHtml`    | `#diagramExport`     | Save the current diagram or chart as a named HTML file with embedded source/data and a CDN renderer. Viewing requires internet access.    |
| `diagram_guide`         | `#diagramGuide`      | Read the `workflow` topic for tool selection and verification, or a diagram/chart topic for examples, syntax and layout tips.             |
| `diagram_pickNodes`     | `#diagramPick`       | Ask a question and wait for the user to pick nodes, relationships or chart items.                                                         |
| `diagram_annotate`      | `#diagramAnnotate`   | Mark items and fade the rest, without redrawing. Omit marks to clear them.                                                                |
| `diagram_findFiles`     | `#diagramFiles`      | Find workspace files by glob, in all open folders.                                                                                        |
| `diagram_searchText`    | `#diagramSearch`     | Search workspace files for literal text; returns matching lines and their locations.                                                      |
| `diagram_readFile`      | `#diagramRead`       | Read a range of numbered lines from a workspace file, including unsaved edits.                                                            |
| `diagram_inspectData`   | `#diagramData`       | Inspect exact column names, inferred types and up to 20 sample rows; page through wide tables or later rows without charting them.        |
| `diagram_updateChart`   | `#diagramUpdate`     | Change the current chart's settings using its loaded data, keeping supported styling.                                                     |
| `diagram_style`         | `#diagramStyle`      | Set Mermaid item colors through `style` and `linkStyle` lines.                                                                            |
| `diagram_queryGraph`    | `#diagramGraph`      | Query dependencies, paths, directed cycles or components; optionally focus the results.                                                   |
| `diagram_editStructure` | `#diagramStructure`  | Add, remove, rename, insert, reconnect or move flowchart items, individually or in batches.                                               |
| `diagram_checkpoint`    | `#diagramCheckpoint` | Save, list, compare, restore or delete named alternatives.                                                                                |
| `diagram_draft`         | `#diagramDraft`      | Check source, edits, structural operations or chart settings before applying them.                                                        |
| `diagram_evidence`      | `#diagramEvidence`   | Attach source ranges and assumptions to items, and inspect file freshness.                                                                |

Workspace tools stay within open workspace folders. Find and search respect `files.exclude`, `search.exclude` and `search.useIgnoreFiles`, and always exclude `.git` and `node_modules`.

## An agent workflow

1. For a new diagram, choose Mermaid for structure or ECharts for quantitative data. Read an unfamiliar type's `diagram_guide` topic; `{"topic":"workflow"}` explains how to combine the tools. Ground code diagrams in files you have read.
2. Before a follow-up, read the current state: the user may have edited the source or selection. `diagram_getState` with `{"detail":"summary"}` reads selection, errors and metadata without repeating the source. To inspect a large source, use `{"detail":"source","startLine":1,"endLine":100}`; ranges include exact source lines and the revision. Continue at the next line reported by the tool. To locate a label or setting, use `{"detail":"search","query":"label"}` and copy exact text from the returned blocks into edits.
3. Choose an editing tool below. Summary state reports `editStructure`, `inspectRows` and `updateChart` capabilities, with reasons when unavailable. Pass the revision you read; await each change and reuse its returned revision. On conflict, reread and adapt. `sinceRevision` shows intervening changes when still in session history.
4. Save a checkpoint before exploring an alternative. Validate uncertain changes with `diagram_draft`, using source, exact edits, structural operations or chart settings. Inspect warnings and optional images, then apply its id at the original revision. Compare checkpoints or restore one to revisit an alternative.
5. For tables, inspect uncertain columns and units with `diagram_inspectData`, then pass its `datasetId` to later inspection or `diagram_chart` to reuse that exact data. An explicit source reads it again and may rerun its command. Use `selection:true` to inspect rows behind selected chart items and `summary:true` for statistics.
6. Fix render errors and warnings. Inspect `diagram_getImage` for dense layouts; crop with exact ids and pass the revision. Use graph queries to trace dependencies, annotations or walkthroughs to explain them, and `diagram_pickNodes` for user choices. Attach source evidence and assumptions to grounded claims; revisit their freshness after edits.
7. When asked to save HTML, call `diagram_exportHtml` with a destination such as `{"file":"docs/architecture.html","revision":7}`. It exports current source and data without rerunning commands. Viewing needs internet access for the pinned renderer.

| Change                                             | Tool                                                                              |
| -------------------------------------------------- | --------------------------------------------------------------------------------- |
| Exact source replacements or code links            | `diagram_edit`                                                                    |
| Supported flowchart nodes and edges                | `diagram_editStructure`; use `operations` for an atomic batch                     |
| Mermaid item colors                                | `diagram_style`                                                                   |
| Generated chart settings, using loaded data        | `diagram_updateChart`                                                             |
| Preview source, edits, structure or chart settings | `diagram_draft`                                                                   |
| Replace the drawing or its data source             | `diagram_render` or `diagram_chart`; use `newDiagram:true` for a separate drawing |

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

`diagram_inspectData` without a source inspects the current chart's loaded data and reports its revision; restart paging if that revision changes. A given source is read anew, rerunning a command on each call. When it fits the session cache, the report includes a `datasetId`. Pass that id to subsequent inspection or `diagram_chart` to reuse the snapshot without I/O. It cannot be combined with `data`, `file`, `command` or `format`. Read the explicit source again to refresh into a new snapshot. The cache keeps up to eight datasets within 16 MiB and evicts the oldest; oversized tables remain inspectable without a handle. A chart retains its loaded table after handle eviction, and its Refresh action still reloads the original source.

Use `selection:true` or `ids:["exact item id"]` to inspect contributing rows of a generated chart. Results retain original 1-based row numbers and parsed units, including after aggregation, sorting, filtering, binning and facets. Duplicate labels are distinguished by exact item ids. Treemap and sunburst items include their contributing descendants; Sankey nodes and links include their contributing rows. Custom options or manual edits that change chart data or structure have no supported item mapping; inspect raw data without `ids` or `selection` instead.

`filters` narrows the inspected rows without changing the chart. `summary:true` computes count, minimum, maximum, sum, mean and median over all matching rows for each returned numeric column. Pass `revision` for current data; omit it with an explicit source or `datasetId`. Item ids and selection also refer only to the current chart. Item inspection never reloads a file or command.

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

`diagram_annotate` and `diagram_getImage` accept `revision` to reject item ids from an older drawing before reopening or acting. `diagram_annotate` reopens a closed panel before resolving item names. If a drawing is still rendering or changes while reopening, it leaves the marks unchanged and asks the agent to retry against the current state.

### HTML export

`diagram_exportHtml` accepts a `.html` or `.htm` destination, absolute or relative to the first workspace folder; the parent folder must exist. It asks for confirmation before writing; existing files are preserved unless `"overwrite":true`, and unsaved editor changes are always preserved. Pass `revision` to reject an export of a diagram that has changed. Source, data and theme are embedded in the file; renderer JavaScript loads from a CDN. The panel's **Export** command offers PNG, SVG and the same HTML export for diagrams and charts.

### Graph queries and structural edits

`diagram_queryGraph` takes `operation:"upstream"`, `"downstream"`, `"path"`, `"cycles"` or `"components"`. Reachability starts at `id`; a path also needs `target`. Queries use the rendered graph, excluding sequence messages, and return exact item ids with optional depth or component numbers. Cycles are directed strongly connected groups; components ignore direction. `focus:true` marks up to 50 results and fades the rest without changing source. Clear with `diagram_annotate` and `{}`.

`diagram_editStructure` requires the current `revision` and one operation, or an `operations` array of 1–50 operations:
- `rename`: `id` and `label`; keeps the node id and shape.
- `insert`: an existing `edge`, new `id` and `label`.
- `reconnect`: `edge` and an existing new `source`, `target` or both.
- `move`: `id` and an existing subgraph `group`.
- `addNode`: new `id`, `label` and optional existing subgraph `group`.
- `addEdge`: existing `source`, `target` and optional `label`.
- `removeNode`: `id`; removes its incident edges and code link.
- `removeEdge`: `edge`; retains its endpoint nodes.

Batches apply in order with one revision check and render; if an operation fails, none is applied. Existing edges use exact ids from the original drawing; new edges can use unique endpoint aliases. Numeric edge styling is remapped as edges change. For example:

```json
{
  "revision": 7,
  "operations": [
    { "operation": "addNode", "id": "cache", "label": "Cache" },
    { "operation": "addEdge", "source": "api", "target": "cache" }
  ]
}
```

Edits preserve unrelated source, comments and links. Chained/grouped edges, extended shapes and ambiguous declarations are refused; use exact source edits for unsupported syntax.

### Callouts and walkthroughs

Each annotation mark can include `text` of up to 500 characters. `focus:true` pans to marked items without changing keyboard focus or selection. A walkthrough supplies 1–20 `steps`, each with `text`, optional `marks`, `dim` and `focus`. Put marks inside steps rather than alongside them. The user advances with Previous/Next; `diagram_getState` reports the active step. Annotations are temporary and do not change exported source.

### Alternatives and revision changes

`diagram_checkpoint` with `action:"save"` and `name` returns an id. `list` returns saved alternatives; `compare` compares `id` with the current drawing, or with `otherId`. Comparisons include source and metadata differences, known additions/removals and modified node labels when captured labels are available. `restore` makes the snapshot current; `delete` removes it. Pass the current `revision` for mutations.

Checkpoints include loaded chart data, survive restart, and are limited to 20 within 8 MB. Restore never reruns a command or reads a data file, and detaches the Markdown binding. Editing a restored drawing leaves its saved checkpoint unchanged.

`diagram_getState` with `sinceRevision` returns source and metadata changes since that revision. Automatic history keeps up to 32 revisions within 4 MB for the current extension session. If the base is unavailable, read current state instead. These parameters cannot be combined with source or item paging.

### Draft validation

`diagram_draft` with `action:"validate"` accepts exactly one of `source`, `edits`, `operations` or `chartUpdate`, and an optional `revision`. Exact edits and structural batches use the same inputs as their editing tools; chart updates use the same settings as `diagram_updateChart`, with the revision only on the outer request. Full source accepts optional `language` and `title`; edits also accept `title`. Validation shares application checks and renders offscreen. The displayed diagram and source draft stay intact. `image:true` returns a PNG for models accepting images; `preserveNodes` and `preservePaths:[{"source":"A","target":"B"}]` check explicit Mermaid graph constraints. These checks do not prove semantic equivalence.

A valid result includes a draft id. For example, `{"action":"validate","revision":7,"chartUpdate":{"type":"horizontalBar"},"image":true}` previews a chart change using loaded data and retained styling. Use `action:"apply"` with that id while its original revision is current, or `action:"discard"`. Generated charts retain their normal styling-only edit restrictions. The last four successful drafts remain available for the session. ECharts drafts cannot execute JavaScript. Draft operations do not write Markdown.

### Evidence

`diagram_evidence` with `action:"set"`, `revision` and `items:[{"id":"A","locations":[{"file":"src/auth.ts","startLine":10,"endLine":20}],"assumptions":["The caller retries failures"]}]` attaches evidence to exact items. Locations must reference workspace files. Each item can have four locations and eight assumptions; up to 50 items can have evidence.

`action:"read"` returns current numbered snippets and unchanged, changed, missing or unavailable file status. Hashes include unsaved edits. Each location also reports `rangeStatus`, distinguishing changes within the cited lines from changes elsewhere in the file. Legacy attachments without range hashes report `unverified`. Each item reports `itemStatus`: unchanged, changed, missing, unavailable or unverified. Removed items and changed identities retain their attachments for review; their flags stay until `set` reaffirms the evidence, including when an id reappears. Chart source changes conservatively flag attached items. These statuses do not prove claims. Reads support `ids`, `startItem` and `maxItems` (up to 10). Each call reads at most eight files of up to 1 MiB, with ranges of up to 100 lines. `action:"clear"` removes the given `ids` or all evidence and requires `revision`. No source file is changed.
