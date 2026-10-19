# Tools for agents

Any chat agent can use these tools; `@diagram` includes them by default, unless its model cannot call tools. Attach a `#` reference to have `@diagram` call that tool first. `/explain` allows only the tools that read the diagram's state and image, the workspace and the guide, and says which attached tools it leaves out.

| Tool | Reference | Purpose |
| --- | --- | --- |
| `diagram_render` | `#diagram` | Render Mermaid or an ECharts option as JSON or JavaScript, including callbacks, custom series and timelines. Reports render errors, with fixes for common Mermaid mistakes, chart problems such as hidden labels, unreadable values, values beyond an axis, misspelled keys or callbacks that throw, and Mermaid drawings that read badly in the panel. |
| `diagram_edit` | `#diagramEdit` | Change the current diagram or chart with exact text replacements in its source, keeping the rest, its title, code links and click prompt. |
| `diagram_chart` | `#chart` | Chart inline data, a file or a command's output. Infers columns and dates, and reports how it read the data. |
| `diagram_getState` | `#diagramState` | Read the source, revision, edits, render error, selection, marks and the ids of edges or messages between the same nodes. |
| `diagram_getImage` | `#diagramImage` | Look at the drawing, or at the part around some items, as an image, to check its layout, for a model that accepts images. |
| `diagram_guide` | `#diagramGuide` | Look up a Mermaid diagram type or ECharts chart kind: an example that renders, the syntax rules models get wrong and layout tips. |
| `diagram_pickNodes` | `#diagramPick` | Ask a question and wait for the user to pick nodes, relationships or chart items. |
| `diagram_annotate` | `#diagramAnnotate` | Mark items and fade the rest, without redrawing. Omit marks to clear them. |
| `diagram_findFiles` | `#diagramFiles` | Find workspace files by glob, in all open folders. |
| `diagram_searchText` | `#diagramSearch` | Search workspace files for literal text; returns matching lines and their locations. |
| `diagram_readFile` | `#diagramRead` | Read a range of numbered lines from a workspace file, including unsaved edits. |
| `diagram_inspectData` | `#diagramData` | Show a table's columns, inferred types and up to 20 sample rows without charting it. |
| `diagram_updateChart` | `#diagramUpdate` | Change the current chart's settings using its loaded data, keeping supported styling. |
| `diagram_style` | `#diagramStyle` | Set the fill, border and text colors of the nodes, subgraphs, edges, classes, states and ER entities of a Mermaid diagram by editing their `style` and `linkStyle` lines. |

Workspace tools stay within open workspace folders. Find and search respect `files.exclude`, `search.exclude` and `search.useIgnoreFiles`, and always exclude `.git` and `node_modules`.

`diagram_edit` takes replacements such as `{"edits": [{"oldText": "A --> B", "newText": "A --> C --> B"}]}`, made in order. Each `oldText` must occur exactly once, unless `"replaceAll": true`; if any edit does not apply, none is made, and the result quotes the closest lines of the source. The result names the nodes added and removed, or the render error with the lines around it; an edit that fails to render stays shown, for the next edit to fix, as a failed `diagram_render` does. `links` adds or changes code links (`null` removes one) and keeps the others. Pass `revision` to reject stale edits. On a chart from `diagram_chart`, styling edits survive **Refresh** and `diagram_updateChart`, and changes to its data or structure are refused. Writing an edit to Markdown requires confirmation.

`diagram_updateChart` keeps omitted settings unless the new chart type cannot use them; `null` clears a setting. Pass the revision from `diagram_getState` to reject stale updates. Incompatible manual source edits block the update.

`diagram_inspectData` without a source inspects the current chart's loaded data. A given source is read anew, rerunning a command.

`diagram_style` accepts CSS colors, e.g. `{"styles": [{"id": "pay", "fill": "green"}]}`, for flowchart nodes and subgraphs, classes, noncomposite states and ER entities, and flowchart edges, named by their ends as in `"A --> B"`, which get a `linkStyle` line of their own with `stroke` for the line and `text` for the label. Opaque fills get contrasting black or white text unless you specify `text`; translucent fills use theme text. Omitted colors stay, `null` removes one, and `"clear": true` removes the item's style. Changes appear in source and exports, and one that fails to render stays shown for `diagram_edit` to fix, as an edit does; writing them to Markdown requires confirmation. The panel background follows the VS Code theme.

`diagram_getImage` gives a PNG of the drawing as the panel shows it, opening the panel again if it was closed, in its theme, without the selection and marks: all of it, a chart as laid out for the panel, or with `ids` the part around those items. Text is drawn about 16 pixels high where that fits in 1568 pixels a side and 1.15 megapixels. The result gives the drawing's size, the image's scale, whether its text is too small to read there, the panel's zoom, and how much of a wide Mermaid drawing's width the panel shows at a time. `@diagram` leaves the tool out for a model that says it does not accept images.

`diagram_annotate` and `diagram_getImage` take an edge or sequence message by its ends' node ids with an arrow between, as in `"A --> B"` (`->`, `→` and the arrows of Mermaid sources, such as `-)`, `--x`, `o--o` or `<|--`, work too; either way round for one that goes both or no way), and one of several between the same nodes also by its label, as in `"A --> B: Yes"`, `"A -->|Yes| B"` or `"A -- Yes --> B"`. Where a name fits several, `diagram_getImage` shows them all, and `diagram_annotate` marks none of them and lists their `edge:` and `message:` ids to use instead. `diagram_getState` gives the ids of those that ends and labels do not tell apart; they survive redraws but may change with the source. It also supplies ids for chart items with duplicate names.

Both rendering tools accept a `clickPrompt`, e.g. `"Explain {label} in more detail"`. Mermaid also accepts code links such as `{"parse": "src/parser.ts#L42"}`; missing workspace files are omitted. Links take priority over click prompts.
