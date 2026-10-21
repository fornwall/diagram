import * as assert from "node:assert";
import { DiagramGuideTool, findTopic, guideIndex, guideText, topicText } from "../guide";
import { GUIDE_TOPICS } from "../guideTopics";
import { DIAGRAM_TYPES } from "../webview/mermaidErrors";
import { invokeTool } from "./toolText";
import { suitePage } from "./webviewHarness";

/** The most that a topic may take, for a model to read it at little cost. */
const MAX_TOPIC_LENGTH = 3_000;

suite("diagram_guide", () => {
  test("lists every topic on a line of its own, and gives each in a few thousand characters", async () => {
    const index = await invokeTool(new DiagramGuideTool(), {});
    assert.strictEqual(index, guideIndex());
    for (const topic of GUIDE_TOPICS) {
      const lines = index.split("\n").filter((line) => line.startsWith(`- ${topic.name}: `));
      assert.deepStrictEqual(lines, [`- ${topic.name}: ${topic.summary}`]);
      assert.doesNotMatch(topic.summary, /\.$|\n/, topic.name);
      const text = topicText(topic);
      assert.ok(text.length <= MAX_TOPIC_LENGTH, `${topic.name}: ${text.length} characters`);
      assert.strictEqual(await invokeTool(new DiagramGuideTool(), { topic: topic.name }), text);
    }
  });

  test("tells each topic by its name or aliases alone", () => {
    const names = GUIDE_TOPICS.flatMap((topic) => [topic.name, ...topic.aliases]);
    for (const topic of GUIDE_TOPICS) {
      for (const name of [topic.name, ...topic.aliases]) {
        assert.strictEqual(findTopic(name), topic, name);
      }
    }
    const keys = names.map((name) => name.toLowerCase().replace(/[^a-z0-9]/g, ""));
    assert.strictEqual(new Set(keys).size, keys.length);
  });

  test("exposes a concise workflow separately from the drawing examples", async () => {
    const text = await invokeTool(new DiagramGuideTool(), { topic: "workflow" });
    assert.match(guideIndex(), /^- workflow: .+$/m);
    assert.match(text, /^workflow: /);
    assert.ok(text.length <= MAX_TOPIC_LENGTH, `workflow: ${text.length} characters`);
    assert.strictEqual(findTopic("workflow"), undefined);
    for (const topic of ["tools", "getting-started", "Agent workflow", "WORKFLOW"]) {
      assert.strictEqual(await invokeTool(new DiagramGuideTool(), { topic }), text, topic);
      assert.strictEqual(findTopic(topic), undefined, topic);
    }
    assert.match(text, /oldText copied exactly from current source/);
    assert.match(text, /revision conflict, reread and adapt; keep the revision guard/);
    assert.match(text, /inspection and charting execute a command separately/);
    assert.match(text, /Images omit selection and marks/);
    assert.match(text, /only to paths and lines you read/);
    assert.match(text, /diagram_exportHtml.*file:"report.html"/);
    assert.match(text, /opening needs internet for the CDN renderer/);
  });

  test("has a topic for every type of diagram that Mermaid draws", () => {
    for (const type of DIAGRAM_TYPES.filter((type) => type !== "info")) {
      assert.strictEqual(findTopic(type)?.language, "mermaid", type);
    }
  });

  test("finds topics by the words a model may use", () => {
    const found = (name: string) => findTopic(name)?.name;
    assert.strictEqual(found("sequenceDiagram"), "sequence");
    assert.strictEqual(found("Mermaid sequence diagram"), "sequence");
    assert.strictEqual(found("stateDiagram-v2"), "state");
    assert.strictEqual(found("C4Container"), "c4");
    assert.strictEqual(found("Bar chart"), "echarts-bar");
    assert.strictEqual(found("ECharts line"), "echarts-bar");
    assert.strictEqual(found("pie chart"), "pie");
    assert.strictEqual(found("ECharts pie"), "echarts-pie");
  });

  test("answers an unknown topic with the index and the closest topic", () => {
    assert.strictEqual(
      guideText({ topic: "flowchrt" }),
      `There is no topic "flowchrt"; the closest is "flowchart".\n\n${guideIndex()}`,
    );
    assert.match(
      guideText({ topic: "a flowchart with subgraphs" }),
      /^There is no topic "a flowchart with subgraphs"; the closest is "flowchart"\./,
    );
    assert.match(guideText({ topic: "echarts-bars" }), /the closest is "echarts-bar"\./);
    assert.match(guideText({ topic: "workflw" }), /the closest is "workflow"\./);
  });

  test("answers a malformed input with the index and what to fix", () => {
    assert.strictEqual(guideText({ topic: "  " }), guideIndex());
    assert.strictEqual(guideText({ topic: null }), guideIndex());
    assert.strictEqual(guideText(undefined), guideIndex());
    assert.strictEqual(
      guideText({ topic: 3 }),
      `"topic" must be a string, such as "flowchart".\n\n${guideIndex()}`,
    );
    assert.strictEqual(
      guideText({ name: "gantt" }),
      `Unknown property "name"; the properties are "topic".\n\n${guideIndex()}`,
    );
  });

  test("names the topic it reads in chat", () => {
    const tool = new DiagramGuideTool();
    const message = (input: unknown) =>
      tool.prepareInvocation({ input: input as never }).invocationMessage;
    assert.strictEqual(message({ topic: "erDiagram" }), "Reading the guide to er");
    assert.strictEqual(
      message({ topic: "getting started" }),
      "Reading the guide to the diagram workflow",
    );
    assert.strictEqual(message({}), "Reading the guide to diagram types");
    assert.strictEqual(message({ topic: 3 }), "Reading the guide to diagram types");
  });
});

suite("diagram_guide examples in the webview", function () {
  // The first render loads the webview and the libraries, which can take a while.
  this.timeout(20_000);

  const page = suitePage();

  for (const topic of GUIDE_TOPICS) {
    test(`draws the example of ${topic.name} without an error or a warning`, async () => {
      const outcome = await page.render({
        language: topic.language,
        source: topic.example,
        title: topic.name,
      });
      assert.ok(outcome.ok, outcome.ok ? "" : outcome.error);
      assert.deepStrictEqual(page.panel.warnings, []);
    });
  }
});
