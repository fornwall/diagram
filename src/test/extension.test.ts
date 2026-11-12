import * as assert from "node:assert";
import * as vscode from "vscode";
import { diagramExtension, recordMessages } from "./afterTest";
import { toolText } from "./toolText";

async function invoke(name: string, input: object): Promise<string> {
  return toolText(await vscode.lm.invokeTool(name, { input, toolInvocationToken: undefined }));
}

suite("extension", function () {
  // The first render loads the webview, which can take a while.
  this.timeout(10_000);
  suiteSetup(() => diagramExtension().activate());

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("discovers the Diagram agent and its tools for ordinary conversations", async () => {
    const extension = diagramExtension();
    const { chatAgents, chatParticipants, languageModelTools } = extension.packageJSON.contributes;
    assert.strictEqual(chatParticipants, undefined);
    assert.strictEqual(chatAgents.length, 1);
    const uri = vscode.Uri.joinPath(extension.extensionUri, chatAgents[0].path);
    const agents = await vscode.commands.executeCommand<
      { uri: { path: string }; type: string; extensionId: string }[]
    >("_listExtensionPromptFiles");
    assert.ok(
      agents.some(
        (agent) =>
          agent.type === "agent" &&
          agent.extensionId === extension.id &&
          agent.uri.path === uri.path,
      ),
      "VS Code must discover the bundled agent",
    );
    const source = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    assert.match(source, /^---\n\s*name: Diagram\n/);
    // Without a list of tools, the agent has all of them.
    assert.doesNotMatch(source, /^tools:/m);
    for (const { name } of languageModelTools as { name: string }[]) {
      assert.ok(
        vscode.lm.tools.some((tool) => tool.name === name),
        name,
      );
    }
  });

  test("registers the language model tools, described on one line each", () => {
    const declared: {
      name: string;
      modelDescription: string;
      userDescription: string;
      inputSchema: Record<string, unknown>;
    }[] = diagramExtension().packageJSON.contributes.languageModelTools;
    const registered = vscode.lm.tools.filter((tool) => tool.name.startsWith("diagram_"));
    assert.deepStrictEqual(
      registered.map((tool) => tool.name).sort(),
      declared.map((tool) => tool.name).sort(),
    );
    // As Copilot's schema checks require for every model: Gemini takes no list of types, and
    // Copilot drops "null" from one, so a nullable value is an anyOf.
    const checkSchema = (schema: Record<string, unknown>, where: string) => {
      assert.ok(typeof schema.type === "string" || Array.isArray(schema.anyOf), where);
      if (schema.type === "array") assert.ok(schema.items, `${where} has no items`);
      const children = [
        ...Object.entries((schema.properties ?? {}) as Record<string, Record<string, unknown>>),
        ...((schema.anyOf ?? []) as Record<string, unknown>[]).map((child, index) => [
          `anyOf[${index}]`,
          child,
        ]),
        ...(schema.items ? [["items", schema.items]] : []),
      ] as [string, Record<string, unknown>][];
      for (const [key, child] of children) checkSchema(child, `${where}.${key}`);
    };
    for (const { name, modelDescription, userDescription, inputSchema } of declared) {
      for (const description of [modelDescription, userDescription]) {
        assert.match(description, /^\S.*\S$/, name);
      }
      assert.strictEqual(inputSchema.type, "object", name);
      assert.ok(inputSchema.properties, name);
      checkSchema(inputSchema, name);
    }
  });

  test("registers the contributed commands, which are the ones its menus name", async () => {
    const { commands, menus } = diagramExtension().packageJSON.contributes as {
      commands: { command: string }[];
      menus: Record<string, { command: string }[]>;
    };
    const registered = new Set(await vscode.commands.getCommands(true));
    const declared = commands.map(({ command }) => command);
    for (const command of declared) {
      assert.ok(registered.has(command), command);
    }
    for (const { command } of Object.values(menus).flat()) {
      assert.ok(declared.includes(command), command);
    }
  });

  test("opens Help as a brief modal guide", async () => {
    let options: unknown;
    const messages = recordMessages("showInformationMessage", (_message, given) => {
      options = given;
    });
    await vscode.commands.executeCommand("diagram.help");
    assert.deepStrictEqual(messages, ["Diagram Help"]);
    assert.ok(options && typeof options === "object" && "modal" in options && options.modal);
    assert.ok("detail" in options && typeof options.detail === "string");
    assert.match(options.detail, /your chat agent/);
    assert.match(options.detail, /Ctrl\/Cmd\/Shift\+click/);
  });

  test("loads without formatting a number, which first loads locale data", () => {
    const extension = diagramExtension();
    // Activation waits on loading the bundle, which every Markdown file starts.
    const bundle = require.resolve(`${extension.extensionPath}/dist/extension.js`);
    const loaded = require.cache[bundle];
    const format = Number.prototype.toLocaleString;
    let formatted = 0;
    Number.prototype.toLocaleString = function (...args) {
      formatted++;
      return format.apply(this, args);
    };
    try {
      delete require.cache[bundle];
      require(bundle);
    } finally {
      Number.prototype.toLocaleString = format;
      require.cache[bundle] = loaded;
    }
    assert.strictEqual(formatted, 0);
  });

  test("bundles ECharts only in the panel's lazy-loaded library", async () => {
    const dist = vscode.Uri.joinPath(diagramExtension().extensionUri, "dist");
    const read = async (uri: vscode.Uri) =>
      new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    // As of the text measuring of zrender, which ECharts draws with.
    const zrender = /asciiWidthMapTried/;
    assert.match(await read(vscode.Uri.joinPath(dist, "echarts.js")), zrender);
    const chunks = vscode.Uri.joinPath(dist, "chunks");
    const scripts = (await vscode.workspace.fs.readDirectory(chunks))
      .filter(([name]) => name.endsWith(".js"))
      .map(([name]) => vscode.Uri.joinPath(chunks, name));
    for (const script of scripts) {
      assert.doesNotMatch(await read(script), zrender, script.path);
    }
  });

  test("renders a diagram through the registered tool, which getState then describes", async () => {
    const text = await invoke("diagram_render", {
      source: "flowchart TD\n  A[Start] --> B{Valid?}\n  B -->|yes| C[Done]",
      title: "Test flow",
    });
    assert.match(text, /Rendered the flowchart/);

    const state = await invoke("diagram_getState", {});
    assert.match(state, /"Test flow"/);
    assert.match(state, /A\[Start\] --> B\{Valid\?\}/);
    assert.doesNotMatch(state, /fails to render/);
  });

  test("gives a model an image of the drawing through the registered tool", async () => {
    assert.match(
      await invoke("diagram_render", { source: "flowchart LR\n  A --> B" }),
      /^Rendered/,
    );
    const result = await vscode.lm.invokeTool("diagram_getImage", {
      input: {},
      toolInvocationToken: undefined,
    });
    const [text, image] = result.content;
    assert.ok(text instanceof vscode.LanguageModelTextPart, toolText(result));
    assert.ok(image instanceof vscode.LanguageModelDataPart);
    assert.strictEqual(image.mimeType, "image/png");
    assert.strictEqual(Buffer.from(image.data).subarray(1, 4).toString(), "PNG");
  });

  test("tells the agent that a tree series draws only the first of its trees", async () => {
    const tree = (...names: string[]) =>
      invoke("diagram_render", {
        source: JSON.stringify({
          series: [{ type: "tree", data: names.map((name) => ({ name })) }],
        }),
        language: "echarts",
      });
    const warning =
      "Tree series 1 has 2 trees in its data, of which ECharts draws only the first: put them under one root node to draw them all.";
    assert.ok((await tree("A", "B")).endsWith(`\n\n${warning}`));
    assert.ok((await invoke("diagram_getState", {})).includes(`\n${warning}\n`));
    assert.doesNotMatch(await tree("A"), /Tree series/);
    assert.doesNotMatch(await invoke("diagram_getState", {}), /Tree series/);
  });

  test("draws a chart whose timeline steps ECharts ignores, and tells the agent", async () => {
    const text = await invoke("diagram_render", {
      source: JSON.stringify({
        series: [{ type: "pie", data: [1] }],
        options: [{ series: [{ data: [2] }] }],
      }),
      language: "echarts",
    });
    assert.match(text, /^Rendered .*timeline steps in "options" but no "timeline"/s);
  });

  test("reports syntax errors back to the agent", async () => {
    const text = await invoke("diagram_render", { source: "flowchart TD\n  A --> --> B[" });
    assert.match(text, /fails to render/);

    const state = await invoke("diagram_getState", {});
    assert.match(state, /fails to render/);
  });

  test("renders an ECharts option", async () => {
    const option = {
      title: { text: "Languages" },
      series: [
        {
          type: "pie",
          data: [
            { name: "TypeScript", value: 3 },
            { name: "CSS", value: 1 },
          ],
        },
      ],
    };
    const text = await invoke("diagram_render", {
      source: JSON.stringify(option),
      language: "echarts",
    });
    assert.match(text, /Rendered the pie chart/);

    const state = await invoke("diagram_getState", {});
    assert.match(state, /"Languages"/);
    assert.match(state, /```echarts/);
    assert.match(state, /no chart items selected/);
    assert.doesNotMatch(state, /fails to render/);
  });

  test("reports an unparsable ECharts option back to the agent", async () => {
    const text = await invoke("diagram_render", {
      // Unclosed, and so neither JSON nor a JavaScript object literal; a trailing comma would be
      // a syntax error only in JSON, which an option is no longer limited to.
      source: '{"series": [{"type": "bar"}',
      language: "echarts",
    });
    assert.match(text, /fails to render/);
    assert.match(text, /could not be parsed/);
  });

  test("marks the diagram already shown, and clears the marks again", async () => {
    assert.match(
      await invoke("diagram_render", {
        source: "flowchart LR\n  parse[Parser] --> check[Checker]",
        title: "Pipeline",
      }),
      /Rendered the flowchart/,
    );
    const marked = await invoke("diagram_annotate", {
      marks: [
        { id: "parse", mark: "current" },
        { id: "Checker", mark: "problem" },
      ],
      dim: true,
    });
    assert.match(marked, /^Marked 1 node: "parse" \(current\)\./);
    assert.match(marked, /Unmarked items are faded\./);
    // The label of a node is not its id, so there is nothing to mark for it.
    assert.match(
      marked,
      /These ids are not selectable items of the diagram.*"Checker"\. Its items are "parse", "check", "parse --> check"\./,
    );

    // The marks belong to the state a later request sees, and the diagram is still the one drawn.
    const state = await invoke("diagram_getState", {});
    assert.match(state, /Marked: "parse" \(current\)\./);
    assert.match(state, /flowchart LR/);

    assert.strictEqual(await invoke("diagram_annotate", {}), "Cleared the diagram's marks.");
    assert.doesNotMatch(await invoke("diagram_getState", {}), /marked/);
  });

  test("reports malformed input back to the agent", async () => {
    assert.match(
      await invoke("diagram_render", {}),
      /Nothing was rendered: Give "source", the complete diagram/,
    );
    assert.match(
      await invoke("diagram_render", { source: "A", language: "dot" }),
      /Unknown language "dot"/,
    );
    assert.match(
      await invoke("diagram_annotate", { marks: [{ id: "a", mark: "red" }] }),
      /Nothing was marked: Invalid marks:\n- Mark 1: "mark" is "red"; it must be one of/,
    );
  });
});
