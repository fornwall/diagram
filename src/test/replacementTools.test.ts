import * as assert from "node:assert";
import * as vscode from "vscode";
import { ChartTool } from "../chartTools";
import { RenderDiagramTool } from "../tools";
import { replace } from "./afterTest";
import { newFakePanel } from "./newPanel";
import { invokeTool } from "./toolText";

const initial = {
  language: "mermaid",
  source: "flowchart TD\n  Original",
  title: "Original",
} as const;
const data = "name,value\nA,1\nB,2";

suite("replacement tools", () => {
  test("chart preparation preserves command confirmation even before the requested revision exists", async () => {
    const { panel } = await newFakePanel();
    const tool = new ChartTool(panel);
    const input = {
      type: "bar",
      command: "printf 'name,value\\nA,1'",
      revision: panel.revision + 1,
      newDiagram: true,
    };
    const prepared = tool.prepareInvocation({ input: input as never });
    assert.ok(prepared.confirmationMessages);
    await panel.render(initial, "tool");
    assert.strictEqual(panel.revision, input.revision);
    assert.ok(tool.prepareInvocation({ input: input as never }).confirmationMessages);
  });

  for (const name of ["diagram_render", "diagram_chart"] as const) {
    test(`${name} starts a separate diagram only when requested`, async () => {
      const { panel } = await newFakePanel();
      const openedFrom = vscode.Uri.file("/tmp/original-diagram.html").toString();
      const drawing =
        name === "diagram_render"
          ? { ...initial, openedFrom }
          : { language: "echarts" as const, source: "{}", title: "Original", openedFrom };
      const tool = name === "diagram_render" ? new RenderDiagramTool(panel) : new ChartTool(panel);
      const input =
        name === "diagram_render"
          ? { source: initial.source, title: initial.title }
          : { type: "bar", data, title: initial.title };
      for (const newDiagram of [undefined, null, false, true]) {
        await panel.render(drawing, "document");
        const result = await invokeTool(tool, {
          ...input,
          newDiagram,
          revision: panel.revision,
        });
        assert.match(result, /^Rendered/);
        assert.deepStrictEqual(panel.current?.openedFrom, newDiagram ? undefined : openedFrom);
        if (panel.current?.chart) {
          assert.ok(!Object.hasOwn(panel.current.chart, "newDiagram"));
        }
      }
    });

    test(`${name} validates newDiagram and still rejects stale replacements`, async () => {
      const { panel } = await newFakePanel();
      await panel.render(initial, "tool");
      const before = panel.current;
      const tool = name === "diagram_render" ? new RenderDiagramTool(panel) : new ChartTool(panel);
      const input =
        name === "diagram_render"
          ? { source: "flowchart TD\n  Replacement" }
          : { type: "bar", file: "sizes.tsv" };
      replace(vscode.workspace, "fs", {
        ...vscode.workspace.fs,
        readFile: async () => assert.fail("An invalid replacement must not load chart data"),
      });
      for (const newDiagram of ["true", 1, {}, []]) {
        assert.match(
          await invokeTool(tool, { ...input, newDiagram }),
          /"newDiagram" must be true or false/,
        );
      }
      assert.match(
        await invokeTool(tool, { ...input, newDiagram: true, revision: panel.revision - 1 }),
        /changed since revision/,
      );
      assert.strictEqual(panel.current, before);
    });

    test(`${name} rejects stale and malformed revisions before reading files`, async () => {
      const { panel } = await newFakePanel();
      await panel.render(initial, "tool");
      const before = panel.current;
      const revision = panel.revision;
      const tool = name === "diagram_render" ? new RenderDiagramTool(panel) : new ChartTool(panel);
      const input =
        name === "diagram_render"
          ? { source: "flowchart TD\n  Replacement", links: { Replacement: "sizes.tsv" } }
          : { type: "bar", file: "sizes.tsv" };
      replace(vscode.workspace, "fs", {
        ...vscode.workspace.fs,
        stat: async () => assert.fail("A rejected replacement must not check file links"),
        readFile: async () => assert.fail("A rejected replacement must not load chart data"),
      });
      assert.match(
        await invokeTool(tool, { ...input, revision: revision - 1 }),
        /changed since revision.*Read diagram_getState.*keeping the revision guard/,
      );
      for (const invalid of [-1, 0.5, "1", true, {}, Number.MAX_SAFE_INTEGER + 1]) {
        assert.match(
          await invokeTool(tool, { ...input, revision: invalid }),
          /"revision" must be a nonnegative integer/,
        );
      }
      assert.strictEqual(panel.current, before);
      assert.strictEqual(panel.revision, revision);
    });

    test(`${name} accepts current, omitted and null revisions`, async () => {
      const { panel } = await newFakePanel();
      const tool = name === "diagram_render" ? new RenderDiagramTool(panel) : new ChartTool(panel);
      const input =
        name === "diagram_render"
          ? { source: "flowchart TD\n  Replacement" }
          : { type: "bar", data };
      for (const guard of ["current", "omit", "null"]) {
        const revision = panel.revision;
        const extra = guard === "omit" ? {} : { revision: guard === "null" ? null : revision };
        const result = await invokeTool(tool, { ...input, ...extra });
        assert.match(result, /^Rendered/);
        assert.match(result, new RegExp(`Revision: ${revision + 1}\\.`));
        assert.strictEqual(panel.revision, revision + 1);
        if (name === "diagram_chart") {
          assert.ok(panel.current?.chart);
          assert.ok(!Object.hasOwn(panel.current.chart, "revision"));
        }
      }
    });

    test(`${name} preserves another agent's drawing made while its files load`, async () => {
      const { panel } = await newFakePanel();
      await panel.render(initial, "tool");
      const changes = panel.userChangeCount;
      const other = { ...initial, source: "flowchart TD\n  OtherAgent", title: "Other" };
      const fs = vscode.workspace.fs;
      replace(vscode.workspace, "fs", {
        ...fs,
        stat: async (uri) => {
          if (name === "diagram_render") await panel.render(other, "tool");
          return fs.stat(uri);
        },
        readFile: async (uri) => {
          if (name === "diagram_chart") await panel.render(other, "tool");
          return fs.readFile(uri);
        },
      });
      const result =
        name === "diagram_render"
          ? await invokeTool(new RenderDiagramTool(panel), {
              source: "flowchart TD\n  Replacement",
              links: { Replacement: "sizes.tsv" },
            })
          : await invokeTool(new ChartTool(panel), { type: "bar", file: "sizes.tsv" });
      assert.match(result, /was rendered because the diagram changed in the panel/);
      assert.strictEqual(panel.current?.source, other.source);
      assert.strictEqual(panel.userChangeCount, changes);
    });
  }
});
