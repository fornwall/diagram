# Changelog

## 0.0.1 (unreleased)

- `@diagram` chat participant that draws, changes and explains Mermaid diagrams and Apache ECharts charts, with `/new`, `/explain` and `/show` commands. When a diagram fails to render, it sends the error back to the model and retries.
- Interactive panel beside the chat: select nodes or chart items, send requests about them to chat, edit the source by hand, and zoom and drag diagrams around. Switch between the diagram, the diagram beside its source, and the source alone. Diagrams and charts follow the VS Code color theme.
- Language model tools that any agent can use, and that you can attach with `#`, also in `@diagram` requests:
  - `diagram_render` (`#diagram`): render Mermaid source or an ECharts option.
  - `diagram_chart` (`#chart`): chart data as a pie, doughnut, bar, line, area, stacked area or scatter chart, as a treemap or sunburst of a hierarchy, a sankey of flows, a heatmap of a pivot, a radar of several measures, a box plot of each group's spread, a gauge of one value or a funnel of stages. Reads CSV, TSV, JSON, JSON Lines, Markdown tables and whitespace-separated columns, given inline, in a file or as the output of a shell command that you confirm first (in trusted workspaces only). Works out which column labels, nests, flows into or measures what — the levels of a treemap from path-like labels such as `du -ah` output, or from several label columns — and says so, so that the agent can ask again with the columns it meant. Groups the rows that share a label on request, summing, averaging or counting them before sorting and limiting, so that raw data such as `git log --format=%an` charts as "commits per author" without being summarized first. Draws a column of unambiguous ISO dates on a time axis, where the points sit by when they happened. Charts of files and commands can be refreshed from the panel.
  - `diagram_getState` (`#diagramState`): read the current diagram, with your edits and selection.
  - `diagram_pickNodes` (`#diagramPick`): ask you to answer by clicking nodes, and wait for the answer.
  - `diagram_annotate` (`#diagramAnnotate`): mark nodes of the diagram already shown — the step being explained, something wrong, something that works, or a plain pointer, in the theme's colors — with a short note each, a line above the diagram and everything else faded, without drawing the diagram again, so that an agent can walk you through it while it stays put. Each call replaces the marks before it, a new diagram clears them, and an id the diagram has no node for is reported back to the agent.
- Save a chart from the panel as a self-contained HTML file: the chart, the colors it is drawn in and the chart library in one file that opens in any browser and loads nothing.
- Drag the drawing out of the panel as an image, into a chat message, a document or a design tool: a PNG, or an SVG while Shift is held, drawn in the colors the panel shows. A diagram's labels are drawn as text in the image rather than as the HTML that a PNG cannot be rasterized from and that most readers of SVG leave out, and the tooltips that say where a node links to are left out, so that an image carries no paths from the machine it was made on.
- Charts draw as SVG rather than on a canvas, so that they stay sharp at any zoom and on every screen without being drawn again for its pixel ratio, their text is text, and they can be handed out as a vector image.
- `clickPrompt` option for `diagram_render` and `diagram_chart`: a click on a node sends a request about it to chat, for diagrams you explore part by part.
- `links` option for `diagram_render`: Mermaid nodes can point at places in the code, such as `{"parse": "src/parser.ts#L42"}`, and a click on such a node opens the file there. You are asked first for a file outside the workspace, or any file in an untrusted one.
- ECharts options can be written as a JavaScript object literal instead of JSON, with functions wherever ECharts takes a callback: `formatter`, `symbolSize`, `labelLayout` and `renderItem` for `custom` series.
- Open a diagram that is already written in a Markdown file: an **Open in Diagram** action above every `mermaid` and `echarts` code block, or the **Diagram: Open Diagram at Cursor** command. Apply in the panel writes your edits back into that code block, keeping its fence, indentation and the file's line endings, and leaves a block that changed meanwhile alone. A **Write to** button writes the diagram as shown, which is how one an agent drew reaches the document without being edited first. The action can be turned off with the `diagram.codeLens.enabled` setting.
- Requires VS Code 1.140.

### Fixes

- Focus the panel when explicitly opened, while preserving editor focus for agent updates; offer opening Markdown diagrams from the editor context menu.
- Keep toolbar actions, annotation notes and selections usable in narrow panels. Improve keyboard resizing, focus restoration and screen-reader selection feedback, and disable sending empty chat messages.
- Preserve small byte values and differences between large values when scaling chart units; reject overflowing numeric values.
- Keep missing JSON fields empty, including fields named `__proto__`; report JSON error locations correctly after blank lines.
- Honor cancelled data requests and avoid redundant command cleanup after cancellation.
