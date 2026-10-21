import * as assert from "node:assert";
import { RenderDiagramTool } from "../tools";
import { afterTest } from "./afterTest";
import { invokeTool } from "./toolText";
import { suitePage } from "./webviewHarness";

suite("Mermaid recovery in diagram_render", function () {
  this.timeout(60_000);
  const page = suitePage();

  test("quotes only the diagnosed label, preserving shapes and other source", async () => {
    for (const [broken, fixed] of [
      ["A[Start (init)]", 'A["Start (init)"]'],
      ["A{Is it (really) ok?}", 'A{"Is it (really) ok?"}'],
      ["A(Call foo(x))", 'A("Call foo(x)")'],
      ["A[items[0]]", 'A["items[0]"]'],
      ["A[a|b]", 'A["a|b"]'],
      ['A[He said "hi"]', 'A["He said #quot;hi#quot;"]'],
      ["A((x (y)))", 'A(("x (y)"))'],
      ["A[(Store (main))]", 'A[("Store (main)")]'],
      ["A{{x (y)}}", 'A{{"x (y)"}}'],
      ["A>x (y)]", 'A>"x (y)"]'],
      ["A[/x (y)/]", 'A[/"x (y)"/]'],
      ["A[[x (y)]]", 'A[["x (y)"]]'],
      ["A([x (y)])", 'A(["x (y)"])'],
      ["A -->|call (x)| C", 'A -->|"call (x)"| C'],
    ] as const) {
      const revision = page.panel.revision;
      const result = await invokeTool(new RenderDiagramTool(page.panel), {
        source: `flowchart TD\n  ${broken} --> B[Done]`,
        title: "Calls",
        clickPrompt: "Explain {label}",
        revision,
      });
      assert.match(result, /^Rendered/, broken);
      assert.match(result, /Automatic repair: Quoted the label on line 2:/);
      assert.strictEqual(page.panel.current?.source, `flowchart TD\n  ${fixed} --> B[Done]`);
      assert.strictEqual(page.panel.current?.title, "Calls");
      assert.strictEqual(page.panel.current?.clickPrompt, "Explain {label}");
      assert.strictEqual(page.panel.revision, revision + 1);
      assert.strictEqual(page.panel.current?.error, undefined);
    }
  });

  test("maps diagnostics through front matter and comments without changing line endings", async () => {
    afterTest(() => page.evaluate('document.getElementById("view-visual").click()'));
    for (const newline of ["\n", "\r\n", "\r"]) {
      const source = [
        "---",
        "title: Calls",
        "---",
        '%%{init: {"flowchart": {"curve": "linear"}}}%%',
        "%% Comments are removed before parsing",
        "graph LR",
        "  A[Call foo(x)] --> B",
      ].join(newline);
      const result = await invokeTool(new RenderDiagramTool(page.panel), { source });
      assert.match(result, /Automatic repair: Quoted the label on line 7:/);
      assert.strictEqual(
        page.panel.current?.source,
        source.replace("[Call foo(x)]", '["Call foo(x)"]'),
      );
      await page.evaluate('document.getElementById("view-split").click()');
      assert.strictEqual(
        await page.evaluate('document.getElementById("source").value'),
        page.panel.current?.source?.replace(/\r\n?/g, "\n"),
      );
    }
  });

  test("keeps the original source when one correction cannot make it render", async () => {
    afterTest(() => page.evaluate('document.getElementById("view-visual").click()'));
    const source = "flowchart TD\n  A[Call foo(x)] --> B[Call bar(y)]";
    const result = await invokeTool(new RenderDiagramTool(page.panel), { source });
    assert.match(result, /^The diagram failed to render/);
    assert.match(result, /unexpected "\(".*A\["Call foo\(x\)"\]/);
    assert.match(result, /Automatic repair failed; kept the original source/);
    assert.strictEqual(page.panel.current?.source, source);
    assert.match(page.panel.current?.error ?? "", /Automatic repair failed/);
    await page.evaluate('document.getElementById("view-split").click()');
    assert.strictEqual(await page.evaluate('document.getElementById("source").value'), source);
  });

  test("leaves valid source, other errors and manual rendering unchanged", async () => {
    const valid = 'flowchart TD\n  A["Start (init)"] --> B((Done))';
    const result = await invokeTool(new RenderDiagramTool(page.panel), { source: valid });
    assert.match(result, /^Rendered/);
    assert.doesNotMatch(result, /repair/i);
    assert.strictEqual(page.panel.current?.source, valid);

    const invalid = "flowchart TD\n  A --> --> B[";
    const failure = await invokeTool(new RenderDiagramTool(page.panel), { source: invalid });
    assert.match(failure, /^The diagram failed to render/);
    assert.doesNotMatch(failure, /Automatic repair/);
    assert.strictEqual(page.panel.current?.source, invalid);

    const manual = "flowchart TD\n  A[Start (init)] --> B";
    const outcome = await page.render({ source: manual });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(page.panel.current?.source, manual);
  });
});
