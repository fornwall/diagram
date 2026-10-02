# Changelog

## 0.0.1 (unreleased)

- `@diagram` draws, edits and explains Mermaid diagrams and Apache ECharts charts in a panel beside chat. Includes `/new`, `/explain` and `/show`, and automatic repair of rendering errors.
- Select nodes or chart items, ask follow-up questions, edit source, zoom and pan. Diagram, split and source views follow the VS Code theme.
- Tools for any chat agent: `diagram_render` (`#diagram`), `diagram_chart` (`#chart`), `diagram_getState` (`#diagramState`), `diagram_pickNodes` (`#diagramPick`) and `diagram_annotate` (`#diagramAnnotate`). Annotations highlight existing nodes without redrawing; picks let users answer by clicking.
- Chart inline data, files or confirmed shell command output. Supports CSV, TSV, JSON, JSON Lines, Markdown tables and whitespace-separated columns; infers columns and supports aggregation, sorting, limits, date axes and hierarchical data. Refresh file and command charts from the panel. Commands require a trusted workspace.
- Save charts as self-contained HTML, or drag PNG images into other apps. Hold Shift to export SVG. Charts render as SVG; exported images preserve theme colors and omit local file link tooltips.
- Add `clickPrompt` to ask questions by clicking nodes, or `links` to open code locations from Mermaid nodes. Opening code outside the workspace, or any code in an untrusted workspace, requires confirmation.
- ECharts accepts JSON or JavaScript object literals, including callbacks and custom series.
- Open Markdown `mermaid` and `echarts` blocks through CodeLens, the editor context menu or **Diagram: Open Diagram at Cursor**. Apply edits or write the current diagram back, preserving fences, indentation and line endings. Changed blocks are protected from overwrite. Disable CodeLens with `diagram.codeLens.enabled`.
- Requires VS Code 1.140.

### Fixes

- Focus explicitly opened panels and preserve editor focus during agent updates without revealing panels already visible. Report failures when a Markdown diagram's panel is unavailable.
- Preserve unapplied source edits across webview reloads and flag conflicts with newer diagrams.
- Keep toolbar actions, annotations and selections usable in narrow panels. Improve keyboard resizing, focus restoration and screen-reader feedback; prevent empty chat submissions.
- Preserve small byte values and differences between large values when scaling chart units; reject numeric overflow.
- Keep missing JSON fields empty, including `__proto__`, and report error locations correctly after blank lines.
- Reject malformed CSV closing quotes with a line number while allowing trailing whitespace.
- Enforce table size limits before expanding data into cells. Limit treemap, sunburst and sankey inputs to 100 hierarchy levels per row, with guidance for reducing deeper inputs.
- Honor cancelled data requests and avoid redundant command cleanup.
