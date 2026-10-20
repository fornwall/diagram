# Tools for agents

Any chat agent can use these tools. `@diagram` includes them when its model supports tool calls; attach a `#` reference to call that tool first. `/explain` permits only tools that read the diagram, workspace or guide.

| Tool | Reference | Purpose |
| --- | --- | --- |
| `diagram_render` | `#diagram` | Render Mermaid or an ECharts option as JSON or JavaScript. Reports syntax errors and layout problems, with fixes where available. |
| `diagram_edit` | `#diagramEdit` | Change the current diagram or chart with exact text replacements in its source, keeping the rest, its title, code links and click prompt. |
| `diagram_chart` | `#chart` | Chart inline data, a file or a command's output. Infers columns and dates, and reports how it read the data. |
| `diagram_getState` | `#diagramState` | Read the source, revision, edits, render error, selection, marks and the ids of edges or messages between the same nodes. |
| `diagram_getImage` | `#diagramImage` | View the drawing or selected items as an image to check layout. Requires a model that accepts images. |
| `diagram_guide` | `#diagramGuide` | Get examples, syntax help and layout tips for a diagram or chart type. |
| `diagram_pickNodes` | `#diagramPick` | Ask a question and wait for the user to pick nodes, relationships or chart items. |
| `diagram_annotate` | `#diagramAnnotate` | Mark items and fade the rest, without redrawing. Omit marks to clear them. |
| `diagram_findFiles` | `#diagramFiles` | Find workspace files by glob, in all open folders. |
| `diagram_searchText` | `#diagramSearch` | Search workspace files for literal text; returns matching lines and their locations. |
| `diagram_readFile` | `#diagramRead` | Read a range of numbered lines from a workspace file, including unsaved edits. |
| `diagram_inspectData` | `#diagramData` | Show a table's columns, inferred types and up to 20 sample rows without charting it. |
| `diagram_updateChart` | `#diagramUpdate` | Change the current chart's settings using its loaded data, keeping supported styling. |
| `diagram_style` | `#diagramStyle` | Set Mermaid item colors through `style` and `linkStyle` lines. |

Workspace tools stay within open workspace folders. Find and search respect `files.exclude`, `search.exclude` and `search.useIgnoreFiles`, and always exclude `.git` and `node_modules`.

`diagram_edit` applies replacements in order, for example `{"edits": [{"oldText": "A --> B", "newText": "A --> C --> B"}]}`. Each `oldText` must occur exactly once unless `"replaceAll": true`. If any replacement cannot be applied, none is made; the result quotes nearby source to help correct it. Render errors leave the edited source in the panel for repair. `links` merges code links (`null` removes one); `revision` rejects stale edits. For generated charts, styling survives **Refresh** and `diagram_updateChart`; edits to data or structure are refused. Writing to Markdown requires confirmation.

`diagram_updateChart` keeps omitted settings unless the new chart type cannot use them; `null` clears a setting. Pass the revision from `diagram_getState` to reject stale updates. Incompatible manual source edits block the update.

`diagram_inspectData` without a source inspects the current chart's loaded data. A given source is read anew, rerunning a command.

`diagram_style` accepts CSS colors, e.g. `{"styles": [{"id": "pay", "fill": "green"}]}`. It supports flowchart nodes, subgraphs and edges, classes, noncomposite states and ER entities. Name an edge by its ends, e.g. `"A --> B"`; `stroke` colors its line and `text` its label. Opaque fills get contrasting black or white text unless overridden; translucent fills use theme text. Omitted colors stay, `null` removes one, and `"clear": true` removes the item's style. Changes appear in source and exports; writing to Markdown requires confirmation. The panel background follows the VS Code theme.

`diagram_getImage` returns a PNG in the panel's theme, without selection highlights or marks, reopening the panel if needed. Pass `ids` to crop around items. Images fit within 1568 pixels per side and 1.15 megapixels, targeting text about 16 pixels high. The result reports dimensions, scale, readability and panel zoom. `@diagram` omits this tool for models that do not accept images.

`diagram_annotate` and `diagram_getImage` accept edges and sequence messages by endpoint ids, e.g. `"A --> B"`. Unicode and Mermaid arrows work too; bidirectional and undirected edges accept either order. Add a label to distinguish parallel edges: `"A --> B: Yes"`, `"A -->|Yes| B"` or `"A -- Yes --> B"`. If several items match, `diagram_getImage` shows all of them; `diagram_annotate` instead lists exact ids to use. `diagram_getState` supplies these ids and disambiguates chart items with duplicate names. Relationship ids survive redraws but may change when the source changes.

Both rendering tools accept a `clickPrompt`, e.g. `"Explain {label} in more detail"`. Mermaid also accepts code links such as `{"parse": "src/parser.ts#L42"}`; missing workspace files are omitted. Links take priority over click prompts.
