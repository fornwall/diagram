# Changelog

## 0.0.1

- `@diagram` chat participant that draws and changes Mermaid diagrams, with `/new`, `/explain` and `/show` commands, and retries when a diagram fails to render.
- Interactive diagram panel: select nodes, send requests about them to chat, edit the source by hand, zoom.
- `diagram_render` and `diagram_getState` language model tools, so that other agents can use the diagram panel.
- Requires VS Code 1.140.
