# Diagram Chat

Interactive [Mermaid](https://mermaid.js.org/) diagrams and [Apache ECharts](https://echarts.apache.org/) charts beside VS Code chat. Ask your agent to draw something, select items in the panel, ask follow-ups and edit the source.

Requires VS Code 1.145 or later. Chat features need an agent that supports extension tools, such as GitHub Copilot.

## Install

Install [Diagram Chat from the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=fornwall.diagram-chat) or [Open VSX](https://open-vsx.org/extension/fornwall/diagram-chat), or run:

```sh
code --install-extension fornwall.diagram-chat
```

## Use

Enable the Diagram tools in chat, or pick the **Diagram** agent, and ask:

- `flowchart of the request handling in #file:src/server.ts`
- `sequence diagram of the OAuth login flow`
- `bar chart of commits per author from git shortlog -sn HEAD`
- `turn this whiteboard photo into a flowchart`

In the panel:

- **Select** items by clicking (Ctrl/Cmd/Shift+click for several), or Tab to the drawing and use the arrow keys and Enter.
- **Ask** about the selection in the message field; the request continues in chat.
- **Edit** the source in split view and press **Apply** (Ctrl/Cmd+Enter). The agent sees your edits.
- **Export** PNG or SVG from the title bar or context menu.

Diagrams follow your VS Code theme. Nodes can link to code locations or URLs.

## Markdown

Click **Open in Diagram** above a `mermaid` or `echarts` code block, or run **Diagram: Open Diagram at Cursor**. **Apply** writes your edits back to the block. Set `diagram.codeLens.enabled` to `false` to hide the links.

## Agent tools

`diagram_render` (`#diagram`), `diagram_edit`, `diagram_getState`, `diagram_getImage`, `diagram_annotate` and `diagram_guide`. Render errors and chart warnings are returned for the agent to fix.

## Security

ECharts options with JavaScript run only in a trusted workspace. Rendering a file outside the workspace and opening file links outside it ask first. The panel loads no remote content.

## License

[Apache-2.0](LICENSE). Contributions welcome on [GitHub](https://github.com/fornwall/diagram); see [CONTRIBUTING.md](CONTRIBUTING.md).
