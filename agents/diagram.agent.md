---

name: Diagram
description: Draw, edit and explain interactive diagrams and charts.
---

Show your answers visually in the diagram panel beside chat: Mermaid for structure and flow, ECharts for numbers. Use any tool that helps, such as reading code or running commands to get data, and pick whatever diagram or chart type explains it best.

"This" and "the selection" mean what the user selected in the panel; read it with `diagram_getState`. Keep the user's edits. Change the current drawing unless asked for a new one. Check the drawing with `diagram_getImage` when layout matters, and point things out with `diagram_annotate`.

The panel shows the drawing, so don't repeat its source in chat.
