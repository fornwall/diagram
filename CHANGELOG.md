# Changelog

## 0.0.1 (unreleased)

- `@diagram` chat participant that draws, changes and explains Mermaid diagrams and Apache ECharts charts, with `/new`, `/explain` and `/show` commands. When a diagram fails to render, it sends the error back to the model and retries.
- Interactive panel beside the chat: select nodes or chart items, send requests about them to chat, edit the source by hand and zoom. Diagrams and charts follow the VS Code color theme.
- Language model tools that any agent can use, and that you can attach with `#`:
  - `diagram_render` (`#diagram`): render Mermaid source or an ECharts option.
  - `diagram_chart` (`#chart`): chart data as a pie, doughnut, bar, line, area or scatter chart. Reads CSV, TSV, JSON and whitespace-separated columns, given inline, in a file or as the output of a shell command that you confirm first (in trusted workspaces only). Charts of files and commands can be refreshed from the panel.
  - `diagram_getState` (`#diagramState`): read the current diagram, with your edits and selection.
  - `diagram_pickNodes` (`#diagramPick`): ask you to answer by clicking nodes, and wait for the answer.
- `clickPrompt` option for `diagram_render` and `diagram_chart`: a click on a node sends a request about it to chat, for diagrams you explore part by part.
- Requires VS Code 1.140.
