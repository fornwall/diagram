import * as assert from "node:assert";
import type { ToWebview } from "../protocol";
import { RenderDiagramTool } from "../tools";
import { newFakePanel } from "./newPanel";
import { invokeTool } from "./toolText";

suite("render recovery state", () => {
  const source = "flowchart LR\nA[foo(x)]";
  const repair = { source: 'flowchart LR\nA["foo(x)"]', description: "Quoted A's label." };

  test("saves the successful correction under the render's revision", async () => {
    const saved = new Map<string, unknown>();
    const { panel, webview } = await newFakePanel(saved);
    webview.answer = (message) =>
      message.type === "render"
        ? { type: "rendered", requestId: message.requestId, diagramType: "flowchart-v2", repair }
        : undefined;
    const revision = panel.revision + 1;
    const result = await invokeTool(new RenderDiagramTool(panel), { source });
    assert.match(result, /Automatic repair: Quoted A's label/);
    assert.strictEqual(panel.current?.source, repair.source);
    assert.strictEqual(panel.revision, revision);
    const restored = (await newFakePanel(saved)).panel;
    assert.strictEqual(restored.current?.source, repair.source);
    assert.strictEqual(restored.revision, revision);
  });

  test("ignores a successful correction of a superseded render", async () => {
    const { panel, webview } = await newFakePanel();
    const requested = new Promise<Extract<ToWebview, { type: "render" }>>((resolve) => {
      webview.nextRender(resolve);
    });
    const first = invokeTool(new RenderDiagramTool(panel), { source });
    const { requestId } = await requested;
    const replacement = {
      language: "mermaid",
      source: "flowchart LR\nOther",
      title: "Other",
    } as const;
    await panel.render(replacement, "tool");
    await webview.receive({ type: "rendered", requestId, diagramType: "flowchart-v2", repair });
    assert.match(await first, /replaced before it finished rendering/);
    assert.strictEqual(panel.current?.source, replacement.source);
  });

  test("accepts corrections only when requested for Mermaid", async () => {
    const { panel, webview } = await newFakePanel();
    webview.answer = (message) =>
      message.type === "render"
        ? { type: "rendered", requestId: message.requestId, diagramType: "test", repair }
        : undefined;
    for (const language of ["mermaid", "echarts"] as const) {
      await panel.render({ language, source, title: "Test" }, "tool");
      assert.strictEqual(panel.current?.source, source);
    }
    await invokeTool(new RenderDiagramTool(panel), { source: "{}", language: "echarts" });
    assert.strictEqual(panel.current?.source, "{}");
  });
});
