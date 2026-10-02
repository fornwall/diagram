# @diagram

Interactive [Mermaid](https://mermaid.js.org/) diagrams and [Apache ECharts](https://echarts.apache.org/) charts beside VS Code chat. Select parts, edit source and ask follow-up questions from the panel.

Requires VS Code 1.140 or later. Chat features need a configured chat provider, such as GitHub Copilot. You can also open and edit diagrams in Markdown files without chat.

## Get started

Ask `@diagram` to draw, optionally attaching files with `#file`:

- `@diagram sequence diagram of the OAuth login flow`
- `@diagram class diagram of #file:src/panel.ts`
- `@diagram add a retry path after the payment step`
- `@diagram line chart of #file:benchmarks.csv`
- `@diagram bar chart of commits per author from git shortlog -sn HEAD`
- `@diagram treemap of du -ah src`

Follow-ups change the current diagram. Use `/new` to start another, `/explain` to discuss the diagram or selection without changing it, and `/show` to reopen the panel. Failed renders are sent back to the model for repair.

## Use the panel

| Action | How |
| --- | --- |
| Select | Click a node or chart item. Ctrl/Cmd+click or Shift+click selects several. |
| Ask | Type in **Send to chat**. The request includes your selection and goes to `@diagram` or the agent that drew the diagram. |
| Edit | Use the top-right view buttons to show source. **Apply** (Ctrl/Cmd+Enter) renders edits; **Revert** discards them. Unapplied edits survive view changes and incoming diagrams. |
| Resize | Drag the divider in split view, or focus it and use arrow keys. Home/End set the limits; Enter or double-click resets it. |
| Refresh | Reload a chart's file or command output, replacing manual source edits. |
| Save | Export a chart as a self-contained HTML file that works offline. |
| Export an image | Drag the picture handle into another app for PNG; hold Shift for SVG. PNG failures fall back to SVG. Images keep the theme and omit code-link tooltips and paths. |
| Open code | Click an underlined node linked to a file. |
| Zoom and pan | Use the toolbar, Ctrl/Cmd+scroll and dragging. Charts fit the panel. |

Diagrams follow your VS Code theme. Agents can also ask you to pick nodes, or mark them with notes and captions during a walkthrough.

## Edit Markdown diagrams

Click **Open in Diagram** above a `mermaid` or `echarts` code block. Alternatively, place the cursor inside a block and use **Diagram: Open Diagram at Cursor** from the Command Palette or editor context menu. Disable the inline actions with `diagram.codeLens.enabled`.

**Apply** renders your edits and writes them to the original block, preserving fences, indentation and surrounding text. Failed renders leave the file unchanged and keep your edits in the panel. Writes can be undone in VS Code. If the block changed or cannot be identified safely, reopen it.

If an agent replaces the diagram, **Write to** applies its version after confirmation. Switching between Mermaid and ECharts detaches it from the original block.

## Tools for agents

Any chat agent can use these tools. Attach a reference with `#` to have it called first, including in an `@diagram` request.

| Tool | Reference | Purpose |
| --- | --- | --- |
| `diagram_render` | `#diagram` | Render Mermaid or ECharts JSON/JavaScript, including callbacks and custom series. Reports render errors. |
| `diagram_chart` | `#chart` | Chart inline data, files or command output. Infer columns, group rows and recognize date axes. Report how the data was interpreted. |
| `diagram_getState` | `#diagramState` | Read source, manual edits, render errors and selection. |
| `diagram_pickNodes` | `#diagramPick` | Ask a question and wait for the user to answer by clicking. |
| `diagram_annotate` | `#diagramAnnotate` | Replace marks, notes, caption and fading without redrawing. Omit marks to clear them. |

`diagram_chart` reads CSV, TSV, JSON, JSON Lines, Markdown tables and whitespace-separated output such as `du` or `wc -l`. Supported charts: pie, doughnut, bar (vertical, horizontal or stacked), line, area (plain or stacked), scatter, treemap, sunburst, sankey, heatmap, radar, box plot, gauge and funnel. Group by sum, mean, count, min, max or median; ISO dates become a time axis.

`diagram_render` and `diagram_chart` accept `clickPrompt`, such as `"Explain {label} in more detail"`. Clicking sends that request immediately with the item's label substituted.

For Mermaid, `diagram_render` accepts `links` from node ids to code locations, e.g. `{"parse": "src/parser.ts#L42", "check": "src/checker.ts#L10-L30"}`. Links take priority over `clickPrompt`; picking and Ctrl/Cmd/Shift+click take priority over both.

## Data access and limits

VS Code asks before running a command, reading a file outside the workspace, or opening a linked file outside it. Opening any linked file in an untrusted workspace also requires confirmation. Commands require a trusted, nonvirtual workspace.

Relative paths resolve from the first workspace folder. Commands run there with `/bin/sh` (`cmd.exe` on Windows), or in your home directory if no folder is open.

- Files and command output: 10 MiB; command timeout: 60 seconds.
- Tables: 1,000,000 cells, including headers and empty cells.
- Treemap, sunburst and sankey: 100 hierarchy levels per row.

Summarize larger datasets before charting them.

## Development

```sh
npm install
npm run watch        # rebuild on change
npm run compile      # type-check, lint and build
npm test             # integration tests in VS Code; use xvfb-run -a npm test on headless Linux
npm run vsix         # package a .vsix
```

Press <kbd>F5</kbd> to launch an Extension Development Host. To install a package, use **Extensions: Install from VSIX…**.

CI tests and packages every branch push and pull request. Download `diagram-<commit SHA>.vsix` from the commit's **CI** artifacts, retained for 90 days. Packages contain minified bundles without source maps or development files. A push with multiple commits builds its latest commit.
