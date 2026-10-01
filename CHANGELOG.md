# Changelog

## Unreleased

- Charts with Apache ECharts 6.1, embedded in the panel. The model picks Mermaid for diagrams and ECharts for quantitative data, and `@diagram` can write either.
- `diagram_chart` tool (`#chart`): render data as a pie, doughnut, bar, line, area or scatter chart, with the data inline, in a file, or from a shell command that you confirm first. Charts of files and commands can be refreshed from the panel.
- `diagram_render` takes `language: "echarts"` to render an ECharts option.
- Charts follow the VS Code theme, sit on the editor background and adapt their layout to the panel size; chart items can be selected, picked and clicked like diagram nodes.
- A diagram the panel could not show, because it was closed or did not respond, is no longer reported as a syntax error, and `@diagram` no longer tries to repair it.
- Picking nodes ends when the diagram is replaced or edited, and answers right away when the diagram fails to render.
- `@diagram` says when a reply ends before its diagram is complete, and only ends a diagram at a closing fence on a line of its own.
- The tools report malformed input instead of failing with a type error.

## 0.0.1

- `@diagram` chat participant that draws and changes Mermaid diagrams, with `/new`, `/explain` and `/show` commands, and retries when a diagram fails to render.
- Interactive diagram panel: select nodes, send requests about them to chat, edit the source by hand, zoom.
- `diagram_render` and `diagram_getState` language model tools, so that other agents can use the diagram panel.
- `diagram_pickNodes` tool: agents can ask the user to answer by clicking nodes, and wait for the answer.
- `clickPrompt` option for `diagram_render`: clicking a node sends a request about it to chat.
- Requires VS Code 1.140.
