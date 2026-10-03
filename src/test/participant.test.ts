import * as assert from "node:assert";
import * as vscode from "vscode";
import type { DiagramPanel } from "../panel";
import { createParticipantHandler } from "../participant";
import { newPanel } from "./newPanel";

type Part = vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart;
/** A model's reply, or a function giving it, e.g. after doing what a tool call would. */
type Reply = Part[] | (() => Promise<Part[]>);

const text = (value: string) => new vscode.LanguageModelTextPart(value);
const valid = "```mermaid\nflowchart TD\n  A --> B\n```";
const defaultTools = [
  "diagram_annotate",
  "diagram_chart",
  "diagram_findFiles",
  "diagram_getState",
  "diagram_inspectData",
  "diagram_pickNodes",
  "diagram_readFile",
  "diagram_render",
  "diagram_searchText",
  "diagram_updateChart",
];
const readOnlyTools = [
  "diagram_findFiles",
  "diagram_getState",
  "diagram_readFile",
  "diagram_searchText",
];
const availableDefaults = () =>
  vscode.lm.tools
    .map((tool) => tool.name)
    .filter((name) => defaultTools.includes(name))
    .sort();
const invalid = "```mermaid\nflowchart TD\n  A --> --> B[\n```";

// The constructors are hidden from the API, but not at runtime.
type Constructor<T> = new (...args: unknown[]) => T;
const RequestTurn = vscode.ChatRequestTurn as unknown as Constructor<vscode.ChatRequestTurn>;
const ResponseTurn = vscode.ChatResponseTurn as unknown as Constructor<vscode.ChatResponseTurn>;

/** The fake model's token count: about one token per four characters. */
const tokenCount = (text: string) => Math.ceil(text.length / 4);

/**
 * Sends a request to the participant, with a model that gives the replies in turn and takes
 * `maxInputTokens`.
 */
async function ask(
  panel: DiagramPanel,
  replies: Reply[],
  {
    history = [],
    maxInputTokens = 100_000,
    token = new vscode.CancellationTokenSource().token,
    ...overrides
  }: Partial<
    vscode.ChatRequest &
      vscode.ChatContext & { maxInputTokens: number; token: vscode.CancellationToken }
  > = {},
) {
  const sent: {
    messages: vscode.LanguageModelChatMessage[];
    options: vscode.LanguageModelChatRequestOptions;
  }[] = [];
  let counted = 0;
  const model = {
    name: "Fake",
    maxInputTokens,
    countTokens: async (text: string) => {
      counted++;
      return tokenCount(text);
    },
    sendRequest: async (
      messages: vscode.LanguageModelChatMessage[],
      options: vscode.LanguageModelChatRequestOptions,
    ) => {
      sent.push({ messages: [...messages], options });
      const reply = replies.shift() ?? [];
      const parts = typeof reply === "function" ? await reply() : reply;
      return {
        stream: (async function* () {
          yield* parts;
        })(),
      };
    },
  };
  const request = {
    prompt: "Draw it",
    command: undefined,
    references: [],
    toolReferences: [],
    toolInvocationToken: undefined,
    model,
    ...overrides,
  } as unknown as vscode.ChatRequest;
  let shown = "";
  const stream = new Proxy({} as vscode.ChatResponseStream, {
    get: (_target, method) => (value: unknown) => {
      if (method === "markdown") {
        shown += value;
      }
    },
  });
  const result = await createParticipantHandler(panel)(request, { history }, stream, token);
  return { result: result || undefined, shown, sent, counted };
}

/** The text of a message, including tool results. */
function messageText(message: vscode.LanguageModelChatMessage | undefined): string {
  return (message?.content ?? [])
    .flatMap((part) => (part instanceof vscode.LanguageModelToolResultPart ? part.content : [part]))
    .map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : ""))
    .join("");
}

suite("participant", function () {
  // The first render loads the webview, which can take a while.
  this.timeout(10_000);

  test("a cancelled request does not contact the model", async () => {
    const panel = newPanel();
    const cancellation = new vscode.CancellationTokenSource();
    cancellation.cancel();
    try {
      const { result, shown, sent } = await ask(panel, [[text(valid)]], {
        token: cancellation.token,
      });
      assert.strictEqual(result, undefined);
      assert.strictEqual(shown, "");
      assert.deepStrictEqual(sent, []);
      assert.strictEqual(panel.current, undefined);
    } finally {
      cancellation.dispose();
      panel.dispose();
    }
  });

  test("ignores model output arriving after cancellation", async () => {
    const panel = newPanel();
    const cancellation = new vscode.CancellationTokenSource();
    try {
      const { result, shown, sent } = await ask(
        panel,
        [
          async () => {
            cancellation.cancel();
            return [
              text(`Here it is:\n${valid}`),
              new vscode.LanguageModelToolCallPart("1", "diagram_getState", {}),
            ];
          },
        ],
        { token: cancellation.token },
      );
      assert.strictEqual(result, undefined);
      assert.strictEqual(shown, "");
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(panel.current, undefined);
    } finally {
      cancellation.dispose();
      panel.dispose();
    }
  });

  test("cancellation during rendering does not start a repair request", async () => {
    const panel = newPanel();
    const cancellation = new vscode.CancellationTokenSource();
    panel.render = async () => {
      cancellation.cancel();
      return { ok: false, kind: "invalid", error: "Invalid diagram" };
    };
    try {
      const { result, shown, sent } = await ask(panel, [[text(invalid)], [text(valid)]], {
        token: cancellation.token,
      });
      assert.strictEqual(result, undefined);
      assert.strictEqual(shown, "");
      assert.strictEqual(sent.length, 1);
    } finally {
      cancellation.dispose();
      panel.dispose();
    }
  });

  test("cancellation stops waiting for an unresponsive diagram panel", async () => {
    const panel = newPanel();
    const cancellation = new vscode.CancellationTokenSource();
    const rendering = Promise.withResolvers<void>();
    const outcome = Promise.withResolvers<Awaited<ReturnType<DiagramPanel["render"]>>>();
    panel.render = () => {
      rendering.resolve();
      return outcome.promise;
    };
    try {
      const response = ask(panel, [[text(valid)]], { token: cancellation.token });
      await rendering.promise;
      cancellation.cancel();
      const { result, sent } = await response;
      assert.strictEqual(result, undefined);
      assert.strictEqual(sent.length, 1);
    } finally {
      outcome.resolve({ ok: true, diagramType: "flowchart" });
      cancellation.dispose();
      panel.dispose();
    }
  });

  for (const phase of ["token counting", "model request", "response stream"] as const) {
    test(`cancellation stops waiting for unresponsive ${phase}`, async () => {
      const panel = newPanel();
      const cancellation = new vscode.CancellationTokenSource();
      const started = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const stall = async (at: typeof phase) => {
        if (at === phase) {
          started.resolve();
          await resume.promise;
        }
      };
      const model = {
        name: "Unresponsive provider",
        maxInputTokens: 2_000,
        countTokens: async () => {
          await stall("token counting");
          return 1;
        },
        sendRequest: async () => {
          await stall("model request");
          return {
            stream: (async function* () {
              await stall("response stream");
              yield text(valid);
            })(),
          };
        },
      } as unknown as vscode.LanguageModelChat;
      try {
        const response = ask(panel, [], { model, token: cancellation.token });
        await started.promise;
        cancellation.cancel();
        const { result, shown } = await response;
        assert.strictEqual(result, undefined);
        assert.strictEqual(shown, "");
        resume.resolve();
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(panel.current, undefined, "Late output must not replace the diagram");
      } finally {
        resume.resolve();
        cancellation.dispose();
        panel.dispose();
      }
    });
  }

  test("cancellation stops waiting for an unresponsive tool", async () => {
    const panel = newPanel();
    const cancellation = new vscode.CancellationTokenSource();
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<vscode.LanguageModelToolResult>();
    const invokeTool = vscode.lm.invokeTool;
    vscode.lm.invokeTool = () => {
      started.resolve();
      return resume.promise;
    };
    try {
      const response = ask(
        panel,
        [[new vscode.LanguageModelToolCallPart("1", "diagram_getState", {})], [text(valid)]],
        { toolReferences: [{ name: "diagram_getState" }], token: cancellation.token },
      );
      await started.promise;
      cancellation.cancel();
      const { result, sent } = await response;
      assert.strictEqual(result, undefined);
      resume.resolve(new vscode.LanguageModelToolResult([]));
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(sent.length, 1, "Late tool results must not start another model request");
      assert.strictEqual(panel.current, undefined);
    } finally {
      resume.resolve(new vscode.LanguageModelToolResult([]));
      vscode.lm.invokeTool = invokeTool;
      cancellation.dispose();
      panel.dispose();
    }
  });

  test("cancellation stops waiting for an attachment and skips subsequent history reads", async () => {
    const panel = newPanel();
    const cancellation = new vscode.CancellationTokenSource();
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<string>();
    const opened: string[] = [];
    const provider = vscode.workspace.registerTextDocumentContentProvider("diagram-cancel-test", {
      provideTextDocumentContent: (uri) => {
        opened.push(uri.path);
        started.resolve();
        return resume.promise;
      },
    });
    const reference = (path: string): vscode.ChatPromptReference => ({
      id: path,
      value: vscode.Uri.parse(`diagram-cancel-test:${path}`),
    });
    try {
      const response = ask(panel, [[text(valid)]], {
        token: cancellation.token,
        references: [reference("/current")],
        history: [
          new RequestTurn("Earlier", undefined, [reference("/history")], "diagram.participant"),
        ],
      });
      await started.promise;
      cancellation.cancel();
      const { result, sent } = await response;
      assert.strictEqual(result, undefined);
      resume.resolve("Late attachment");
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepStrictEqual(opened, ["/current"]);
      assert.deepStrictEqual(sent, []);
    } finally {
      resume.resolve("Late attachment");
      provider.dispose();
      cancellation.dispose();
      panel.dispose();
    }
  });

  test("renders a diagram written next to a tool call, without showing its source", async () => {
    const panel = newPanel();
    try {
      const { result, shown, sent } = await ask(panel, [
        [
          text(`Here it is:\n${valid}\n`),
          new vscode.LanguageModelToolCallPart("1", "diagram_getState", {}),
        ],
        [text("It has two nodes.")],
      ]);
      assert.deepStrictEqual(result?.metadata, {
        language: "mermaid",
        source: "flowchart TD\n  A --> B",
      });
      assert.strictEqual(panel.current?.source, "flowchart TD\n  A --> B");
      assert.strictEqual(shown, "Here it is:\nIt has two nodes.");
      assert.strictEqual(sent.length, 2);
    } finally {
      panel.dispose();
    }
  });

  for (const finalBlock of [false, true]) {
    test(`preserves a tool render ${finalBlock ? "despite a later diagram fence" : "in history"}`, async () => {
      const panel = newPanel();
      const invokeTool = vscode.lm.invokeTool;
      const toolInvocationToken = { requestId: "latest-diagram" } as never;
      const toolDiagram = {
        language: "mermaid",
        source: "flowchart TD\n  Tool --> Result",
        title: "Tool result",
        links: { Tool: { file: "src/tools.ts" } },
      } as const;
      vscode.lm.invokeTool = async () => {
        assert.ok((await panel.render(toolDiagram, "tool", toolInvocationToken)).ok);
        return new vscode.LanguageModelToolResult([text("Rendered the diagram.")]);
      };
      try {
        const { result, shown } = await ask(
          panel,
          [
            [
              text(valid),
              new vscode.LanguageModelToolCallPart("1", "diagram_render", {
                ...toolDiagram,
                links: { Tool: "src/tools.ts" },
              }),
            ],
            [text(finalBlock ? "```mermaid\nflowchart TD\n  Final --> Result\n```" : "Done.")],
          ],
          { toolReferences: [{ name: "diagram_render" }], toolInvocationToken },
        );
        const source = toolDiagram.source;
        assert.strictEqual(panel.current?.source, source);
        assert.strictEqual(result?.metadata?.source, source);
        assert.strictEqual(panel.current?.origin, "participant");
        assert.deepStrictEqual(panel.current?.links, toolDiagram.links);
        assert.doesNotMatch(shown, /flowchart/);
      } finally {
        vscode.lm.invokeTool = invokeTool;
        panel.dispose();
      }
    });
  }

  test("asks the model to fix a diagram that fails to render", async () => {
    const panel = newPanel();
    try {
      const { result, sent } = await ask(panel, [[text(invalid)], [text(`Fixed it.\n${valid}`)]]);
      assert.match(messageText(sent[1]?.messages.at(-1)), /failed to render with this error/);
      assert.strictEqual(result?.metadata?.source, "flowchart TD\n  A --> B");
      assert.strictEqual(panel.current?.error, undefined);
    } finally {
      panel.dispose();
    }
  });

  test("gives up on a diagram that still fails to render, and says so", async () => {
    const panel = newPanel();
    try {
      const gaveUp = await ask(panel, [[text(invalid)], [text("I can't fix it.")]]);
      assert.match(gaveUp.shown, /failed to render: .*Edit source/s);
      assert.strictEqual(gaveUp.result?.metadata?.source, "flowchart TD\n  A --> --> B[");

      const keepsFailing = await ask(panel, [
        [text(invalid)],
        [text(invalid)],
        [text(invalid)],
        [text(valid)],
      ]);
      assert.strictEqual(keepsFailing.sent.length, 3);
      assert.match(keepsFailing.shown, /failed to render: .*Edit source/s);
    } finally {
      panel.dispose();
    }
  });

  test("adopts a diagram that a tool drew for the request, but not one drawn for another", async () => {
    const panel = newPanel();
    try {
      const diagram = {
        language: "mermaid",
        source: "flowchart TD\n  A --> B",
        title: "A",
      } as const;
      const drawFor = (requestId: string) => async () => {
        assert.ok((await panel.render(diagram, "tool", { requestId })).ok);
        return [text("Done.")];
      };
      const toolInvocationToken = { requestId: "this" } as never;
      const other = await ask(panel, [drawFor("other")], { toolInvocationToken });
      assert.strictEqual(other.result, undefined);
      assert.strictEqual(panel.current?.origin, "tool");
      const own = await ask(panel, [drawFor("this")], { toolInvocationToken });
      assert.deepStrictEqual(own.result?.metadata, {
        language: "mermaid",
        source: diagram.source,
      });
      assert.strictEqual(panel.current?.origin, "participant");
    } finally {
      panel.dispose();
    }
  });

  test("makes the model call the tools that the user attached first", async () => {
    const panel = newPanel();
    try {
      const { sent } = await ask(
        panel,
        [[new vscode.LanguageModelToolCallPart("1", "diagram_getState", {})], [text(valid)]],
        { toolReferences: [{ name: "diagram_getState" }] },
      );
      const toolNames = sent.map(({ options }) => options.tools?.map((tool) => tool.name).sort());
      assert.deepStrictEqual(toolNames, [["diagram_getState"], availableDefaults()]);
      assert.deepStrictEqual(
        sent.map(({ options }) => options.toolMode),
        [vscode.LanguageModelChatToolMode.Required, undefined],
      );
      assert.match(
        messageText(sent[1]?.messages.at(-1)),
        /Current Mermaid diagram|No diagram has been rendered/,
      );
    } finally {
      panel.dispose();
    }
  });

  test("does not run tools that the model was not given", async () => {
    const panel = newPanel();
    try {
      const call = new vscode.LanguageModelToolCallPart("1", "unknown_external_tool", {});
      const { sent } = await ask(panel, [[call], [text("Sorry.")]]);
      assert.strictEqual(
        messageText(sent[1]?.messages.at(-1)),
        "The tool unknown_external_tool is not available in this round. Use only the tools you were given.",
      );
    } finally {
      panel.dispose();
    }
  });

  test("keeps attached tools available when the registry returns fresh descriptors", async () => {
    const panel = newPanel();
    const descriptor = Object.getOwnPropertyDescriptor(vscode.lm, "tools");
    assert.ok(descriptor);
    const available = vscode.lm.tools;
    Object.defineProperty(vscode.lm, "tools", {
      configurable: true,
      get: () => available.map((tool) => ({ ...tool })),
    });
    try {
      const call = new vscode.LanguageModelToolCallPart("1", "diagram_getState", {});
      const { sent } = await ask(panel, [[call], [text("Done.")]], {
        toolReferences: [{ name: "diagram_getState" }],
      });
      assert.deepStrictEqual(
        sent[1]?.options.tools?.map((tool) => tool.name).sort(),
        availableDefaults(),
      );
    } finally {
      Object.defineProperty(vscode.lm, "tools", descriptor);
      panel.dispose();
    }
  });

  test("offers all built-in tools by default and only explicitly attached external tools", async () => {
    const panel = newPanel();
    const descriptor = Object.getOwnPropertyDescriptor(vscode.lm, "tools");
    assert.ok(descriptor);
    const names = [...defaultTools, "external_attached", "external_unattached", "diagram_unknown"];
    Object.defineProperty(vscode.lm, "tools", {
      configurable: true,
      get: () => names.map((name) => ({ name, description: name, inputSchema: {} })),
    });
    const invoke = vscode.lm.invokeTool;
    vscode.lm.invokeTool = async () => new vscode.LanguageModelToolResult([text("Done")]);
    try {
      const regular = await ask(panel, [[text("Ready.")]]);
      assert.deepStrictEqual(
        regular.sent[0]?.options.tools?.map((tool) => tool.name).sort(),
        defaultTools,
      );
      const attached = await ask(
        panel,
        [[new vscode.LanguageModelToolCallPart("1", "external_attached", {})], [text("Done.")]],
        { toolReferences: [{ name: "external_attached" }] },
      );
      assert.deepStrictEqual(
        attached.sent[0]?.options.tools?.map((tool) => tool.name),
        ["external_attached"],
      );
      assert.deepStrictEqual(attached.sent[1]?.options.tools?.map((tool) => tool.name).sort(), [
        ...defaultTools,
        "external_attached",
      ]);
    } finally {
      vscode.lm.invokeTool = invoke;
      Object.defineProperty(vscode.lm, "tools", descriptor);
      panel.dispose();
    }
  });

  test("/explain rejects mutating and unknown tools even when explicitly attached", async () => {
    const panel = newPanel();
    await panel.render(
      { language: "mermaid", source: "flowchart TD\n A --> B", title: "Original" },
      "participant",
    );
    const before = panel.current;
    const invoke = vscode.lm.invokeTool;
    let invoked = 0;
    vscode.lm.invokeTool = async () => {
      invoked++;
      return new vscode.LanguageModelToolResult([]);
    };
    try {
      const { sent, result } = await ask(
        panel,
        [
          [
            "diagram_render",
            "diagram_chart",
            "diagram_updateChart",
            "diagram_inspectData",
            "diagram_annotate",
            "diagram_pickNodes",
            "external_tool",
          ].map((name, i) => new vscode.LanguageModelToolCallPart(String(i), name, {})),
          [text(valid)],
        ],
        {
          command: "explain",
          toolReferences: [
            { name: "diagram_render" },
            { name: "diagram_chart" },
            { name: "external_tool" },
          ],
        },
      );
      assert.strictEqual(invoked, 0);
      assert.strictEqual(panel.current, before);
      assert.strictEqual(result, undefined);
      assert.ok(sent[0]?.options.tools?.every((tool) => readOnlyTools.includes(tool.name)));
      assert.strictEqual(sent[0]?.options.toolMode, undefined);
      assert.match(messageText(sent[1]?.messages.at(-1)), /not available/);
    } finally {
      vscode.lm.invokeTool = invoke;
      panel.dispose();
    }
  });

  test("supports extended exploration and stops after twelve tool rounds", async () => {
    const panel = newPanel();
    const invoke = vscode.lm.invokeTool;
    let invoked = 0;
    vscode.lm.invokeTool = async () => {
      invoked++;
      return new vscode.LanguageModelToolResult([text("Read")]);
    };
    try {
      const replies = Array.from({ length: 20 }, (_, i) => [
        new vscode.LanguageModelToolCallPart(String(i), "diagram_getState", {}),
      ]);
      const { sent, shown } = await ask(panel, replies);
      assert.strictEqual(invoked, 12);
      assert.strictEqual(sent.length, 14);
      assert.match(messageText(sent[13]?.messages.at(-1)), /tool round limit/);
      assert.match(shown, /Stopped tool use.*tool round limit/);
    } finally {
      vscode.lm.invokeTool = invoke;
      panel.dispose();
    }
  });

  test("bounds batched tool calls and permits a final explanation", async () => {
    const panel = newPanel();
    const invoke = vscode.lm.invokeTool;
    let invoked = 0;
    vscode.lm.invokeTool = async () => {
      invoked++;
      return new vscode.LanguageModelToolResult([text("Read")]);
    };
    try {
      const calls = Array.from(
        { length: 40 },
        (_, i) => new vscode.LanguageModelToolCallPart(String(i), "diagram_getState", {}),
      );
      const { sent, shown } = await ask(panel, [calls, [text("Exploration stopped.")]]);
      assert.strictEqual(invoked, 32);
      assert.strictEqual(sent.length, 2);
      assert.match(messageText(sent[1]?.messages.at(-1)), /tool call limit/);
      assert.strictEqual(shown, "Exploration stopped.");
    } finally {
      vscode.lm.invokeTool = invoke;
      panel.dispose();
    }
  });

  for (const name of ["Canceled", "CancellationError", "AbortError"]) {
    test(`does not repeat a declined tool (${name}) in the batch or subsequent rounds`, async () => {
      const panel = newPanel();
      const invoke = vscode.lm.invokeTool;
      let invoked = 0;
      vscode.lm.invokeTool = async () => {
        invoked++;
        const error = new Error("Declined");
        error.name = name;
        throw error;
      };
      try {
        const call = (id: string) =>
          new vscode.LanguageModelToolCallPart(id, "diagram_getState", {});
        const { sent, shown } = await ask(panel, [
          [call("1"), call("2")],
          [call("3")],
          [text("Unreachable")],
        ]);
        assert.strictEqual(invoked, 1);
        assert.strictEqual(sent.length, 2);
        assert.match(messageText(sent[1]?.messages.at(-1)), /user declined/);
        assert.match(shown, /Stopped tool use.*user declined/);
      } finally {
        vscode.lm.invokeTool = invoke;
        panel.dispose();
      }
    });
  }

  test("shares the tool budget with rendering repairs", async () => {
    const panel = newPanel();
    const invoke = vscode.lm.invokeTool;
    let invoked = 0;
    vscode.lm.invokeTool = async () => {
      invoked++;
      return new vscode.LanguageModelToolResult([text("Read")]);
    };
    try {
      const calls = Array.from(
        { length: 32 },
        (_, i) => new vscode.LanguageModelToolCallPart(String(i), "diagram_getState", {}),
      );
      const { result, sent } = await ask(panel, [
        calls,
        [text(invalid)],
        [new vscode.LanguageModelToolCallPart("repair", "diagram_getState", {})],
        [text(valid)],
      ]);
      assert.strictEqual(invoked, 32);
      assert.strictEqual(sent.length, 4);
      assert.match(messageText(sent[3]?.messages.at(-1)), /tool call limit/);
      assert.strictEqual(result?.metadata?.source, "flowchart TD\n  A --> B");
    } finally {
      vscode.lm.invokeTool = invoke;
      panel.dispose();
    }
  });

  test("ordinary tool failures can be corrected in a later round", async () => {
    const panel = newPanel();
    const invoke = vscode.lm.invokeTool;
    let invoked = 0;
    vscode.lm.invokeTool = async () => {
      if (++invoked === 1) throw new Error("Invalid input");
      return new vscode.LanguageModelToolResult([text("Read")]);
    };
    try {
      const call = (id: string) => new vscode.LanguageModelToolCallPart(id, "diagram_getState", {});
      const { result, sent } = await ask(panel, [[call("1")], [call("2")], [text("Done.")]]);
      assert.strictEqual(invoked, 2);
      assert.match(messageText(sent[1]?.messages.at(-1)), /tool call failed: Invalid input/);
      assert.strictEqual(result?.errorDetails, undefined);
    } finally {
      vscode.lm.invokeTool = invoke;
      panel.dispose();
    }
  });

  test("adopts chart provenance instead of copying its rendered data into history", async () => {
    const panel = newPanel();
    const invoke = vscode.lm.invokeTool;
    const toolInvocationToken = { requestId: "chart-history" } as never;
    const chart = { data: "name,value\na,1\nb,2", type: "bar" } as const;
    const source =
      '{ "xAxis": { "data": ["a", "b"] }, "yAxis": {}, "series": [{ "type": "bar", "data": [1, 2] }] }';
    vscode.lm.invokeTool = async () => {
      assert.ok(
        (
          await panel.render(
            { language: "echarts", source, title: "Chart", chart },
            "tool",
            toolInvocationToken,
          )
        ).ok,
      );
      return new vscode.LanguageModelToolResult([text("Rendered")]);
    };
    try {
      const { result } = await ask(
        panel,
        [[new vscode.LanguageModelToolCallPart("1", "diagram_chart", chart)], [text(valid)]],
        { toolInvocationToken },
      );
      assert.deepStrictEqual(result?.metadata, { chart });
      assert.strictEqual(panel.current?.source, source);
    } finally {
      vscode.lm.invokeTool = invoke;
      panel.dispose();
    }
  });

  test("required tool rounds run only the tool exposed in that round", async () => {
    const panel = newPanel();
    try {
      const call = new vscode.LanguageModelToolCallPart("1", "diagram_chart", {});
      const { sent } = await ask(panel, [[call], [text("Sorry.")]], {
        toolReferences: [{ name: "diagram_getState" }],
      });
      assert.deepStrictEqual(
        sent[0]?.options.tools?.map((tool) => tool.name),
        ["diagram_getState"],
      );
      assert.strictEqual(
        messageText(sent[1]?.messages.at(-1)),
        "The tool diagram_chart is not available in this round. Use only the tools you were given.",
      );
    } finally {
      panel.dispose();
    }
  });

  test("shortens tool results that don't fit the model's input, and says so", async () => {
    const panel = newPanel();
    try {
      // The tools show the extension's own panel.
      const source = `flowchart TD\n  A --> B\n%% ${"y".repeat(20_000)}`;
      const input = { input: { source }, toolInvocationToken: undefined };
      await vscode.lm.invokeTool("diagram_render", input);
      const maxInputTokens = 4_000;
      const { sent } = await ask(
        panel,
        [[new vscode.LanguageModelToolCallPart("1", "diagram_getState", {})], [text("Hm.")]],
        { toolReferences: [{ name: "diagram_getState" }], maxInputTokens },
      );
      const messages = sent[1]?.messages.map(messageText) ?? [];
      assert.match(messages.at(-1) ?? "", /y\n\n\[truncated: first \d+ of \d+ characters\]$/);
      const tokens = messages.reduce((sum, message) => sum + tokenCount(message) + 4, 0);
      assert.ok(
        tokens > (maxInputTokens * 3) / 4 && tokens <= (maxInputTokens * 7) / 8,
        `${tokens}`,
      );
    } finally {
      panel.dispose();
    }
  });

  test("stops with a clear error when tool rounds exhaust the model's context", async () => {
    const panel = newPanel();
    try {
      const { sent, result } = await ask(
        panel,
        [[text("x".repeat(20_000)), new vscode.LanguageModelToolCallPart("1", "unknown", {})]],
        { maxInputTokens: 4_000 },
      );
      assert.strictEqual(sent.length, 1);
      assert.match(result?.errorDetails?.message ?? "", /too large for Fake.*Start a new chat/);
    } finally {
      panel.dispose();
    }
  });

  test("reports model connection failures as chat errors", async () => {
    const panel = newPanel();
    try {
      const { result } = await ask(panel, [
        async () => {
          throw new Error("Connection lost. Try again.");
        },
      ]);
      assert.strictEqual(result?.errorDetails?.message, "Connection lost. Try again.");
    } finally {
      panel.dispose();
    }
  });

  test("attaches referenced files, selections and text in prompt order", async () => {
    const panel = newPanel();
    try {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
      assert.ok(folder);
      const file = vscode.Uri.joinPath(folder, "sizes.tsv");
      const references = [
        { id: "folder", value: folder },
        { id: "selection", value: new vscode.Location(file, new vscode.Range(1, 0, 2, 0)) },
        { id: "text", value: "some text", modelDescription: "The terminal selection" },
      ].reverse();
      const { sent } = await ask(panel, [[text("Hm.")]], { references });
      const attached = sent[0]?.messages.map(messageText).filter((m) => m.startsWith("Attached"));
      assert.ok(
        attached?.[0]?.startsWith(
          `Attached by the user: ${vscode.workspace.asRelativePath(folder)}, which could not be read: `,
        ),
      );
      assert.deepStrictEqual(
        attached?.slice(1).map((message) => message.split("\n")[0]),
        [
          "Attached by the user: sizes.tsv:2",
          "Attached by the user: text (The terminal selection)",
        ],
      );
    } finally {
      panel.dispose();
    }
  });

  test("shares attachment reads across selections and history, rereading on each request", async () => {
    const panel = newPanel();
    const open = vscode.workspace.openTextDocument;
    const document = await open({ content: "first\nsecond" });
    let reads = 0;
    vscode.workspace.openTextDocument = async () => {
      reads++;
      return document;
    };
    try {
      const references = [
        { id: "file", value: document.uri },
        { id: "line", value: new vscode.Location(document.uri, new vscode.Range(1, 0, 1, 6)) },
      ];
      const history = [
        new RequestTurn("Read it", undefined, references, "diagram.participant", []),
      ];
      for (let request = 1; request <= 2; request++) {
        const { sent } = await ask(panel, [[text("Read.")]], { references, history });
        assert.strictEqual(reads, request);
        const attached = sent[0]?.messages.map(messageText).filter((m) => m.startsWith("Attached"));
        assert.strictEqual(attached?.length, 2);
        assert.ok(attached?.some((text) => text.endsWith("```\nsecond\n```")));
        assert.ok(attached?.some((text) => text.endsWith("```\nfirst\nsecond\n```")));
      }
    } finally {
      vscode.workspace.openTextDocument = open;
      panel.dispose();
    }
  });

  test("shares failed attachment reads without caching them across requests", async () => {
    const panel = newPanel();
    const open = vscode.workspace.openTextDocument;
    let reads = 0;
    vscode.workspace.openTextDocument = async () => {
      reads++;
      throw new Error("File unavailable");
    };
    try {
      const references = [{ id: "file", value: vscode.Uri.file("/unavailable.csv") }];
      const history = [
        new RequestTurn("Read it", undefined, references, "diagram.participant", []),
      ];
      for (let request = 1; request <= 2; request++) {
        const { result, sent } = await ask(panel, [[text("Unavailable.")]], {
          references,
          history,
        });
        assert.strictEqual(reads, request);
        assert.strictEqual(result?.errorDetails, undefined);
        const attached = sent[0]?.messages.map(messageText).filter((m) => m.startsWith("Attached"));
        assert.strictEqual(attached?.length, 1);
        assert.match(attached?.[0] ?? "", /File unavailable/);
      }
    } finally {
      vscode.workspace.openTextDocument = open;
      panel.dispose();
    }
  });

  test("reports attachment read failures without losing the rest of the request", async () => {
    const panel = newPanel();
    const open = vscode.workspace.openTextDocument;
    vscode.workspace.openTextDocument = async () => {
      throw new Error("Permission denied");
    };
    try {
      const { result, sent } = await ask(panel, [[text("Cannot read that file.")]], {
        references: [
          { id: "file", value: vscode.Uri.file("/unreadable.csv") },
          { id: "text", value: "Chart the file when available" },
        ],
      });
      assert.strictEqual(result?.errorDetails, undefined);
      const attached = sent[0]?.messages.map(messageText).filter((m) => m.startsWith("Attached"));
      assert.strictEqual(attached?.length, 2);
      assert.match(
        attached?.[1] ?? "",
        /unreadable\.csv, which could not be read: Permission denied/,
      );
      assert.match(attached?.[0] ?? "", /Chart the file when available/);
    } finally {
      vscode.workspace.openTextDocument = open;
      panel.dispose();
    }
  });

  test("gives the model earlier turns, with their diagrams and attachments", async () => {
    const panel = newPanel();
    try {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
      assert.ok(folder);
      const references = [{ id: "file", value: vscode.Uri.joinPath(folder, "sizes.tsv") }];
      const history = [
        new RequestTurn("Draw #file:sizes.tsv", undefined, references, "diagram.participant", []),
        new ResponseTurn(
          [new vscode.ChatResponseMarkdownPart("Here it is.")],
          { metadata: { language: "mermaid", source: "flowchart TD\n  A --> B" } },
          "diagram.participant",
        ),
      ];
      const { sent, counted } = await ask(panel, [[text("Hm.")]], { history, references });
      // A small prompt fits without counting its tokens.
      assert.strictEqual(counted, 0);
      const messages = sent[0]?.messages.map(messageText).slice(1) ?? [];
      assert.deepStrictEqual(
        messages.map((message) => message.split("\n")[0]),
        ["Draw #file:sizes.tsv", "Here it is.", "Attached by the user: sizes.tsv", "Draw it"],
      );
      assert.strictEqual(messages[1], "Here it is.\n\n```mermaid\nflowchart TD\n  A --> B\n```");
    } finally {
      panel.dispose();
    }
  });

  test("keeps historical chart settings without repeating large inline data", async () => {
    const panel = newPanel();
    try {
      const chart = {
        type: "bar",
        title: "Regional sales",
        labelColumn: "region",
        valueColumns: ["sales"],
        data: `region,sales\n${"Private sample row,42\n".repeat(20_000)}`,
      };
      const history = [
        new RequestTurn("Chart regional sales", undefined, [], "diagram.participant", []),
        new ResponseTurn(
          [new vscode.ChatResponseMarkdownPart("Here are the regional totals.")],
          { metadata: { chart } },
          "diagram.participant",
        ),
      ];
      const { result, sent } = await ask(panel, [[text("The settings are retained.")]], {
        history,
        maxInputTokens: 4_000,
      });
      assert.strictEqual(result?.errorDetails, undefined);
      const messages = sent[0]?.messages.map(messageText) ?? [];
      assert.ok(messages.includes("Chart regional sales"));
      const reply = messages.find((message) => message.startsWith("Here are the regional totals."));
      assert.ok(reply);
      assert.match(reply, /"type":"bar"/);
      assert.match(reply, /"title":"Regional sales"/);
      assert.match(reply, /"labelColumn":"region","valueColumns":\["sales"\]/);
      assert.ok(reply.includes(`inline data: ${chart.data.length} characters`));
      assert.doesNotMatch(messages.join("\n"), /Private sample row/);
      assert.ok(messages.reduce((sum, message) => sum + tokenCount(message) + 4, 0) <= 3_000);
    } finally {
      panel.dispose();
    }
  });

  test("leaves out the oldest turns, and older diagrams first, to fit the model's input", async () => {
    const panel = newPanel();
    try {
      // Each turn takes about 3000 tokens of text and 10000 of diagram, and the prompt may take
      // 3/4 of 41640 tokens: the last two turns fit with their diagrams, and one more without.
      const history = [1, 2, 3, 4].flatMap((n) => [
        new RequestTurn(`Draw ${n}`, undefined, [], "diagram.participant", []),
        new ResponseTurn(
          [new vscode.ChatResponseMarkdownPart(`Reply ${n}: ${"x".repeat(12_000)}`)],
          { metadata: { language: "mermaid", source: `flowchart TD\n%% ${"y".repeat(40_000)}` } },
          "diagram.participant",
        ),
      ]);
      const { sent } = await ask(panel, [[text("Hm.")]], { history, maxInputTokens: 41_640 });
      const messages = sent[0]?.messages.map(messageText).slice(1) ?? [];
      assert.deepStrictEqual(
        messages.map((message) => message.slice(0, 7)),
        ["Draw 2", "Reply 2", "Draw 3", "Reply 3", "Draw 4", "Reply 4", "Draw it"],
      );
      assert.match(messages[1] ?? "", /x\n\n\(I drew a diagram, left out here\.\)$/);
      assert.match(messages[3] ?? "", /y\n```$/);
      assert.match(messages[5] ?? "", /y\n```$/);
    } finally {
      panel.dispose();
    }
  });

  test("counts prose-only history after leaving out a diagram", async () => {
    const panel = newPanel();
    try {
      const history = [
        new RequestTurn("Earlier question", undefined, [], "diagram.participant", []),
        new ResponseTurn(
          [new vscode.ChatResponseMarkdownPart("x".repeat(12_000))],
          {},
          "diagram.participant",
        ),
        new RequestTurn("Draw it", undefined, [], "diagram.participant", []),
        new ResponseTurn(
          [new vscode.ChatResponseMarkdownPart("Here it is.")],
          { metadata: { language: "mermaid", source: "y".repeat(20_000) } },
          "diagram.participant",
        ),
      ];
      const maxInputTokens = 4_000;
      const { sent } = await ask(panel, [[text("Hm.")]], { history, maxInputTokens });
      const messages = sent[0]?.messages.map(messageText) ?? [];
      assert.ok(messages.some((message) => message.includes("I drew a diagram, left out here")));
      assert.ok(!messages.includes("Earlier question"));
      const tokens = messages.reduce((sum, message) => sum + tokenCount(message) + 4, 0);
      assert.ok(tokens <= (maxInputTokens * 3) / 4, `${tokens}`);
    } finally {
      panel.dispose();
    }
  });

  test("counts repeated history once and skips unused shortened replies", async () => {
    const panel = newPanel();
    try {
      const history = [1, 2].flatMap(() => [
        new RequestTurn("Draw it", undefined, [], "diagram.participant", []),
        new ResponseTurn(
          [new vscode.ChatResponseMarkdownPart("Here it is.")],
          { metadata: { language: "mermaid", source: "x".repeat(2_800) } },
          "diagram.participant",
        ),
      ]);
      const { sent, counted } = await ask(panel, [[text("Hm.")]], {
        history,
        maxInputTokens: 4_000,
      });
      const messages = sent[0]?.messages.map(messageText) ?? [];
      assert.strictEqual(
        messages.filter((message) => message.includes("x".repeat(2_800))).length,
        2,
      );
      // Instructions, the shared prompt and the shared complete reply.
      assert.strictEqual(counted, 3);
    } finally {
      panel.dispose();
    }
  });

  test("shortens the attachments that don't fit the model's input, and says so", async () => {
    const panel = newPanel();
    try {
      const references = [
        { id: "long", value: "a".repeat(20_000) },
        { id: "short", value: "short text" },
      ];
      const maxInputTokens = 4_000;
      const { sent } = await ask(panel, [[text("Hm.")]], { references, maxInputTokens });
      const messages = sent[0]?.messages.map(messageText) ?? [];
      assert.ok(messages.includes("Attached by the user: text\n\n```\nshort text\n```"));
      const truncated =
        /^Attached by the user: text, truncated to the first \d+ of its 20000 characters\n\n```\na+\n```$/;
      assert.ok(messages.some((message) => truncated.test(message)));
      const tokens = messages.reduce((sum, message) => sum + tokenCount(message) + 4, 0);
      assert.ok(tokens > maxInputTokens / 2 && tokens <= (maxInputTokens * 3) / 4, `${tokens}`);
    } finally {
      panel.dispose();
    }
  });

  test("says what is too large when the request does not fit the model's input", async () => {
    const panel = newPanel();
    try {
      const prompt = "Draw ".repeat(4_000);
      const { result, sent } = await ask(panel, [], { prompt, maxInputTokens: 4_000 });
      assert.strictEqual(sent.length, 0);
      assert.strictEqual(
        result?.errorDetails?.message,
        "This request exceeds Fake's 3000-token input budget: your message takes 5004 tokens. Shorten your message or choose a model with a larger context.",
      );
    } finally {
      panel.dispose();
    }
  });
});
