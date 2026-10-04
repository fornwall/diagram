import * as assert from "node:assert";
import { RenderDiagramTool } from "../tools";
import { newPanel } from "./newPanel";

suite("tools", () => {
  test("diagram_render reads a source starting with a brace as an ECharts option", () => {
    const panel = newPanel();
    try {
      const tool = new RenderDiagramTool(panel);
      const message = (source: string, language?: string) =>
        tool.prepareInvocation({ input: { source, language } }).invocationMessage;
      assert.strictEqual(
        message(' {"title": {"text": "Sales"}, "series": []}'),
        'Rendering chart "Sales"',
      );
      assert.match(String(message("flowchart LR\n  A --> B")), /^Rendering diagram/);
      assert.match(String(message('{"series": []}', "mermaid")), /^Rendering diagram/);
    } finally {
      panel.dispose();
    }
  });
});
