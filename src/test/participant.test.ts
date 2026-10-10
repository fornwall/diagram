import * as assert from "node:assert";
import * as vscode from "vscode";
import { ChartTool, UpdateChartTool } from "../chartTools";
import type { DiagramPanel } from "../panel";
import { createParticipantHandler } from "../participant";
import { drawnResult } from "../tools";
import { afterTest, cancellationSource, replace, workspaceRoot } from "./afterTest";
import { type FakeWebview, newFakePanel } from "./newPanel";

type Part = vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart;
/** A model's reply, or a function giving it, e.g. after doing what a tool call would. */
type Reply = Part[] | (() => Promise<Part[]>);

const text = (value: string) => new vscode.LanguageModelTextPart(value);
/** A call of diagram_getState, which a fake model makes. */
const getState = (id = "1") => new vscode.LanguageModelToolCallPart(id, "diagram_getState", {});
/** An image pasted into chat, which chat gives with a ChatReferenceBinaryData. */
const pasted = (mimeType: string, data: Uint8Array) => ({
  id: "pasted",
  value: { mimeType, data: async () => data },
});
const valid = "```mermaid\nflowchart TD\n  A --> B\n```";
const flowchart = {
  language: "mermaid",
  source: "flowchart LR\n  A[Parser] --> B[Checker]",
} as const;
const defaultTools = [
  "diagram_annotate",
  "diagram_chart",
  "diagram_findFiles",
  "diagram_getImage",
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
  "diagram_getImage",
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
const brokenChart = '{"title": {"text": "*a* <b>"}, "series": [1 2]}';
/** The errors that the page reports for the sources that fail to render. */
const renderErrors = new Map([
  ["flowchart TD\n  A --> --> B[", 'Parse error on line 2, column 9: unexpected "-->".'],
  [
    brokenChart,
    'The ECharts option could not be parsed: Missing "," before this element (line 1, column 45).\n' +
      `1 | ${brokenChart}\n` +
      `  | ${" ".repeat(44)}^`,
  ],
]);

// The constructors are hidden from the API, but not at runtime.
type Constructor<T> = new (...args: unknown[]) => T;
const RequestTurn = vscode.ChatRequestTurn as unknown as Constructor<vscode.ChatRequestTurn>;
const ResponseTurn = vscode.ChatResponseTurn as unknown as Constructor<vscode.ChatResponseTurn>;

/** A request to @diagram and its reply in Markdown, as earlier turns of the chat. */
function exchange(
  prompt: string,
  reply: string,
  result: vscode.ChatResult = {},
  {
    command,
    references = [],
  }: { command?: string; references?: vscode.ChatPromptReference[] } = {},
) {
  return [
    new RequestTurn(prompt, command, references, "diagram.participant", []),
    new ResponseTurn(
      [new vscode.ChatResponseMarkdownPart(reply)],
      result,
      "diagram.participant",
      command,
    ),
  ];
}

/** The fake model's token count: about one token per four characters. */
const tokenCount = (text: string) => Math.ceil(text.length / 4);

/** The panel the participant draws in, shown in a page that draws all but {@link renderErrors}. */
let panel: DiagramPanel;

/**
 * Sends a request to the participant, with a model that gives the replies in turn and takes
 * `maxInputTokens`.
 */
async function ask(
  replies: Reply[],
  {
    history = [],
    maxInputTokens = 100_000,
    capabilities = {},
    token = new vscode.CancellationTokenSource().token,
    ...overrides
  }: Partial<
    vscode.ChatRequest &
      vscode.ChatContext & {
        maxInputTokens: number;
        capabilities: object;
        token: vscode.CancellationToken;
      }
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
    capabilities,
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
  const references: string[] = [];
  const stream = new Proxy({} as vscode.ChatResponseStream, {
    get: (_target, method) => (value: unknown) => {
      if (method === "markdown") {
        shown += value;
      } else if (method === "reference") {
        references.push(vscode.workspace.asRelativePath(value as vscode.Uri));
      }
    },
  });
  const result = await createParticipantHandler(panel)(request, { history }, stream, token);
  return { result: result || undefined, shown, sent, counted, references };
}

/**
 * Counts the tools that the participant calls until the test ends, answering the nth call as
 * `answer` says, by default with "Read".
 */
function countToolCalls(
  answer: (call: number) => vscode.LanguageModelToolResult = () =>
    new vscode.LanguageModelToolResult([text("Read")]),
): { count: number } {
  const calls = { count: 0 };
  replace(vscode.lm, "invokeTool", async () => answer(++calls.count));
  return calls;
}

/** The text of a message, including tool results, with data and prompt-tsx parts in brackets. */
function messageText(message: vscode.LanguageModelChatMessage | undefined): string {
  return (message?.content ?? [])
    .flatMap((part) => (part instanceof vscode.LanguageModelToolResultPart ? part.content : [part]))
    .map((part) =>
      part instanceof vscode.LanguageModelTextPart
        ? part.value
        : part instanceof vscode.LanguageModelDataPart
          ? `[${part.mimeType}]`
          : part instanceof vscode.LanguageModelPromptTsxPart
            ? "[prompt-tsx]"
            : "",
    )
    .join("");
}

/** The texts of the attachments among the messages to a model. */
function attachments(messages: vscode.LanguageModelChatMessage[] = []): string[] {
  return messages.map(messageText).filter((message) => message.startsWith("Attached"));
}

suite("participant", () => {
  let webview: FakeWebview;
  setup(async () => {
    ({ panel, webview } = await newFakePanel());
    webview.answer = (message) => {
      if (message.type !== "render") return undefined;
      const { requestId } = message;
      const error = renderErrors.get(message.source);
      return error === undefined
        ? { type: "rendered", requestId, diagramType: "test" }
        : { type: "renderError", requestId, message: error };
    };
  });

  test("a cancelled request does not contact the model", async () => {
    const cancellation = cancellationSource();
    cancellation.cancel();
    const { result, shown, sent } = await ask([[text(valid)]], { token: cancellation.token });
    assert.strictEqual(result, undefined);
    assert.strictEqual(shown, "");
    assert.deepStrictEqual(sent, []);
    assert.strictEqual(panel.current, undefined);
  });

  test("ignores model output arriving after cancellation", async () => {
    const cancellation = cancellationSource();
    const { result, shown, sent } = await ask(
      [
        async () => {
          cancellation.cancel();
          return [text(`Here it is:\n${valid}`), getState()];
        },
      ],
      { token: cancellation.token },
    );
    assert.strictEqual(result, undefined);
    assert.strictEqual(shown, "");
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(panel.current, undefined);
  });

  test("cancellation during rendering does not start a repair request", async () => {
    const cancellation = cancellationSource();
    panel.render = async () => {
      cancellation.cancel();
      return { ok: false, kind: "invalid", error: "Invalid diagram", revision: 1 };
    };
    const { result, shown, sent } = await ask([[text(invalid)], [text(valid)]], {
      token: cancellation.token,
    });
    assert.strictEqual(result, undefined);
    assert.strictEqual(shown, "");
    assert.strictEqual(sent.length, 1);
  });

  test("cancellation stops waiting for an unresponsive diagram panel", async () => {
    const cancellation = cancellationSource();
    const rendering = Promise.withResolvers<void>();
    const outcome = Promise.withResolvers<Awaited<ReturnType<DiagramPanel["render"]>>>();
    afterTest(() => outcome.resolve({ ok: true, diagramType: "flowchart", revision: 1 }));
    panel.render = () => {
      rendering.resolve();
      return outcome.promise;
    };
    const response = ask([[text(valid)]], { token: cancellation.token });
    await rendering.promise;
    cancellation.cancel();
    const { result, sent } = await response;
    assert.strictEqual(result, undefined);
    assert.strictEqual(sent.length, 1);
  });

  for (const phase of ["token counting", "model request", "response stream"] as const) {
    test(`cancellation stops waiting for unresponsive ${phase}`, async () => {
      const cancellation = cancellationSource();
      const started = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      afterTest(() => resume.resolve());
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
      const response = ask([], { model, token: cancellation.token });
      await started.promise;
      cancellation.cancel();
      const { result, shown } = await response;
      assert.strictEqual(result, undefined);
      assert.strictEqual(shown, "");
      resume.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(panel.current, undefined, "Late output must not replace the diagram");
    });
  }

  test("cancellation stops waiting for an unresponsive tool", async () => {
    const cancellation = cancellationSource();
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<vscode.LanguageModelToolResult>();
    afterTest(() => resume.resolve(new vscode.LanguageModelToolResult([])));
    replace(vscode.lm, "invokeTool", () => {
      started.resolve();
      return resume.promise;
    });
    const response = ask([[getState()], [text(valid)]], {
      toolReferences: [{ name: "diagram_getState" }],
      token: cancellation.token,
    });
    await started.promise;
    cancellation.cancel();
    const { result, sent } = await response;
    assert.strictEqual(result, undefined);
    resume.resolve(new vscode.LanguageModelToolResult([]));
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(sent.length, 1, "Late tool results must not start another model request");
    assert.strictEqual(panel.current, undefined);
  });

  test("cancellation stops waiting for an attachment and skips subsequent history reads", async () => {
    const cancellation = cancellationSource();
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<string>();
    afterTest(() => resume.resolve("Late attachment"));
    const opened: string[] = [];
    const provider = vscode.workspace.registerTextDocumentContentProvider("diagram-cancel-test", {
      provideTextDocumentContent: (uri) => {
        opened.push(uri.path);
        started.resolve();
        return resume.promise;
      },
    });
    afterTest(() => provider.dispose());
    const reference = (path: string): vscode.ChatPromptReference => ({
      id: path,
      value: vscode.Uri.parse(`diagram-cancel-test:${path}`),
    });
    const response = ask([[text(valid)]], {
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
  });

  test("/show and /explain need a diagram, and say so without asking the model; /show keeps the focus in chat", async () => {
    const shown: boolean[] = [];
    panel.show = (preserveFocus = false) => void shown.push(preserveFocus);
    for (const [command, reply] of [
      ["show", "There is no diagram yet. Describe what you want me to draw."],
      ["explain", "There is no diagram to explain yet. Describe what you want me to draw."],
    ]) {
      const asked = await ask([[text("Unexpected")]], { command });
      assert.deepStrictEqual([asked.shown, asked.sent, asked.result], [reply, [], undefined]);
    }
    assert.deepStrictEqual(shown, []);
    assert.ok((await panel.render({ ...flowchart, title: "Flow" }, "tool")).ok);
    const asked = await ask([[text("Unexpected")]], { command: "show" });
    // Leaving the focus in chat.
    assert.deepStrictEqual(
      [asked.shown, asked.sent, shown],
      ["Opened the diagram panel.", [], [true]],
    );
  });

  test("/new leaves the current diagram out of the request, and asks for a new one", async () => {
    assert.ok((await panel.render({ ...flowchart, title: "Flow" }, "tool")).ok);
    const prompt = (command?: string, history: vscode.ChatContext["history"] = []) =>
      ask([[text("Hm.")]], { command, history }).then(({ sent }) =>
        (sent[0]?.messages ?? []).map(messageText),
      );
    assert.ok((await prompt()).join("\n").includes(flowchart.source));
    // The earlier diagram is in the history, which the model is not to change.
    const history = exchange("Chart it", "Here.", { metadata: flowchart }, { command: "new" });
    const messages = await prompt("new", history);
    assert.ok(!messages.slice(3).join("\n").includes(flowchart.source));
    assert.deepStrictEqual([messages[1], messages.at(-1)], ["/new Chart it", "/new Draw it"]);
  });

  test("tells the page a follow-up's diagram for a revision, and that of /new for another", async () => {
    const drawn = () =>
      webview.sent.flatMap((message) => (message.type === "render" ? [message.diagram] : []));
    await ask([[text(valid)]]);
    await ask([[text(valid.replace("A --> B", "A --> B\n  B --> A"))]]);
    // A /new that draws nothing leaves the next follow-up a revision.
    await ask([[text("Nothing to draw.")]], { command: "new" });
    await ask([[text(valid)]]);
    // Under the same title, which untitled diagrams of a type have.
    await ask([[text(valid)]], { command: "new" });
    const [first, revision, later, another] = drawn();
    assert.deepStrictEqual([revision, later], [first, first]);
    assert.notStrictEqual(another, first);
  });

  test("keeps a diagram the panel could not show, and says why", async () => {
    webview.deliver = (message) => message.type !== "render";
    const { result, shown, sent } = await ask([[text(`Here it is:\n${valid}`)]]);
    assert.strictEqual(sent.length, 1);
    assert.match(shown, /\n\nThe diagram panel is unavailable\.$/);
    assert.deepStrictEqual(result?.metadata, {
      language: "mermaid",
      source: "flowchart TD\n  A --> B",
    });
  });

  test("says when a reply ends inside a diagram, and draws nothing", async () => {
    const { result, shown } = await ask([[text("Here:\n```mermaid\nflowchart TD\n  A --> B")]]);
    assert.strictEqual(result, undefined);
    assert.strictEqual(panel.current, undefined);
    assert.match(shown, /The reply ended before the diagram was complete\./);
  });

  test("renders a diagram written next to a tool call, without showing its source", async () => {
    const { result, shown, sent } = await ask([
      [text(`Here it is:\n${valid}\n`), getState()],
      [text("It has two nodes.")],
    ]);
    assert.deepStrictEqual(result?.metadata, {
      language: "mermaid",
      source: "flowchart TD\n  A --> B",
    });
    assert.strictEqual(panel.current?.source, "flowchart TD\n  A --> B");
    assert.strictEqual(shown, "Here it is:\nIt has two nodes.");
    assert.strictEqual(sent.length, 2);
  });

  for (const finalBlock of [false, true]) {
    test(`preserves a tool render ${finalBlock ? "despite a later diagram fence" : "in history"}`, async () => {
      const toolDiagram = {
        language: "mermaid",
        source: "flowchart TD\n  Tool --> Result",
        title: "Tool result",
        links: { Tool: { file: "src/tools.ts" } },
      } as const;
      replace(vscode.lm, "invokeTool", async () => {
        const outcome = await panel.render(toolDiagram, "tool");
        assert.ok(outcome.ok);
        return drawnResult("Rendered the diagram.", outcome.revision);
      });
      const { result, shown } = await ask(
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
        { toolReferences: [{ name: "diagram_render" }] },
      );
      const source = toolDiagram.source;
      assert.strictEqual(panel.current?.source, source);
      assert.strictEqual(result?.metadata?.source, source);
      assert.strictEqual(panel.current?.origin, "participant");
      assert.deepStrictEqual(panel.current?.links, toolDiagram.links);
      assert.doesNotMatch(shown, /flowchart/);
    });
  }

  test("asks the model to fix a diagram that fails to render", async () => {
    const { result, sent } = await ask([[text(invalid)], [text(`Fixed it.\n${valid}`)]]);
    assert.match(messageText(sent[1]?.messages.at(-1)), /failed to render with this error/);
    assert.strictEqual(result?.metadata?.source, "flowchart TD\n  A --> B");
    assert.strictEqual(panel.current?.error, undefined);
  });

  test("gives up on a diagram that still fails to render, and says so", async () => {
    const gaveUp = await ask([[text(invalid)], [text("I can't fix it.")]]);
    assert.match(
      gaveUp.shown,
      /failed to render: Parse error on line 2, column 9: unexpected "--\\>"\.\n\n.*source view/,
    );
    assert.strictEqual(gaveUp.result?.metadata?.source, "flowchart TD\n  A --> --> B[");
  });

  test("shows a render error as Markdown, with its source excerpt in a code block, after three tries", async () => {
    const broken = text(`\`\`\`echarts\n${brokenChart}\n\`\`\``);
    const { sent, shown } = await ask([[broken], [broken], [broken], [text(valid)]]);
    assert.strictEqual(sent.length, 3);
    assert.ok(
      shown.endsWith(
        'The chart failed to render: The ECharts option could not be parsed: Missing "," before this element (line 1, column 45).\n\n' +
          '```\n1 | {"title": {"text": "*a* <b>"}, "series": [1 2]}\n' +
          "  |                                             ^\n```\n\n" +
          "You can fix it in the source view of the diagram panel, which the `</>` button at its top right opens.",
      ),
      shown,
    );
  });

  test("adopts a diagram that its own tool call drew, unless it was drawn over since", async () => {
    /** Draws as a tool does, for this request or, while the model replies, for another. */
    const draw = async (source: string) => {
      const outcome = await panel.render({ language: "mermaid", source, title: "A" }, "tool");
      assert.ok(outcome.ok);
      return outcome.revision;
    };
    const reply = (source: string) => async () => {
      await draw(source);
      return [text("Done.")];
    };
    const other = await ask([reply("flowchart TD\n  Other")]);
    assert.strictEqual(other.result, undefined);
    assert.strictEqual(panel.current?.origin, "tool");

    // The call draws its own diagram, after or before another request draws during it.
    let otherFirst = true;
    replace(vscode.lm, "invokeTool", async () => {
      if (otherFirst) await draw("flowchart TD\n  Meanwhile");
      const revision = await draw("flowchart TD\n  Own");
      if (!otherFirst) await draw("flowchart TD\n  Meanwhile");
      return drawnResult("Rendered.", revision);
    });
    const render = new vscode.LanguageModelToolCallPart("1", "diagram_render", {});
    const own = await ask([[render], [text("Done.")]]);
    assert.deepStrictEqual(own.result?.metadata, {
      language: "mermaid",
      source: "flowchart TD\n  Own",
    });
    assert.strictEqual(panel.current?.origin, "participant");

    otherFirst = false;
    const drawnDuring = await ask([[render], [text("Done.")]]);
    assert.strictEqual(drawnDuring.result, undefined);
    assert.strictEqual(panel.current?.source, "flowchart TD\n  Meanwhile");
    assert.strictEqual(panel.current?.origin, "tool");

    otherFirst = true;
    const drawnOver = await ask([[render], reply("flowchart TD\n  Later")]);
    assert.strictEqual(drawnOver.result, undefined);
    assert.strictEqual(panel.current?.source, "flowchart TD\n  Later");
    assert.strictEqual(panel.current?.origin, "tool");
  });

  test("draws its diagram block although another request drew during the reply", async () => {
    const other = { language: "mermaid", source: "flowchart TD\n  Other", title: "A" } as const;
    const expected = { language: "mermaid", source: "flowchart TD\n  A --> B" };
    const drawn = await ask([
      async () => {
        await panel.render(other, "tool");
        return [text(valid)];
      },
    ]);
    assert.deepStrictEqual(drawn.result?.metadata, expected);
    assert.strictEqual(panel.current?.source, expected.source);

    // Also over what its own tool call failed to draw, which the other request drew over.
    replace(vscode.lm, "invokeTool", async () => {
      const outcome = await panel.render(
        { ...other, source: "flowchart TD\n  A --> --> B[" },
        "tool",
      );
      assert.ok(!outcome.ok);
      await panel.render(other, "tool");
      return drawnResult("Failed.", outcome.revision);
    });
    const render = new vscode.LanguageModelToolCallPart("1", "diagram_render", {});
    const repaired = await ask([[render], [text(valid)]]);
    assert.deepStrictEqual(repaired.result?.metadata, expected);
    assert.strictEqual(panel.current?.source, expected.source);
  });

  test("leaves its diagram block undrawn over what the user changed during the reply", async () => {
    const edited = "flowchart TD\n  Edited";
    const opened = { language: "mermaid", source: "flowchart TD\n  Opened", title: "A" } as const;
    const changes: [string, () => Promise<unknown>][] = [
      [edited, () => webview.edit(edited)],
      [opened.source, () => panel.render(opened, "document")],
    ];
    assert.ok((await panel.render(opened, "tool")).ok);
    for (const [source, change] of changes) {
      const { result, shown } = await ask([
        async () => {
          await change();
          return [text(`Here:\n${valid}`)];
        },
      ]);
      assert.strictEqual(result, undefined);
      assert.strictEqual(panel.current?.source, source);
      assert.strictEqual(
        shown,
        "Here:\n\n\nI did not draw this diagram over the change you made in the panel meanwhile. Ask again to draw it.",
      );
    }
  });

  test("makes the model call the tools that the user attached first, whose descriptors may be new objects", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(vscode.lm, "tools");
    assert.ok(descriptor);
    const available = vscode.lm.tools;
    // As the registry returns them.
    Object.defineProperty(vscode.lm, "tools", {
      configurable: true,
      get: () => available.map((tool) => ({ ...tool })),
    });
    afterTest(() => Object.defineProperty(vscode.lm, "tools", descriptor));
    const { sent } = await ask([[getState()], [text(valid)]], {
      toolReferences: [{ name: "diagram_getState" }],
    });
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
  });

  test("gives a model that does not accept images no tool to view the diagram with", async () => {
    const { sent, shown } = await ask([[text(valid)]], {
      capabilities: { supportsImageToText: false },
      toolReferences: [{ name: "diagram_getImage" }],
    });
    assert.deepStrictEqual(
      sent.map(({ options }) => [options.tools?.map((tool) => tool.name).sort(), options.toolMode]),
      [[availableDefaults().filter((name) => name !== "diagram_getImage"), undefined]],
    );
    assert.match(shown, /^Fake does not accept images, so it cannot view the diagram\.\n\n/);
  });

  test("gives a model that cannot call tools none, and draws its diagram block", async () => {
    // The source is too long to give, and the model cannot call a tool for it either.
    const long = `flowchart TD\n${"  A --> B\n".repeat(4_000)}`;
    assert.ok(
      (await panel.render({ language: "mermaid", source: long, title: "Long" }, "tool")).ok,
    );
    const { sent, shown, result } = await ask([[text(`Here it is:\n${valid}`)]], {
      capabilities: { supportsToolCalling: false },
      toolReferences: [{ name: "diagram_getState" }],
    });
    assert.deepStrictEqual(
      sent.map(({ options }) => [options.tools, options.toolMode]),
      [[[], undefined]],
    );
    const prompt = sent[0]?.messages.map(messageText).join("\n") ?? "";
    assert.match(prompt, /Reply with one complete diagram in a mermaid or echarts code block/);
    assert.match(prompt, /The source is [\d,]+ characters long, too long to show here\./);
    assert.doesNotMatch(prompt, /diagram_|Revision/);
    assert.match(shown, /^Fake cannot call tools, so the attached tools are left out\.\n\n/);
    assert.strictEqual(result?.metadata?.source, "flowchart TD\n  A --> B");
    // Nor is it told that it has tools to explain a diagram with.
    const explained = await ask([[text("It flows.")]], {
      command: "explain",
      capabilities: { supportsToolCalling: false },
    });
    const instructions = messageText(explained.sent[0]?.messages[0]);
    assert.match(instructions, /^You are @diagram in VS Code\. Explain/);
    assert.doesNotMatch(instructions, /the available tools/);
  });

  test("offers all built-in tools by default and only explicitly attached external tools", async () => {
    const names = [...defaultTools, "external_attached", "external_unattached", "diagram_unknown"];
    replace(
      vscode.lm,
      "tools",
      names.map((name) => ({ name, description: name, inputSchema: {}, tags: [] })),
    );
    countToolCalls();
    const regular = await ask([[text("Ready.")]]);
    assert.deepStrictEqual(
      regular.sent[0]?.options.tools?.map((tool) => tool.name).sort(),
      defaultTools,
    );
    const attached = await ask(
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
  });

  test("/explain rejects mutating and unknown tools even when explicitly attached", async () => {
    await panel.render(
      { language: "mermaid", source: "flowchart TD\n A --> B", title: "Original" },
      "participant",
    );
    const before = panel.current;
    const calls = countToolCalls();
    const { sent, result, shown } = await ask(
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
    assert.match(
      shown,
      /^\/explain uses only the tools that read the diagram and the workspace, so it leaves out the attached `diagram_render`, `diagram_chart` and `external_tool`\.\n\n/,
    );
    assert.strictEqual(calls.count, 0);
    assert.strictEqual(panel.current, before);
    assert.strictEqual(result, undefined);
    assert.ok(sent[0]?.options.tools?.every((tool) => readOnlyTools.includes(tool.name)));
    assert.strictEqual(sent[0]?.options.toolMode, undefined);
    // Not "in this round", as no round of the request offers them.
    assert.match(
      messageText(sent[1]?.messages.at(-1)),
      /^The tool diagram_render is not available\. Use only the tools you were given\./,
    );
  });

  test("stops calling tools after twelve rounds, and says so", async () => {
    const calls = countToolCalls();
    const replies = Array.from({ length: 20 }, (_, i) => [getState(String(i))]);
    const { sent, shown } = await ask(replies);
    assert.strictEqual(calls.count, 12);
    assert.strictEqual(sent.length, 14);
    assert.match(messageText(sent[13]?.messages.at(-1)), /tool round limit/);
    assert.match(shown, /Stopped tool use.*tool round limit/);
  });

  test("runs at most 32 tool calls, then lets the model answer", async () => {
    const calls = countToolCalls();
    const batch = Array.from({ length: 40 }, (_, i) => getState(String(i)));
    const { sent, shown } = await ask([batch, [text("Exploration stopped.")]]);
    assert.strictEqual(calls.count, 32);
    assert.strictEqual(sent.length, 2);
    assert.match(messageText(sent[1]?.messages.at(-1)), /tool call limit/);
    assert.strictEqual(shown, "Exploration stopped.");
  });

  for (const name of ["Canceled", "CancellationError", "AbortError"]) {
    test(`does not repeat a declined tool (${name}) in the batch or subsequent rounds`, async () => {
      const calls = countToolCalls(() => {
        const error = new Error("Declined");
        error.name = name;
        throw error;
      });
      const { sent, shown } = await ask([
        [getState("1"), getState("2")],
        [getState("3")],
        [text("Unreachable")],
      ]);
      assert.strictEqual(calls.count, 1);
      assert.strictEqual(sent.length, 2);
      assert.match(messageText(sent[1]?.messages.at(-1)), /user declined/);
      assert.match(shown, /Stopped tool use.*user declined/);
    });
  }

  test("shares the tool budget with rendering repairs", async () => {
    const calls = countToolCalls();
    const batch = Array.from({ length: 32 }, (_, i) => getState(String(i)));
    const { result, sent } = await ask([
      batch,
      [text(invalid)],
      [getState("repair")],
      [text(valid)],
    ]);
    assert.strictEqual(calls.count, 32);
    assert.strictEqual(sent.length, 4);
    assert.match(messageText(sent[3]?.messages.at(-1)), /tool call limit/);
    assert.strictEqual(result?.metadata?.source, "flowchart TD\n  A --> B");
  });

  test("gives the model a failed tool call's error to correct in the next round", async () => {
    const calls = countToolCalls((call) => {
      if (call === 1) throw new Error("Invalid input");
      return new vscode.LanguageModelToolResult([text("Read")]);
    });
    const { result, sent } = await ask([[getState("1")], [getState("2")], [text("Done.")]]);
    assert.strictEqual(calls.count, 2);
    assert.match(messageText(sent[1]?.messages.at(-1)), /tool call failed: Invalid input/);
    assert.strictEqual(result?.errorDetails, undefined);
  });

  test("adopts chart provenance instead of copying its rendered data into history", async () => {
    const chart = { data: "name,value\na,1\nb,2", type: "bar" } as const;
    const source =
      '{ "xAxis": { "data": ["a", "b"] }, "yAxis": {}, "series": [{ "type": "bar", "data": [1, 2] }] }';
    replace(vscode.lm, "invokeTool", async () => {
      const outcome = await panel.render(
        { language: "echarts", source, title: "Chart", chart },
        "tool",
      );
      assert.ok(outcome.ok);
      return drawnResult("Rendered", outcome.revision);
    });
    const { result } = await ask([
      [new vscode.LanguageModelToolCallPart("1", "diagram_chart", chart)],
      [text(valid)],
    ]);
    assert.deepStrictEqual(result?.metadata, { chart });
    assert.strictEqual(panel.current?.source, source);
  });

  test("does not adopt the chart that a failed update keeps", async () => {
    const chart = { data: "name,value\na,1\nb,2", type: "bar" } as const;
    const tools = new Map<string, vscode.LanguageModelTool<object>>([
      ["diagram_chart", new ChartTool(panel)],
      ["diagram_updateChart", new UpdateChartTool(panel)],
    ]);
    replace(vscode.lm, "invokeTool", async (name, options, token) => {
      const result = await tools
        .get(name)
        ?.invoke(options, token ?? new vscode.CancellationTokenSource().token);
      return result ?? assert.fail(`Unexpected tool ${name}`);
    });
    const invocation = { input: chart, toolInvocationToken: undefined };
    await vscode.lm.invokeTool("diagram_chart", invocation);
    assert.strictEqual(panel.current?.origin, "tool");
    const revision = panel.revision;
    // The page fails the updated chart, and then draws the kept one again.
    webview.failNextRender("Bad option");
    const update = new vscode.LanguageModelToolCallPart("1", "diagram_updateChart", {
      type: "line",
    });
    const { result, sent } = await ask([[update], [text("It failed.")]]);
    assert.match(messageText(sent[1]?.messages.at(-1)), /The chart was not updated: Bad option/);
    assert.ok(panel.revision > revision + 1, "The kept chart is drawn again");
    assert.strictEqual(result, undefined);
    assert.strictEqual(panel.current?.origin, "tool");
    assert.strictEqual(panel.current?.chart?.type, "bar");
  });

  test("lists the workspace files that its tool calls read as references, once each", async () => {
    countToolCalls(
      (call) =>
        new vscode.LanguageModelToolResult([text(call === 2 ? "Error: Not found." : "Read")]),
    );
    const read = (id: string, file: string) =>
      new vscode.LanguageModelToolCallPart(id, "diagram_readFile", { file });
    const { references } = await ask([
      [read("1", "src/a.ts"), read("2", "src/missing.ts"), read("3", "src/a.ts")],
      [text("Done.")],
    ]);
    assert.deepStrictEqual(references, ["src/a.ts"]);
  });

  test("runs only the attached tool in the round that must call it", async () => {
    const call = new vscode.LanguageModelToolCallPart("1", "diagram_chart", {});
    const { sent } = await ask([[call], [text("Sorry.")]], {
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
  });

  test("shortens tool results that don't fit the model's input, and says so", async () => {
    const source = `flowchart TD\n  A --> B\n%% ${"y".repeat(20_000)}`;
    countToolCalls(() => new vscode.LanguageModelToolResult([text(source)]));
    const maxInputTokens = 4_000;
    const { sent } = await ask([[getState()], [text("Hm.")]], {
      toolReferences: [{ name: "diagram_getState" }],
      maxInputTokens,
    });
    const messages = sent[1]?.messages.map(messageText) ?? [];
    assert.match(messages.at(-1) ?? "", /y\n\n\[truncated: first [\d,]+ of [\d,]+ characters\]$/);
    const tokens = messages.reduce((sum, message) => sum + tokenCount(message) + 4, 0);
    assert.ok(tokens > (maxInputTokens * 3) / 4 && tokens <= (maxInputTokens * 7) / 8, `${tokens}`);
  });

  test("tells the tools the tokens left for their results, shared by the calls of a round", async () => {
    const budgets: number[] = [];
    replace(vscode.lm, "invokeTool", async (_name, { tokenizationOptions }) => {
      budgets.push(tokenizationOptions?.tokenBudget ?? 0);
      assert.strictEqual(await tokenizationOptions?.countTokens("12345678"), 2);
      return new vscode.LanguageModelToolResult([text("Read")]);
    });
    await ask([[getState("1")], [getState("2"), getState("3")], [text("Done.")]], {
      maxInputTokens: 10_000,
    });
    const [first = 0, second = 0, third] = budgets;
    // Up to 7/8 of the input, less the request so far.
    assert.ok(first > 5_000 && first < 8_750, `${first}`);
    assert.ok(second < first / 2, `${second}`);
    assert.strictEqual(third, second);
  });

  test("counts tool results that are not text, and leaves out or shortens those that don't fit", async () => {
    const small = new vscode.LanguageModelPromptTsxPart({ text: "small" });
    countToolCalls(
      () =>
        new vscode.LanguageModelToolResult([
          small,
          new vscode.LanguageModelPromptTsxPart({ text: "x".repeat(20_000) }),
          vscode.LanguageModelDataPart.json({ rows: "z".repeat(20_000) }),
          text("ok"),
          vscode.LanguageModelDataPart.image(new Uint8Array(4 * 1024 * 1024), "image/png"),
        ]),
    );
    const { sent } = await ask([[getState()], [text("Hm.")]], {
      toolReferences: [{ name: "diagram_getState" }],
      maxInputTokens: 4_000,
    });
    const [result] = (sent[1]?.messages.at(-1)?.content ??
      []) as vscode.LanguageModelToolResultPart[];
    const [kept, leftOut, shortened, ok, image] = result?.content ?? [];
    assert.strictEqual(kept, small);
    assert.deepStrictEqual(
      leftOut,
      new vscode.LanguageModelTextPart(
        "[left out: a prompt-tsx part, too large for the model's input]",
      ),
    );
    assert.ok(shortened instanceof vscode.LanguageModelTextPart);
    assert.match(
      shortened.value,
      /"rows": ?"z+\n\n\[truncated: first [\d,]+ of 20,0\d\d characters\]$/,
    );
    assert.deepStrictEqual(ok, text("ok"));
    assert.deepStrictEqual(
      image,
      text("[left out: an image of 4.0 MiB, more than the 3 MiB limit]"),
    );
  });

  test("leaves out the images of tool results for a model that does not accept images", async () => {
    const image = vscode.LanguageModelDataPart.image(new Uint8Array(8), "image/png");
    countToolCalls(() => new vscode.LanguageModelToolResult([image]));
    const { sent } = await ask([[getState()], [text("Hm.")]], {
      capabilities: { supportsImageToText: false },
    });
    assert.strictEqual(
      messageText(sent[1]?.messages.at(-1)),
      "[left out: an image, as Fake does not accept images]",
    );
  });

  test("stops with a clear error when tool rounds exhaust the model's context", async () => {
    const { sent, result } = await ask(
      [[text("x".repeat(20_000)), new vscode.LanguageModelToolCallPart("1", "unknown", {})]],
      { maxInputTokens: 4_000 },
    );
    assert.strictEqual(sent.length, 1);
    assert.match(result?.errorDetails?.message ?? "", /too large for Fake.*Start a new chat/);
  });

  test("reports model connection failures as chat errors", async () => {
    const { result } = await ask([
      async () => {
        throw new Error("Connection lost. Try again.");
      },
    ]);
    assert.strictEqual(result?.errorDetails?.message, "Connection lost. Try again.");
  });

  test("attaches referenced files, selections and text in prompt order", async () => {
    const folder = workspaceRoot().uri;
    const file = vscode.Uri.joinPath(folder, "sizes.tsv");
    const references = [
      { id: "folder", value: folder },
      { id: "selection", value: new vscode.Location(file, new vscode.Range(1, 0, 2, 0)) },
      { id: "lines", value: new vscode.Location(file, new vscode.Range(1, 2, 2, 1)) },
      { id: "text", value: "some text", modelDescription: "The terminal selection" },
    ].reverse();
    const { sent } = await ask([[text("Hm.")]], { references });
    const attached = attachments(sent[0]?.messages);
    assert.ok(
      attached?.[0]?.startsWith(
        `Attached by the user: ${vscode.workspace.asRelativePath(folder)}, which could not be read: `,
      ),
    );
    assert.deepStrictEqual(
      attached?.slice(1).map((message) => message.split("\n")[0]),
      [
        "Attached by the user: sizes.tsv:2",
        "Attached by the user: sizes.tsv:2-3",
        "Attached by the user: text (The terminal selection)",
      ],
    );
  });

  test("shares attachment reads across selections and history, rereading on each request", async () => {
    const document = await vscode.workspace.openTextDocument({ content: "first\nsecond" });
    let reads = 0;
    replace(vscode.workspace, "openTextDocument", (async () => {
      reads++;
      return document;
    }) as typeof vscode.workspace.openTextDocument);
    const references = [
      { id: "file", value: document.uri },
      { id: "line", value: new vscode.Location(document.uri, new vscode.Range(1, 0, 1, 6)) },
    ];
    const history = [new RequestTurn("Read it", undefined, references, "diagram.participant", [])];
    for (let request = 1; request <= 2; request++) {
      const { sent } = await ask([[text("Read.")]], { references, history });
      assert.strictEqual(reads, request);
      const attached = attachments(sent[0]?.messages);
      assert.strictEqual(attached.length, 2);
      assert.ok(attached.some((text) => text.endsWith("```\nsecond\n```")));
      assert.ok(attached.some((text) => text.endsWith("```\nfirst\nsecond\n```")));
    }
  });

  test("shares failed attachment reads without caching them across requests", async () => {
    let reads = 0;
    replace(vscode.workspace, "openTextDocument", async () => {
      reads++;
      throw new Error("File unavailable");
    });
    const references = [{ id: "file", value: vscode.Uri.file("/unavailable.csv") }];
    const history = [new RequestTurn("Read it", undefined, references, "diagram.participant", [])];
    for (let request = 1; request <= 2; request++) {
      const { result, sent } = await ask([[text("Unavailable.")]], { references, history });
      assert.strictEqual(reads, request);
      assert.strictEqual(result?.errorDetails, undefined);
      assert.deepStrictEqual(attachments(sent[0]?.messages), [
        "Attached by the user, but not read: /unavailable.csv does not exist.",
      ]);
    }
  });

  test("points the model to the workspace tools for an attached folder", async () => {
    const root = workspaceRoot().uri;
    const folder = vscode.Uri.joinPath(root, "attached-folder");
    await vscode.workspace.fs.createDirectory(folder);
    afterTest(() => vscode.workspace.fs.delete(folder, { recursive: true }));
    const { sent, shown } = await ask([[text("Exploring.")]], {
      references: [{ id: "folder", value: folder }],
    });
    assert.strictEqual(shown, "Exploring.");
    const attached = attachments(sent[0]?.messages)[0];
    assert.match(
      attached ?? "",
      /attached-folder, which could not be read: it is a folder; list its files with diagram_findFiles and the glob "attached-folder\/\*\*"$/,
    );
    // A model that calls no tools cannot list them, so the user is told it was left out.
    const toolless = await ask([[text(valid)]], {
      references: [{ id: "folder", value: folder }],
      capabilities: { supportsToolCalling: false },
    });
    assert.match(
      toolless.shown,
      /^Left out attached-folder: it is a folder, whose files are not attached\.\n\n/,
    );
    assert.doesNotMatch(toolless.sent[0]?.messages.map(messageText).join("\n") ?? "", /diagram_/);
  });

  test("reports attachment read failures without losing the rest of the request", async () => {
    const { result, sent, shown } = await ask([[text("Cannot read that file.")]], {
      references: [
        { id: "file", value: vscode.Uri.file("/un*read_able <x> [1].csv") },
        { id: "text", value: "Chart the file when available" },
      ],
    });
    assert.strictEqual(result?.errorDetails, undefined);
    const attached = attachments(sent[0]?.messages);
    assert.strictEqual(attached?.length, 2);
    // The error names the file once.
    assert.strictEqual(
      attached?.[1],
      "Attached by the user, but not read: /un*read_able <x> [1].csv does not exist.",
    );
    assert.match(attached?.[0] ?? "", /Chart the file when available/);
    // Markdown, with the file name shown as is.
    assert.strictEqual(
      shown,
      `${String.raw`Left out: /un\*read\_able \<x\> \[1\].csv does not exist.`}\n\nCannot read that file.`,
    );
  });

  test("gives the model attached images once, and says why others are left out", async () => {
    const root = workspaceRoot().uri;
    const file = vscode.Uri.joinPath(root, "whiteboard.PNG");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await vscode.workspace.fs.writeFile(file, png);
    afterTest(() => vscode.workspace.fs.delete(file));
    const references = [
      { id: "file", value: file },
      pasted("image/jpeg", new Uint8Array([1, 2, 3])),
      pasted("image/png", new Uint8Array(3 * 1024 * 1024 + 1)),
      pasted("application/pdf", new Uint8Array([1])),
      pasted("image/bmp", new Uint8Array([1])),
      pasted("image/jpg", new Uint8Array([4])),
      { id: "problems", value: { diagnostics: [] } },
      { id: "file", value: file },
      pasted("image/jpeg", new Uint8Array([1, 2, 3])),
      { id: "symbol", value: 42 },
      { id: "file", value: vscode.Uri.joinPath(root, "gone.png") },
    ].reverse();
    const { sent, shown } = await ask([[text("Drawing.")]], { references });
    const messages = sent[0]?.messages.filter((m) => messageText(m).startsWith("Attached"));
    assert.deepStrictEqual(messages?.map(messageText), [
      "Attached by the user: whiteboard.PNG[image/png]",
      "Attached by the user: image[image/jpeg]",
      "Attached by the user: image, which could not be read: the image takes 3.0 MiB, more than the 3 MiB limit. Attach a smaller or more compressed image.",
      "Attached by the user: image, which could not be read: @diagram does not support application/pdf attachments",
      "Attached by the user: image, which could not be read: the image is image/bmp, which models do not accept. Attach a PNG, JPEG, GIF or WebP image.",
      "Attached by the user: image[image/jpeg]",
      "Attached by the user: problems, which could not be read: @diagram does not support this kind of attachment",
      "Attached by the user: symbol, which could not be read: @diagram does not support this kind of attachment",
      "Attached by the user, but not read: gone.png does not exist.",
    ]);
    assert.strictEqual(
      shown,
      "Left out image: the image takes 3.0 MiB, more than the 3 MiB limit. Attach a smaller or more compressed image. " +
        "Left out image: @diagram does not support application/pdf attachments. " +
        "Left out image: the image is image/bmp, which models do not accept. Attach a PNG, JPEG, GIF or WebP image. " +
        "Left out problems, symbol: @diagram does not support this kind of attachment. " +
        "Left out: gone.png does not exist.\n\nDrawing.",
    );
    const images = messages?.map((m) =>
      m.content.find((part) => part instanceof vscode.LanguageModelDataPart),
    );
    assert.deepStrictEqual(
      images?.slice(0, 2).map((part) => [part?.mimeType, [...(part?.data ?? [])]]),
      [
        ["image/png", [...png]],
        ["image/jpeg", [1, 2, 3]],
      ],
    );
    // An image/jpg as models accept it.
    assert.deepStrictEqual(images?.[5]?.mimeType, "image/jpeg");
    assert.ok(
      images
        ?.toSpliced(5, 1)
        .slice(2)
        .every((part) => part === undefined),
    );
  });

  test("leaves out images for models without image input and from earlier requests", async () => {
    let reads = 0;
    const references = [
      {
        id: "pasted",
        value: {
          mimeType: "image/png",
          data: async () => {
            reads++;
            return new Uint8Array([1]);
          },
        },
      },
    ];
    const history = [
      new RequestTurn("Draw this", undefined, references, "diagram.participant", []),
    ];
    const { sent, shown } = await ask([[text("Hm.")]], {
      history,
      references,
      capabilities: { supportsImageToText: false },
    });
    assert.strictEqual(reads, 0);
    const attached = attachments(sent[0]?.messages);
    assert.deepStrictEqual(attached, [
      "Attached by the user: image, which could not be read: images are only given with the request they are attached to",
      "Attached by the user: image, which could not be read: Fake does not accept images. Choose a model that does, or describe the image in words.",
    ]);
    // Only about this request's attachments.
    assert.strictEqual(
      shown,
      "Left out image: Fake does not accept images. Choose a model that does, or describe the image in words.\n\nHm.",
    );
  });

  test("does not note an earlier request's image that is attached again", async () => {
    const root = workspaceRoot().uri;
    const file = vscode.Uri.joinPath(root, "again.png");
    await vscode.workspace.fs.writeFile(file, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    afterTest(() => vscode.workspace.fs.delete(file));
    const history = [
      new RequestTurn(
        "Draw these",
        undefined,
        [
          { id: "file", value: file },
          pasted("image/png", new Uint8Array([1, 2])),
          pasted("image/png", new Uint8Array([3])),
        ],
        "diagram.participant",
        [],
      ),
    ];
    const { sent } = await ask([[text("Drawn.")]], {
      history,
      references: [pasted("image/png", new Uint8Array([1, 2])), { id: "file", value: file }],
    });
    const attached = attachments(sent[0]?.messages);
    assert.deepStrictEqual(attached, [
      "Attached by the user: image, which could not be read: images are only given with the request they are attached to",
      "Attached by the user: again.png[image/png]",
      "Attached by the user: image[image/png]",
    ]);
  });

  test("gives the model earlier turns, with their diagrams and attachments", async () => {
    const folder = workspaceRoot().uri;
    const references = [{ id: "file", value: vscode.Uri.joinPath(folder, "sizes.tsv") }];
    const history = exchange(
      "Draw #file:sizes.tsv",
      "Here it is.",
      { metadata: { language: "mermaid", source: "flowchart TD\n  A --> B" } },
      { references },
    );
    const { sent, counted } = await ask([[text("Hm.")]], { history, references });
    // A small prompt fits without counting its tokens.
    assert.strictEqual(counted, 0);
    const messages = sent[0]?.messages.map(messageText).slice(1) ?? [];
    assert.deepStrictEqual(
      messages.map((message) => message.split("\n")[0]),
      ["Draw #file:sizes.tsv", "Here it is.", "Attached by the user: sizes.tsv", "Draw it"],
    );
    assert.strictEqual(messages[1], "Here it is.\n\n```mermaid\nflowchart TD\n  A --> B\n```");

    // The current diagram, which the request describes, is not repeated.
    assert.ok((await panel.render({ ...flowchart, title: "Flow" }, "participant")).ok);
    const turn = (source: string) =>
      exchange("Draw", "Drawn.", { metadata: { language: "mermaid", source } });
    const again = await ask([[text("Hm.")]], {
      history: [...turn(flowchart.source), ...turn(`${flowchart.source}\n  B --> C`)],
    });
    const replies = again.sent[0]?.messages.map(messageText).filter((m) => m.startsWith("Drawn."));
    assert.deepStrictEqual(replies, [
      "Drawn.\n\n(I drew the current diagram, described below.)",
      `Drawn.\n\n\`\`\`mermaid\n${flowchart.source}\n  B --> C\n\`\`\``,
    ]);
  });

  test("leaves /show out of the history, and gives a command without a message by its name", async () => {
    assert.ok((await panel.render({ ...flowchart, title: "Flow" }, "tool")).ok);
    const turn = (command: string, reply: string) => exchange(" ", reply, {}, { command });
    const history = [...turn("explain", "It parses."), ...turn("show", "Opened the panel.")];
    const { sent } = await ask([[text("Hm.")]], { history, command: "explain", prompt: "" });
    const messages = sent[0]?.messages.map(messageText) ?? [];
    assert.deepStrictEqual(
      [...messages.slice(1, 3), messages.at(-1)],
      ["/explain", "It parses.", "/explain"],
    );
    assert.strictEqual(messages.length, 5);
  });

  test("keeps historical chart settings without repeating large inline data", async () => {
    const chart = {
      type: "bar",
      title: "Regional sales",
      labelColumn: "region",
      valueColumns: ["sales"],
      data: `region,sales\n${"Private sample row,42\n".repeat(20_000)}`,
    };
    const history = exchange("Chart regional sales", "Here are the regional totals.", {
      metadata: { chart },
    });
    const { result, sent } = await ask([[text("The settings are retained.")]], {
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
    assert.ok(
      reply.includes(`inline data: ${chart.data.length.toLocaleString("en-US")} characters)`),
    );
    // The current chart may be another one.
    assert.doesNotMatch(reply, /diagram_inspectData/);
    assert.doesNotMatch(messages.join("\n"), /Private sample row/);
    assert.ok(messages.reduce((sum, message) => sum + tokenCount(message) + 4, 0) <= 3_000);
  });

  test("leaves out the oldest turns, and older diagrams first, to fit the model's input", async () => {
    // Each turn takes about 3000 tokens of text and 10000 of diagram, and the prompt may take
    // 3/4 of 41640 tokens: the last two turns fit with their diagrams, and one more without.
    const history = [1, 2, 3, 4].flatMap((n) =>
      exchange(`Draw ${n}`, `Reply ${n}: ${"x".repeat(12_000)}`, {
        metadata: { language: "mermaid", source: `flowchart TD\n%% ${"y".repeat(40_000)}` },
      }),
    );
    const { sent } = await ask([[text("Hm.")]], { history, maxInputTokens: 41_640 });
    const messages = sent[0]?.messages.map(messageText).slice(1) ?? [];
    assert.deepStrictEqual(
      messages.map((message) => message.slice(0, 7)),
      ["Draw 2", "Reply 2", "Draw 3", "Reply 3", "Draw 4", "Reply 4", "Draw it"],
    );
    assert.match(messages[1] ?? "", /x\n\n\(I drew a diagram, left out here\.\)$/);
    assert.match(messages[3] ?? "", /y\n```$/);
    assert.match(messages[5] ?? "", /y\n```$/);
  });

  test("counts prose-only history after leaving out a diagram", async () => {
    const history = [
      ...exchange("Earlier question", "x".repeat(12_000)),
      ...exchange("Draw it", "Here it is.", {
        metadata: { language: "mermaid", source: "y".repeat(20_000) },
      }),
    ];
    const maxInputTokens = 4_000;
    const { sent } = await ask([[text("Hm.")]], { history, maxInputTokens });
    const messages = sent[0]?.messages.map(messageText) ?? [];
    assert.ok(messages.some((message) => message.includes("I drew a diagram, left out here")));
    assert.ok(!messages.includes("Earlier question"));
    const tokens = messages.reduce((sum, message) => sum + tokenCount(message) + 4, 0);
    assert.ok(tokens <= (maxInputTokens * 3) / 4, `${tokens}`);
  });

  test("counts repeated history once and skips unused shortened replies", async () => {
    const history = [1, 2].flatMap(() =>
      exchange("Draw it", "Here it is.", {
        metadata: { language: "mermaid", source: "x".repeat(2_800) },
      }),
    );
    const { sent, counted } = await ask([[text("Hm.")]], {
      history,
      maxInputTokens: 4_000,
    });
    const messages = sent[0]?.messages.map(messageText) ?? [];
    assert.strictEqual(messages.filter((message) => message.includes("x".repeat(2_800))).length, 2);
    // Instructions, the shared prompt and the shared complete reply.
    assert.strictEqual(counted, 3);
  });

  test("counts the messages of earlier tool rounds once", async () => {
    // A short result, so that each round's fits whole.
    countToolCalls(() => new vscode.LanguageModelToolResult([text("flowchart TD\n  A --> B")]));
    const history = exchange("Draw it", "Here it is.", {
      metadata: { language: "mermaid", source: "x".repeat(5_000) },
    });
    const call = () => [getState()];
    const options = {
      history,
      maxInputTokens: 4_000,
      toolReferences: [{ name: "diagram_getState" }],
    };
    const once = await ask([call(), [text("Hm.")]], options);
    const thrice = await ask([call(), call(), call(), [text("Hm.")]], options);
    assert.strictEqual(thrice.sent.length, 4);
    // Each round calls the tool alike, so later rounds have no new text to count.
    assert.ok(once.counted > 0);
    assert.strictEqual(thrice.counted, once.counted);
  });

  test("shortens the attachments that don't fit the model's input, and says so", async () => {
    const references = [
      { id: "long", value: "a".repeat(20_000) },
      { id: "short", value: "short text" },
    ];
    const maxInputTokens = 4_000;
    const { sent } = await ask([[text("Hm.")]], { references, maxInputTokens });
    const messages = sent[0]?.messages.map(messageText) ?? [];
    assert.ok(messages.includes("Attached by the user: text\n\n```\nshort text\n```"));
    const truncated =
      /^Attached by the user: text, truncated to the first [\d,]+ of its 20,000 characters\n\n```\na+\n```$/;
    assert.ok(messages.some((message) => truncated.test(message)));
    const tokens = messages.reduce((sum, message) => sum + tokenCount(message) + 4, 0);
    assert.ok(tokens > maxInputTokens / 2 && tokens <= (maxInputTokens * 3) / 4, `${tokens}`);
  });

  test("says what is too large when the request does not fit the model's input", async () => {
    const prompt = "Draw ".repeat(4_000);
    const { result, sent } = await ask([], { prompt, maxInputTokens: 4_000 });
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(
      result?.errorDetails?.message,
      "This request exceeds Fake's 3,000-token input budget: your message takes 5,004 tokens. Shorten your message or choose a model with a larger context.",
    );
  });
});
