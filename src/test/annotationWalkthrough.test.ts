import * as assert from "node:assert";
import { AnnotateDiagramTool } from "../tools";
import { newFakePanel } from "./newPanel";
import { invokeTool } from "./toolText";

suite("annotation walkthrough", () => {
  test("resolves every step and reports only current-render progress to the agent", async () => {
    const { panel, webview } = await newFakePanel();
    webview.answer = (message) =>
      message.type === "render"
        ? {
            type: "rendered",
            requestId: message.requestId,
            diagramType: "flowchart-v2",
            nodeIds: ["A", "B"],
            relationships: [
              {
                id: "edge:1",
                label: "A to B",
                relationship: {
                  kind: "edge",
                  source: "A",
                  target: "B",
                  direction: "forward",
                  text: "",
                },
              },
            ],
          }
        : undefined;
    await panel.render(
      { language: "mermaid", source: "flowchart LR\n A --> B", title: "Flow" },
      "tool",
    );
    const result = await invokeTool(new AnnotateDiagramTool(panel), {
      steps: [
        { text: "Send request", marks: [{ id: "A --> B", text: "Network call" }] },
        { text: "Receive response", marks: [{ id: "A --> B", text: "Response", mark: "good" }] },
      ],
    });
    assert.match(result, /walkthrough with 2 steps/);
    const annotation = webview.sent.findLast((message) => message.type === "annotate");
    assert.ok(annotation?.type === "annotate");
    const annotationId = annotation.annotationId as number;
    assert.deepStrictEqual(
      annotation.steps?.map((step) => step.marks[0]),
      [
        { id: "edge:1", kind: "current", text: "Network call" },
        { id: "edge:1", kind: "good", text: "Response" },
      ],
    );
    assert.match(panel.describeForModel() ?? "", /Walkthrough step 1\/2: "Send request"/);
    const { requestId } = webview.render;
    await webview.receive({
      type: "annotationStep",
      requestId: requestId - 1,
      annotationId,
      step: 1,
    });
    assert.match(panel.describeForModel() ?? "", /Walkthrough step 1\/2/);
    await webview.receive({ type: "annotationStep", requestId, annotationId, step: 9 });
    assert.match(panel.describeForModel() ?? "", /Walkthrough step 1\/2/);
    await webview.receive({ type: "annotationStep", requestId, annotationId, step: 1 });
    assert.match(panel.describeForModel() ?? "", /Walkthrough step 2\/2: "Receive response"/);
    panel.clearSelection();
    await webview.receive({ type: "annotationStep", requestId, annotationId, step: 0 });
    assert.doesNotMatch(panel.describeForModel() ?? "", /Walkthrough step/);
  });

  test("ignores progress from a replaced walkthrough on the same diagram", async () => {
    const { panel, webview } = await newFakePanel();
    await panel.render(
      { language: "mermaid", source: "flowchart LR\n A --> B", title: "Flow" },
      "tool",
    );
    const tool = new AnnotateDiagramTool(panel);
    await invokeTool(tool, { steps: [{ text: "Old first" }, { text: "Old second" }] });
    const old = webview.sent.findLast((message) => message.type === "annotate");
    await invokeTool(tool, { steps: [{ text: "New first" }, { text: "New second" }] });
    const current = webview.sent.findLast((message) => message.type === "annotate");
    assert.ok(old?.type === "annotate" && current?.type === "annotate");
    assert.notStrictEqual(old.annotationId, current.annotationId);
    const { requestId } = webview.render;
    await webview.receive({
      type: "annotationStep",
      requestId,
      annotationId: old.annotationId as number,
      step: 1,
    });
    assert.match(panel.describeForModel() ?? "", /Walkthrough step 1\/2: "New first"/);
    await webview.receive({
      type: "annotationStep",
      requestId,
      annotationId: current.annotationId as number,
      step: 1,
    });
    assert.match(panel.describeForModel() ?? "", /Walkthrough step 2\/2: "New second"/);
  });
});
